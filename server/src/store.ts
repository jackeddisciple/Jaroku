// SQLite persistence for runs + steps (doc §5.2 trace store: SQLite -> Postgres later).
// Uses Node's built-in node:sqlite (no native build). JSON payload fields are stored as TEXT.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Run, Step } from "./types.ts";

// A run plus a cheap derived step count, for the sidebar history list. The frozen Run
// schema is unchanged — step_count is a read-side convenience, not part of the event schema.
export type RunSummary = Run & { step_count: number };

export class TraceStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
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
    // Additive migrations for existing DBs (debug depth — control-plane columns only; the frozen
    // event schema is untouched). `runs.parent_run_id` / `runs.branch_from_seq` land with
    // branching; `steps.checkpoint_id` correlates a step to the durable checkpoint after its node.
    this.ensureColumn("steps", "checkpoint_id", "TEXT");
    this.ensureColumn("runs", "parent_run_id", "TEXT");
    this.ensureColumn("runs", "branch_from_seq", "INTEGER");
  }

  // Idempotent ADD COLUMN — CREATE TABLE IF NOT EXISTS never alters an existing table.
  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  private static j(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    return JSON.stringify(v);
  }

  // Inverse of `j`. The payload columns are TEXT, so a row read straight back out carries
  // JSON *strings* where the Step schema promises parsed values — a step replayed from
  // history would then be a different shape than the same step streamed live. Parse on the
  // way out so both paths hand consumers identical objects.
  private static unj(v: unknown): unknown {
    if (typeof v !== "string") return v ?? null;
    try {
      return JSON.parse(v);
    } catch {
      return v; // Not JSON (shouldn't happen) — hand back the raw text rather than throw.
    }
  }

  private static hydrateStep(row: Record<string, unknown>): Step {
    return {
      ...row,
      input: TraceStore.unj(row["input"]),
      output: TraceStore.unj(row["output"]),
      state_before: TraceStore.unj(row["state_before"]),
      state_after: TraceStore.unj(row["state_after"]),
    } as Step;
  }

  // Insert (or replace, for the run_end update) a run.
  upsertRun(run: Run): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_id, provider, model, status, started_at, ended_at, cost, tokens, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status=excluded.status, ended_at=excluded.ended_at,
           cost=excluded.cost, tokens=excluded.tokens, error=excluded.error`,
      )
      .run(
        run.id, run.agent_id, run.provider, run.model, run.status,
        run.started_at, run.ended_at, run.cost, run.tokens, run.error,
      );
  }

  insertStep(step: Step): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO steps
           (id, run_id, seq, type, name, input, output, state_before, state_after,
            tokens, cost, latency_ms, error, parent_step_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        step.id, step.run_id, step.seq, step.type, step.name,
        TraceStore.j(step.input), TraceStore.j(step.output),
        TraceStore.j(step.state_before), TraceStore.j(step.state_after),
        step.tokens, step.cost, step.latency_ms, step.error,
        step.parent_step_id, step.started_at,
      );
  }

  listRuns(limit = 50): RunSummary[] {
    return this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM steps s WHERE s.run_id = r.id) AS step_count
         FROM runs r ORDER BY r.started_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as RunSummary[];
  }

  getRun(runId: string): Run | undefined {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as
      | Record<string, unknown>
      | undefined;
    return row as Run | undefined;
  }

  // Store-only status flip (e.g. 'running' -> 'paused' when a run halts at a boundary, or back to
  // 'running' on resume). NOT a frozen-event change — no run_end/run_start is emitted for a pause.
  setRunStatus(runId: string, status: string): void {
    this.db.prepare(`UPDATE runs SET status = ? WHERE id = ?`).run(status, runId);
  }

  // The run's current highest seq — the offset a resumed subprocess continues its timeline from.
  maxSeqForRun(runId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(seq) AS m FROM steps WHERE run_id = ?`)
      .get(runId) as { m: number | null };
    return row.m ?? -1;
  }

  // Correlate a boundary's checkpoint to the steps it covers (seq <= uptoSeq, not yet stamped),
  // so branching can later resume from the checkpoint that follows a chosen step's node.
  setCheckpointUpto(runId: string, uptoSeq: number, checkpointId: string): void {
    this.db
      .prepare(
        `UPDATE steps SET checkpoint_id = ?
         WHERE run_id = ? AND seq <= ? AND checkpoint_id IS NULL`,
      )
      .run(checkpointId, runId, uptoSeq);
  }

  // The node boundary a step belongs to: its checkpoint id (the durable checkpoint AFTER that
  // node) + the boundary's highest seq. Branching forks at a boundary, never mid-node, so a
  // branch's copied prefix always contains whole nodes. Returns null if the step isn't stamped.
  boundaryForStep(runId: string, seq: number): { checkpointId: string; seqHigh: number } | null {
    const row = this.db
      .prepare(`SELECT checkpoint_id FROM steps WHERE run_id = ? AND seq = ?`)
      .get(runId, seq) as { checkpoint_id: string | null } | undefined;
    if (!row?.checkpoint_id) return null;
    const hi = this.db
      .prepare(`SELECT MAX(seq) AS m FROM steps WHERE run_id = ? AND checkpoint_id = ?`)
      .get(runId, row.checkpoint_id) as { m: number };
    return { checkpointId: row.checkpoint_id, seqHigh: hi.m };
  }

  // Fork a run's history into a new branch run: copy the run row (new id, parentage, status
  // 'running') and steps 0..uptoSeq VERBATIM (payload TEXT copied as-is — no re-serialize),
  // minting fresh step ids and remapping parent_step_id so the branch's own step graph is intact.
  // The parent's rows are only read — the original stays byte-for-byte inspectable.
  copyRunPrefix(parentRunId: string, newRunId: string, uptoSeq: number, branchFromSeq: number): void {
    const parent = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(parentRunId) as
      | Record<string, unknown>
      | undefined;
    if (!parent) throw new Error(`copyRunPrefix: unknown parent run ${parentRunId}`);
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_id, provider, model, status, started_at, ended_at, cost,
           tokens, error, parent_run_id, branch_from_seq)
         VALUES (?, ?, ?, ?, 'running', ?, NULL, 0, 0, NULL, ?, ?)`,
      )
      .run(
        ...([newRunId, parent["agent_id"], parent["provider"], parent["model"],
          new Date().toISOString(), parentRunId, branchFromSeq] as SQLInputValue[]),
      );

    const rows = this.db
      .prepare(
        `SELECT * FROM steps WHERE run_id = ? AND seq <= ? ORDER BY seq ASC`,
      )
      .all(parentRunId, uptoSeq) as Record<string, unknown>[];

    const idMap = new Map<string, string>();
    for (const r of rows) idMap.set(r["id"] as string, randomUUID());

    const ins = this.db.prepare(
      `INSERT INTO steps
         (id, run_id, seq, type, name, input, output, state_before, state_after,
          tokens, cost, latency_ms, error, parent_step_id, started_at, checkpoint_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      const oldParent = r["parent_step_id"] as string | null;
      const newParent = oldParent ? idMap.get(oldParent) ?? null : null;
      ins.run(
        ...([idMap.get(r["id"] as string)!, newRunId, r["seq"], r["type"], r["name"],
          r["input"], r["output"], r["state_before"], r["state_after"],
          r["tokens"], r["cost"], r["latency_ms"], r["error"], newParent,
          r["started_at"], r["checkpoint_id"]] as SQLInputValue[]),
      );
    }
  }

  stepsForRun(runId: string): Step[] {
    const rows = this.db
      .prepare(`SELECT * FROM steps WHERE run_id = ? ORDER BY seq ASC`)
      .all(runId) as unknown as Record<string, unknown>[];
    return rows.map(TraceStore.hydrateStep);
  }

  close(): void {
    this.db.close();
  }
}
