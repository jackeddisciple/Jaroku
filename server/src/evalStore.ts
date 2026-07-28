// Eval Engine data model (doc §6.4) — additive control-plane tables only.
//
// THE FROZEN SCHEMA IS UNTOUCHED. schema/events.md v1 stays exactly as it is, and an eval
// is not a new event type: it is a BATCH OF ORDINARY RUNS. Every job in an eval executes
// through the same ProcessManager -> jaroku_runner -> JarokuTracer -> TraceStore path as a
// run the user triggers by hand, and produces the same Run/Step rows. `eval_jobs.run_id`
// is a plain foreign key into `runs.id` — that FK is the entire integration surface.
//
// This is the same discipline as pause/resume/branch (store.ts:56-62): when eval needed
// data the frozen schema doesn't carry, it went into new tables beside it, never into the
// event shape.
//
// Two modelling decisions worth stating up front, because both exist to keep cost honest:
//
//   * `eval_jobs` rows are written BEFORE dispatch, not after completion. A queue that
//     only exists in memory turns a server restart mid-eval into orphaned runs that
//     already cost money with nothing recording that they were part of anything. Rows
//     first means an interrupted eval is a recoverable eval.
//
//   * Per-job cost is a column here, not a read-through to `runs.cost`. `runs.cost` is
//     only written on run_end, so a run that crashes mid-flight reports 0 despite having
//     really spent — see aggregation (commit 9), which sums `steps.cost` instead. The
//     column also carries `cost_complete`, because "we know this cost $0.04" and "we
//     couldn't price some of these steps" are different claims and the dashboard has to
//     be able to tell them apart.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";

// --- row shapes --------------------------------------------------------------

