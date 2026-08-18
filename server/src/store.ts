// Persistence for runs + steps (doc §5.2 trace store).
//
// Goes through the `Db` interface rather than a driver, so the same code runs on SQLite
// locally and Postgres hosted. JSON payload fields are stored as TEXT on one and `json` on
// the other; the hydration below is what keeps that difference invisible to everything above.
//
// EVERY METHOD TAKES A TenantContext FIRST, and every statement filters on it. That is not a
// convention with a comment behind it — it is the shape of the API, so a query that reaches
// these tables without a scope is one you cannot write by accident. Postgres RLS is the
// backstop for the times somebody manages it anyway; on SQLite, which has no RLS, this layer
// is the whole of the enforcement.
//
// AND workspace_id NEVER LEAVES. It is a storage column, the one documented exception to the
// frozen event schema, and it must not appear in an emitted event. The SELECTs below name
// their columns for exactly that reason: `SELECT *` puts it into the object handed to the
// broadcast, and the exception stops being one.

import { randomUUID } from "node:crypto";
import { asInt, asIntOrNull, jsonFromColumn, type Db, type Queryable } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";
import type { Run, Step, StepType } from "./types.ts";

// A run plus a cheap derived step count, for the sidebar history list. The frozen Run
// schema is unchanged — step_count is a read-side convenience, not part of the event schema.
export type RunSummary = Run & { step_count: number };

/**
 * The columns a Run is read as.
 *
 * Everything the frozen schema defines, plus the two control-plane columns branching added
 * (`parent_run_id`, `branch_from_seq`) which the sidebar already renders. What is absent is
 * `workspace_id`, and its absence is the point: this list IS the enforcement, not a comment
 * asking the payload not to carry it.
 */
export const RUN_COLUMNS = [
  "id", "agent_id", "provider", "model", "status", "started_at", "ended_at",
  "cost", "tokens", "error", "parent_run_id", "branch_from_seq",
] as const;

/** The same, for a Step. Again: no workspace_id. */
export const STEP_COLUMNS = [
  "id", "run_id", "seq", "type", "name", "input", "output", "state_before", "state_after",
  "tokens", "cost", "latency_ms", "error", "parent_step_id", "started_at", "checkpoint_id",
] as const;

const cols = (list: readonly string[], alias?: string): string =>
  list.map((c) => (alias ? `${alias}.${c}` : c)).join(", ");

export class TraceStore {
  constructor(private db: Db) {}

  /**
   * Compatibility fixes for a database that predates a column.
   *
   * The tables themselves come from migration 002 on both drivers now. What is left here is
   * the additive ALTERs that landed with branching, for a jaroku.db old enough to be missing
   * them and to have no migration row saying so. `CREATE TABLE IF NOT EXISTS` never alters an
   * existing table, which is why these could not simply be edited into the declaration.
   */
  async init(): Promise<void> {
    if (this.db.dialect !== "sqlite") return;
    await this.ensureColumn("steps", "checkpoint_id", "TEXT");
    await this.ensureColumn("runs", "parent_run_id", "TEXT");
    await this.ensureColumn("runs", "branch_from_seq", "INTEGER");
  }

