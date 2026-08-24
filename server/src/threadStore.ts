// The thread store — build sessions, as rows rather than as whatever the open tab remembers.
//
// AN ADDITIVE CONTROL-PLANE TABLE, exactly as the eval engine and the MCP registry are.
// schema/events.md v1 is untouched: a thread does not appear in the trace, a run does not gain a
// field, and nothing here is read by the ingest path. §7 of the spec says the same thing from the
// other side — new capability rides beside the frozen schema in new tables and a new channel.
//
// EVERY METHOD TAKES A `TenantContext` FIRST, and on SQLite that parameter IS the tenancy boundary
// (migration 009 grants that driver no RLS at all). §6 admits no unscoped read path in this
// feature, so there is no method here that finds a thread by id alone — `get` takes a context and
// a scoped WHERE, which is what makes "another workspace's thread id" resolve to undefined rather
// than to somebody else's session.
//
// NOTHING HERE DERIVES ANYTHING. §3.3's status is a function of pending diffs, in-flight runs,
// failed steps and awaiting plans — none of which this table holds — so the derivation lives in its
// own module and this store persists what it concluded. That split is why `setStatus` exists and
// why it is the only way the column moves: a store that computed status would have to know about
// the editor, the run pool and the eval queue, and would be the third place each of those is
// modelled.
//
// ARCHIVE, NEVER DELETE (§3.4). There is deliberately no `deleteThread` on this class. A thread
// holds what was thought, what was generated and what it cost, and the eval store's own
// `deleteDataset` comment gives the reason the same way: a past comparison has to stay readable
// after the artefact it was about is gone. `archive` sets a timestamp, `restore` clears it, and
// nothing removes a row — which is also why §3.4 says the delete-confirmation dialog specified for
// this redesign applies to Agents and not here. There is no delete path to confirm.

import { randomUUID } from "node:crypto";

import { asBool, asInt, type Db, type Queryable } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";

/** §3.3's five. Derived, never sent by a client — see `setStatus`. */
export type ThreadStatus = "needs_you" | "running" | "errored" | "idle" | "archived";

export const THREAD_STATUSES: readonly ThreadStatus[] = [
  "needs_you", "running", "errored", "idle", "archived",
];

export function isThreadStatus(v: unknown): v is ThreadStatus {
  return typeof v === "string" && (THREAD_STATUSES as readonly string[]).includes(v);
}

export interface Thread {
  id: string;
  /**
   * The agent this session is building, or null.
   *
   * Null means one of two things and the snapshot below is what tells them apart: null with no
   * snapshot is a thread that has not generated anything yet (§3.1's planning stage), null with a
   * snapshot is a thread whose agent was deleted (§3.2).
   */
  agent_id: string | null;
  /** The name it was linked to. Outlives the agent, on purpose — see §3.2. */
  agent_name_snapshot: string | null;
  title: string;
  /** True once somebody renamed it. Auto-titling must never overwrite one (§5). */
  title_is_custom: boolean;
  /** Attribution for the Team author column. Null for a thread server-side work opened. */
  created_by: string | null;
  created_at: string;
  last_activity_at: string;
  /** Null means active. The only way a thread leaves the default list. */
  archived_at: string | null;
  status: ThreadStatus;
}

/**
 * The six kinds of thing a thread can own (migration 044).
 *
 * `message` is the only one with prose of its own; the other five are pointers at rows or at
 * in-memory state that already exists somewhere else.
 */
export type ThreadItemKind = "message" | "plan" | "generation" | "proposal" | "run" | "eval";

export interface ThreadItem {
  thread_id: string;
  kind: ThreadItemKind;
  /** The id in the owning table. Null on a message, which owns itself. */
  ref_id: string | null;
  role: "user" | null;
  body: string | null;
  created_at: string;
}

/** One of the user's own turns. The only prose this table holds — see migration 044. */
export interface ThreadMessage {
  body: string;
  created_at: string;
}

