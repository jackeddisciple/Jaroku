// Persistence for runs + steps (doc §5.2 trace store).
//
// Goes through the `Db` interface rather than a driver, so the same code runs on SQLite
// locally and Postgres hosted. JSON payload fields are stored as TEXT on one and `json` on
// the other; the hydration below is what keeps that difference invisible to everything above.

import { randomUUID } from "node:crypto";
import { asInt, asIntOrNull, jsonFromColumn, type Db, type Queryable } from "./db/db.ts";
import type { Run, Step } from "./types.ts";

// A run plus a cheap derived step count, for the sidebar history list. The frozen Run
// schema is unchanged — step_count is a read-side convenience, not part of the event schema.
export type RunSummary = Run & { step_count: number };

export class TraceStore {
  constructor(private db: Db) {}

  /**
   * Declare the tables this store owns.
   *
   * Separate from the constructor because it writes, and writing is asynchronous now. Only
   * SQLite does this: on Postgres the schema comes from the numbered migrations, all the
   * way down, and a store creating its own tables there would be a second source of truth
   * for what the schema is.
   */
  async init(): Promise<void> {
    if (this.db.dialect !== "sqlite") return;
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        provider    TEXT NOT NULL,
        model       TEXT NOT NULL,
        status      TEXT NOT NULL,
        started_at  TEXT NOT NULL,
        ended_at    TEXT,
        cost        REAL NOT NULL DEFAULT 0,
        tokens      INTEGER NOT NULL DEFAULT 0,
        error       TEXT
      );
      CREATE TABLE IF NOT EXISTS steps (
        id             TEXT PRIMARY KEY,
        run_id         TEXT NOT NULL,
        seq            INTEGER NOT NULL,
        type           TEXT NOT NULL,
        name           TEXT NOT NULL,
        input          TEXT,
        output         TEXT,
        state_before   TEXT,
        state_after    TEXT,
        tokens         INTEGER,
        cost           REAL,
        latency_ms     REAL NOT NULL DEFAULT 0,
        error          TEXT,
        parent_step_id TEXT,
        started_at     TEXT NOT NULL,
        checkpoint_id  TEXT,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_steps_run_seq ON steps(run_id, seq);
    `);
    // Additive migrations for existing DBs (debug depth — control-plane columns only; the
    // frozen event schema is untouched). `runs.parent_run_id` / `runs.branch_from_seq` land
    // with branching; `steps.checkpoint_id` correlates a step to the durable checkpoint
    // after its node. These predate the migration runner and stay here rather than becoming
    // migrations, because a database that already has them has no row saying so.
    await this.ensureColumn("steps", "checkpoint_id", "TEXT");
    await this.ensureColumn("runs", "parent_run_id", "TEXT");
    await this.ensureColumn("runs", "branch_from_seq", "INTEGER");
  }

  // Idempotent ADD COLUMN — CREATE TABLE IF NOT EXISTS never alters an existing table.
  private async ensureColumn(table: string, column: string, decl: string): Promise<void> {
    const cols = await this.db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!cols.some((c) => c.name === column)) {
      await this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
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
  async upsertRun(run: Run): Promise<void> {
    await this.db.run(
      `INSERT INTO runs (id, agent_id, provider, model, status, started_at, ended_at, cost, tokens, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status=excluded.status, ended_at=excluded.ended_at,
         cost=excluded.cost, tokens=excluded.tokens, error=excluded.error`,
      [
        run.id, run.agent_id, run.provider, run.model, run.status,
        run.started_at, run.ended_at, run.cost, run.tokens, run.error,
      ],
    );
  }

  // ON CONFLICT DO NOTHING rather than SQLite's INSERT OR IGNORE: the same meaning, in the
  // spelling both dialects understand. A step arriving twice — a resumed segment replaying
  // its boundary, an at-least-once ingest — must be ignored, never duplicated.
  async insertStep(step: Step): Promise<void> {
    await this.db.run(
      `INSERT INTO steps
         (id, run_id, seq, type, name, input, output, state_before, state_after,
          tokens, cost, latency_ms, error, parent_step_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [
        step.id, step.run_id, step.seq, step.type, step.name,
        TraceStore.j(step.input), TraceStore.j(step.output),
        TraceStore.j(step.state_before), TraceStore.j(step.state_after),
        step.tokens, step.cost, step.latency_ms, step.error,
        step.parent_step_id, step.started_at,
      ],
    );
  }

  async listRuns(limit = 50): Promise<RunSummary[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT r.*, (SELECT COUNT(*) FROM steps s WHERE s.run_id = r.id) AS step_count
       FROM runs r ORDER BY r.started_at DESC LIMIT ?`,
      [limit],
    );
    // COUNT is a bigint in Postgres and arrives as a string. The sidebar renders it.
    return rows.map((r) => ({ ...r, step_count: asInt(r["step_count"]) })) as unknown as RunSummary[];
  }

  async getRun(runId: string): Promise<Run | undefined> {
    return (await this.db.get<Record<string, unknown>>(`SELECT * FROM runs WHERE id = ?`, [runId])) as
      | Run
      | undefined;
  }

  // Store-only status flip (e.g. 'running' -> 'paused' when a run halts at a boundary, or back to
  // 'running' on resume). NOT a frozen-event change — no run_end/run_start is emitted for a pause.
  async setRunStatus(runId: string, status: string): Promise<void> {
    await this.db.run(`UPDATE runs SET status = ? WHERE id = ?`, [status, runId]);
  }

  // The run's current highest seq — the offset a resumed subprocess continues its timeline from.
  async maxSeqForRun(runId: string): Promise<number> {
    const row = await this.db.get<{ m: unknown }>(`SELECT MAX(seq) AS m FROM steps WHERE run_id = ?`, [runId]);
    return asIntOrNull(row?.m) ?? -1;
  }

  // Correlate a boundary's checkpoint to the steps it covers (seq <= uptoSeq, not yet stamped),
  // so branching can later resume from the checkpoint that follows a chosen step's node.
  async setCheckpointUpto(runId: string, uptoSeq: number, checkpointId: string): Promise<void> {
    await this.db.run(
      `UPDATE steps SET checkpoint_id = ?
       WHERE run_id = ? AND seq <= ? AND checkpoint_id IS NULL`,
      [checkpointId, runId, uptoSeq],
    );
  }

  // The node boundary a step belongs to: its checkpoint id (the durable checkpoint AFTER that
  // node) + the boundary's highest seq. Branching forks at a boundary, never mid-node, so a
  // branch's copied prefix always contains whole nodes. Returns null if the step isn't stamped.
  async boundaryForStep(runId: string, seq: number): Promise<{ checkpointId: string; seqHigh: number } | null> {
    const row = await this.db.get<{ checkpoint_id: string | null }>(
      `SELECT checkpoint_id FROM steps WHERE run_id = ? AND seq = ?`,
      [runId, seq],
    );
    if (!row?.checkpoint_id) return null;
    const hi = await this.db.get<{ m: unknown }>(
      `SELECT MAX(seq) AS m FROM steps WHERE run_id = ? AND checkpoint_id = ?`,
      [runId, row.checkpoint_id],
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
  async copyRunPrefix(
    parentRunId: string,
    newRunId: string,
    uptoSeq: number,
    branchFromSeq: number,
  ): Promise<void> {
    await this.db.transaction(async (tx: Queryable) => {
      const parent = await tx.get<Record<string, unknown>>(`SELECT * FROM runs WHERE id = ?`, [parentRunId]);
      if (!parent) throw new Error(`copyRunPrefix: unknown parent run ${parentRunId}`);
      await tx.run(
        `INSERT INTO runs (id, agent_id, provider, model, status, started_at, ended_at, cost,
           tokens, error, parent_run_id, branch_from_seq)
         VALUES (?, ?, ?, ?, 'running', ?, NULL, 0, 0, NULL, ?, ?)`,
        [
          newRunId, parent["agent_id"], parent["provider"], parent["model"],
          new Date().toISOString(), parentRunId, branchFromSeq,
        ],
      );

      const rows = await tx.all<Record<string, unknown>>(
        `SELECT * FROM steps WHERE run_id = ? AND seq <= ? ORDER BY seq ASC`,
        [parentRunId, uptoSeq],
      );

      const idMap = new Map<string, string>();
      for (const r of rows) idMap.set(r["id"] as string, randomUUID());

      for (const r of rows) {
        const oldParent = r["parent_step_id"] as string | null;
        const newParent = oldParent ? idMap.get(oldParent) ?? null : null;
        await tx.run(
          `INSERT INTO steps
             (id, run_id, seq, type, name, input, output, state_before, state_after,
              tokens, cost, latency_ms, error, parent_step_id, started_at, checkpoint_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            idMap.get(r["id"] as string)!, newRunId, r["seq"], r["type"], r["name"],
            r["input"], r["output"], r["state_before"], r["state_after"],
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

  async stepsForRun(runId: string): Promise<Step[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT * FROM steps WHERE run_id = ? ORDER BY seq ASC`,
      [runId],
    );
    return rows.map((r) => this.hydrateStep(r));
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
