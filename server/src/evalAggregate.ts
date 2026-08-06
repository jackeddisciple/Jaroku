// Result aggregation — turning traces into the numbers the comparison dashboard shows.
//
// This is the file the doc's warning is about (§8: "verify the math — wrong cost numbers
// destroy trust instantly"). Four decisions carry that weight:
//
// 1. COST COMES FROM `steps`, NOT `runs.cost`.
//    `runs.cost` is written by run_end. A run that crashes mid-graph never emits run_end,
//    so its row still reads 0 — while its steps record real money already spent. Summing
//    the steps is the only figure that matches the bill.
//
// 2. UNPRICED IS NULL, NOT ZERO.
//    If the model has no pricing entry, per-step cost is null, SUM is null, and this
//    reports null — "cost unknown". Coalescing that to 0 would render an unpriced model as
//    FREE next to a priced one, which is not a rounding error but a different claim.
//
// 3. A FREE MODEL IS GENUINELY $0.
//    The dry-run provider is priced, at zero. "Priced and free" and "unpriced" must not
//    collapse into the same cell, so the gate is whether the model is in the table, not
//    whether the sum came out empty.
//
// 4. PARTIAL PRICING IS FLAGGED, NOT HIDDEN.
//    If any llm_call step reports tokens but no cost, the total is an UNDERCOUNT. That run
//    is marked cost-incomplete so the dashboard can say so, rather than presenting a
//    confidently wrong number.
//
// And the comparison/spend split (the milestone's cost-semantics decision): the number a
// provider is COMPARED on counts succeeded runs only, so a provider that hit transient rate
// limits isn't scored as expensive for being unlucky. TRUE SPEND counts every attempt plus
// judge cost, because that is what actually hit the card — and it's what the budget ceiling
// checks.

import type { TraceStore } from "./store.ts";
import type { TenantContext } from "./db/tenant.ts";
import type { EvalStore, EvalJob } from "./evalStore.ts";
import { asInt } from "./db/db.ts";
import { isPriced, round8 } from "./pricing.ts";

export interface JobMetrics {
  cost_usd: number | null;
  tokens: number | null;
  latency_ms: number | null;
  /** False when some llm_call had tokens but no cost — the total is an undercount. */
  cost_complete: boolean;
}

/**
 * Metrics for one finished job, derived from its run's steps.
 *
 * `model` is passed in rather than read from the run row because an unpriced model must
 * report null cost even when its steps happen to sum to nothing.
 */
