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
import type { SystemContext, TenantContext } from "./db/tenant.ts";

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

// Explicit column lists, for the same reason the trace store keeps them: `SELECT *` would put
// workspace_id into the object that goes onto the wire.
const RUBRIC_COLUMNS = `id, dataset_id, name, criteria, created_at, updated_at`;
const EVAL_RUN_COLUMNS = `id, dataset_id, agent_id, rubric_id, status, targets, budget_usd,
                          judge_cost_usd, started_at, ended_at, error`;
const EVAL_JOB_COLUMNS = `id, eval_id, example_id, provider, model, status, attempt, run_id,
                          cost_usd, tokens, latency_ms, cost_complete, error, started_at,
                          ended_at, retry_not_before, spent_usd`;
const EVAL_SCORE_COLUMNS = `id, job_id, score, per_criterion, rationale, judge_model,
                            judge_cost_usd, error, created_at`;

export class EvalStore {
  // Shares the trace store's database: same file, single writer, and aggregation can JOIN
  // eval_jobs against the frozen `steps` table. See TraceStore.database().
  //
  // Every method takes a TenantContext first and every statement filters on it, for the same
  // reasons the trace store does — with one extra edge worth naming: an eval_job's cost is
  // somebody's bill, so a job row reachable from the wrong workspace is not just a read of
  // private data, it is a number that would appear in the wrong person's spend.
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

