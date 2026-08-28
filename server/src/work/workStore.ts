// The work store — what somebody asked a deployed agent to do, and what became of it.
//
// EVERY METHOD TAKES A `TenantContext` FIRST, and on SQLite that parameter IS the tenancy boundary
// (migration 009 grants that driver no RLS at all). §7 admits no unscoped read path in this
// feature, so there is no method here that finds an item by id alone: `get` takes a context and a
// scoped WHERE, which is what makes another workspace's item id resolve to undefined rather than
// to somebody else's job. That is §6.3's rule stated exactly — an id belonging to another
// workspace reads as ABSENT, never as forbidden — and here it matters more than it does on the
// Inbox, because a row carries the run id and the deployment id that `cancelWork` and `retryWork`
// act on. A leak on this table is not a disclosure; it is an operator in one tenant stopping a job
// in another.
//
// NOTHING HERE DERIVES A NUMBER. Cost, tokens and duration are read from `steps` through
// `evalAggregate.ts`'s existing rules and never stored — see migration 063's header, and §11.2:
// `runs.cost` is written by `run_end`, so a run that crashed mid-graph reads 0 while its steps
// record real money already spent. A `cost` column here would be that bug a second time, in a
// table built to be the operator's honest record of what was spent on their behalf.
//
// NOTHING HERE DECIDES A STATUS EITHER. §6.5: from the moment the container answers 202, THE TRACE
// DRIVES THE STATE — `run_end` closes the item, a confirmation request moves it to `waiting`, an
// answer moves it back. This class writes down what the lifecycle concluded; working out what the
// lifecycle concluded is `lifecycle.ts`'s job, exactly as `InboxStore` and the reconciler split
// "write it down" from "work out whether it is true".
//
// THE ONE JUDGEMENT THIS FILE DOES MAKE is the input cap, and it is here rather than at the
// composer because a cap enforced only at the surface is a cap the socket goes around. §4 asks for
// 65,536 bytes, matching `MAX_BODY_BYTES`, and it is BYTES rather than characters: the limit exists
// because the value crosses an HTTP boundary into somebody's container, and a JavaScript string's
// length is not what that boundary counts.

import { randomUUID } from "node:crypto";

import { asInt, type Db, type Queryable } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";
import { MAX_BODY_BYTES } from "../http/router.ts";
import { boundError, boundOutput } from "./payload.ts";

/**
 * A closed set of six, and the CHECK constraint in migration 063 is the same six.
 *
 * `waiting` MEANS A PERSON HAS TO ANSWER SOMETHING. It exists because Part 1 made it reachable —
 * a deployed run that calls a high-impact MCP tool parks on the confirmation gate — and a status
 * nothing can enter is a status that lies about what the product can do.
 *
 * `cancelled` MEANS GENUINELY CANCELLED AT A NODE BOUNDARY, not "we stopped listening". Part 1's
 * cancel asks the container to stop and the run emits its own `run_end`; the thing this word used
 * to have to cover is now `stopped_reporting`, which is a failure kind and says what it means.
 */
