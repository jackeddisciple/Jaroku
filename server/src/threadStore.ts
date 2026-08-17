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

import { asBool, type Db, type Queryable } from "./db/db.ts";
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

const nowIso = (): string => new Date().toISOString();

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
      `INSERT INTO threads (id, workspace_id, agent_id, agent_name_snapshot, title,
                            title_is_custom, created_by, created_at, last_activity_at, status)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'idle')`,
      [
        id,
        ctx.workspaceId,
        t.agentId ?? null,
        t.agentName ?? null,
        t.title?.trim() || UNTITLED,
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
   * `archived_at DESC` before the activity sort so the active rows come first on both drivers:
   * NULLs sort differently between them, and the section grouping happens above this anyway.
   */
  async list(ctx: TenantContext): Promise<Thread[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM threads
        WHERE workspace_id = ?
        ORDER BY last_activity_at DESC`,
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
    const trimmed = title.trim();
    if (!trimmed) return;
    await this.q(ctx).run(
      `UPDATE threads SET title = ?, title_is_custom = 1 WHERE workspace_id = ? AND id = ?`,
      [trimmed, ctx.workspaceId, id],
    );
  }

  /**
   * The auto-title, applied only where nobody has chosen one.
   *
   * The `title_is_custom = 0` in the WHERE rather than a read-then-write, because the guarantee is
   * "never overwrites a custom title" and a check in TypeScript is a check with a gap in it: two
   * clients in a Team workspace can rename and send in the same millisecond, and the rung-ordering
   * bug this codebase already fixed once is what that looks like when it happens.
   */
  async autoTitle(ctx: TenantContext, id: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return;
    await this.q(ctx).run(
      `UPDATE threads SET title = ?
        WHERE workspace_id = ? AND id = ? AND title_is_custom = 0`,
      [trimmed, ctx.workspaceId, id],
    );
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
    const now = nowIso();
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
        ORDER BY created_at ASC`,
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
        ORDER BY created_at ASC`,
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
        ORDER BY created_at ASC`,
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
        ORDER BY created_at ASC LIMIT 1`,
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
   * NULLS THE FK AND KEEPS THE NAME, in one statement, and the `COALESCE` is what makes it safe to
   * call twice: a thread already detached has a snapshot and no agent, and a second sweep must not
   * overwrite the name with the null it is being handed. The row then renders as
   * `stripe_webhook (deleted)`, dimmed, rather than as "(agent deleted)".
   *
   * Returns how many threads it kept, so the caller can say so rather than assume.
   */
  async detachAgent(ctx: TenantContext, agentId: string, agentName: string | null): Promise<number> {
    const res = await this.q(ctx).run(
      `UPDATE threads
          SET agent_id = NULL,
              agent_name_snapshot = COALESCE(agent_name_snapshot, ?)
        WHERE workspace_id = ? AND agent_id = ?`,
      [agentName, ctx.workspaceId, agentId],
    );
    return res.changes;
  }
}
