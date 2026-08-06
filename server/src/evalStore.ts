// Eval Engine data model (doc §6.4) — additive control-plane tables only.
//
// THE FROZEN SCHEMA IS UNTOUCHED. schema/events.md v1 stays exactly as it is, and an eval
// is not a new event type: it is a BATCH OF ORDINARY RUNS. Every job in an eval executes
// through the same ProcessManager -> jaroku_runner -> JarokuTracer -> TraceStore path as a
// run the user triggers by hand, and produces the same Run/Step rows. `eval_jobs.run_id`
// is a plain foreign key into `runs.id` — that FK is the entire integration surface.
//
// This is the same discipline as pause/resume/branch (store.ts): when eval needed data the
// frozen schema doesn't carry, it went into new tables beside it, never into the event shape.
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
//     really spent — see aggregation, which sums `steps.cost` instead. The column also
//     carries `cost_complete`, because "we know this cost $0.04" and "we couldn't price
//     some of these steps" are different claims and the dashboard has to be able to tell
//     them apart.

import { randomUUID } from "node:crypto";
import { asInt, jsonFromColumn, type Db, type Queryable } from "./db/db.ts";

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
  /** The FINAL attempt's cost — the like-for-like comparison figure. Null when unpriced. */
  cost_usd: number | null;
  /** CUMULATIVE cost across every attempt. What the bill and the budget ceiling see. */
  spent_usd: number;
  tokens: number | null;
  latency_ms: number | null;
  /** 0 when some llm_call step had tokens but no cost — the total is an UNDERCOUNT. */
  cost_complete: number;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** ISO time before which a backing-off retry must not be dispatched. */
  retry_not_before?: string | null;
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
  // Shares the trace store's database: same file, single writer, and aggregation can JOIN
  // eval_jobs against the frozen `steps` table. See TraceStore.database().
  constructor(private db: Db) {}

  /** SQLite only — on Postgres these tables come from the numbered migrations. */
  /** Compatibility fixes for a database that predates a column. See TraceStore.init. */
  async init(): Promise<void> {
    if (this.db.dialect !== "sqlite") return;
    // Additive migration for DBs created before retry landed. A retried job must not be
    // re-dispatched immediately — backing off is the entire point when the failure was a
    // rate limit.
    await this.ensureColumn("eval_jobs", "retry_not_before", "TEXT");
    // CUMULATIVE spend across every attempt of this job.
    //
    // `cost_usd` is the FINAL attempt's cost — the like-for-like number a provider is
    // compared on. On a retry it is overwritten, which is correct for comparison and
    // WRONG for the bill: attempt 1 already charged for the tokens it burned before
    // failing. Without a separate cumulative column that money silently vanishes from
    // true spend, and the budget ceiling under-counts exactly when retries are firing —
    // i.e. precisely when it most needs to be accurate.
    await this.ensureColumn("eval_jobs", "spent_usd", "REAL NOT NULL DEFAULT 0");
    // Insertion order, made explicit.
    //
    // Jobs were listed `ORDER BY rowid`, which is SQLite's own hidden column and does not
    // exist in Postgres — and Postgres has nothing to put in its place, because a physical
    // row identifier there is not stable. The order is real product behaviour (the grid
    // shows examples in dataset order), so it becomes a column rather than an accident of
    // storage. Existing rows are backfilled FROM rowid, so nothing reshuffles.
    if (await this.ensureColumn("eval_jobs", "position", "INTEGER NOT NULL DEFAULT 0")) {
      await this.db.exec(`UPDATE eval_jobs SET position = rowid`);
    }
  }

  /**
   * Idempotent ADD COLUMN — CREATE TABLE IF NOT EXISTS never alters an existing table.
   * Returns whether it added one, so a caller can backfill only when it did.
   */
  private async ensureColumn(table: string, column: string, decl: string): Promise<boolean> {
    const cols = await this.db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (cols.some((c) => c.name === column)) return false;
    await this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    return true;
  }

  // Told which driver it is reading from rather than guessing from the value — see
  // jsonFromColumn. Every column here holds an object or an array, so the string-scalar trap
  // it defends against cannot arise; it goes through the same helper anyway, because "this
  // one is safe by accident" is how the next column added here stops being safe.
  private parseJson<T>(v: unknown, fallback: T): T {
    const parsed = jsonFromColumn(this.db.dialect, v);
    return parsed === null || typeof parsed === "string" ? fallback : (parsed as T);
  }

  // --- datasets --------------------------------------------------------------

  async createDataset(agentId: string, name: string): Promise<Dataset> {
    const row: Dataset = {
      id: randomUUID(),
      agent_id: agentId,
      name: name.trim() || "Untitled dataset",
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    await this.db.run(
      `INSERT INTO datasets (id, agent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [row.id, row.agent_id, row.name, row.created_at, row.updated_at],
    );
    return row;
  }

  async renameDataset(datasetId: string, name: string): Promise<void> {
    await this.db.run(`UPDATE datasets SET name = ?, updated_at = ? WHERE id = ?`, [name, nowIso(), datasetId]);
  }

  /** Datasets for one agent (or all, when agentId is omitted), newest first. */
  async listDatasets(agentId?: string): Promise<DatasetSummary[]> {
    const where = agentId ? `WHERE d.agent_id = ?` : ``;
    const args: unknown[] = agentId ? [agentId] : [];
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT d.*, (SELECT COUNT(*) FROM dataset_examples e WHERE e.dataset_id = d.id) AS example_count
       FROM datasets d ${where} ORDER BY d.created_at DESC`,
      args,
    );
    return rows.map((r) => ({ ...r, example_count: asInt(r["example_count"]) })) as unknown as DatasetSummary[];
  }

  async getDataset(datasetId: string): Promise<Dataset | undefined> {
    return (await this.db.get(`SELECT * FROM datasets WHERE id = ?`, [datasetId])) as Dataset | undefined;
  }

  /** Deletes the dataset and its examples. Eval history that referenced it is left intact
   *  — a past comparison stays readable even after its dataset is gone. */
  async deleteDataset(datasetId: string): Promise<void> {
    await this.db.transaction(async (tx: Queryable) => {
      await tx.run(`DELETE FROM dataset_examples WHERE dataset_id = ?`, [datasetId]);
      await tx.run(`DELETE FROM datasets WHERE id = ?`, [datasetId]);
    });
  }

  // --- examples --------------------------------------------------------------

  async addExample(
    datasetId: string,
    input: string,
    expected?: string | null,
    notes?: string | null,
  ): Promise<DatasetExample> {
    const next = await this.db.get<{ p: unknown }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM dataset_examples WHERE dataset_id = ?`,
      [datasetId],
    );
    const row: DatasetExample = {
      id: randomUUID(),
      dataset_id: datasetId,
      input,
      expected: expected ?? null,
      notes: notes ?? null,
      position: asInt(next?.p),
      created_at: nowIso(),
    };
    await this.db.transaction(async (tx: Queryable) => {
      await tx.run(
        `INSERT INTO dataset_examples (id, dataset_id, input, expected, notes, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.dataset_id, row.input, row.expected, row.notes, row.position, row.created_at],
      );
      await tx.run(`UPDATE datasets SET updated_at = ? WHERE id = ?`, [row.created_at, datasetId]);
    });
    return row;
  }

  async updateExample(
    exampleId: string,
    patch: { input?: string; expected?: string | null; notes?: string | null },
  ): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.input !== undefined) { sets.push("input = ?"); args.push(patch.input); }
    if (patch.expected !== undefined) { sets.push("expected = ?"); args.push(patch.expected); }
    if (patch.notes !== undefined) { sets.push("notes = ?"); args.push(patch.notes); }
    if (!sets.length) return;
    args.push(exampleId);
    await this.db.run(`UPDATE dataset_examples SET ${sets.join(", ")} WHERE id = ?`, args);
  }

  async deleteExample(exampleId: string): Promise<void> {
    await this.db.run(`DELETE FROM dataset_examples WHERE id = ?`, [exampleId]);
  }

  /** Whether this exact input is already in the dataset. Promotion uses it to avoid
   *  silently doubling the cost of an eval by adding the same case twice. */
  async hasExampleWithInput(datasetId: string, input: string): Promise<boolean> {
    const row = await this.db.get(
      `SELECT 1 AS x FROM dataset_examples WHERE dataset_id = ? AND input = ? LIMIT 1`,
      [datasetId, input],
    );
    return row !== undefined;
  }

  /** The dataset a one-click promotion should land in: the agent's most recently touched
   *  one, or a new default. Server-side so promotion stays a single round trip — a client
   *  can't create-then-add without waiting to learn the new id. */
  async defaultDatasetFor(agentId: string, agentName?: string): Promise<Dataset> {
    const row = (await this.db.get(`SELECT * FROM datasets WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 1`, [
      agentId,
    ])) as Dataset | undefined;
    return row ?? (await this.createDataset(agentId, `${agentName ?? agentId} tests`));
  }

  async listExamples(datasetId: string): Promise<DatasetExample[]> {
    return (await this.db.all(`SELECT * FROM dataset_examples WHERE dataset_id = ? ORDER BY position ASC`, [
      datasetId,
    ])) as unknown as DatasetExample[];
  }

  async getExample(exampleId: string): Promise<DatasetExample | undefined> {
    return (await this.db.get(`SELECT * FROM dataset_examples WHERE id = ?`, [exampleId])) as
      | DatasetExample
      | undefined;
  }

  // --- rubrics ---------------------------------------------------------------

  private hydrateRubric(row: Record<string, unknown>): Rubric {
    return { ...row, criteria: this.parseJson<RubricCriterion[]>(row["criteria"], []) } as Rubric;
  }

  /** Insert or replace a rubric. `dataset_id: null` is the shared built-in default. */
  async putRubric(r: {
    id?: string;
    dataset_id: string | null;
    name: string;
    criteria: RubricCriterion[];
  }): Promise<Rubric> {
    const existing = r.id ? await this.getRubric(r.id) : undefined;
    const row: Rubric = {
      id: r.id ?? randomUUID(),
      dataset_id: r.dataset_id,
      name: r.name,
      criteria: r.criteria,
      created_at: existing?.created_at ?? nowIso(),
      updated_at: nowIso(),
    };
    await this.db.run(
      `INSERT INTO rubrics (id, dataset_id, name, criteria, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         dataset_id=excluded.dataset_id, name=excluded.name,
         criteria=excluded.criteria, updated_at=excluded.updated_at`,
      [row.id, row.dataset_id, row.name, JSON.stringify(row.criteria), row.created_at, row.updated_at],
    );
    return row;
  }

  async getRubric(rubricId: string): Promise<Rubric | undefined> {
    const row = await this.db.get<Record<string, unknown>>(`SELECT * FROM rubrics WHERE id = ?`, [rubricId]);
    return row ? this.hydrateRubric(row) : undefined;
  }

  /** The rubric a dataset scores against, if it has customized one. */
  async rubricForDataset(datasetId: string): Promise<Rubric | undefined> {
    const row = await this.db.get<Record<string, unknown>>(
      `SELECT * FROM rubrics WHERE dataset_id = ? ORDER BY updated_at DESC LIMIT 1`,
      [datasetId],
    );
    return row ? this.hydrateRubric(row) : undefined;
  }

  // --- eval runs -------------------------------------------------------------

  private hydrateEvalRun(row: Record<string, unknown>): EvalRun {
    return { ...row, targets: this.parseJson<EvalTarget[]>(row["targets"], []) } as EvalRun;
  }

  async createEvalRun(r: {
    id?: string;
    dataset_id: string;
    agent_id: string;
    rubric_id: string;
    targets: EvalTarget[];
    budget_usd: number | null;
  }): Promise<EvalRun> {
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
    await this.db.run(
      `INSERT INTO eval_runs (id, dataset_id, agent_id, rubric_id, status, targets,
         budget_usd, judge_cost_usd, started_at, ended_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL)`,
      [
        row.id, row.dataset_id, row.agent_id, row.rubric_id, row.status,
        JSON.stringify(row.targets), row.budget_usd, row.started_at,
      ],
    );
    return row;
  }

  async setEvalStatus(evalId: string, status: EvalRunStatus, error?: string | null): Promise<void> {
    const ended = status === "queued" || status === "running" ? null : nowIso();
    await this.db.run(
      `UPDATE eval_runs SET status = ?, ended_at = COALESCE(?, ended_at), error = ? WHERE id = ?`,
      [status, ended, error ?? null, evalId],
    );
  }

  /** Accumulate judge spend. Separate from any provider's agent cost by design. */
  async addJudgeCost(evalId: string, usd: number): Promise<void> {
    await this.db.run(`UPDATE eval_runs SET judge_cost_usd = judge_cost_usd + ? WHERE id = ?`, [usd, evalId]);
  }

  async getEvalRun(evalId: string): Promise<EvalRun | undefined> {
    const row = await this.db.get<Record<string, unknown>>(`SELECT * FROM eval_runs WHERE id = ?`, [evalId]);
    return row ? this.hydrateEvalRun(row) : undefined;
  }

  async listEvalRuns(limit = 50): Promise<EvalRun[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT * FROM eval_runs ORDER BY started_at DESC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => this.hydrateEvalRun(r));
  }

  /** Evals still in flight at startup — everything a restart needs to reconcile. */
  async unfinishedEvalRuns(): Promise<EvalRun[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT * FROM eval_runs WHERE status IN ('queued', 'running')`,
    );
    return rows.map((r) => this.hydrateEvalRun(r));
  }

  // --- eval jobs -------------------------------------------------------------

  /** Persist the whole fan-out up front, in one transaction, BEFORE anything dispatches. */
  async createJobs(
    evalId: string,
    jobs: { example_id: string; provider: string; model: string }[],
  ): Promise<EvalJob[]> {
    const out: EvalJob[] = [];
    await this.db.transaction(async (tx: Queryable) => {
      let position = 0;
      for (const j of jobs) {
        const id = randomUUID();
        await tx.run(
          `INSERT INTO eval_jobs (id, eval_id, example_id, provider, model, status, attempt,
             cost_complete, position)
           VALUES (?, ?, ?, ?, ?, 'queued', 0, 1, ?)`,
          [id, evalId, j.example_id, j.provider, j.model, position++],
        );
        out.push({
          id, eval_id: evalId, example_id: j.example_id, provider: j.provider, model: j.model,
          status: "queued", attempt: 0, run_id: null, cost_usd: null, spent_usd: 0, tokens: null,
          latency_ms: null, cost_complete: 1, error: null, started_at: null, ended_at: null,
        });
      }
    });
    return out;
  }

  /** Mark a job dispatched, binding it to the ordinary run that will carry its trace. */
  async markJobRunning(jobId: string, runId: string, attempt: number): Promise<void> {
    await this.db.run(
      `UPDATE eval_jobs SET status = 'running', run_id = ?, attempt = ?, started_at = ? WHERE id = ?`,
      [runId, attempt, nowIso(), jobId],
    );
  }

  /**
   * Terminal update for one ATTEMPT of a job.
   *
   * `cost_usd` is replaced (it describes this attempt — the comparison figure), while
   * `spent_usd` ACCUMULATES (it describes the bill). A job retried twice therefore
   * compares on its final attempt and bills for all three.
   */
  async finishJob(
    jobId: string,
    status: Exclude<EvalJobStatus, "queued" | "running">,
    result: {
      cost_usd?: number | null;
      tokens?: number | null;
      latency_ms?: number | null;
      cost_complete?: boolean;
      error?: string | null;
    } = {},
  ): Promise<void> {
    await this.db.run(
      `UPDATE eval_jobs SET status = ?, cost_usd = ?, spent_usd = COALESCE(spent_usd, 0) + ?,
         tokens = ?, latency_ms = ?, cost_complete = ?, error = ?, ended_at = ? WHERE id = ?`,
      [
        status,
        result.cost_usd ?? null,
        result.cost_usd ?? 0, // an unpriced attempt adds nothing knowable to the bill
        result.tokens ?? null,
        result.latency_ms ?? null,
        result.cost_complete === false ? 0 : 1,
        result.error ?? null,
        nowIso(),
        jobId,
      ],
    );
  }

  /** Put a job back on the queue without consuming an attempt. For the case where the
   *  pool refuses a dispatch the caps said should fit — the work is still owed, and
   *  leaving the row in 'running' would strand it. */
  async requeueJob(jobId: string): Promise<void> {
    await this.db.run(
      `UPDATE eval_jobs SET status = 'queued', run_id = NULL, started_at = NULL WHERE id = ?`,
      [jobId],
    );
  }

  /**
   * Queue a job for another attempt after `notBefore`.
   *
   * Consumes an attempt (unlike `requeueJob`) because the previous one really ran and
   * really spent. Its `cost_usd` is deliberately LEFT IN PLACE: a failed attempt's spend
   * still counts toward true spend and the budget ceiling.
   */
  async retryJob(jobId: string, attempt: number, notBefore: Date): Promise<void> {
    await this.db.run(
      `UPDATE eval_jobs SET status = 'queued', attempt = ?, retry_not_before = ?,
         run_id = NULL, started_at = NULL, ended_at = NULL WHERE id = ?`,
      [attempt, notBefore.toISOString(), jobId],
    );
  }

  /** Cancel everything still queued — how a budget abort stops the bleeding. */
  async cancelQueuedJobs(evalId: string, reason: string): Promise<number> {
    const res = await this.db.run(
      `UPDATE eval_jobs SET status = 'cancelled', error = ?, ended_at = ? WHERE eval_id = ? AND status = 'queued'`,
      [reason, nowIso(), evalId],
    );
    return res.changes;
  }

  async jobsForEval(evalId: string): Promise<EvalJob[]> {
    return (await this.db.all(`SELECT * FROM eval_jobs WHERE eval_id = ? ORDER BY position ASC, id ASC`, [
      evalId,
    ])) as unknown as EvalJob[];
  }

  async getJob(jobId: string): Promise<EvalJob | undefined> {
    return (await this.db.get(`SELECT * FROM eval_jobs WHERE id = ?`, [jobId])) as EvalJob | undefined;
  }

  /** The eval job a trace run belongs to, if any. Lets run events be routed correctly. */
  async jobForRun(runId: string): Promise<EvalJob | undefined> {
    return (await this.db.get(`SELECT * FROM eval_jobs WHERE run_id = ?`, [runId])) as EvalJob | undefined;
  }

  /**
   * TRUE SPEND so far: every attempt, succeeded or not, plus judge cost.
   *
   * This — never the comparison number — is what the budget ceiling checks. A failed or
   * retried attempt still hit the user's card, and a ceiling that only counted successes
   * would let a rate-limit storm spend past it without ever tripping.
   */
  async trueSpend(evalId: string): Promise<number> {
    // spent_usd, not cost_usd: the cumulative column is the one that survives retries.
    const jobs = await this.db.get<{ c: number | null }>(
      `SELECT COALESCE(SUM(spent_usd), 0) AS c FROM eval_jobs WHERE eval_id = ?`,
      [evalId],
    );
    const run = await this.db.get<{ j: number | null }>(
      `SELECT COALESCE(judge_cost_usd, 0) AS j FROM eval_runs WHERE id = ?`,
      [evalId],
    );
    return Number(jobs?.c ?? 0) + Number(run?.j ?? 0);
  }

  // --- scores ----------------------------------------------------------------

  /** Record a judge verdict. `score: null` means UNSCORED (judge failed), not "scored 0". */
  async putScore(s: {
    job_id: string;
    score: number | null;
    per_criterion?: Record<string, number> | null;
    rationale?: string | null;
    judge_model?: string | null;
    judge_cost_usd?: number | null;
    error?: string | null;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO eval_scores (id, job_id, score, per_criterion, rationale, judge_model,
         judge_cost_usd, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         score=excluded.score, per_criterion=excluded.per_criterion,
         rationale=excluded.rationale, judge_model=excluded.judge_model,
         judge_cost_usd=excluded.judge_cost_usd, error=excluded.error`,
      [
        randomUUID(), s.job_id, s.score,
        s.per_criterion ? JSON.stringify(s.per_criterion) : null,
        s.rationale ?? null, s.judge_model ?? null, s.judge_cost_usd ?? null,
        s.error ?? null, nowIso(),
      ],
    );
  }

  async scoresForEval(evalId: string): Promise<EvalScore[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT s.* FROM eval_scores s JOIN eval_jobs j ON j.id = s.job_id WHERE j.eval_id = ?`,
      [evalId],
    );
    return rows.map(
      (r) =>
        ({
          ...r,
          per_criterion: this.parseJson<Record<string, number> | null>(r["per_criterion"], null),
        }) as EvalScore,
    );
  }
}