  async createDataset(ctx: TenantContext, agentId: string, name: string): Promise<Dataset> {
    const row: Dataset = {
      id: randomUUID(),
      agent_id: agentId,
      name: name.trim() || "Untitled dataset",
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    await this.db.run(
      `INSERT INTO datasets (id, workspace_id, agent_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, ctx.workspaceId, row.agent_id, row.name, row.created_at, row.updated_at],
    );
    return row;
  }

  async renameDataset(ctx: TenantContext, datasetId: string, name: string): Promise<void> {
    await this.db.run(`UPDATE datasets SET name = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`, [
      name,
      nowIso(),
      datasetId,
      ctx.workspaceId,
    ]);
  }

  /** Datasets for one agent (or all, when agentId is omitted), newest first. */
  async listDatasets(ctx: TenantContext, agentId?: string): Promise<DatasetSummary[]> {
    const where = agentId ? `AND d.agent_id = ?` : ``;
    const args: unknown[] = agentId ? [ctx.workspaceId, agentId] : [ctx.workspaceId];
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT d.id, d.agent_id, d.name, d.created_at, d.updated_at,
              (SELECT COUNT(*) FROM dataset_examples e
                WHERE e.dataset_id = d.id AND e.workspace_id = d.workspace_id) AS example_count
       FROM datasets d WHERE d.workspace_id = ? ${where} ORDER BY d.created_at DESC`,
      args,
    );
    return rows.map((r) => ({ ...r, example_count: asInt(r["example_count"]) })) as unknown as DatasetSummary[];
  }

  async getDataset(ctx: TenantContext, datasetId: string): Promise<Dataset | undefined> {
    return (await this.db.get(
      `SELECT id, agent_id, name, created_at, updated_at
         FROM datasets WHERE id = ? AND workspace_id = ?`,
      [datasetId, ctx.workspaceId],
    )) as Dataset | undefined;
  }

  /** Deletes the dataset and its examples. Eval history that referenced it is left intact
   *  — a past comparison stays readable even after its dataset is gone. */
  async deleteDataset(ctx: TenantContext, datasetId: string): Promise<void> {
    await this.db.transaction(async (tx: Queryable) => {
      await tx.run(`DELETE FROM dataset_examples WHERE dataset_id = ? AND workspace_id = ?`, [
        datasetId,
        ctx.workspaceId,
      ]);
      await tx.run(`DELETE FROM datasets WHERE id = ? AND workspace_id = ?`, [datasetId, ctx.workspaceId]);
    });
  }

  // --- examples --------------------------------------------------------------

  async addExample(
    ctx: TenantContext,
    datasetId: string,
    input: string,
    expected?: string | null,
    notes?: string | null,
  ): Promise<DatasetExample> {
    const next = await this.db.get<{ p: unknown }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM dataset_examples
        WHERE dataset_id = ? AND workspace_id = ?`,
      [datasetId, ctx.workspaceId],
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
        `INSERT INTO dataset_examples
           (id, workspace_id, dataset_id, input, expected, notes, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id, ctx.workspaceId, row.dataset_id, row.input, row.expected, row.notes,
          row.position, row.created_at,
        ],
      );
      await tx.run(`UPDATE datasets SET updated_at = ? WHERE id = ? AND workspace_id = ?`, [
        row.created_at,
        datasetId,
        ctx.workspaceId,
      ]);
    });
    return row;
  }

  async updateExample(
    ctx: TenantContext,
    exampleId: string,
    patch: { input?: string; expected?: string | null; notes?: string | null },
  ): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.input !== undefined) { sets.push("input = ?"); args.push(patch.input); }
    if (patch.expected !== undefined) { sets.push("expected = ?"); args.push(patch.expected); }
    if (patch.notes !== undefined) { sets.push("notes = ?"); args.push(patch.notes); }
    if (!sets.length) return;
    args.push(exampleId, ctx.workspaceId);
    await this.db.run(
      `UPDATE dataset_examples SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`,
      args,
    );
  }

  async deleteExample(ctx: TenantContext, exampleId: string): Promise<void> {
    await this.db.run(`DELETE FROM dataset_examples WHERE id = ? AND workspace_id = ?`, [
      exampleId,
      ctx.workspaceId,
    ]);
  }

  /** Whether this exact input is already in the dataset. Promotion uses it to avoid
   *  silently doubling the cost of an eval by adding the same case twice. */
  async hasExampleWithInput(ctx: TenantContext, datasetId: string, input: string): Promise<boolean> {
    const row = await this.db.get(
      `SELECT 1 AS x FROM dataset_examples
        WHERE dataset_id = ? AND workspace_id = ? AND input = ? LIMIT 1`,
      [datasetId, ctx.workspaceId, input],
    );
    return row !== undefined;
  }

  /** The dataset a one-click promotion should land in: the agent's most recently touched
   *  one, or a new default. Server-side so promotion stays a single round trip — a client
   *  can't create-then-add without waiting to learn the new id. */
  async defaultDatasetFor(ctx: TenantContext, agentId: string, agentName?: string): Promise<Dataset> {
    const row = (await this.db.get(
      `SELECT id, agent_id, name, created_at, updated_at FROM datasets
        WHERE agent_id = ? AND workspace_id = ? ORDER BY updated_at DESC LIMIT 1`,
      [agentId, ctx.workspaceId],
    )) as Dataset | undefined;
    return row ?? (await this.createDataset(ctx, agentId, `${agentName ?? agentId} tests`));
  }

  async listExamples(ctx: TenantContext, datasetId: string): Promise<DatasetExample[]> {
    return (await this.db.all(
      `SELECT id, dataset_id, input, expected, notes, position, created_at
         FROM dataset_examples WHERE dataset_id = ? AND workspace_id = ? ORDER BY position ASC`,
      [datasetId, ctx.workspaceId],
    )) as unknown as DatasetExample[];
  }

  async getExample(ctx: TenantContext, exampleId: string): Promise<DatasetExample | undefined> {
    return (await this.db.get(
      `SELECT id, dataset_id, input, expected, notes, position, created_at
         FROM dataset_examples WHERE id = ? AND workspace_id = ?`,
      [exampleId, ctx.workspaceId],
    )) as DatasetExample | undefined;
  }

  // --- rubrics ---------------------------------------------------------------

  private hydrateRubric(row: Record<string, unknown>): Rubric {
    return { ...row, criteria: this.parseJson<RubricCriterion[]>(row["criteria"], []) } as Rubric;
  }

  /**
   * Insert or replace a rubric. `dataset_id: null` is THIS WORKSPACE's default.
   *
   * It used to be THE default — one row, a fixed id, shared by every dataset that had not
   * customised one. That cannot survive tenancy in either direction: two workspaces editing
   * "the default rubric" would be editing each other's, and with workspace_id NOT NULL the
   * row can only belong to one of them anyway, so the other's lookup finds nothing. See
   * `defaultRubricFor`, which creates one per workspace on first use.
   */
  async putRubric(
    ctx: TenantContext,
    r: { id?: string; dataset_id: string | null; name: string; criteria: RubricCriterion[] },
  ): Promise<Rubric> {
    const existing = r.id ? await this.getRubric(ctx, r.id) : undefined;
    const row: Rubric = {
      id: r.id ?? randomUUID(),
      dataset_id: r.dataset_id,
      name: r.name,
      criteria: r.criteria,
      created_at: existing?.created_at ?? nowIso(),
      updated_at: nowIso(),
    };
    await this.db.run(
      `INSERT INTO rubrics (id, workspace_id, dataset_id, name, criteria, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         dataset_id=excluded.dataset_id, name=excluded.name,
         criteria=excluded.criteria, updated_at=excluded.updated_at
       WHERE rubrics.workspace_id = ?`,
      [
        row.id, ctx.workspaceId, row.dataset_id, row.name, JSON.stringify(row.criteria),
        row.created_at, row.updated_at, ctx.workspaceId,
      ],
    );
    return row;
  }

  async getRubric(ctx: TenantContext, rubricId: string): Promise<Rubric | undefined> {
    const row = await this.db.get<Record<string, unknown>>(
      `SELECT ${RUBRIC_COLUMNS} FROM rubrics WHERE id = ? AND workspace_id = ?`,
      [rubricId, ctx.workspaceId],
    );
    return row ? this.hydrateRubric(row) : undefined;
  }

  /** The rubric a dataset scores against, if it has customized one. */
  async rubricForDataset(ctx: TenantContext, datasetId: string): Promise<Rubric | undefined> {
    const row = await this.db.get<Record<string, unknown>>(
      `SELECT ${RUBRIC_COLUMNS} FROM rubrics
        WHERE dataset_id = ? AND workspace_id = ? ORDER BY updated_at DESC LIMIT 1`,
      [datasetId, ctx.workspaceId],
    );
    return row ? this.hydrateRubric(row) : undefined;
  }

  /**
   * This workspace's default rubric — the one with no dataset — creating it on first use.
   *
   * The replacement for a constant id shared by everybody. Identified by (workspace, no
   * dataset) rather than by a well-known primary key, so there is nothing for two tenants to
   * collide on and nothing to seed at boot.
   */
  async defaultRubricFor(
    ctx: TenantContext,
    criteria: RubricCriterion[],
  ): Promise<Rubric> {
    const row = await this.db.get<Record<string, unknown>>(
      `SELECT ${RUBRIC_COLUMNS} FROM rubrics
        WHERE workspace_id = ? AND dataset_id IS NULL ORDER BY created_at ASC LIMIT 1`,
      [ctx.workspaceId],
    );
    if (row) return this.hydrateRubric(row);
    return this.putRubric(ctx, { dataset_id: null, name: "Default", criteria });
  }

  // --- eval runs -------------------------------------------------------------

  private hydrateEvalRun(row: Record<string, unknown>): EvalRun {
    return { ...row, targets: this.parseJson<EvalTarget[]>(row["targets"], []) } as EvalRun;
  }

  async createEvalRun(ctx: TenantContext, r: {
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
      `INSERT INTO eval_runs (id, workspace_id, dataset_id, agent_id, rubric_id, status,
         targets, budget_usd, judge_cost_usd, started_at, ended_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL)`,
      [
        row.id, ctx.workspaceId, row.dataset_id, row.agent_id, row.rubric_id, row.status,
        JSON.stringify(row.targets), row.budget_usd, row.started_at,
      ],
    );
    return row;
  }

  async setEvalStatus(
    ctx: TenantContext,
    evalId: string,
    status: EvalRunStatus,
    error?: string | null,
  ): Promise<void> {
    const ended = status === "queued" || status === "running" ? null : nowIso();
    await this.db.run(
      `UPDATE eval_runs SET status = ?, ended_at = COALESCE(?, ended_at), error = ?
        WHERE id = ? AND workspace_id = ?`,
      [status, ended, error ?? null, evalId, ctx.workspaceId],
    );
  }

  /** Accumulate judge spend. Separate from any provider's agent cost by design. */
  async addJudgeCost(ctx: TenantContext, evalId: string, usd: number): Promise<void> {
    await this.db.run(
      `UPDATE eval_runs SET judge_cost_usd = judge_cost_usd + ? WHERE id = ? AND workspace_id = ?`,
      [usd, evalId, ctx.workspaceId],
    );
  }

  async getEvalRun(ctx: TenantContext, evalId: string): Promise<EvalRun | undefined> {
    const row = await this.db.get<Record<string, unknown>>(
      `SELECT ${EVAL_RUN_COLUMNS} FROM eval_runs WHERE id = ? AND workspace_id = ?`,
      [evalId, ctx.workspaceId],
    );
    return row ? this.hydrateEvalRun(row) : undefined;
  }

  async listEvalRuns(ctx: TenantContext, limit = 50): Promise<EvalRun[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT ${EVAL_RUN_COLUMNS} FROM eval_runs
        WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?`,
      [ctx.workspaceId, limit],
    );
    return rows.map((r) => this.hydrateEvalRun(r));
  }

  /**
   * Evals still in flight at startup — everything a restart needs to reconcile.
   *
   * The one read here that is deliberately NOT workspace-scoped, and it takes a SystemContext
   * to say so out loud. A restart has to reconcile every workspace's interrupted evals, not
   * the one whichever context happened to be at hand; leaving another tenant's rows claiming
   * to be running forever would be the bug, not the isolation. It returns the workspace id
   * alongside each row so the caller can scope the writes that follow.
   */
  async unfinishedEvalRuns(_ctx: SystemContext): Promise<(EvalRun & { workspace_id: string })[]> {
    return (await this.db.all<Record<string, unknown>>(
      `SELECT ${EVAL_RUN_COLUMNS}, workspace_id FROM eval_runs WHERE status IN ('queued', 'running')`,
    )).map((r) => ({
      ...this.hydrateEvalRun(r),
      workspace_id: r["workspace_id"] as string,
    }));
  }

  /**
   * Finished evals across EVERY workspace, for the startup checkpoint sweep.
   *
   * Deliberately unscoped, and takes a SystemContext to say so in the signature. The sweeper
   * cleans a machine's disk, not a tenant's rows: scoping it to one workspace would leave
   * every other tenant's blobs behind forever. It returns each row's workspace so the caller
   * can scope the reads that follow it.
   */
  async finishedEvalRunsAcrossWorkspaces(
    _ctx: SystemContext,
    limit = 500,
  ): Promise<{ id: string; workspace_id: string }[]> {
    return this.db.all<{ id: string; workspace_id: string }>(
      `SELECT id, workspace_id FROM eval_runs
        WHERE status NOT IN ('queued', 'running') ORDER BY started_at DESC LIMIT ?`,
      [limit],
    );
  }

  // --- eval jobs -------------------------------------------------------------

  /** Persist the whole fan-out up front, in one transaction, BEFORE anything dispatches. */
  async createJobs(
    ctx: TenantContext,
    evalId: string,
    jobs: { example_id: string; provider: string; model: string }[],
  ): Promise<EvalJob[]> {
    const out: EvalJob[] = [];
    await this.db.transaction(async (tx: Queryable) => {
      let position = 0;
      for (const j of jobs) {
        const id = randomUUID();
        await tx.run(
          `INSERT INTO eval_jobs (id, workspace_id, eval_id, example_id, provider, model,
             status, attempt, cost_complete, position)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 1, ?)`,
          [id, ctx.workspaceId, evalId, j.example_id, j.provider, j.model, position++],
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
  async markJobRunning(
    ctx: TenantContext,
    jobId: string,
    runId: string,
    attempt: number,
  ): Promise<void> {
    await this.db.run(
      `UPDATE eval_jobs SET status = 'running', run_id = ?, attempt = ?, started_at = ?
        WHERE id = ? AND workspace_id = ?`,
      [runId, attempt, nowIso(), jobId, ctx.workspaceId],
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
    ctx: TenantContext,
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
         tokens = ?, latency_ms = ?, cost_complete = ?, error = ?, ended_at = ?
        WHERE id = ? AND workspace_id = ?`,
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
        ctx.workspaceId,
      ],
    );
  }

  /** Put a job back on the queue without consuming an attempt. For the case where the
   *  pool refuses a dispatch the caps said should fit — the work is still owed, and
   *  leaving the row in 'running' would strand it. */
  async requeueJob(ctx: TenantContext, jobId: string): Promise<void> {
    await this.db.run(
      `UPDATE eval_jobs SET status = 'queued', run_id = NULL, started_at = NULL
        WHERE id = ? AND workspace_id = ?`,
      [jobId, ctx.workspaceId],
    );
  }

  /**
   * Queue a job for another attempt after `notBefore`.
   *
   * Consumes an attempt (unlike `requeueJob`) because the previous one really ran and
   * really spent. Its `cost_usd` is deliberately LEFT IN PLACE: a failed attempt's spend
   * still counts toward true spend and the budget ceiling.
   */
  async retryJob(
    ctx: TenantContext,
    jobId: string,
    attempt: number,
    notBefore: Date,
  ): Promise<void> {
    await this.db.run(
      `UPDATE eval_jobs SET status = 'queued', attempt = ?, retry_not_before = ?,
         run_id = NULL, started_at = NULL, ended_at = NULL WHERE id = ? AND workspace_id = ?`,
      [attempt, notBefore.toISOString(), jobId, ctx.workspaceId],
    );
  }

  /** Cancel everything still queued — how a budget abort stops the bleeding. */
  async cancelQueuedJobs(ctx: TenantContext, evalId: string, reason: string): Promise<number> {
    const res = await this.db.run(
      `UPDATE eval_jobs SET status = 'cancelled', error = ?, ended_at = ?
        WHERE eval_id = ? AND workspace_id = ? AND status = 'queued'`,
      [reason, nowIso(), evalId, ctx.workspaceId],
    );
    return res.changes;
  }

  async jobsForEval(ctx: TenantContext, evalId: string): Promise<EvalJob[]> {
    return (await this.db.all(
      `SELECT ${EVAL_JOB_COLUMNS} FROM eval_jobs
        WHERE eval_id = ? AND workspace_id = ? ORDER BY position ASC, id ASC`,
      [evalId, ctx.workspaceId],
    )) as unknown as EvalJob[];
  }

  async getJob(ctx: TenantContext, jobId: string): Promise<EvalJob | undefined> {
    return (await this.db.get(
      `SELECT ${EVAL_JOB_COLUMNS} FROM eval_jobs WHERE id = ? AND workspace_id = ?`,
      [jobId, ctx.workspaceId],
    )) as EvalJob | undefined;
  }

  /** The eval job a trace run belongs to, if any. Lets run events be routed correctly. */
  async jobForRun(ctx: TenantContext, runId: string): Promise<EvalJob | undefined> {
    return (await this.db.get(
      `SELECT ${EVAL_JOB_COLUMNS} FROM eval_jobs WHERE run_id = ? AND workspace_id = ?`,
      [runId, ctx.workspaceId],
    )) as EvalJob | undefined;
  }

  /**
   * TRUE SPEND so far: every attempt, succeeded or not, plus judge cost.
   *
   * This — never the comparison number — is what the budget ceiling checks. A failed or
   * retried attempt still hit the user's card, and a ceiling that only counted successes
   * would let a rate-limit storm spend past it without ever tripping.
   */
  async trueSpend(ctx: TenantContext, evalId: string): Promise<number> {
    // spent_usd, not cost_usd: the cumulative column is the one that survives retries.
    const jobs = await this.db.get<{ c: number | null }>(
      `SELECT COALESCE(SUM(spent_usd), 0) AS c FROM eval_jobs
        WHERE eval_id = ? AND workspace_id = ?`,
      [evalId, ctx.workspaceId],
    );
    const run = await this.db.get<{ j: number | null }>(
      `SELECT COALESCE(judge_cost_usd, 0) AS j FROM eval_runs WHERE id = ? AND workspace_id = ?`,
      [evalId, ctx.workspaceId],
    );
    return Number(jobs?.c ?? 0) + Number(run?.j ?? 0);
  }

  // --- scores ----------------------------------------------------------------

  /** Record a judge verdict. `score: null` means UNSCORED (judge failed), not "scored 0". */
  async putScore(ctx: TenantContext, s: {
    job_id: string;
    score: number | null;
    per_criterion?: Record<string, number> | null;
    rationale?: string | null;
    judge_model?: string | null;
    judge_cost_usd?: number | null;
    error?: string | null;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO eval_scores (id, workspace_id, job_id, score, per_criterion, rationale,
         judge_model, judge_cost_usd, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         score=excluded.score, per_criterion=excluded.per_criterion,
         rationale=excluded.rationale, judge_model=excluded.judge_model,
         judge_cost_usd=excluded.judge_cost_usd, error=excluded.error
       WHERE eval_scores.workspace_id = ?`,
      [
        randomUUID(), ctx.workspaceId, s.job_id, s.score,
        s.per_criterion ? JSON.stringify(s.per_criterion) : null,
        s.rationale ?? null, s.judge_model ?? null, s.judge_cost_usd ?? null,
        s.error ?? null, nowIso(), ctx.workspaceId,
      ],
    );
  }

  async scoresForEval(ctx: TenantContext, evalId: string): Promise<EvalScore[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT ${EVAL_SCORE_COLUMNS.split(",").map((c) => `s.${c.trim()}`).join(", ")}
         FROM eval_scores s JOIN eval_jobs j ON j.id = s.job_id AND j.workspace_id = s.workspace_id
        WHERE j.eval_id = ? AND s.workspace_id = ?`,
      [evalId, ctx.workspaceId],
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
