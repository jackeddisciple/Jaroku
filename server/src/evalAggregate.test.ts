// Cost/latency aggregation — the math the doc says destroys trust when it's wrong (§8).
//
// Every case here is a way the dashboard could quietly lie: a crashed run reporting $0
// because run_end never fired, an unpriced model rendering as free, a free model rendering
// as unknown, a partially-priced run presenting a floor as a total, or a provider being
// scored expensive for runs that failed.
//
// Steps are inserted directly so each scenario is exact — no dependence on what a real
// provider happened to charge.
//
//   npm run test:aggregate

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceStore } from "./store.ts";
import { EvalStore } from "./evalStore.ts";
import { aggregateEval, aggregateJob } from "./evalAggregate.ts";
import type { Step } from "./types.ts";
import { openTestSqlite, testContext } from "./db/testDb.ts";

const DB = join(tmpdir(), `jaroku-agg-${randomUUID()}.db`);
const db = await openTestSqlite(DB);
const store = new TraceStore(db);
await store.init();
const evalStore = new EvalStore(store.database());
await evalStore.init();
const ctx = testContext();

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

let seq = 0;
async function step(runId: string, over: Partial<Step>): Promise<void> {
  await store.insertStep(ctx, {
    id: randomUUID(), run_id: runId, seq: seq++, type: "llm_call", name: "call_model",
    input: null, output: null, state_before: null, state_after: null,
    tokens: null, cost: null, latency_ms: 0, error: null, parent_step_id: null,
    started_at: new Date().toISOString(), ...over,
  } as Step);
}

/** A run row plus its steps. `endedAt: null` models a crash before run_end. */
async function makeRun(opts: {
  model: string;
  costs: (number | null)[];
  tokens?: (number | null)[];
  startedAt?: string;
  endedAt?: string | null;
  /** What runs.cost claims — the field that is WRONG for a crashed run. */
  runCost?: number;
}): Promise<string> {
  const runId = randomUUID();
  await store.upsertRun(ctx, {
    id: runId, agent_id: "a", provider: "p", model: opts.model,
    status: opts.endedAt === null ? "running" : "completed",
    started_at: opts.startedAt ?? "2026-01-01T00:00:00.000Z",
    ended_at: opts.endedAt === undefined ? "2026-01-01T00:00:01.000Z" : opts.endedAt,
    cost: opts.runCost ?? 0, tokens: 0, error: null,
  });
  // `?? 100` would be wrong here: a deliberate null token count (what the free dry-run
  // model reports) must stay null, and `??` treats null as absent.
  for (const [i, c] of opts.costs.entries()) {
    await step(runId, { cost: c, tokens: opts.tokens === undefined ? 100 : (opts.tokens[i] ?? null) });
  }
  return runId;
}

// --- 1. cost comes from steps, not runs.cost -----------------------------------------
{
  // The exact shape of a run that died mid-graph: real spend in the steps, run_end never
  // fired, so runs.cost still reads 0.
  const runId = await makeRun({ model: "claude-haiku-4-5", costs: [0.004, 0.006], endedAt: null, runCost: 0 });
  const m = await aggregateJob(ctx, store, runId, "claude-haiku-4-5");
  check("crashed run reports its real spend, not runs.cost's 0",
    m.cost_usd === 0.01, `got ${m.cost_usd}`);
  check("crashed run's cost is still complete", m.cost_complete === true);
}

// --- 2. unpriced is null, priced-and-free is zero ------------------------------------
{
  const unpriced = await makeRun({ model: "some-unreleased-model", costs: [null, null] });
  check("unpriced model reports null, NOT 0",
    (await aggregateJob(ctx, store, unpriced, "some-unreleased-model")).cost_usd === null);

  // The dry-run provider genuinely costs nothing; that must not render the same as
  // "we don't know what this cost".
  const free = await makeRun({ model: "fake-dry-run", costs: [null, null], tokens: [null, null] });
  const m = await aggregateJob(ctx, store, free, "fake-dry-run");
  check("priced-and-free model reports 0, not null", m.cost_usd === 0, `got ${m.cost_usd}`);
  check("free model is not flagged incomplete", m.cost_complete === true);
}

// --- 3. partial pricing is flagged, not silently undercounted ------------------------
{
  // One llm_call priced, one with tokens but no cost — the sum is a floor.
  const runId = await makeRun({ model: "claude-haiku-4-5", costs: [0.01, null], tokens: [500, 500] });
  const m = await aggregateJob(ctx, store, runId, "claude-haiku-4-5");
  check("partially-priced run flags cost_complete = false", m.cost_complete === false);
  check("partially-priced run still reports the floor", m.cost_usd === 0.01, `got ${m.cost_usd}`);
}