/** What `create` needs. Everything else about a new thread is a default with a reason. */
export interface NewThread {
  agentId?: string | null;
  agentName?: string | null;
  /** Omitted for a thread opened before anything has been said — see `UNTITLED`. */
  title?: string;
  createdBy?: string | null;
}

/**
 * A thread that has been created and not yet spoken to (§5).
 *
 * Here rather than in the client, because the server writes the row and a client-side default
 * would mean two spellings of the same absence — and the one the database held would be whichever
 * client wrote it first.
 */
export const UNTITLED = "Untitled thread";

/**
 * The longest title this table will store.
 *
 * FOUR TIMES `threadTitle`'s OWN CAP, deliberately generous rather than equal to it. Auto-titling
 * cuts at sixty because that is where a first line stops being a label; a person naming their own
 * session may reasonably want more, and refusing at sixty would make the two entry points disagree
 * about what a title IS in the other direction.
 *
 * What it exists to stop is that there was no bound at all: `createThread` accepted any string and
 * `renameThread` coerced with `String(...)`, so a megabyte of text — or `"[object Object]"` from a
 * non-string — was stored verbatim, read back into every snapshot, and broadcast to every socket in
 * the workspace on every state transition. Bounded by the socket's `maxPayload` and rendered inside
 * a `Truncate`, so this is hygiene rather than a live risk; a column with no bound is still a column
 * somebody eventually fills.
 */
export const TITLE_MAX = 240;

/** Trim, and cut at `TITLE_MAX`. The one definition of "a storable title". */
function capTitle(title: string): string {
  return title.trim().slice(0, TITLE_MAX).trim();
}

const nowIso = (): string => new Date().toISOString();

/**
 * A clock for `thread_items` that never issues the same instant twice.
 *
 * WHY THIS IS NOT PARANOIA. `created_at` is the ONLY ordering these rows have — there is no
 * sequence column — and every read of them is ordered by it. Two items written in the same
 * millisecond therefore have no defined order at all, and neither driver promises a stable one: the
 * result depends on the scan the planner chose, which changes when an index is added.
 *
 * What that costs is not theoretical. §4.3's preview is "the last USER message", derived by walking
 * the items in order — so a message and the proposal it produced landing in one millisecond can
 * make a thread's preview flip to an older sentence, with no write in between and nothing to blame.
 * It is invisible until it happens in front of somebody.
 *
 * A PROCESS-LOCAL MONOTONIC CLOCK, not a database sequence, because that is proportional to the
 * problem: the items whose ordering matters are written by one process handling one conversation,
 * and a sequence would be a migration plus a round trip on every append to fix an ordering that is
 * already correct for every other case. Two gateway replicas writing into one thread in the same
 * millisecond remain possible and remain tie-broken by `id` at the read — which is arbitrary but
 * at least stable, so the preview cannot change between two reads of unchanged rows.
 */
let lastIssued = 0;
function nextItemIso(): string {
  const now = Date.now();
  lastIssued = now > lastIssued ? now : lastIssued + 1;
  return new Date(lastIssued).toISOString();
}

// Explicit rather than `SELECT *`: `workspace_id` is on every row and belongs on none of the
// snapshots a client receives. The same reason the MCP registry lists its columns out.
const COLUMNS = `id, agent_id, agent_name_snapshot, title, title_is_custom, created_by,
                 created_at, last_activity_at, archived_at, status`;

export class ThreadStore {
  /** Shares the trace store's database: same file, single writer. See TraceStore.database(). */
  constructor(private db: Db) {}

  // No `init()`. The table arrives with migration 043 on both drivers and no column has been
  // added to it after the fact. When one is, copy `ensureColumn` from store.ts — an existing
  // database has no migration row saying it is missing a column, so a migration cannot know to
  // add it.

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  private static hydrate(row: Record<string, unknown>): Thread {
    return {
      ...row,
      // INTEGER 0/1 on SQLite, boolean on Postgres. A truthy check on the raw column would make
      // `0` false on one driver and `false` false on both, which is the sort of parity bug that
      // only shows up in production.
      title_is_custom: asBool(row["title_is_custom"]),
    } as unknown as Thread;
  }