export const WORK_STATUSES = [
  "queued", "running", "waiting", "succeeded", "failed", "cancelled",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export function isWorkStatus(v: unknown): v is WorkStatus {
  return typeof v === "string" && (WORK_STATUSES as readonly string[]).includes(v);
}

/** The four a job can still leave under its own power. What the concurrency cap counts. */
export const WORK_IN_FLIGHT: ReadonlySet<WorkStatus> = new Set<WorkStatus>([
  "queued", "running", "waiting",
]);

/**
 * Why a job failed, as a value rather than a sentence, because the six are acted on differently.
 *
 * `unauthorised` IS THE ONLY ONE WITH A BUTTON ATTACHED — the stored serve token is wrong, and
 * Reconnect is the fix. `rejected` is the one that must be WORDED as Jaroku's fault, because it
 * is: a 400 or a 413 means Jaroku sent the container something it refused.
 *
 * `stopped_reporting` IS NOT `failed` AND MUST NEVER BE RENDERED AS ONE. §11.3: the container went
 * quiet, it may have completed, and it may have spent money. Anything more definite is a claim
 * about somebody's bill that nothing in this system is in a position to make.
 */
export const WORK_FAILURE_KINDS = [
  "unauthorised", "agent_error", "rejected", "unreachable", "stopped_reporting", "busy",
] as const;
export type WorkFailureKind = (typeof WORK_FAILURE_KINDS)[number];

export function isWorkFailureKind(v: unknown): v is WorkFailureKind {
  return typeof v === "string" && (WORK_FAILURE_KINDS as readonly string[]).includes(v);
}

export interface WorkItem {
  id: string;
  agent_id: string;
  /** The deployment that actually ran it, never the agent's current one. */
  deployment_id: string;
  /** The trace. Null only between insert and dispatch — see migration 063. */
  run_id: string | null;
  created_by: string;
  input: string;
  status: WorkStatus;
  output: string | null;
  error: string | null;
  failure_kind: WorkFailureKind | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  created_seq: number;
}

/**
 * The largest input a job may carry, in BYTES.
 *
 * `MAX_BODY_BYTES` rather than a number of its own, because it is the same boundary: this value
 * is put into a JSON body and POSTed to a container, and the router next door caps what may
 * arrive by the same route at the same figure. Two constants would eventually be two numbers.
 */
export const MAX_WORK_INPUT_BYTES = MAX_BODY_BYTES;

export interface CreateWorkItem {
  agentId: string;
  deploymentId: string;
  input: string;
  /** Minted by the caller BEFORE the row is written, so a crash leaves a readable record — §6.2. */
  runId: string;
  /** The clock, for a caller that has one — a backfill, a test. Defaults to now. */
  at?: string;
}

/** What `finish` records. One call for every way a job can end. */
export interface FinishWorkItem {
  status: Extract<WorkStatus, "succeeded" | "failed" | "cancelled">;
  output?: string | null;
  error?: string | null;
  failureKind?: WorkFailureKind | null;
  at?: string;
}

/** §5's filters, as the store reads them. */
export interface ListWorkFilters {
  /** `mine` narrows to the asking context's own actor. The DEFAULT — see §8. */
  scope?: "mine" | "all";
  status?: WorkStatus;
  agentId?: string;
  /** A keyset cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
  limit?: number;
}

/** One page, with the cursor that continues it — null when there is no more. */
export interface WorkPage {
  items: WorkItem[];
  nextCursor: string | null;
}

/** Refused before a row exists, with the figures, because §4 says refuse at the composer. */
export class WorkInputTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(
      `that input is ${bytes.toLocaleString()} bytes and the limit is ` +
        `${MAX_WORK_INPUT_BYTES.toLocaleString()} — shorten it before dispatching`,
    );
    this.name = "WorkInputTooLarge";
  }
}

/**
 * How many rows one page holds.
 *
 * Fifty rather than everything, because this list is the one surface in the product whose row
 * count grows with USE rather than with what somebody built — a workspace running four agents on
 * a schedule accumulates a page an hour — and a read that returned all of it would be fine for a
 * month and then be the slowest thing on the socket.
 */
export const WORK_PAGE = 50;

const nowIso = (): string => new Date().toISOString();

// Explicit rather than `SELECT *`: `workspace_id` is on every row and belongs on none of the
// snapshots a client receives, exactly as the thread and inbox stores list their columns out.
const COLUMNS = `id, agent_id, deployment_id, run_id, created_by, input, status, output, error,
                 failure_kind, created_at, started_at, ended_at, created_seq`;

export class WorkStore {
  /** Shares the trace store's database: same file, single writer. See TraceStore.database(). */
  constructor(private db: Db) {}

  // No `init()`. The table arrives with migration 063 on both drivers and no column has been added
  // to it after the fact. When one is, copy `ensureColumn` from store.ts — an existing database has
  // no migration row saying it is missing a column, so a migration cannot know to add it.

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  private hydrate(row: Record<string, unknown>): WorkItem {
    return {
      id: String(row.id),
      agent_id: String(row.agent_id),
      deployment_id: String(row.deployment_id),
      run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
      created_by: String(row.created_by),
      input: String(row.input),
      status: row.status as WorkStatus,
      output: row.output === null || row.output === undefined ? null : String(row.output),
      error: row.error === null || row.error === undefined ? null : String(row.error),
      failure_kind: (row.failure_kind ?? null) as WorkFailureKind | null,
      created_at: String(row.created_at),
      started_at: row.started_at === null || row.started_at === undefined ? null : String(row.started_at),
      ended_at: row.ended_at === null || row.ended_at === undefined ? null : String(row.ended_at),
      created_seq: asInt(row.created_seq),
    };
  }