  // Idempotent ADD COLUMN — CREATE TABLE IF NOT EXISTS never alters an existing table.
  private async ensureColumn(table: string, column: string, decl: string): Promise<void> {
    const existing = await this.db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!existing.some((c) => c.name === column)) {
      await this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  /**
   * The database, scoped to a request's workspace.
   *
   * Every read and write in this class goes through it, so on Postgres each statement carries
   * the SET LOCAL the RLS policies read. On SQLite it is the connection itself — no RLS to
   * scope — which is why the substitution is uniform and costs that driver nothing.
   */
  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  private static j(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    return JSON.stringify(v);
  }

  // Inverse of `j`, and the reason it takes the dialect rather than sniffing the value.
  //
  // On SQLite the payload columns are TEXT, so a row read straight back out carries JSON
  // *strings* where the Step schema promises parsed values — a step replayed from history
  // would then be a different shape than the same step streamed live. On Postgres the column
  // is `json` and the driver has already parsed it.
  //
  // Deciding between those by looking at the value is the trap: a payload that IS the JSON
  // string "123" comes back from Postgres as the JavaScript string `123`, and a parser that
  // re-parses every string it sees would hand the consumer the number. See jsonFromColumn.
  private hydrateStep(row: Record<string, unknown>): Step {
    const d = this.db.dialect;
    return {
      ...row,
      input: jsonFromColumn(d, row["input"]),
      output: jsonFromColumn(d, row["output"]),
      state_before: jsonFromColumn(d, row["state_before"]),
      state_after: jsonFromColumn(d, row["state_after"]),
    } as Step;
  }

  // Insert (or replace, for the run_end update) a run.
  //
  // The UPDATE half carries `AND workspace_id = ?` as well as matching on the primary key.
  // Not redundant: a run id is a uuid a client can send back, and without the scope a
  // `run_end` naming another workspace's run would overwrite its status and its cost.
  async upsertRun(ctx: TenantContext, run: Run): Promise<void> {
    await this.q(ctx).run(
      `INSERT INTO runs (id, workspace_id, agent_id, provider, model, status, started_at,
                         ended_at, cost, tokens, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status=excluded.status, ended_at=excluded.ended_at,
         cost=excluded.cost, tokens=excluded.tokens, error=excluded.error
       WHERE runs.workspace_id = ?`,
      [
        run.id, ctx.workspaceId, run.agent_id, run.provider, run.model, run.status,
        run.started_at, run.ended_at, run.cost, run.tokens, run.error,
        ctx.workspaceId,
      ],
    );
  }

  // ON CONFLICT DO NOTHING rather than SQLite's INSERT OR IGNORE: the same meaning, in the
  // spelling both dialects understand. A step arriving twice — a resumed segment replaying
  // its boundary, an at-least-once ingest — must be ignored, never duplicated.
  //
  // THE ARBITER IS `(id, started_at)` AND NOT `(id)`, which is not a widening of the dedup key
  // so much as the only one this table can offer. `steps` is partitioned by `started_at`, and
  // Postgres will not let a unique index on a partitioned table omit the partition key — so
  // there is no unique index on `id` alone for a conflict target to name, and Postgres does not
  // accept a prefix of a wider one (42P10, `infer_arbiter_indexes`). Migration 030 explains the
  // rest and adds the matching index on SQLite so this stays one statement.
  //
  // It still deduplicates what the ingest can actually produce: a redelivery replays the same
  // buffered event object, so `started_at` is byte-identical on the second attempt. What it
  // cannot do is stop one id from appearing twice under two different timestamps — those land in
  // different partitions and no index spans them. That is the price of partitioning on a value
  // the producer supplies, and it is paid for retention being a catalogue update.
  async insertStep(ctx: TenantContext, step: Step): Promise<void> {
    await this.q(ctx).run(
      `INSERT INTO steps
         (id, workspace_id, run_id, seq, type, name, input, output, state_before, state_after,
          tokens, cost, latency_ms, error, parent_step_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, started_at) DO NOTHING`,
      [
        step.id, ctx.workspaceId, step.run_id, step.seq, step.type, step.name,
        TraceStore.j(step.input), TraceStore.j(step.output),
        TraceStore.j(step.state_before), TraceStore.j(step.state_after),
        step.tokens, step.cost, step.latency_ms, step.error,
        step.parent_step_id, step.started_at,
      ],
    );
  }

  async listRuns(ctx: TenantContext, limit = 50): Promise<RunSummary[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${cols(RUN_COLUMNS, "r")},
              (SELECT COUNT(*) FROM steps s
                WHERE s.run_id = r.id AND s.workspace_id = r.workspace_id) AS step_count
         FROM runs r
        WHERE r.workspace_id = ?
        ORDER BY r.started_at DESC LIMIT ?`,
      [ctx.workspaceId, limit],
    );
    // COUNT is a bigint in Postgres and arrives as a string. The sidebar renders it.
    return rows.map((r) => ({ ...r, step_count: asInt(r["step_count"]) })) as unknown as RunSummary[];
  }

  /**
   * How every run in this workspace went, for §3.3's derivation.
   *
   * TWO QUERIES RATHER THAN ONE, and the second one's shape is the point. Every run's status is a
   * cheap read off `runs`. The count of FAILED STEPS is not: `steps` is the table this codebase
   * partitioned because it gets huge, and `error IS NOT NULL` is not indexed — so the second query
   * is driven from `runs.status = 'error'`, which is selective, and reaches `steps` through the
   * (workspace_id, run_id) index it already has. A query written the other way round would be a
   * scan of every step in the workspace every time somebody opens the Threads tab.
   *
   * Counted only for runs that ENDED in error, which is also what §3.3 means by "was not retried":
   * a run that recorded a failed step and then completed retried it, and surfacing that as blocked
   * work would put an amber ◆ on a thread whose problem solved itself.
   */
  async runOutcomes(
    ctx: TenantContext,
    /**
     * The runs actually asked about — the ones some thread owns.
     *
     * NARROWED AT THE QUERY RATHER THAN AT THE READER. The derivation only ever looks up runs that
     * appear in `thread_items`, and the caller has that list in hand already, so asking for every
     * run in the workspace was a full-table read and a `GROUP BY` over every errored run's steps on
     * every message, every run start and every thread command. An empty array means "none", which
     * is a real answer for a workspace whose threads own nothing yet; omitting it keeps the old
     * whole-workspace behaviour for callers that genuinely want it.
     *
     * Batched, because a parameter list has a limit on both drivers and a query that works until
     * the first workspace large enough to need it is worse than no optimisation at all.
     */
    runIds?: readonly string[],
  ): Promise<Map<string, { status: string; failedSteps: number }>> {
    const out = new Map<string, { status: string; failedSteps: number }>();
    if (runIds && runIds.length === 0) return out;

    const chunks: (readonly string[] | null)[] = runIds ? batches([...new Set(runIds)], 200) : [null];
    for (const chunk of chunks) {
      const filter = chunk ? ` AND id IN (${chunk.map(() => "?").join(", ")})` : "";
      const runs = await this.q(ctx).all<Record<string, unknown>>(
        `SELECT id, status FROM runs WHERE workspace_id = ?${filter}`,
        [ctx.workspaceId, ...(chunk ?? [])],
      );
      for (const r of runs) out.set(String(r["id"]), { status: String(r["status"]), failedSteps: 0 });

      const stepFilter = chunk ? ` AND r.id IN (${chunk.map(() => "?").join(", ")})` : "";
      const failed = await this.q(ctx).all<Record<string, unknown>>(
        `SELECT s.run_id AS run_id, COUNT(*) AS failed
           FROM runs r
           JOIN steps s ON s.workspace_id = r.workspace_id AND s.run_id = r.id
          WHERE r.workspace_id = ? AND r.status = 'error' AND s.error IS NOT NULL${stepFilter}
          GROUP BY s.run_id`,
        [ctx.workspaceId, ...(chunk ?? [])],
      );
      for (const f of failed) {
        const at = out.get(String(f["run_id"]));
        if (at) at.failedSteps = asInt(f["failed"]);
      }
    }
    return out;
  }

  async getRun(ctx: TenantContext, runId: string): Promise<Run | undefined> {
    return (await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${cols(RUN_COLUMNS)} FROM runs WHERE id = ? AND workspace_id = ?`,
      [runId, ctx.workspaceId],
    )) as Run | undefined;
  }

  // Store-only status flip (e.g. 'running' -> 'paused' when a run halts at a boundary, or back to
  // 'running' on resume). NOT a frozen-event change — no run_end/run_start is emitted for a pause.
  async setRunStatus(ctx: TenantContext, runId: string, status: string): Promise<void> {
    await this.q(ctx).run(`UPDATE runs SET status = ? WHERE id = ? AND workspace_id = ?`, [
      status,
      runId,
      ctx.workspaceId,
    ]);
  }

  /**
   * Close out runs a restart interrupted, in ONE workspace. Returns what it closed.
   *
   * A run is marked `running` by the process supervising its subprocess, and that subprocess
   * dies with the server. Nothing else ever revisits the row, so a crash mid-run left a run
   * spinning in the sidebar permanently — no end, no error, and no way for the user to clear
   * it. Interrupted evals and interrupted deployments were both already reconciled at boot;
   * the runs underneath them were the case nobody wrote.
   *
   * `paused` is deliberately excluded. It looks equally unfinished and is not: a run halted at
   * a boundary keeps its checkpoint precisely so it can be branched from later, which is why
   * the eval artifact sweep spares interactive checkpoints too. Failing it here would delete
   * the only reason it was kept.
   *
   * Safe at boot because the process has not started a run yet, so every `running` row it can
   * see belongs to an earlier life. That stops being true the day two replicas share a
   * database — the same caveat the eval and deploy reconciliations beside it already carry,
   * and the same place it has to be solved: a lease naming the process that owns the run.
   */
  async reconcileInterruptedRuns(ctx: TenantContext): Promise<string[]> {
    const rows = await this.q(ctx).all<{ id: string }>(
      `SELECT id FROM runs WHERE workspace_id = ? AND status = 'running'`,
      [ctx.workspaceId],
    );
    for (const r of rows) {
      await this.q(ctx).run(
        `UPDATE runs SET status = 'error', ended_at = ?, error = ?
          WHERE id = ? AND workspace_id = ? AND status = 'running'`,
        [new Date().toISOString(), "interrupted by a server restart", r.id, ctx.workspaceId],
      );
    }
    return rows.map((r) => r.id);
  }

  // A live cancellation (Session 5's cancelRun), not a restart reconciliation — the process is
  // about to be killed, not already gone, so this always writes rather than only touching rows
  // a restart found still marked 'running'. A hard kill never reaches the runner's own
  // run_end (SIGKILL leaves no chance to run its `finally`), so without this the row would
  // read 'running' forever — the same silence reconcileInterruptedRuns exists to close, just
  // triggered by a click instead of a restart.
  async markRunCancelled(ctx: TenantContext, runId: string): Promise<void> {
    await this.q(ctx).run(
      `UPDATE runs SET status = 'error', ended_at = ?, error = ?
        WHERE id = ? AND workspace_id = ? AND status != 'completed'`,
      [new Date().toISOString(), "cancelled by user", runId, ctx.workspaceId],
    );
  }

  // The run's current highest seq — the offset a resumed subprocess continues its timeline from.
  async maxSeqForRun(ctx: TenantContext, runId: string): Promise<number> {
    const row = await this.q(ctx).get<{ m: unknown }>(
      `SELECT MAX(seq) AS m FROM steps WHERE run_id = ? AND workspace_id = ?`,
      [runId, ctx.workspaceId],
    );
    return asIntOrNull(row?.m) ?? -1;
  }

  // Correlate a boundary's checkpoint to the steps it covers (seq <= uptoSeq, not yet stamped),
  // so branching can later resume from the checkpoint that follows a chosen step's node.
  async setCheckpointUpto(
    ctx: TenantContext,
    runId: string,
    uptoSeq: number,
    checkpointId: string,
  ): Promise<void> {
    await this.q(ctx).run(
      `UPDATE steps SET checkpoint_id = ?
        WHERE run_id = ? AND workspace_id = ? AND seq <= ? AND checkpoint_id IS NULL`,
      [checkpointId, runId, ctx.workspaceId, uptoSeq],
    );
  }

  // The node boundary a step belongs to: its checkpoint id (the durable checkpoint AFTER that
  // node) + the boundary's highest seq. Branching forks at a boundary, never mid-node, so a
  // branch's copied prefix always contains whole nodes. Returns null if the step isn't stamped.
  async boundaryForStep(
    ctx: TenantContext,
    runId: string,
    seq: number,
  ): Promise<{ checkpointId: string; seqHigh: number } | null> {
    const row = await this.q(ctx).get<{ checkpoint_id: string | null }>(
      `SELECT checkpoint_id FROM steps WHERE run_id = ? AND workspace_id = ? AND seq = ?`,
      [runId, ctx.workspaceId, seq],
    );
    if (!row?.checkpoint_id) return null;
    const hi = await this.q(ctx).get<{ m: unknown }>(
      `SELECT MAX(seq) AS m FROM steps WHERE run_id = ? AND workspace_id = ? AND checkpoint_id = ?`,
      [runId, ctx.workspaceId, row.checkpoint_id],
    );
    return { checkpointId: row.checkpoint_id, seqHigh: asInt(hi?.m) };
  }

  // Fork a run's history into a new branch run: copy the run row (new id, parentage, status
  // 'running') and steps 0..uptoSeq VERBATIM (payload copied as-is — no re-serialize),
  // minting fresh step ids and remapping parent_step_id so the branch's own step graph is intact.
  // The parent's rows are only read — the original stays byte-for-byte inspectable.
  //
  // In one transaction. That used to be free: the whole copy ran between two ticks of the
  // event loop and nothing could observe it half-done. It no longer is — every statement
  // awaits, so an ingest landing mid-copy would see a branch run whose steps are still
  // arriving, and a crash would leave one permanently. The transaction restores what the
  // synchronous version had rather than adding a guarantee it lacked.
  //
  // The branch lands in the SAME workspace as its parent, which is why the parent lookup is
  // scoped: branching from a run you cannot see should not be possible, and the alternative —
  // copying its rows into your own workspace — would be a way to read another tenant's trace
  // one branch at a time.
  async copyRunPrefix(
    ctx: TenantContext,
    parentRunId: string,
    newRunId: string,
    uptoSeq: number,
    branchFromSeq: number,
  ): Promise<void> {
    await this.db.scoped(ctx.workspaceId, async (tx: Queryable) => {
      const parent = await tx.get<Record<string, unknown>>(
        `SELECT ${cols(RUN_COLUMNS)} FROM runs WHERE id = ? AND workspace_id = ?`,
        [parentRunId, ctx.workspaceId],
      );
      if (!parent) throw new Error(`copyRunPrefix: unknown parent run ${parentRunId}`);
      await tx.run(
        `INSERT INTO runs (id, workspace_id, agent_id, provider, model, status, started_at,
           ended_at, cost, tokens, error, parent_run_id, branch_from_seq)
         VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, 0, 0, NULL, ?, ?)`,
        [
          newRunId, ctx.workspaceId, parent["agent_id"], parent["provider"], parent["model"],
          new Date().toISOString(), parentRunId, branchFromSeq,
        ],
      );

      const rows = await tx.all<Record<string, unknown>>(
        `SELECT ${cols(STEP_COLUMNS)} FROM steps
          WHERE run_id = ? AND workspace_id = ? AND seq <= ? ORDER BY seq ASC`,
        [parentRunId, ctx.workspaceId, uptoSeq],
      );

      const idMap = new Map<string, string>();
      for (const r of rows) idMap.set(r["id"] as string, randomUUID());

      for (const r of rows) {
        const oldParent = r["parent_step_id"] as string | null;
        const newParent = oldParent ? idMap.get(oldParent) ?? null : null;
        await tx.run(
          `INSERT INTO steps
             (id, workspace_id, run_id, seq, type, name, input, output, state_before,
              state_after, tokens, cost, latency_ms, error, parent_step_id, started_at,
              checkpoint_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            idMap.get(r["id"] as string)!, ctx.workspaceId, newRunId, r["seq"], r["type"],
            r["name"], r["input"], r["output"], r["state_before"], r["state_after"],
            r["tokens"], r["cost"], r["latency_ms"], r["error"], newParent,
            r["started_at"], r["checkpoint_id"],
          ],
        );
      }
    });
  }

  // The database itself, for sibling stores that live in the SAME one.
  //
  // The eval control plane, the MCP registry and the deploy records are separate, additive
  // tables beside the frozen ones — but they are in one database on one connection, not
  // three. Aggregation JOINs eval_jobs against `steps` directly, and two connections to the
  // same SQLite file would mean two writers racing for the write lock. Sharing keeps that a
  // single-writer problem. It does NOT make any of them part of the trace store.
  database(): Db {
    return this.db;
  }

  async stepsForRun(ctx: TenantContext, runId: string): Promise<Step[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${cols(STEP_COLUMNS)} FROM steps
        WHERE run_id = ? AND workspace_id = ? ORDER BY seq ASC`,
      [runId, ctx.workspaceId],
    );
    return rows.map((r) => this.hydrateStep(r));
  }

  /**
   * How many steps of one kind a run recorded.
   *
   * A COUNT rather than `stepsForRun(…).filter(…)`, because the caller that wants this is asking
   * a yes-or-no question about a run that may have emitted thousands of steps, and pulling every
   * payload across to count them is how a cheap check becomes an expensive one. Session 8's
   * miner detector is the caller: "held a sandbox for four minutes and called no model" is two
   * numbers, and this is the second of them.
   */
  async countSteps(ctx: TenantContext, runId: string, type: StepType): Promise<number> {
    const row = await this.q(ctx).get<{ n: unknown }>(
      `SELECT COUNT(*) AS n FROM steps WHERE run_id = ? AND workspace_id = ? AND type = ?`,
      [runId, ctx.workspaceId, type],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Everything the Agents grid reads out of `runs`, for every agent in the workspace, in two
   * statements that do not grow with the number of agents.
   *
   * TWO RATHER THAN FORTY, WHICH IS THE POINT (§7.2). The obvious version of this is a per-agent
   * count and a per-agent "last twenty" — and at forty agents that is eighty round trips on the path
   * a socket is waiting on, which is the N+1 the specification says will be instantly visible. Both
   * of these are GROUP BY / PARTITION BY over the same workspace-bounded scan `runs_ws_started`
   * already provides, so the cost is a function of how many runs a workspace has, not how many
   * agents it has.
   *
   * NO NEW INDEX BEHIND THEM, deliberately. `migrate:check` refuses an unqualified CREATE INDEX on
   * `runs` — building one takes a write lock for the whole build on the hottest write path in the
   * system, and a migration file cannot use CONCURRENTLY because the runner puts each file in one
   * transaction. `(workspace_id, started_at DESC)` bounds both scans to one workspace, which is the
   * same shape `spendByAgent` has always had.
   *
   * KEYED BY SLUG, because `runs.agent_id` is the slug: it predates migration 008 and still names the
   * directory a run's subprocess works in. The caller joins it to the uuid, which is where the two
   * names for an agent are already reconciled.
   *
   * `started_at` IS ISO-8601 TEXT and is compared as text, which is correct here and is worth saying
   * because migration 044 had to cast it. Every value this system writes is UTC `Z`-suffixed, so
   * lexicographic order is chronological order — and unlike 044 there is no COALESCE with a real
   * timestamp for Postgres to refuse to unify.
   */
  async agentRunFacts(
    ctx: TenantContext,
    /** The start of the 7-day window, ISO-8601. Everything at or after it counts. */
    since: string,
    /** How many recent runs per agent the sparkline draws. See agentHealth.OUTCOME_WINDOW. */
    window: number,
  ): Promise<Map<string, AgentRunFacts>> {
    const out = new Map<string, AgentRunFacts>();
    const at = (slug: string): AgentRunFacts => {
      const existing = out.get(slug);
      if (existing) return existing;
      const fresh: AgentRunFacts = {
        runs7d: 0, errors7d: 0, liveRuns: 0, pausedRuns: 0,
        lastRunAt: null, lastError: null, recent: [],
      };
      out.set(slug, fresh);
      return fresh;
    };

    // The counts. `runs7d` and `errors7d` are windowed; `liveRuns`, `pausedRuns` and `lastRunAt` are
    // not, because "is something running right now" and "when did this last do anything" are not
    // questions about the last seven days — an agent whose only run was a fortnight ago is Quiet and
    // still has a last-active date, and one paused for a fortnight is still paused.
    const counts = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT agent_id AS agent_id,
              COUNT(CASE WHEN started_at >= ? THEN 1 END) AS runs_7d,
              COUNT(CASE WHEN started_at >= ? AND status = 'error' THEN 1 END) AS errors_7d,
              COUNT(CASE WHEN status = 'running' THEN 1 END) AS live_runs,
              COUNT(CASE WHEN status = 'paused'  THEN 1 END) AS paused_runs,
              MAX(started_at) AS last_run_at
         FROM runs
        WHERE workspace_id = ?
        GROUP BY agent_id`,
      [since, since, ctx.workspaceId],
    );
    for (const row of counts) {
      const facts = at(String(row["agent_id"]));
      facts.runs7d = asInt(row["runs_7d"]);
      facts.errors7d = asInt(row["errors_7d"]);
      facts.liveRuns = asInt(row["live_runs"]);
      facts.pausedRuns = asInt(row["paused_runs"]);
      facts.lastRunAt = (row["last_run_at"] as string | null) ?? null;
    }

    // The last N per agent, as ONE window function rather than one query per agent. `node:sqlite` and
    // Postgres both support `ROW_NUMBER() OVER (PARTITION BY …)`, and this is the read that would
    // otherwise be the N+1 — §5.5's sparkline is on every card in the grid.
    //
    // THE OUTER SELECT NAMES ITS COLUMNS rather than `SELECT *`, for the reason RUN_COLUMNS exists:
    // `workspace_id` is a storage column and the one documented exception to the frozen event
    // schema, and a `*` here would put it into a payload that is broadcast.
    const recent = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT id, agent_id, status, started_at, ended_at, error FROM (
         SELECT id, agent_id, status, started_at, ended_at, error,
                ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY started_at DESC, id DESC) AS rn
           FROM runs
          WHERE workspace_id = ?
       ) ranked
        WHERE rn <= ?
        ORDER BY agent_id ASC, started_at ASC, id ASC`,
      [ctx.workspaceId, window],
    );
    for (const row of recent) {
      const facts = at(String(row["agent_id"]));
      const status = String(row["status"]);
      // OLDEST FIRST, because that is the order a sparkline is read in and the order `healthOf`
      // asks for — the ORDER BY above ascends deliberately, after the window has already taken the
      // newest N descending. Sorting the whole table ascending and taking the first N would take
      // the OLDEST twenty, which is the opposite list.
      facts.recent.push({
        runId: String(row["id"]),
        outcome:
          status === "error" ? "error"
            : status === "running" ? "running"
            : status === "paused" ? "paused"
            : "ok",
        startedAt: String(row["started_at"]),
        endedAt: (row["ended_at"] as string | null) ?? null,
      });
      // The newest error in the window, which is what "last error" means on a card. Assigned as the
      // ascending scan goes, so the last one written is the most recent.
      if (status === "error" && row["error"]) facts.lastError = String(row["error"]);
    }

    return out;
  }

  /**
   * The first failing step of each of these runs — §5.5's "a failed bar opens on the failing step".
   *
   * THE FIRST, NOT THE LAST. A failure usually cascades: a tool call raises, the router sends the
   * graph down an error branch, and the node after that fails for want of what the first one did not
   * produce. What somebody clicking a red bar wants is where it went wrong, which is the first one;
   * the ones after it are consequences and are visible in the trace beside it anyway.
   *
   * ONE QUERY FOR EVERY RED BAR IN THE GRID, batched. The grid can carry twenty bars per card, so a
   * per-bar lookup would be the N+1 at its worst — and it is asked only for the runs that failed,
   * which in a healthy workspace is none.
   */
  async firstFailedStepFor(ctx: TenantContext, runIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (runIds.length === 0) return out;
    for (const chunk of batches([...new Set(runIds)], 200)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = await this.q(ctx).all<Record<string, unknown>>(
        `SELECT run_id, id FROM (
           SELECT run_id, id, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY seq ASC) AS rn
             FROM steps
            WHERE workspace_id = ? AND error IS NOT NULL AND run_id IN (${placeholders})
         ) ranked
          WHERE rn = 1`,
        [ctx.workspaceId, ...chunk],
      );
      for (const row of rows) out.set(String(row["run_id"]), String(row["id"]));
    }
    return out;
  }

  /** How many runs one agent has started since a moment. The denominator for a cost per run. */
  async runCountSince(ctx: TenantContext, agentSlug: string, since: string): Promise<number> {
    const row = await this.q(ctx).get<{ n: unknown }>(
      `SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ? AND agent_id = ? AND started_at >= ?`,
      [ctx.workspaceId, agentSlug, since],
    );
    return asInt(row?.n, 0);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/** One recent run, as the Agents card's sparkline draws it and clicks through to it (§5.5). */
export interface RecentRun {
  runId: string;
  outcome: "ok" | "error" | "running" | "paused";
  startedAt: string;
  /** Null while a run is still going, which is what makes its duration unknown rather than zero. */
  endedAt: string | null;
}

/** What one agent's runs say about it. See `TraceStore.agentRunFacts`. */
export interface AgentRunFacts {
  runs7d: number;
  errors7d: number;
  liveRuns: number;
  pausedRuns: number;
  lastRunAt: string | null;
  /** The message of the most recent failure in the window, or null. */
  lastError: string | null;
  /** The last ~20, OLDEST FIRST — the order the sparkline is drawn and read in. */
  recent: RecentRun[];
}

/** Split a list into chunks a parameter list can carry on both drivers. */
function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