  /**
   * Open a thread.
   *
   * THE AGENT NAME IS SNAPSHOTTED AT CREATION, not looked up at read time, and that is §3.2
   * working in advance: the column has to hold a name before the agent is deleted, because
   * afterwards there is nowhere to read one from. A thread created without an agent gets neither
   * field, and both arrive together when generation names one — see `attachAgent`.
   */
  async create(ctx: TenantContext, t: NewThread = {}): Promise<Thread> {
    const id = randomUUID();
    const now = nowIso();
    await this.q(ctx).run(
      // `title_is_custom` IS A BOUND PARAMETER AND NOT AN INLINE `0`, and that is the whole
      // difference between this working and this never having worked on Postgres.
      //
      // The column is `INTEGER` on SQLite and `boolean` on Postgres. A bound value is untyped when
      // it leaves the driver, so Postgres resolves it against the target column and accepts `0` as
      // false — which is how every other boolean in this codebase is written (`hand_written`,
      // `configured`, `overridden`). A LITERAL `0` in the statement text is typed `integer` before
      // the column is consulted, and Postgres refuses to assign it:
      //
      //     column "title_is_custom" is of type boolean but expression is of type integer
      //
      // So `create` threw on every call against the production driver — which means creating a
      // thread, and therefore `ensureForAgent` and every run, generation and edit that resolves a
      // session through it, could not work there at all. It went unseen because every thread suite
      // opens SQLite: the same shape as migration 044's COALESCE, and the same lesson.
      `INSERT INTO threads (id, workspace_id, agent_id, agent_name_snapshot, title,
                            title_is_custom, created_by, created_at, last_activity_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle')`,
      [
        id,
        ctx.workspaceId,
        t.agentId ?? null,
        t.agentName ?? null,
        (t.title ? capTitle(t.title) : "") || UNTITLED,
        // A new thread's title is whatever this row was opened with, never something a person
        // typed — `rename` is the only thing that makes it custom.
        0,
        // `actorUserId` rather than a required argument: every caller already has a context, and
        // a second place to pass the person is a second place to pass the wrong one.
        t.createdBy ?? ctx.actorUserId ?? null,
        now,
        now,
      ],
    );
    return (await this.get(ctx, id))!;
  }