  /**
   * Write the row, as `queued`, before anything leaves the process.
   *
   * §6.2, and it is the same discipline `eval_jobs` and `deployments` both hold: a dispatch
   * creates something in somebody else's account and can be interrupted at any point, so a record
   * that only appears on success turns a crash into money spent with nothing in Jaroku knowing it
   * was spent. The run id is minted by the caller and written HERE rather than patched in after
   * the POST, so the row is joinable to its trace from the instant it exists.
   *
   * `created_by` COMES FROM THE CONTEXT AND IS NOT A PARAMETER. It is the one column in this table
   * that exists to be true, and a caller that could pass it could pass somebody else's id — which
   * is precisely the attribution the column was added to make impossible to get wrong. A context
   * with no actor is a background job, and a background job has no business dispatching work here
   * (Part 3's scheduler carries the person who created the schedule; see §17.1), so it is refused
   * rather than written as null: the column is NOT NULL and a null would be a driver error at the
   * bottom of a stack instead of a sentence at the top of one.
   */
  async create(ctx: TenantContext, input: CreateWorkItem): Promise<WorkItem> {
    const bytes = Buffer.byteLength(input.input, "utf8");
    if (bytes > MAX_WORK_INPUT_BYTES) throw new WorkInputTooLarge(bytes);
    if (!ctx.actorUserId) {
      throw new Error("a work item has to be attributed to a person, and this request names none");
    }

    const at = input.at ?? nowIso();
    const row: WorkItem = {
      id: randomUUID(),
      agent_id: input.agentId,
      deployment_id: input.deploymentId,
      run_id: input.runId,
      created_by: ctx.actorUserId,
      input: input.input,
      status: "queued",
      output: null,
      error: null,
      failure_kind: null,
      created_at: at,
      started_at: null,
      ended_at: null,
      created_seq: 0,
    };

    // The sequence read and the insert are ONE TRANSACTION, for the reason `deployStore.create`
    // gives: two dispatches started together would otherwise read the same maximum and claim the
    // same position, which is exactly the tie `created_seq` exists to break — and this list is
    // ordered on every read the tab makes, so a coin flip there is rows moving under a cursor
    // while somebody is looking at them.
    await this.db.scoped(ctx.workspaceId, async (tx: Queryable) => {
      const top = await tx.get<{ n: unknown }>(
        `SELECT COALESCE(MAX(created_seq), 0) AS n FROM work_items WHERE workspace_id = ?`,
        [ctx.workspaceId],
      );
      row.created_seq = asInt(top?.n) + 1;
      await tx.run(
        `INSERT INTO work_items
           (id, workspace_id, agent_id, deployment_id, run_id, created_by, input, status,
            created_at, created_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        [
          row.id, ctx.workspaceId, row.agent_id, row.deployment_id, row.run_id, row.created_by,
          row.input, row.created_at, row.created_seq,
        ],
      );
    });
    return row;
  }

  /** One item, or undefined for an id this workspace does not own. The two are the same answer. */
  async get(ctx: TenantContext, id: string): Promise<WorkItem | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM work_items WHERE id = ? AND workspace_id = ?`,
      [id, ctx.workspaceId],
    );
    return row ? this.hydrate(row) : undefined;
  }

  /**
   * The item a trace event belongs to.
   *
   * THE LIFECYCLE'S ONE READ, and the reason it is by run id rather than by item id: what arrives
   * from a container is a run, and the run id is the only thing the two sides share. Scoped like
   * everything else — the run id in an event is text a container sent, and the ingest chain has
   * already reconciled it against the entry Jaroku registered, but a store that trusted it
   * unscoped would be the one place that reconciliation could be bypassed.
   */
  async byRun(ctx: TenantContext, runId: string): Promise<WorkItem | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM work_items WHERE run_id = ? AND workspace_id = ?`,
      [runId, ctx.workspaceId],
    );
    return row ? this.hydrate(row) : undefined;
  }

  /**
   * One keyset page of the work list, newest first.
   *
   * KEYSET AND NOT OFFSET, for the reason the runtime log window is a timestamp rather than a
   * page number: this list has rows inserted at its head while somebody is reading it, and an
   * OFFSET walks backwards through a moving window — showing a row twice, or skipping one that
   * arrived in between.
   *
   * THE TIE-BREAK IS IN THE CURSOR AS WELL AS IN THE ORDER. `(created_at, created_seq)` is what
   * makes the cursor total: two rows sharing a millisecond would otherwise be a boundary the
   * cursor cannot sit between, and the page after it would either repeat one or drop one.
   *
   * Written as `a < ? OR (a = ? AND b < ?)` rather than as a row-value comparison, which both
   * drivers do support: `(created_at, created_seq) < (?, ?)` makes Postgres infer the first
   * parameter's type from a row constructor, and `created_at` is `timestamptz` there and `TEXT`
   * on SQLite. The expanded form compares each column against a parameter the way every other
   * query in this codebase passes an instant, which is the form that is known to work on both.
   */
  async list(ctx: TenantContext, filters: ListWorkFilters = {}): Promise<WorkPage> {
    const limit = Math.min(Math.max(filters.limit ?? WORK_PAGE, 1), WORK_PAGE);
    const where: string[] = ["workspace_id = ?"];
    const params: unknown[] = [ctx.workspaceId];

    // "MINE" IS A FILTER, NOT A PERMISSION — §8. Anyone who can see the Cockpit sees the whole
    // workspace's work when they toggle; this narrows the DEFAULT view because the operator's
    // first question is about their own jobs. A context with no actor cannot narrow to itself, and
    // asking it to would silently return everything, so it falls through to the workspace.
    if (filters.scope !== "all" && ctx.actorUserId) {
      where.push("created_by = ?");
      params.push(ctx.actorUserId);
    }
    if (filters.status) {
      where.push("status = ?");
      params.push(filters.status);
    }
    if (filters.agentId) {
      where.push("agent_id = ?");
      params.push(filters.agentId);
    }
    const cursor = parseCursor(filters.cursor);
    if (cursor) {
      where.push("(created_at < ? OR (created_at = ? AND created_seq < ?))");
      params.push(cursor.at, cursor.at, cursor.seq);
    }

    // One row more than the page, so "is there another page" is answered by the read rather than
    // by a second COUNT that can disagree with it.
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM work_items
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, created_seq DESC
        LIMIT ?`,
      [...params, limit + 1],
    );
    const items = rows.slice(0, limit).map((r) => this.hydrate(r));
    const more = rows.length > limit;
    const last = items.at(-1);
    return {
      items,
      nextCursor: more && last ? `${last.created_at}|${last.created_seq}` : null,
    };
  }

