// Retry classification, retry accounting, and the budget ceiling.
//
// These are the runaway-cost guards. Each failure mode is a money bug:
//   * classifying a deterministic failure as transient pays 3x for every broken agent
//   * losing a failed attempt's spend under-counts the bill exactly when retries fire
//   * a ceiling checked against the comparison figure never trips during a retry storm
//
//   npm run test:retry

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceStore } from "./store.ts";
import { openTestSqlite } from "./db/testDb.ts";
import { EvalStore } from "./evalStore.ts";
import { aggregateEval } from "./evalAggregate.ts";
import { isTransientFailure } from "./evalRunner.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- 1. what is worth paying to retry -------------------------------------------------
{
  const transient: [string, string | null, boolean][] = [
    ["rate limit", "RateLimitError: rate limit exceeded", false],
    ["429", "APIStatusError: 429 Too Many Requests", false],
    ["overloaded", "overloaded_error: Overloaded", false],
    ["connection reset", "APIConnectionError: ECONNRESET", false],
    ["502/503/504", "APIStatusError: 503 Service Unavailable", false],
    ["wall-clock timeout", null, true],
  ];
  for (const [name, err, timedOut] of transient) {
    check(`retries a transient failure: ${name}`, isTransientFailure(err, timedOut) === true);
  }

  const deterministic: string[] = [
    "ContractError: agent.py must define build_graph(llm)",
    "ModuleNotFoundError: No module named 'psycopg'",
    "SyntaxError: invalid syntax",
    "AttributeError: 'NoneType' object has no attribute 'invoke'",
    "AuthenticationError: invalid x-api-key",
    "ANTHROPIC_API_KEY is not set",
    "not_found_error: model does not exist",
  ];
  for (const err of deterministic) {
    check(`does NOT retry: ${err.split(":")[0]}`, isTransientFailure(err, false) === false);
  }

  // The default must be the cheap one — an unrecognized error retried 3x is a 3x bill for
  // every broken agent in the dataset.
  check("unrecognized failures default to NOT retrying",
    isTransientFailure("something nobody has seen before", false) === false);
  check("no error at all is not retryable", isTransientFailure(null, false) === false);
  // A deterministic marker inside a retry-shaped message is still deterministic.
  check("deterministic markers beat transient ones",
    isTransientFailure("APIConnectionError while handling ContractError: bad graph", false) === false);
}

// --- 2. a retry must not lose the failed attempt's spend ------------------------------
{
  const DB = join(tmpdir(), `jaroku-retry-${randomUUID()}.db`);
  const db = await openTestSqlite(DB);
  const store = new TraceStore(db);
  await store.init();
  const evalStore = new EvalStore(store.database());
  await evalStore.init();

  const ds = await evalStore.createDataset("agent-r", "retries");
  const ex = await evalStore.addExample(ds.id, "hello");
  const rubric = await evalStore.putRubric({ dataset_id: null, name: "r", criteria: [] });
  const run = await evalStore.createEvalRun({
    dataset_id: ds.id, agent_id: "agent-r", rubric_id: rubric.id,
    targets: [{ provider: "anthropic", model: "claude-haiku-4-5" }], budget_usd: null,
  });
  const [job] = await evalStore.createJobs(run.id, [
    { example_id: ex.id, provider: "anthropic", model: "claude-haiku-4-5" },
  ]);

  // Attempt 1 burns tokens, then rate-limits.
  await evalStore.finishJob(job!.id, "failed", { cost_usd: 0.03, error: "rate limit" });
  await evalStore.retryJob(job!.id, 1, new Date(Date.now() + 1000));
  // Attempt 2 succeeds, more cheaply.
  await evalStore.finishJob(job!.id, "succeeded", { cost_usd: 0.02, tokens: 900, latency_ms: 800 });

  const after = (await evalStore.getJob(job!.id))!;
  check("comparison cost is the FINAL attempt only", after.cost_usd === 0.02, `got ${after.cost_usd}`);
  check("cumulative spend keeps the failed attempt", after.spent_usd === 0.05, `got ${after.spent_usd}`);
  const spend = await evalStore.trueSpend(run.id);
  check("trueSpend uses the cumulative column", Math.abs(spend - 0.05) < 1e-9, `got ${spend}`);

  const p = (await aggregateEval(evalStore, run.id))!.providers[0]!;
  check("dashboard compares on the final attempt", p.comparisonCostUsd === 0.02);
  check("dashboard bills for both attempts", p.spentUsd === 0.05);
  check("attempt count recorded", after.attempt === 1);

  await store.close();
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
}

// --- 3. the ceiling is checked against true spend, not the comparison figure ----------
{
  const DB = join(tmpdir(), `jaroku-budget-${randomUUID()}.db`);
  const db = await openTestSqlite(DB);
  const store = new TraceStore(db);
  await store.init();
  const evalStore = new EvalStore(store.database());
  await evalStore.init();

  const ds = await evalStore.createDataset("agent-b", "budget");
  const ex = await evalStore.addExample(ds.id, "hello");
  const rubric = await evalStore.putRubric({ dataset_id: null, name: "r", criteria: [] });
  const run = await evalStore.createEvalRun({
    dataset_id: ds.id, agent_id: "agent-b", rubric_id: rubric.id,
    targets: [{ provider: "anthropic", model: "claude-haiku-4-5" }], budget_usd: 0.10,
  });
  const jobs = await evalStore.createJobs(run.id, Array.from({ length: 5 }, () => ({
    example_id: ex.id, provider: "anthropic", model: "claude-haiku-4-5",
  })));

  // Two jobs FAIL after spending. Their cost is invisible to the comparison figure — which
  // is exactly why the ceiling must not use it.
  await evalStore.finishJob(jobs[0]!.id, "failed", { cost_usd: 0.05, error: "rate limit" });
  await evalStore.finishJob(jobs[1]!.id, "failed", { cost_usd: 0.06, error: "rate limit" });

  const agg = (await aggregateEval(evalStore, run.id))!;
  const spend = await evalStore.trueSpend(run.id);
  check("comparison figure sees none of the failed spend", agg.providers[0]!.comparisonCostUsd === 0);
  check("true spend sees all of it", Math.abs(spend - 0.11) < 1e-9, `got ${spend}`);
  check("true spend has crossed the ceiling the comparison figure would have missed",
    spend >= 0.10 && (agg.providers[0]!.comparisonCostUsd ?? 0) < 0.10);

  // The abort path: queued work is cancelled so nothing further is started.
  const cancelled = await evalStore.cancelQueuedJobs(run.id, "budget ceiling reached");
  await evalStore.setEvalStatus(run.id, "aborted_over_budget", "over budget");
  check("remaining jobs cancelled on abort", cancelled === 3, `cancelled ${cancelled}`);
  check("no job left queued", (await evalStore.jobsForEval(run.id)).every((j) => j.status !== "queued"));
  check("eval records WHY it stopped",
    (await evalStore.getEvalRun(run.id))!.status === "aborted_over_budget");
  const spendAfter = await evalStore.trueSpend(run.id);
  check("cancelling adds no further spend",
    Math.abs(spendAfter - 0.11) < 1e-9, `got ${spendAfter}`);

  await store.close();
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