  /** One thread, or undefined — including when the id belongs to another workspace. */
  async get(ctx: TenantContext, id: string): Promise<Thread | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM threads WHERE workspace_id = ? AND id = ?`,
      [ctx.workspaceId, id],
    );
    return row ? ThreadStore.hydrate(row) : undefined;
  }

  /**
   * Every thread in the workspace, active or archived.
   *
   * ONE QUERY FOR BOTH, rather than a listing plus an archived listing. The filter chips (§4.4)
   * carry live counts for all five states at once, so a client that had to ask twice would render
   * an Archived count from an older moment than the one beside it — and the counts are what the
   * nav badge is sourced from (§2.1), which makes a mismatch visible in two places.
   *
   * `archived_at IS NULL DESC` FIRST, so the active rows come first on BOTH drivers. This comment
   * claimed that ordering and the query did not have it: SQLite sorts NULLs low and Postgres sorts
   * them high, so "active rows first" was true on one driver and false on the other. It is harmless
   * today only because the client regroups and re-sorts (`threadGroups.ts`) — which makes it a
   * guarantee a future reader would rely on and not get. Written as a boolean expression rather than
   * `archived_at DESC NULLS LAST`, which SQLite does not accept.
   */
  async list(ctx: TenantContext): Promise<Thread[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM threads
        WHERE workspace_id = ?
        ORDER BY (archived_at IS NULL) DESC, last_activity_at DESC`,
      [ctx.workspaceId],
    );
    return rows.map(ThreadStore.hydrate);
  }

  /** This agent's threads, newest first. §3.1's many-to-one, from the many side. */
  async listForAgent(ctx: TenantContext, agentId: string): Promise<Thread[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM threads
        WHERE workspace_id = ? AND agent_id = ?
        ORDER BY last_activity_at DESC`,
      [ctx.workspaceId, agentId],
    );
    return rows.map(ThreadStore.hydrate);
  }

  /**
   * Rename, by hand.
   *
   * SETS `title_is_custom`, which is the whole point of the column: after this, auto-titling from
   * the first user message is inert for this thread forever (§5). A rename that only wrote the
   * title would be silently undone by the next message.
   *
   * The title does NOT move `last_activity_at`. That column orders two of the three sections by
   * when work last happened, and typing a better name is not work happening.
   */
  async rename(ctx: TenantContext, id: string, title: string): Promise<void> {
    const trimmed = capTitle(title);
    if (!trimmed) return;
    await this.q(ctx).run(
      // `title_is_custom` IS BOUND, for the reason `create` states at length: the column is INTEGER
      // on SQLite and boolean on Postgres, and a literal `1` in the statement text is typed integer
      // before the column is consulted — so this refused every rename on the production driver, in
      // exactly the way `create` refused every thread.
      `UPDATE threads SET title = ?, title_is_custom = ? WHERE workspace_id = ? AND id = ?`,
      [trimmed, 1, ctx.workspaceId, id],
    );
  }

  /**
   * The auto-title, applied only where nobody has chosen one.
   *
   * The custom-title guard is IN THE WHERE rather than a read-then-write, because the guarantee is
   * "never overwrites a custom title" and a check in TypeScript is a check with a gap in it: two
   * clients in a Team workspace can rename and send in the same millisecond, and the rung-ordering
   * bug this codebase already fixed once is what that looks like when it happens.
   *
   * AND IT IS A BOUND PARAMETER, not a literal `0`, for the reason `create` gives — with one extra
   * turn of the screw. In a SET or a VALUES a literal is a type mismatch Postgres reports plainly;
   * in a WHERE it is `operator does not exist: boolean = integer`, which reads like a missing
   * operator rather than like the wrong value. Bound, it is resolved against the column and works on
   * both drivers, which is what makes auto-titling happen at all on Postgres.
   */
  async autoTitle(ctx: TenantContext, id: string, title: string): Promise<void> {
    const trimmed = capTitle(title);
    if (!trimmed) return;
    await this.q(ctx).run(
      `UPDATE threads SET title = ?
        WHERE workspace_id = ? AND id = ? AND title_is_custom = ?`,
      [trimmed, ctx.workspaceId, id, 0],
    );
  }

  /**
   * The FIRST thing anybody said in this thread, which is what §5 titles from.
   *
   * REPLACES A COUNT, AND THAT IS THE FIX. The caller used to insert the message, read the message
   * count back and title only when it was exactly one — so two first messages whose inserts both
   * landed before either read both saw two, NEITHER titled, and the count can only grow afterwards:
   * the row stayed `Untitled thread` permanently and §4.4's text filter could never find it. A
   * double-submit, two members of a Team workspace, or a `planAgent` immediately followed by an
   * `edit` are all enough.
   *
   * Asking for the first message instead is idempotent: both racers read the same row and derive the
   * same title, so whichever writes last writes the same thing. It is also cheaper — `LIMIT 1`
   * rather than every body in the thread selected in order to take `.length`.
   */
  async firstMessage(ctx: TenantContext, threadId: string): Promise<string | null> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT body FROM thread_items
        WHERE workspace_id = ? AND thread_id = ? AND kind = 'message' AND role = 'user'
        ORDER BY created_at ASC, id ASC LIMIT 1`,
      [ctx.workspaceId, threadId],
    );
    return row ? String(row["body"] ?? "") : null;
  }

  /** Something happened in this thread. The sort key for Running and Recent (§4.2). */
  async touch(ctx: TenantContext, id: string, at = nowIso()): Promise<void> {
    await this.q(ctx).run(
      `UPDATE threads SET last_activity_at = ? WHERE workspace_id = ? AND id = ?`,
      [at, ctx.workspaceId, id],
    );
  }

  /**
   * Write a derived status back.
   *
   * THE ONLY WRITER OF THAT COLUMN, and it is called with what the deriver concluded rather than
   * with what a caller thinks. `archived` is refused here rather than accepted: archiving is a
   * timestamp (§3.4) and the status follows from it, so a caller allowed to write `archived`
   * directly could produce a row that reads as archived and is still in the default list.
   */
  async setStatus(ctx: TenantContext, id: string, status: ThreadStatus): Promise<void> {
    if (status === "archived") return;
    await this.q(ctx).run(
      `UPDATE threads SET status = ?
        WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
      [status, ctx.workspaceId, id],
    );
  }

  /**
   * The same, for every row that just moved to one status.
   *
   * THE SNAPSHOT BUILDER'S WRITE-BACK, IN ONE STATEMENT PER STATUS instead of one per row awaited
   * in series. There are five statuses, so a workspace with two hundred threads whose statuses all
   * moved costs five round trips rather than two hundred — on the path a socket is waiting on.
   *
   * Batched for the same reason `retention` batches its deletes: a parameter list has a limit on
   * both drivers, and a statement that works until the first workspace large enough to need it is
   * worse than not having written it.
   */
  async setStatuses(ctx: TenantContext, ids: readonly string[], status: ThreadStatus): Promise<void> {
    if (status === "archived" || ids.length === 0) return;
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      await this.q(ctx).run(
        `UPDATE threads SET status = ?
          WHERE workspace_id = ? AND archived_at IS NULL AND id IN (${chunk.map(() => "?").join(", ")})`,
        [status, ctx.workspaceId, ...chunk],
      );
    }
  }

  /**
   * Point a thread at the agent it built, and snapshot the name in the same statement.
   *
   * ONE STATEMENT FOR BOTH, so the pair can never be written apart. A row with an `agent_id` and
   * no snapshot is a row whose history is already lost the moment that agent is deleted, and the
   * snapshot's entire reason for existing is that there is no way to recover it afterwards.
   */
  async attachAgent(ctx: TenantContext, id: string, agentId: string, agentName: string): Promise<void> {
    await this.q(ctx).run(
      `UPDATE threads SET agent_id = ?, agent_name_snapshot = ?, last_activity_at = ?
        WHERE workspace_id = ? AND id = ?`,
      [agentId, agentName, nowIso(), ctx.workspaceId, id],
    );
  }

  /** §3.4. Leaves the default list, keeps every byte. */
  async archive(ctx: TenantContext, id: string, at = nowIso()): Promise<void> {
    await this.q(ctx).run(
      `UPDATE threads SET archived_at = ?, status = 'archived'
        WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
      [at, ctx.workspaceId, id],
    );
  }

  /**
   * The other half, and the reason archiving needs no confirmation dialog.
   *
   * Restores to `idle` rather than to whatever it was before, because what it was before is a
   * derivation over live facts and those facts have moved. The deriver runs on the next read and
   * says what is true now; guessing here would put a stale amber ◆ on a row whose diff was applied
   * a week ago.
   */
  async restore(ctx: TenantContext, id: string): Promise<void> {
    await this.q(ctx).run(
      `UPDATE threads SET archived_at = NULL, status = 'idle'
        WHERE workspace_id = ? AND id = ? AND archived_at IS NOT NULL`,
      [ctx.workspaceId, id],
    );
  }

  // --- what a thread owns (migration 044) ------------------------------------
  //
  // A JOIN, NOT A TRANSCRIPT. `ref_id` names something that lives in its own table — a run in
  // `runs`, an eval in `eval_runs`, a proposal in the editor's own memory — and a row here is only
  // the statement that it happened inside this session. Nothing about whether it is still LIVE is
  // stored, because the owner already knows and two answers would eventually differ.

  /**
   * Record that something happened in this thread, and move its activity clock.
   *
   * ONE STATEMENT PLUS A TOUCH, rather than leaving the caller to remember the second: the whole
   * reason `last_activity_at` exists is that §4.2 sorts two of its three sections by it, and an
   * item written without it would be work that happened to a thread that does not know it did.
   */
  async addItem(
    ctx: TenantContext,
    threadId: string,
    item: { kind: ThreadItemKind; refId?: string | null; role?: "user" | null; body?: string | null },
  ): Promise<void> {
    // The monotonic clock, not the wall one — see `nextItemIso`. These rows are ordered by nothing
    // else, so two written in the same millisecond would have no defined order on either driver.
    const now = nextItemIso();
    await this.q(ctx).run(
      `INSERT INTO thread_items (id, workspace_id, thread_id, kind, ref_id, role, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), ctx.workspaceId, threadId, item.kind,
        item.refId ?? null, item.role ?? null, item.body ?? null, now,
      ],
    );
    await this.touch(ctx, threadId, now);
  }

  /** What somebody said, in order. §4.3's preview is the last of these; §5's title is the first. */
  async messages(ctx: TenantContext, threadId: string): Promise<ThreadMessage[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT body, created_at FROM thread_items
        WHERE workspace_id = ? AND thread_id = ? AND kind = 'message' AND role = 'user'
        ORDER BY created_at ASC, id ASC`,
      [ctx.workspaceId, threadId],
    );
    return rows.map((r) => ({ body: String(r["body"] ?? ""), created_at: String(r["created_at"]) }));
  }

  /**
   * The whole workspace's items, in one query.
   *
   * ONE QUERY FOR EVERY THREAD, not one per thread. The snapshot renders every row at once, and a
   * per-thread read would be N round trips to build one list — which is the same reason
   * `listAgents` reads its deploy states and edit counts in one go rather than per agent.
   */
  async allItems(ctx: TenantContext): Promise<ThreadItem[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT thread_id, kind, ref_id, role, body, created_at FROM thread_items
        WHERE workspace_id = ?
        ORDER BY created_at ASC, id ASC`,
      [ctx.workspaceId],
    );
    return rows.map((r) => ({
      thread_id: String(r["thread_id"]),
      kind: r["kind"] as ThreadItemKind,
      ref_id: (r["ref_id"] as string | null) ?? null,
      role: (r["role"] as "user" | null) ?? null,
      body: (r["body"] as string | null) ?? null,
      created_at: String(r["created_at"]),
    }));
  }

  /**
   * One thread's items, oldest first — what §4.5 rehydrates a conversation from.
   *
   * SEPARATE FROM `allItems` RATHER THAN A FILTER OVER IT, because the two answer different
   * questions at different sizes: the snapshot needs every thread's items and reads them in one
   * query, and opening one thread needs one thread's and must not pay for the workspace's.
   *
   * What comes back is the user's own turns plus a stub per run, eval, plan, generation and
   * proposal. Jaroku's prose is deliberately not in this table (migration 044), so a reopened
   * thread shows what somebody said and what it caused, not a transcript of the replies.
   */
  async itemsFor(ctx: TenantContext, threadId: string): Promise<ThreadItem[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT thread_id, kind, ref_id, role, body, created_at FROM thread_items
        WHERE workspace_id = ? AND thread_id = ?
        ORDER BY created_at ASC, id ASC`,
      [ctx.workspaceId, threadId],
    );
    return rows.map((r) => ({
      thread_id: String(r["thread_id"]),
      kind: r["kind"] as ThreadItemKind,
      ref_id: (r["ref_id"] as string | null) ?? null,
      role: (r["role"] as "user" | null) ?? null,
      body: (r["body"] as string | null) ?? null,
      created_at: String(r["created_at"]),
    }));
  }

  /**
   * Which thread owns this run / eval / plan / proposal, if any.
   *
   * Returns undefined rather than throwing for something that was never bound. Plenty of work
   * predates this table or happens outside a session — a startup reconciliation, a webhook-driven
   * check run — and "no thread" is a real answer rather than a failure.
   */
  async threadForRef(
    ctx: TenantContext,
    kind: ThreadItemKind,
    refId: string,
  ): Promise<string | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT thread_id FROM thread_items
        WHERE workspace_id = ? AND kind = ? AND ref_id = ?
        ORDER BY created_at ASC, id ASC LIMIT 1`,
      [ctx.workspaceId, kind, refId],
    );
    return row ? String(row["thread_id"]) : undefined;
  }

  /**
   * The thread work on this agent belongs to, opening one if there is none.
   *
   * WHAT MAKES THE BINDING WORK BEFORE ANY CLIENT KNOWS ABOUT THREADS. Every command that starts
   * work may carry a `threadId`; until a client sends one, this is the fallback, and it is the same
   * continuity migration 044's backfill established — one session per agent, reused. The
   * alternative, a fresh thread per command, would turn one afternoon's work on one agent into
   * fifteen rows in a list whose whole job is to be scannable.
   *
   * The MOST RECENTLY ACTIVE one rather than the oldest: if somebody has three threads on an agent,
   * the one they are working in is the one they touched last, and putting a new message into a
   * six-week-old session would be a worse guess than any.
   */
  async ensureForAgent(
    ctx: TenantContext,
    agentId: string,
    agentName: string,
  ): Promise<string> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT id FROM threads
        WHERE workspace_id = ? AND agent_id = ? AND archived_at IS NULL
        ORDER BY last_activity_at DESC LIMIT 1`,
      [ctx.workspaceId, agentId],
    );
    if (row) return String(row["id"]);
    return (await this.create(ctx, { agentId, agentName, title: agentName })).id;
  }

  /**
   * An agent is gone; its threads are not (§3.2).
   *
   * KEEPS THE NAME AND KEEPS THE LINK. It used to null `agent_id` as well, and that was a one-way
   * consequence of a reversible cause: an agent is SOFT-deleted, and `upsertFromDisk` clears
   * `deleted_at` the moment its directory comes back. Nothing put the foreign key back, so a
   * momentarily-absent directory — a second replica, an ephemeral disk, a cleaned checkout —
   * permanently detached a live agent's sessions, and the next command on that agent opened a
   * duplicate thread beside the orphan.
   *
   * So §3.2's rendering is a join now: the row is deleted when the AGENT is, which the agents table
   * already knows and can un-know. The snapshot column keeps doing its real job — surviving a HARD
   * delete, where the row cascades to `agent_id = NULL` and there is nowhere left to read the name.
   *
   * `COALESCE` still, and for the same reason: a second sweep must not overwrite a name it is
   * being handed as null.
   *
   * Returns how many threads it kept, so the caller can say so rather than assume.
   */
  async noteAgentDeleted(ctx: TenantContext, agentId: string, agentName: string | null): Promise<number> {
    const res = await this.q(ctx).run(
      `UPDATE threads
          SET agent_name_snapshot = COALESCE(agent_name_snapshot, ?)
        WHERE workspace_id = ? AND agent_id = ?`,
      [agentName, ctx.workspaceId, agentId],
    );
    return res.changes;
  }

  /**
   * §5.2's "current work" line, for every agent in the workspace, in two statements.
   *
   * WHAT THE CARD ACTUALLY ASKS FOR is "the latest thread's title, plus one line derived from its last
   * turn". Done naively that is a sorted read of one agent's threads and then a read of that thread's
   * messages — two round trips per card, eighty for a workspace of forty agents, on the path a socket
   * is waiting on. Both halves here are one statement over a workspace-bounded scan, which is what
   * migration 048's `(workspace_id, agent_id, last_activity_at DESC)` exists to make cheap.
   *
   * THE COUNT AND THE LATEST THREAD DISAGREE ABOUT ARCHIVED ROWS, on purpose. The footer's thread
   * count is how many sessions this agent has open, so it excludes archived ones — a count that
   * included them would keep rising for an agent nobody has touched in months. The latest thread does
   * NOT exclude them, because the line it feeds says whether the agent has been STARTED: an agent
   * whose only session was archived has still been started, and "Not started yet" would be false.
   *
   * ONLY THE USER'S OWN TURNS ARE AVAILABLE TO DERIVE THE SECOND LINE FROM, and that is migration
   * 044's decision rather than a gap here: Jaroku's prose is streamed on the gen / edit / reply
   * channels and rebuilt from them, so `thread_items` holds no reply to quote. The honest last turn
   * is therefore the last thing the person said, which is also what the Threads list shows and for
   * the reason it gives — the user's own intent is what makes a session recognisable.
   */
  async agentThreadFacts(ctx: TenantContext): Promise<Map<string, AgentThreadFacts>> {
    const out = new Map<string, AgentThreadFacts>();
    const at = (agentId: string): AgentThreadFacts => {
      const existing = out.get(agentId);
      if (existing) return existing;
      const fresh: AgentThreadFacts = { threadCount: 0, latest: null };
      out.set(agentId, fresh);
      return fresh;
    };

    // How many live sessions each agent has, and which of ALL of them was active last. One pass,
    // with the archived split expressed as a conditional count rather than as a second query.
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT agent_id, id, title, last_activity_at, live_count FROM (
         SELECT t.agent_id AS agent_id, t.id AS id, t.title AS title,
                t.last_activity_at AS last_activity_at,
                COUNT(CASE WHEN t.archived_at IS NULL THEN 1 END)
                  OVER (PARTITION BY t.agent_id) AS live_count,
                ROW_NUMBER()
                  OVER (PARTITION BY t.agent_id ORDER BY t.last_activity_at DESC, t.id DESC) AS rn
           FROM threads t
          WHERE t.workspace_id = ? AND t.agent_id IS NOT NULL
       ) ranked
        WHERE rn = 1`,
      [ctx.workspaceId],
    );
    for (const row of rows) {
      const facts = at(String(row["agent_id"]));
      facts.threadCount = asInt(row["live_count"]);
      facts.latest = {
        id: String(row["id"]),
        title: String(row["title"]),
        lastActivityAt: String(row["last_activity_at"]),
        lastTurn: null,
      };
    }

    const latestIds = [...out.values()].map((f) => f.latest?.id).filter((id): id is string => !!id);
    if (latestIds.length === 0) return out;

    // The last thing said in each of those threads. Bounded by the number of AGENTS rather than by
    // the number of threads, and batched for the same reason `runOutcomes` batches: a parameter list
    // has a limit on both drivers, and a query that works until the first workspace large enough to
    // need it is worse than no optimisation at all.
    const byThread = new Map<string, string>();
    for (let i = 0; i < latestIds.length; i += 200) {
      const chunk = latestIds.slice(i, i + 200);
      const placeholders = chunk.map(() => "?").join(", ");
      const turns = await this.q(ctx).all<Record<string, unknown>>(
        `SELECT thread_id, body FROM (
           SELECT i.thread_id AS thread_id, i.body AS body,
                  ROW_NUMBER() OVER (PARTITION BY i.thread_id
                                     ORDER BY i.created_at DESC, i.id DESC) AS rn
             FROM thread_items i
            WHERE i.workspace_id = ? AND i.kind = 'message' AND i.role = 'user'
              AND i.body IS NOT NULL AND i.thread_id IN (${placeholders})
         ) ranked
          WHERE rn = 1`,
        [ctx.workspaceId, ...chunk],
      );
      for (const row of turns) byThread.set(String(row["thread_id"]), String(row["body"]));
    }
    for (const facts of out.values()) {
      if (facts.latest) facts.latest.lastTurn = byThread.get(facts.latest.id) ?? null;
    }
    return out;
  }
}

/** The session an agent's card names, and the last thing said in it. */
export interface LatestThread {
  id: string;
  title: string;
  lastActivityAt: string;
  /** The user's last turn, or null for a session nobody has spoken in yet. */
  lastTurn: string | null;
}

/** What one agent's threads say about it. See `ThreadStore.agentThreadFacts`. */
export interface AgentThreadFacts {
  /** Sessions still open on this agent. Archived ones are excluded — see the method's note. */
  threadCount: number;
  /** The most recently active session, archived or not, or null for an agent with none. */
  latest: LatestThread | null;
}