  /**
   * How many items are in each status, for the whole workspace.
   *
   * ONE GROUPED QUERY RATHER THAN ONE PER STATUS, and that is the Agents grid's rule held here:
   * its statement count is asserted equal for one agent and for forty, and §16 asks explicitly
   * that the same line be held on this surface. The badge, the fleet cards and the filter rail
   * are all drawn from this one read.
   *
   * NOT NARROWED TO THE ACTOR. The badge counts `waiting` across the workspace, because a job
   * blocked on a human decision is blocked whoever typed it — and a badge that only counted your
   * own would go to zero while a colleague's job sat waiting for anybody to answer.
   */
  async countsByStatus(ctx: TenantContext): Promise<Record<WorkStatus, number>> {
    const rows = await this.q(ctx).all<{ status: string; n: unknown }>(
      `SELECT status, COUNT(*) AS n FROM work_items WHERE workspace_id = ? GROUP BY status`,
      [ctx.workspaceId],
    );
    const out = Object.fromEntries(WORK_STATUSES.map((s) => [s, 0])) as Record<WorkStatus, number>;
    for (const r of rows) if (isWorkStatus(r.status)) out[r.status] = asInt(r.n);
    return out;
  }

  /**
   * Per-agent counts of what is live and what is waiting, for the fleet strip's one sentence.
   *
   * ONE GROUPED QUERY, again, and for the same reason: a strip of twenty cards must not be twenty
   * reads. It returns only the agents that have something in flight — a card with nothing running
   * says "idle" and reads its figures from elsewhere, so a row of zeroes would be bytes crossing a
   * socket to say nothing.
   */
  async liveByAgent(ctx: TenantContext): Promise<{ agent_id: string; status: WorkStatus; count: number }[]> {
    const rows = await this.q(ctx).all<{ agent_id: string; status: string; n: unknown }>(
      `SELECT agent_id, status, COUNT(*) AS n
         FROM work_items
        WHERE workspace_id = ? AND status IN ('queued', 'running', 'waiting')
        GROUP BY agent_id, status`,
      [ctx.workspaceId],
    );
    return rows
      .filter((r) => isWorkStatus(r.status))
      .map((r) => ({ agent_id: String(r.agent_id), status: r.status as WorkStatus, count: asInt(r.n) }));
  }