// --- 4. latency is wall clock, including the gaps between steps ----------------------
{
  const runId = await makeRun({
    model: "claude-haiku-4-5", costs: [0.001],
    startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:02.500Z",
  });
  // Step durations sum to ~0; the truth is 2500ms of wall clock, most of it spent waiting.
  check("latency is wall clock, not the sum of step durations",
    (await aggregateJob(ctx, store, runId, "claude-haiku-4-5")).latency_ms === 2500);
}

// --- 5. comparison cost vs true spend ------------------------------------------------
{
  const ds = await evalStore.createDataset(ctx, "agent-x", "cost cases");
  const ex = await evalStore.addExample(ctx, ds.id, "hello");
  const rubric = await evalStore.putRubric(ctx, { dataset_id: null, name: "r", criteria: [] });
  const run = await evalStore.createEvalRun(ctx, {
    dataset_id: ds.id, agent_id: "agent-x", rubric_id: rubric.id,
    targets: [{ provider: "anthropic", model: "claude-haiku-4-5" }],
    budget_usd: 1,
  });
  const jobs = await evalStore.createJobs(ctx, run.id, [
    { example_id: ex.id, provider: "anthropic", model: "claude-haiku-4-5" },
    { example_id: ex.id, provider: "anthropic", model: "claude-haiku-4-5" },
    { example_id: ex.id, provider: "anthropic", model: "claude-haiku-4-5" },
  ]);
  // Two succeeded; one failed HALFWAY, so it spent money without producing a result.
  await evalStore.finishJob(ctx, jobs[0]!.id, "succeeded", { cost_usd: 0.02, tokens: 1000, latency_ms: 1000 });
  await evalStore.finishJob(ctx, jobs[1]!.id, "succeeded", { cost_usd: 0.04, tokens: 2000, latency_ms: 3000 });
  await evalStore.finishJob(ctx, jobs[2]!.id, "failed", { cost_usd: 0.01, tokens: 500, latency_ms: 500, error: "rate limited" });
  await evalStore.addJudgeCost(ctx, run.id, 0.005);

  const agg = (await aggregateEval(ctx, evalStore, run.id))!;
  const p = agg.providers[0]!;

  check("comparison cost counts succeeded runs only",
    p.comparisonCostUsd === 0.06, `got ${p.comparisonCostUsd}`);
  check("spend on this leg counts the failed attempt too",
    p.spentUsd === 0.07, `got ${p.spentUsd}`);
  check("true spend adds judge cost on top",
    agg.totals.trueSpendUsd === 0.075, `got ${agg.totals.trueSpendUsd}`);
  check("judge cost is broken out, not folded into the provider",
    agg.totals.judgeCostUsd === 0.005 && agg.totals.agentSpendUsd === 0.07);
  check("cost per run divides by succeeded runs only",
    p.costPerRunUsd === 0.03, `got ${p.costPerRunUsd}`);
  check("success rate excludes the failure", Math.abs(p.successRate - 2 / 3) < 1e-9);
  check("tokens count succeeded runs only", p.tokens === 3000, `got ${p.tokens}`);
  check("p50 over succeeded latencies", p.latencyP50Ms === 1000, `got ${p.latencyP50Ms}`);
  check("p95 over succeeded latencies", p.latencyP95Ms === 3000, `got ${p.latencyP95Ms}`);
  check("budget carried through", agg.totals.budgetUsd === 1);
}

// --- 6. an unpriced leg is excluded from cost, but still reports quality --------------
{
  const ds = await evalStore.createDataset(ctx, "agent-y", "unpriced");
  const ex = await evalStore.addExample(ctx, ds.id, "hello");
  const rubric = await evalStore.putRubric(ctx, { dataset_id: null, name: "r2", criteria: [] });
  const run = await evalStore.createEvalRun(ctx, {
    dataset_id: ds.id, agent_id: "agent-y", rubric_id: rubric.id,
    targets: [{ provider: "mystery", model: "unreleased-x" }], budget_usd: null,
  });
  const jobs = await evalStore.createJobs(ctx, run.id, [
    { example_id: ex.id, provider: "mystery", model: "unreleased-x" },
  ]);
  await evalStore.finishJob(ctx, jobs[0]!.id, "succeeded", { cost_usd: null, tokens: 900, latency_ms: 700 });

  const p = (await aggregateEval(ctx, evalStore, run.id))!.providers[0]!;
  check("unpriced leg is flagged costUnknown", p.costUnknown === true);
  check("unpriced leg reports null cost, never 0", p.comparisonCostUsd === null);
  check("unpriced leg still reports latency and success",
    p.latencyP50Ms === 700 && p.successRate === 1);
}

await store.close();
rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
