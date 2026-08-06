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
import type { Run, Step } from "./types.ts";

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
  async insertStep(ctx: TenantContext, step: Step): Promise<void> {
    await this.q(ctx).run(
      `INSERT INTO steps
         (id, workspace_id, run_id, seq, type, name, input, output, state_before, state_after,
          tokens, cost, latency_ms, error, parent_step_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
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

  async close(): Promise<void> {
    await this.db.close();
  }
}