export async function aggregateJob(
  ctx: TenantContext,
  store: TraceStore,
  runId: string,
  model: string,
): Promise<JobMetrics> {
  // The two raw reads below go through the shared database rather than the trace store,
  // because they are aggregates the store has no method for. They carry the scope by hand
  // for exactly the same reason every store method does.
  const db = store.database();

  const totals = (await db.get<{ cost: number | null; tokens: number | null; step_latency: number | null }>(
    `SELECT
       SUM(cost)   AS cost,
       SUM(tokens) AS tokens,
       SUM(latency_ms) AS step_latency
     FROM steps WHERE run_id = ? AND workspace_id = ?`,
    [runId, ctx.workspaceId],
  )) ?? { cost: null, tokens: null, step_latency: null };

  // An llm_call that reported tokens but no cost means we could not price part of this
  // run. The sum is therefore a floor, not the total.
  const unpriced = await db.get<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM steps
     WHERE run_id = ? AND workspace_id = ? AND type = 'llm_call'
       AND tokens IS NOT NULL AND cost IS NULL`,
    [runId, ctx.workspaceId],
  );

  // Wall-clock from the run row is the honest latency: it includes the gaps between steps
  // (tool I/O, provider queueing) that a sum of step durations silently drops.
  const run = await store.getRun(ctx, runId);
  let latency: number | null = null;
  if (run?.started_at && run.ended_at) {
    const ms = Date.parse(run.ended_at) - Date.parse(run.started_at);
    if (Number.isFinite(ms) && ms >= 0) latency = ms;
  }
  if (latency === null && totals.step_latency !== null) latency = totals.step_latency;

  return {
    // Priced-and-free ($0) and unpriced (unknown) are different answers — never conflate.
    cost_usd: isPriced(model) ? round8(totals.cost ?? 0) : null,
    tokens: totals.tokens ?? null,
    latency_ms: latency,
    cost_complete: asInt(unpriced?.n) === 0,
  };
}

/** Nearest-rank percentile over a sorted ascending array. */
function percentile(sortedAsc: number[], p: number): number | null {
  if (!sortedAsc.length) return null;
  // Nearest-rank, stated explicitly because at the sample sizes an eval produces (often
  // <20 runs) the choice of method visibly moves the number, and an unstated method makes
  // two "p95"s incomparable.
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(Math.max(rank, 1), sortedAsc.length) - 1]!;
}

export interface ProviderMetrics {
  provider: string;
  model: string;
  total: number;
  succeeded: number;
  failed: number;
  /** succeeded / total, 0..1. */
  successRate: number;
  /** Cost of SUCCEEDED runs only — the like-for-like comparison figure. */
  comparisonCostUsd: number | null;
  /** Mean cost per succeeded run — what one more run of this provider would cost. */
  costPerRunUsd: number | null;
  /** Every attempt on this target, succeeded or not. Part of true spend. */
  spentUsd: number;
  tokens: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** No pricing entry for this model — cost is unknown, not zero. Excluded from rankings. */
  costUnknown: boolean;
  /** Some steps couldn't be priced; the cost shown is a floor. */
  costIncomplete: boolean;
  /**
   * Mean judge score over SCORED runs, 0..1, or null when nothing was scored.
   *
   * Unscored runs are excluded rather than counted as 0 — a judge that failed says nothing
   * about the provider, and averaging its silence in as a zero would punish the provider
   * for it. `unscored` is reported alongside so the dashboard can qualify the average.
   */
  qualityScore: number | null;
  scored: number;
  unscored: number;
}

export interface EvalTotals {
  /** Every attempt (including failed and retried) plus judge cost. What hit the card. */
  trueSpendUsd: number;
  /** Judge overhead, broken out — never attributed to a provider's agent cost. */
  judgeCostUsd: number;
  /** Agent-side spend across all attempts, excluding the judge. */
  agentSpendUsd: number;
  budgetUsd: number | null;
}

/** One cell of the comparison grid: what one provider did with one example. */
export interface ExampleCell {
  jobId: string;
  provider: string;
  model: string;
  status: string;
  /** The ordinary run this job produced — the handle drill-down opens the full trace with. */
  runId: string | null;
  costUsd: number | null;
  latencyMs: number | null;
  attempt: number;
  error: string | null;
  /** null = unscored (judge failed or skipped), with `scoreError` saying which. */
  score: number | null;
  scoreError: string | null;
  perCriterion: Record<string, number> | null;
  rationale: string | null;
}

export interface ExampleRow {
  exampleId: string;
  input: string;
  expected: string | null;
  cells: ExampleCell[];
}

export interface EvalAggregate {
  evalId: string;
  datasetId: string;
  agentId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  providers: ProviderMetrics[];
  totals: EvalTotals;
  /** Per-example detail, for drilling into a cell. */
  rows: ExampleRow[];
}

/** Roll every job up into the per-provider comparison plus the eval's spend totals. */
export async function aggregateEval(
  ctx: TenantContext,
  evalStore: EvalStore,
  evalId: string,
): Promise<EvalAggregate | null> {
  const evalRun = await evalStore.getEvalRun(ctx, evalId);
  if (!evalRun) return null;
  const jobs = await evalStore.jobsForEval(ctx, evalId);
  const scores = await evalStore.scoresForEval(ctx, evalId);
  // jobId -> score. A row with a null score is UNSCORED (the judge failed or was skipped);
  // a row absent entirely was never judged. Neither is a zero.
  const scoreByJob = new Map<string, number | null>();
  for (const s of scores) scoreByJob.set(s.job_id, s.score);

  // Group by the (provider, model) leg — the unit the dashboard compares.
  const groups = new Map<string, EvalJob[]>();
  for (const j of jobs) {
    const key = `${j.provider} ${j.model}`;
    const list = groups.get(key);
    if (list) list.push(j);
    else groups.set(key, [j]);
  }

  const providers: ProviderMetrics[] = [];
  let agentSpend = 0;

  for (const [key, group] of groups) {
    const [provider = "", model = ""] = key.split(" ");
    const succeeded = group.filter((j) => j.status === "succeeded");
    const failed = group.filter((j) => j.status === "failed" || j.status === "timed_out");

    // Spend counts EVERY attempt — a failed run still burned tokens on the way down, and
    // a retried one burned them more than once. `spent_usd` is the cumulative column;
    // `cost_usd` only describes the final attempt.
    for (const j of group) agentSpend += j.spent_usd ?? 0;

    // A leg is cost-unknown when the model isn't priced. Checked against the pricing table
    // rather than inferred from a null sum, so a run that simply made no LLM call isn't
    // mistaken for an unpriced model.
    const costUnknown = !isPriced(model);
    const costIncomplete = succeeded.some((j) => j.cost_complete === 0);

    const comparisonCost = costUnknown
      ? null
      : round8(succeeded.reduce((sum, j) => sum + (j.cost_usd ?? 0), 0));

    const latencies = succeeded
      .map((j) => j.latency_ms)
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);

    // Quality averages only what was actually scored. An unscored run is excluded, never
    // folded in as a 0 — the judge failing says nothing about the provider.
    const graded = succeeded
      .map((j) => scoreByJob.get(j.id))
      .filter((v): v is number => typeof v === "number");
    const unscored = succeeded.length - graded.length;

    providers.push({
      provider,
      model,
      total: group.length,
      succeeded: succeeded.length,
      failed: failed.length,
      successRate: group.length ? succeeded.length / group.length : 0,
      comparisonCostUsd: comparisonCost,
      costPerRunUsd:
        comparisonCost !== null && succeeded.length ? round8(comparisonCost / succeeded.length) : null,
      spentUsd: round8(group.reduce((sum, j) => sum + (j.spent_usd ?? 0), 0)),
      tokens: succeeded.reduce((sum, j) => sum + (j.tokens ?? 0), 0),
      latencyP50Ms: percentile(latencies, 50),
      latencyP95Ms: percentile(latencies, 95),
      costUnknown,
      costIncomplete,
      qualityScore: graded.length
        ? Number((graded.reduce((s, v) => s + v, 0) / graded.length).toFixed(4))
        : null,
      scored: graded.length,
      unscored,
    });
  }

  // Stable order so the dashboard doesn't reshuffle between refreshes.
  providers.sort((a, b) => (a.provider + a.model).localeCompare(b.provider + b.model));

  // Per-example rows, in dataset order, each carrying one cell per (provider, model) leg.
  // Built here rather than in the UI so the dashboard grid and the drill-down are always
  // describing the same data.
  const scoreRowByJob = new Map(scores.map((s) => [s.job_id, s]));
  const jobsByExample = new Map<string, EvalJob[]>();
  for (const j of jobs) {
    const list = jobsByExample.get(j.example_id);
    if (list) list.push(j);
    else jobsByExample.set(j.example_id, [j]);
  }
  const rows: ExampleRow[] = [];
  for (const example of await evalStore.listExamples(ctx, evalRun.dataset_id)) {
    const cells = (jobsByExample.get(example.id) ?? []).map((j): ExampleCell => {
      const s = scoreRowByJob.get(j.id);
      return {
        jobId: j.id,
        provider: j.provider,
        model: j.model,
        status: j.status,
        runId: j.run_id,
        costUsd: j.cost_usd,
        latencyMs: j.latency_ms,
        attempt: j.attempt,
        error: j.error,
        score: s?.score ?? null,
        scoreError: s?.error ?? null,
        perCriterion: s?.per_criterion ?? null,
        rationale: s?.rationale ?? null,
      };
    });
    // An example deleted mid-eval leaves jobs with no row; skip rather than invent one.
    if (cells.length) {
      rows.push({ exampleId: example.id, input: example.input, expected: example.expected, cells });
    }
  }

  const judge = evalRun.judge_cost_usd ?? 0;
  return {
    evalId,
    datasetId: evalRun.dataset_id,
    agentId: evalRun.agent_id,
    status: evalRun.status,
    startedAt: evalRun.started_at,
    endedAt: evalRun.ended_at,
    providers,
    rows,
    totals: {
      agentSpendUsd: round8(agentSpend),
      judgeCostUsd: round8(judge),
      trueSpendUsd: round8(agentSpend + judge),
      budgetUsd: evalRun.budget_usd,
    },
  };
}