export interface Dataset {
  id: string;
  agent_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export type DatasetSummary = Dataset & { example_count: number };

export interface DatasetExample {
  id: string;
  dataset_id: string;
  /** The agent's runtime input — exactly what Test mode would send. */
  input: string;
  /** Optional ground truth, handed to the judge as reference when present. */
  expected: string | null;
  notes: string | null;
  position: number;
  created_at: string;
}

/** One scored dimension. Editable — the rubric is product surface, not a constant. */
export interface RubricCriterion {
  id: string;
  label: string;
  /** What the judge is being asked. Full sentences; this goes into the prompt verbatim. */
  description: string;
  /** Relative weight in the overall score. */
  weight: number;
}

export interface Rubric {
  id: string;
  /** null = the built-in default, shared by every dataset that hasn't customized one. */
  dataset_id: string | null;
  name: string;
  criteria: RubricCriterion[];
  created_at: string;
  updated_at: string;
}

/** One (provider, model) leg of an eval. */
export interface EvalTarget {
  provider: string;
  model: string;
}

export type EvalRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "aborted_over_budget"
  | "cancelled"
  | "error";

export interface EvalRun {
  id: string;
  dataset_id: string;
  agent_id: string;
  rubric_id: string;
  status: EvalRunStatus;
  /** The (provider, model) legs this eval fans out across. */
  targets: EvalTarget[];
  /** Hard USD ceiling on TRUE SPEND, or null for no ceiling. Enforced before dispatch. */
  budget_usd: number | null;
  /** Accumulated judge spend. Eval overhead — never attributed to a provider's cost. */
  judge_cost_usd: number;
  started_at: string;
  ended_at: string | null;
  error: string | null;
}

export type EvalJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface EvalJob {
  id: string;
  eval_id: string;
  example_id: string;
  provider: string;
  model: string;
  status: EvalJobStatus;
  /** 0 on first dispatch; incremented per retry. Every attempt spent money. */
  attempt: number;
  /** FK -> runs.id. Null until dispatched. This is the whole integration with the trace. */
  run_id: string | null;
  /** SUM(steps.cost) for the run — null when the model is unpriced ("cost unknown"). */
  cost_usd: number | null;
  tokens: number | null;
  latency_ms: number | null;
  /** 0 when some llm_call step had tokens but no cost — the total is an UNDERCOUNT. */
  cost_complete: number;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface EvalScore {
  id: string;
  job_id: string;
  /** 0..1 weighted overall, or null when the judge failed — "unscored", not "scored 0". */
  score: number | null;
  /** Per-criterion breakdown, keyed by RubricCriterion.id. */
  per_criterion: Record<string, number> | null;
  rationale: string | null;
  judge_model: string | null;
  judge_cost_usd: number | null;
  error: string | null;
  created_at: string;
}

// --- store -------------------------------------------------------------------

const nowIso = (): string => new Date().toISOString();

export class EvalStore {
  // Shares TraceStore's handle: same file, single writer, and aggregation can JOIN
  // eval_jobs against the frozen `steps` table. See TraceStore.connection().
  constructor(private db: DatabaseSync) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dataset_examples (
        id          TEXT PRIMARY KEY,
        dataset_id  TEXT NOT NULL,
        input       TEXT NOT NULL,
        expected    TEXT,
        notes       TEXT,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        FOREIGN KEY (dataset_id) REFERENCES datasets(id)
      );
      CREATE TABLE IF NOT EXISTS rubrics (
        id          TEXT PRIMARY KEY,
        dataset_id  TEXT,
        name        TEXT NOT NULL,
        criteria    TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS eval_runs (
        id             TEXT PRIMARY KEY,
        dataset_id     TEXT NOT NULL,
        agent_id       TEXT NOT NULL,
        rubric_id      TEXT NOT NULL,
        status         TEXT NOT NULL,
        targets        TEXT NOT NULL,
        budget_usd     REAL,
        judge_cost_usd REAL NOT NULL DEFAULT 0,
        started_at     TEXT NOT NULL,
        ended_at       TEXT,
        error          TEXT
      );
      CREATE TABLE IF NOT EXISTS eval_jobs (
        id            TEXT PRIMARY KEY,
        eval_id       TEXT NOT NULL,
        example_id    TEXT NOT NULL,
        provider      TEXT NOT NULL,
        model         TEXT NOT NULL,
        status        TEXT NOT NULL,
        attempt       INTEGER NOT NULL DEFAULT 0,
        run_id        TEXT,
        cost_usd      REAL,
        tokens        INTEGER,
        latency_ms    REAL,
        cost_complete INTEGER NOT NULL DEFAULT 1,
        error         TEXT,
        started_at    TEXT,
        ended_at      TEXT,
        FOREIGN KEY (eval_id) REFERENCES eval_runs(id),
        FOREIGN KEY (example_id) REFERENCES dataset_examples(id)
      );
      CREATE TABLE IF NOT EXISTS eval_scores (
        id             TEXT PRIMARY KEY,
        job_id         TEXT NOT NULL UNIQUE,
        score          REAL,
        per_criterion  TEXT,
        rationale      TEXT,
        judge_model    TEXT,
        judge_cost_usd REAL,
        error          TEXT,
        created_at     TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES eval_jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_examples_dataset ON dataset_examples(dataset_id, position);
      CREATE INDEX IF NOT EXISTS idx_datasets_agent   ON datasets(agent_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_eval        ON eval_jobs(eval_id, status);
      CREATE INDEX IF NOT EXISTS idx_jobs_run         ON eval_jobs(run_id);
      CREATE INDEX IF NOT EXISTS idx_rubrics_dataset  ON rubrics(dataset_id);
    `);
  }

  private static parseJson<T>(v: unknown, fallback: T): T {
    if (typeof v !== "string") return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }

  // --- datasets --------------------------------------------------------------

  createDataset(agentId: string, name: string): Dataset {
    const row: Dataset = {
      id: randomUUID(),
      agent_id: agentId,
      name: name.trim() || "Untitled dataset",
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.db
      .prepare(`INSERT INTO datasets (id, agent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(row.id, row.agent_id, row.name, row.created_at, row.updated_at);
    return row;
  }

  renameDataset(datasetId: string, name: string): void {
    this.db
      .prepare(`UPDATE datasets SET name = ?, updated_at = ? WHERE id = ?`)
      .run(name, nowIso(), datasetId);
  }

  /** Datasets for one agent (or all, when agentId is omitted), newest first. */
  listDatasets(agentId?: string): DatasetSummary[] {
    const where = agentId ? `WHERE d.agent_id = ?` : ``;
    const args: SQLInputValue[] = agentId ? [agentId] : [];
    return this.db
      .prepare(
        `SELECT d.*, (SELECT COUNT(*) FROM dataset_examples e WHERE e.dataset_id = d.id) AS example_count
         FROM datasets d ${where} ORDER BY d.created_at DESC`,
      )
      .all(...args) as unknown as DatasetSummary[];
  }

  getDataset(datasetId: string): Dataset | undefined {
    return this.db.prepare(`SELECT * FROM datasets WHERE id = ?`).get(datasetId) as Dataset | undefined;
  }

  /** Deletes the dataset and its examples. Eval history that referenced it is left intact
   *  — a past comparison stays readable even after its dataset is gone. */
  deleteDataset(datasetId: string): void {
    this.db.prepare(`DELETE FROM dataset_examples WHERE dataset_id = ?`).run(datasetId);
    this.db.prepare(`DELETE FROM datasets WHERE id = ?`).run(datasetId);
  }

  // --- examples --------------------------------------------------------------

  addExample(datasetId: string, input: string, expected?: string | null, notes?: string | null): DatasetExample {
    const next = this.db
      .prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM dataset_examples WHERE dataset_id = ?`)
      .get(datasetId) as { p: number };
    const row: DatasetExample = {
      id: randomUUID(),
      dataset_id: datasetId,
      input,
      expected: expected ?? null,
      notes: notes ?? null,
      position: next.p,
      created_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO dataset_examples (id, dataset_id, input, expected, notes, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.dataset_id, row.input, row.expected, row.notes, row.position, row.created_at);
    this.db.prepare(`UPDATE datasets SET updated_at = ? WHERE id = ?`).run(row.created_at, datasetId);
    return row;
  }

  updateExample(exampleId: string, patch: { input?: string; expected?: string | null; notes?: string | null }): void {
    const sets: string[] = [];
    const args: SQLInputValue[] = [];
    if (patch.input !== undefined) { sets.push("input = ?"); args.push(patch.input); }
    if (patch.expected !== undefined) { sets.push("expected = ?"); args.push(patch.expected); }
    if (patch.notes !== undefined) { sets.push("notes = ?"); args.push(patch.notes); }
    if (!sets.length) return;
    args.push(exampleId);
    this.db.prepare(`UPDATE dataset_examples SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  deleteExample(exampleId: string): void {
    this.db.prepare(`DELETE FROM dataset_examples WHERE id = ?`).run(exampleId);
  }

  /** Whether this exact input is already in the dataset. Promotion uses it to avoid
   *  silently doubling the cost of an eval by adding the same case twice. */
  hasExampleWithInput(datasetId: string, input: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS x FROM dataset_examples WHERE dataset_id = ? AND input = ? LIMIT 1`)
      .get(datasetId, input) as { x: number } | undefined;
    return row !== undefined;
  }

  /** The dataset a one-click promotion should land in: the agent's most recently touched
   *  one, or a new default. Server-side so promotion stays a single round trip — a client
   *  can't create-then-add without waiting to learn the new id. */
  defaultDatasetFor(agentId: string, agentName?: string): Dataset {
    const row = this.db
      .prepare(`SELECT * FROM datasets WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(agentId) as Dataset | undefined;
    return row ?? this.createDataset(agentId, `${agentName ?? agentId} tests`);
  }

  listExamples(datasetId: string): DatasetExample[] {
    return this.db
      .prepare(`SELECT * FROM dataset_examples WHERE dataset_id = ? ORDER BY position ASC`)
      .all(datasetId) as unknown as DatasetExample[];
  }

  getExample(exampleId: string): DatasetExample | undefined {
    return this.db.prepare(`SELECT * FROM dataset_examples WHERE id = ?`).get(exampleId) as
      | DatasetExample
      | undefined;
  }

  // --- rubrics ---------------------------------------------------------------

  private static hydrateRubric(row: Record<string, unknown>): Rubric {
    return { ...row, criteria: EvalStore.parseJson<RubricCriterion[]>(row["criteria"], []) } as Rubric;
  }

  /** Insert or replace a rubric. `dataset_id: null` is the shared built-in default. */
  putRubric(r: { id?: string; dataset_id: string | null; name: string; criteria: RubricCriterion[] }): Rubric {
    const existing = r.id ? this.getRubric(r.id) : undefined;
    const row: Rubric = {
      id: r.id ?? randomUUID(),
      dataset_id: r.dataset_id,
      name: r.name,
      criteria: r.criteria,
      created_at: existing?.created_at ?? nowIso(),
      updated_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO rubrics (id, dataset_id, name, criteria, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           dataset_id=excluded.dataset_id, name=excluded.name,
           criteria=excluded.criteria, updated_at=excluded.updated_at`,
      )
      .run(row.id, row.dataset_id, row.name, JSON.stringify(row.criteria), row.created_at, row.updated_at);
    return row;
  }

  getRubric(rubricId: string): Rubric | undefined {
    const row = this.db.prepare(`SELECT * FROM rubrics WHERE id = ?`).get(rubricId) as
      | Record<string, unknown>
      | undefined;
    return row ? EvalStore.hydrateRubric(row) : undefined;
  }

  /** The rubric a dataset scores against, if it has customized one. */
  rubricForDataset(datasetId: string): Rubric | undefined {
    const row = this.db
      .prepare(`SELECT * FROM rubrics WHERE dataset_id = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(datasetId) as Record<string, unknown> | undefined;
    return row ? EvalStore.hydrateRubric(row) : undefined;
  }

  // --- eval runs -------------------------------------------------------------

  private static hydrateEvalRun(row: Record<string, unknown>): EvalRun {
    return { ...row, targets: EvalStore.parseJson<EvalTarget[]>(row["targets"], []) } as EvalRun;
  }

  createEvalRun(r: {
    id?: string;
    dataset_id: string;
    agent_id: string;
    rubric_id: string;
    targets: EvalTarget[];
    budget_usd: number | null;
  }): EvalRun {
    const row: EvalRun = {
      id: r.id ?? randomUUID(),
      dataset_id: r.dataset_id,
      agent_id: r.agent_id,
      rubric_id: r.rubric_id,
      status: "queued",
      targets: r.targets,
      budget_usd: r.budget_usd,
      judge_cost_usd: 0,
      started_at: nowIso(),
      ended_at: null,
      error: null,
    };
    this.db
      .prepare(
        `INSERT INTO eval_runs (id, dataset_id, agent_id, rubric_id, status, targets,
           budget_usd, judge_cost_usd, started_at, ended_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL)`,
      )
      .run(
        row.id, row.dataset_id, row.agent_id, row.rubric_id, row.status,
        JSON.stringify(row.targets), row.budget_usd, row.started_at,
      );
    return row;
  }

  setEvalStatus(evalId: string, status: EvalRunStatus, error?: string | null): void {
    const ended = status === "queued" || status === "running" ? null : nowIso();
    this.db
      .prepare(`UPDATE eval_runs SET status = ?, ended_at = COALESCE(?, ended_at), error = ? WHERE id = ?`)
      .run(status, ended, error ?? null, evalId);
  }

  /** Accumulate judge spend. Separate from any provider's agent cost by design. */
  addJudgeCost(evalId: string, usd: number): void {
    this.db
      .prepare(`UPDATE eval_runs SET judge_cost_usd = judge_cost_usd + ? WHERE id = ?`)
      .run(usd, evalId);
  }

  getEvalRun(evalId: string): EvalRun | undefined {
    const row = this.db.prepare(`SELECT * FROM eval_runs WHERE id = ?`).get(evalId) as
      | Record<string, unknown>
      | undefined;
    return row ? EvalStore.hydrateEvalRun(row) : undefined;
  }

  listEvalRuns(limit = 50): EvalRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM eval_runs ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as unknown as Record<string, unknown>[];
    return rows.map(EvalStore.hydrateEvalRun);
  }

  /** Evals still in flight at startup — everything a restart needs to reconcile. */
  unfinishedEvalRuns(): EvalRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM eval_runs WHERE status IN ('queued', 'running')`)
      .all() as unknown as Record<string, unknown>[];
    return rows.map(EvalStore.hydrateEvalRun);
  }

  // --- eval jobs -------------------------------------------------------------

  /** Persist the whole fan-out up front, in one transaction, BEFORE anything dispatches. */
  createJobs(evalId: string, jobs: { example_id: string; provider: string; model: string }[]): EvalJob[] {
    const out: EvalJob[] = [];
    const ins = this.db.prepare(
      `INSERT INTO eval_jobs (id, eval_id, example_id, provider, model, status, attempt, cost_complete)
       VALUES (?, ?, ?, ?, ?, 'queued', 0, 1)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const j of jobs) {
        const id = randomUUID();
        ins.run(id, evalId, j.example_id, j.provider, j.model);
        out.push({
          id, eval_id: evalId, example_id: j.example_id, provider: j.provider, model: j.model,
          status: "queued", attempt: 0, run_id: null, cost_usd: null, tokens: null,
          latency_ms: null, cost_complete: 1, error: null, started_at: null, ended_at: null,
        });
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return out;
  }

  /** Mark a job dispatched, binding it to the ordinary run that will carry its trace. */
  markJobRunning(jobId: string, runId: string, attempt: number): void {
    this.db
      .prepare(`UPDATE eval_jobs SET status = 'running', run_id = ?, attempt = ?, started_at = ? WHERE id = ?`)
      .run(runId, attempt, nowIso(), jobId);
  }

  /** Terminal update for a job, including whatever it managed to spend. */
  finishJob(
    jobId: string,
    status: Exclude<EvalJobStatus, "queued" | "running">,
    result: {
      cost_usd?: number | null;
      tokens?: number | null;
      latency_ms?: number | null;
      cost_complete?: boolean;
      error?: string | null;
    } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE eval_jobs SET status = ?, cost_usd = ?, tokens = ?, latency_ms = ?,
           cost_complete = ?, error = ?, ended_at = ? WHERE id = ?`,
      )
      .run(
        status,
        result.cost_usd ?? null,
        result.tokens ?? null,
        result.latency_ms ?? null,
        result.cost_complete === false ? 0 : 1,
        result.error ?? null,
        nowIso(),
        jobId,
      );
  }

  /** Put a job back on the queue without consuming an attempt. For the case where the
   *  pool refuses a dispatch the caps said should fit — the work is still owed, and
   *  leaving the row in 'running' would strand it. */
  requeueJob(jobId: string): void {
    this.db
      .prepare(`UPDATE eval_jobs SET status = 'queued', run_id = NULL, started_at = NULL WHERE id = ?`)
      .run(jobId);
  }

  /** Cancel everything still queued — how a budget abort stops the bleeding. */
  cancelQueuedJobs(evalId: string, reason: string): number {
    const res = this.db
      .prepare(`UPDATE eval_jobs SET status = 'cancelled', error = ?, ended_at = ? WHERE eval_id = ? AND status = 'queued'`)
      .run(reason, nowIso(), evalId);
    return Number(res.changes ?? 0);
  }

  jobsForEval(evalId: string): EvalJob[] {
    return this.db
      .prepare(`SELECT * FROM eval_jobs WHERE eval_id = ? ORDER BY rowid ASC`)
      .all(evalId) as unknown as EvalJob[];
  }

  getJob(jobId: string): EvalJob | undefined {
    return this.db.prepare(`SELECT * FROM eval_jobs WHERE id = ?`).get(jobId) as EvalJob | undefined;
  }

  /** The eval job a trace run belongs to, if any. Lets run events be routed correctly. */
  jobForRun(runId: string): EvalJob | undefined {
    return this.db.prepare(`SELECT * FROM eval_jobs WHERE run_id = ?`).get(runId) as EvalJob | undefined;
  }

  /**
   * TRUE SPEND so far: every attempt, succeeded or not, plus judge cost.
   *
   * This — never the comparison number — is what the budget ceiling checks. A failed or
   * retried attempt still hit the user's card, and a ceiling that only counted successes
   * would let a rate-limit storm spend past it without ever tripping.
   */
  trueSpend(evalId: string): number {
    const jobs = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM eval_jobs WHERE eval_id = ?`)
      .get(evalId) as { c: number };
    const run = this.db
      .prepare(`SELECT COALESCE(judge_cost_usd, 0) AS j FROM eval_runs WHERE id = ?`)
      .get(evalId) as { j: number } | undefined;
    return (jobs.c ?? 0) + (run?.j ?? 0);
  }

  // --- scores ----------------------------------------------------------------

  /** Record a judge verdict. `score: null` means UNSCORED (judge failed), not "scored 0". */
  putScore(s: {
    job_id: string;
    score: number | null;
    per_criterion?: Record<string, number> | null;
    rationale?: string | null;
    judge_model?: string | null;
    judge_cost_usd?: number | null;
    error?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO eval_scores (id, job_id, score, per_criterion, rationale, judge_model,
           judge_cost_usd, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           score=excluded.score, per_criterion=excluded.per_criterion,
           rationale=excluded.rationale, judge_model=excluded.judge_model,
           judge_cost_usd=excluded.judge_cost_usd, error=excluded.error`,
      )
      .run(
        randomUUID(), s.job_id, s.score,
        s.per_criterion ? JSON.stringify(s.per_criterion) : null,
        s.rationale ?? null, s.judge_model ?? null, s.judge_cost_usd ?? null,
        s.error ?? null, nowIso(),
      );
  }

  scoresForEval(evalId: string): EvalScore[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM eval_scores s JOIN eval_jobs j ON j.id = s.job_id WHERE j.eval_id = ?`,
      )
      .all(evalId) as unknown as Record<string, unknown>[];
    return rows.map(
      (r) =>
        ({
          ...r,
          per_criterion: EvalStore.parseJson<Record<string, number> | null>(r["per_criterion"], null),
        }) as EvalScore,
    );
  }
}