  /**
   * How many jobs this workspace has in flight, for §6's concurrency cap.
   *
   * `waiting` IS COUNTED, and that is the decision worth stating: a job parked on a confirmation
   * is not consuming the container's own concurrency, so counting it makes Jaroku's cap slightly
   * tighter than the container's. That is the correct direction — the cap exists so Jaroku does
   * not manufacture the 429s it then retries — and the alternative lets a workspace with four
   * items waiting on a human dispatch four more that the container immediately refuses.
   */
  async inFlight(ctx: TenantContext): Promise<number> {
    const row = await this.q(ctx).get<{ n: unknown }>(
      `SELECT COUNT(*) AS n FROM work_items
        WHERE workspace_id = ? AND status IN ('queued', 'running', 'waiting')`,
      [ctx.workspaceId],
    );
    return asInt(row?.n);
  }

  /**
   * Items still in flight whose run has already ended. What a restart strands.
   *
   * THE SILENCE SWEEP CANNOT SEE THESE, and that is the whole reason this exists. `DeployRuns`
   * keeps its open runs in a `Map` in this process, and the reconciliation sweep is arithmetic over
   * that map — so a restart empties it, and an item that was in flight at the moment the process
   * died is never a candidate again. `reconcileInterruptedRuns` closes the RUN row at boot and
   * always has; nothing was carrying that across to the job, so the row read `running` forever.
   *
   * FOREVER IS NOT AN EXAGGERATION AND IT IS NOT COSMETIC: `inFlight` counts exactly these
   * statuses, so each stranded job permanently consumes one of the workspace's
   * `JAROKU_WORK_CONCURRENCY` slots. Four of them — the default — and that workspace can never
   * dispatch again, with nothing on screen explaining why.
   *
   * THE RULE IS THE RUN, NOT A CLOCK. An item whose run has ended while the item has not is
   * stranded by definition, whatever the reason, so this needs no ceiling to guess with and cannot
   * close a job whose container is still reporting. A `run_id` is null only between insert and
   * dispatch (§4), and those rows are deliberately excluded: nothing was ever started for them.
   *
   * LEFT JOIN, SO A MISSING RUN COUNTS AS ENDED. `work_items.run_id` is deliberately not a foreign
   * key — see migration 063 — so an item can outlive the run it names, and an inner join would
   * leave exactly those unsweepable forever. It also covers the rows this workspace cannot see the
   * run for at all: the trace of a deployed run was once filed in the server's own workspace
   * rather than the job's, and a scoped read must not reach across that boundary to find out.
   */
  async stranded(ctx: TenantContext): Promise<WorkItem[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${COLUMNS.split(",").map((c) => `w.${c.trim()}`).join(", ")}
         FROM work_items w
         LEFT JOIN runs r ON r.id = w.run_id AND r.workspace_id = w.workspace_id
        WHERE w.workspace_id = ?
          AND w.run_id IS NOT NULL
          AND w.status IN ('queued', 'running', 'waiting')
          AND (r.id IS NULL OR r.status <> 'running')`,
      [ctx.workspaceId],
    );
    return rows.map((r) => this.hydrate(r));
  }

  /**
   * The container accepted it. `queued` → `running`, and the clock starts.
   *
   * GUARDED ON THE STATUS IT IS LEAVING, like every transition below. A container can push its
   * `run_start` before this server has finished handling the 202 it just answered — the bus entry
   * is registered first precisely so that race is survivable — so an unguarded UPDATE could move a
   * job that had already reached `waiting` back to `running` and lose the fact that somebody is
   * being asked something.
   */
  async markRunning(ctx: TenantContext, id: string, at = nowIso()): Promise<boolean> {
    const res = await this.db.scoped(ctx.workspaceId, (tx) =>
      tx.run(
        `UPDATE work_items SET status = 'running', started_at = COALESCE(started_at, ?)
          WHERE id = ? AND workspace_id = ? AND status = 'queued'`,
        [at, id, ctx.workspaceId],
      ),
    );
    return res.changes > 0;
  }

  /** A person has to answer something. Reachable only from `running` — §6.5. */
  async markWaiting(ctx: TenantContext, id: string): Promise<boolean> {
    const res = await this.db.scoped(ctx.workspaceId, (tx) =>
      tx.run(
        `UPDATE work_items SET status = 'waiting'
          WHERE id = ? AND workspace_id = ? AND status = 'running'`,
        [id, ctx.workspaceId],
      ),
    );
    return res.changes > 0;
  }

  /**
   * They answered. `waiting` → `running`.
   *
   * THE ANSWER MOVES IT BACK WHETHER IT WAS ALLOW OR DENY, which looks wrong and is right: a
   * denied tool call is an answer, the graph continues with the refusal, and the run is executing
   * again. What ends the job is `run_end`, not the verdict.
   */
  async markResumed(ctx: TenantContext, id: string): Promise<boolean> {
    const res = await this.db.scoped(ctx.workspaceId, (tx) =>
      tx.run(
        `UPDATE work_items SET status = 'running'
          WHERE id = ? AND workspace_id = ? AND status = 'waiting'`,
        [id, ctx.workspaceId],
      ),
    );
    return res.changes > 0;
  }

  /**
   * The job is over, however it ended.
   *
   * IDEMPOTENT BY THE GUARD RATHER THAN BY A CHECK, because it is genuinely reachable twice: a
   * cancelled run emits a `run_end` for the cancellation, so the cancel path and the ingest path
   * both arrive here for the same item. The `status IN (…)` clause is what makes the second call a
   * no-op — and returning whether this call was the one that closed it lets a caller that must
   * broadcast exactly once still do so, which is the same shape `DeployRuns.close` takes.
   */
  async finish(ctx: TenantContext, id: string, outcome: FinishWorkItem): Promise<boolean> {
    const at = outcome.at ?? nowIso();
    // REDACTED AND BOUNDED HERE, BECAUSE THIS IS THE ONLY WRITER OF EITHER COLUMN. `output` is
    // what a model produced inside somebody's container and `error` is a traceback from a process
    // that had every credential the deploy handed it in its environment — so both are sinks in
    // exactly the sense a log is, and both outlive the job in a row that is broadcast to every
    // socket in the workspace. Doing it at the call sites would mean the next call site does not;
    // doing it at render time would leave the ROW holding the raw text. See `payload.ts`.
    const res = await this.db.scoped(ctx.workspaceId, (tx) =>
      tx.run(
        `UPDATE work_items
            SET status = ?, output = ?, error = ?, failure_kind = ?, ended_at = ?,
                started_at = COALESCE(started_at, ?)
          WHERE id = ? AND workspace_id = ?
            AND status IN ('queued', 'running', 'waiting')`,
        [
          outcome.status, boundOutput(outcome.output), boundError(outcome.error),
          outcome.failureKind ?? null, at, at, id, ctx.workspaceId,
        ],
      ),
    );
    return res.changes > 0;
  }

  /**
   * Attach a fresh run to an item that is being retried.
   *
   * A RETRY IS A NEW ROW, not a rewritten one — see `dispatcher.ts` — so this exists for the one
   * case where an id has to move: a dispatch that failed before the container accepted it leaves
   * a row whose `run_id` names a run that never started, and re-dispatching it mints another. It
   * is guarded on `queued` so it can never repoint a job that is executing, which would orphan a
   * live trace.
   */
  async attachRun(ctx: TenantContext, id: string, runId: string): Promise<boolean> {
    const res = await this.db.scoped(ctx.workspaceId, (tx) =>
      tx.run(
        `UPDATE work_items SET run_id = ?
          WHERE id = ? AND workspace_id = ? AND status = 'queued'`,
        [runId, id, ctx.workspaceId],
      ),
    );
    return res.changes > 0;
  }
}

/** `"<iso>|<seq>"`, or null for anything that is not one. A bad cursor reads as the first page. */
function parseCursor(cursor: string | null | undefined): { at: string; seq: number } | null {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 64) return null;
  const bar = cursor.lastIndexOf("|");
  if (bar <= 0) return null;
  const at = cursor.slice(0, bar);
  const seq = Number(cursor.slice(bar + 1));
  if (!Number.isFinite(seq) || !Number.isInteger(seq)) return null;
  // An unparseable instant would compare as a string against a `timestamptz` on Postgres and
  // raise, which is a 500 for a value that arrives off the wire.
  if (Number.isNaN(Date.parse(at))) return null;
  return { at, seq };
}
