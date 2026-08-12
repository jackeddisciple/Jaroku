// A fan-out is many starts, and the ceiling has to bind every one of them.
//
// The eval's own `budget_usd` has been checked on every pump since the eval engine landed,
// because a five-hundred-job eval that checked its budget once would have the first job's
// authorisation cover all five hundred. The workspace ceiling is the same rule one level up
// and is checked in the same place — this suite is what says so.
//
// And the property that must NOT change while porting onto reservations: the ceiling bounds
// what is STARTED, not what is spent. A workspace under its limit may start an eval that takes
// it over; the jobs already running are never killed. Two assertions here pin both halves.
//
//   npm run test:eval-budget

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { openTestSqlite } from "../db/testDb.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { TraceStore } from "../store.ts";
import { EvalStore } from "../evalStore.ts";
import { EvalRunner } from "../evalRunner.ts";
import { Dispatcher } from "../queue/dispatcher.ts";
import { InMemoryQueueBackend } from "../queue/inMemoryBackend.ts";
import type { PoolRunOptions, RunPool, RunPoolEvents } from "../runPool.ts";
import { Balances } from "./balances.ts";
import { BudgetGate, ceilingRefusal } from "./gate.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The same shape evalDispatch.test.ts drives: one slot, completion on command. */
class FakePool extends EventEmitter<RunPoolEvents> {
  started: PoolRunOptions[] = [];
  private active = new Set<string>();
  constructor(private capacity: number) {
    super();
  }
  get freeSlots(): number {
    return this.capacity - this.active.size;
  }
  tryStart(opts: PoolRunOptions): boolean {
    if (this.freeSlots <= 0) return false;
    this.active.add(opts.runId);
    this.started.push(opts);
    return true;
  }
  stop(): void {}
  finish(runId: string): void {
    this.active.delete(runId);
    this.emit("exit", { runId, code: 0, signal: null, timedOut: false, elapsedMs: 0 });
  }
}

const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();
const evalStore = new EvalStore(store.database());
await evalStore.init();
const billing = new BillingRepository(db);
const balances = new Balances(db, billing);
const identity = new IdentityRepository(db);
const gate = new BudgetGate(billing, balances, identity);

async function workspace(): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `evalbudget ${randomUUID().slice(0, 8)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

/** Record spend against this workspace's current period, the way the ingest path would. */
async function spend(ctx: TenantContext, usd: number): Promise<void> {
  await billing.record(ctx, {
    kind: "llm.provider",
    idempotencyKey: `evalbudget-${randomUUID()}`,
    runId: randomUUID(),
    costUsd: usd,
  });
}

/** A runner wired to the workspace ceiling, exactly as index.ts wires the real one. */
function runnerFor(ctx: TenantContext, pool: FakePool): EvalRunner {
  return new EvalRunner({
    pool: pool as unknown as RunPool,
    store,
    dispatcher: new Dispatcher(new InMemoryQueueBackend()),
    evalStore,
    runtimeDir: ".",
    context: () => ctx,
    markEvalRun: () => {},
    onStarted: () => {},
    onProgress: () => {},
    onFinished: () => {},
    workspaceOverBudget: async () => {
      const s = await gate.status(ctx);
      return s.overCeiling ? ceilingRefusal(s) : null;
    },
  });
}

async function datasetOf(ctx: TenantContext, agentId: string, examples: number): Promise<string> {
  const ds = await evalStore.createDataset(ctx, agentId, `${agentId} cases`);
  for (let i = 0; i < examples; i++) await evalStore.addExample(ctx, ds.id, `case-${i}`, null, null);
  return ds.id;
}

console.log("\nan eval under the ceiling starts, however expensive it looks");

{
  // Free plan, $5 ceiling, $4.99 spent. The eval below could plainly cost more than the
  // remaining cent — and it starts anyway, because the ceiling bounds what is STARTED.
  const ctx = await workspace();
  await spend(ctx, 4.99);
  const decision = await gate.mayStart(ctx, { estimateUsd: 50, purpose: "eval" });
  check(decision.ok, "a workspace one cent under its ceiling may start a fifty-dollar eval");
}

console.log("\nan eval over the ceiling never starts");

{
  const ctx = await workspace();
  await spend(ctx, 6);
  const decision = await gate.mayStart(ctx, { estimateUsd: 0.001, purpose: "eval" });
  check(!decision.ok, "and one over it cannot start even a fraction-of-a-cent eval");
  check((decision.message ?? "").includes("$5.0000"), "with a refusal naming the ceiling it hit");
}

console.log("\na ceiling reached mid-fan-out stops what is queued and not what is running");

{
  const ctx = await workspace();
  const pool = new FakePool(1); // one slot, so four of five jobs stay queued
  const runner = runnerFor(ctx, pool);
  const datasetId = await datasetOf(ctx, "agent_ceiling", 5);
  const rubric = await evalStore.putRubric(ctx, { dataset_id: null, name: "r", criteria: [] });

  const started = await runner.start({
    ctx, datasetId, agentId: "agent_ceiling", rubricId: rubric.id,
    targets: [{ provider: "fake", model: "fake" }], budgetUsd: null,
  });
  if ("error" in started) {
    check(false, `start failed: ${started.error}`);
  } else {
    for (let i = 0; i < 60 && pool.started.length < 1; i++) await sleep(15);
    check(pool.started.length === 1, "one job is running; the rest are queued");

    // The workspace runs out of room WHILE that job is in flight — a run of somebody else's, a
    // generation, anything. The next pump is what notices.
    await spend(ctx, 6);
    const runId = pool.started[0]!.runId;
    await store.upsertRun(ctx, {
      id: runId, agent_id: "agent_ceiling", provider: "fake", model: "fake", status: "completed",
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      cost: 0, tokens: 0, error: null,
    });
    pool.finish(runId);

    for (let i = 0; i < 80; i++) {
      const e = await evalStore.getEvalRun(ctx, started.evalId);
      if (e?.status === "aborted_over_budget") break;
      await sleep(20);
    }
    const evalRun = await evalStore.getEvalRun(ctx, started.evalId);
    check(evalRun?.status === "aborted_over_budget", `the eval stops (was ${evalRun?.status})`);
    check(
      (evalRun?.error ?? "").includes("ceiling"),
      "and its reason names the WORKSPACE ceiling, not this eval's own budget",
    );

    const jobs = await evalStore.jobsForEval(ctx, started.evalId);
    check(jobs.filter((j) => j.status === "cancelled").length === 4, "the four queued jobs are cancelled");
    check(
      jobs.filter((j) => j.status === "succeeded").length === 1,
      "and the one already running was allowed to finish — never killed mid-graph",
    );
    check(pool.started.length === 1, "no further job was ever started");
  }
}

console.log("\nthe eval's own budget still stops it, and says which ceiling it was");

{
  const ctx = await workspace();
  const pool = new FakePool(1);
  const runner = runnerFor(ctx, pool);
  const datasetId = await datasetOf(ctx, "agent_evalbudget", 4);
  const rubric = await evalStore.putRubric(ctx, { dataset_id: null, name: "r", criteria: [] });

  const started = await runner.start({
    ctx, datasetId, agentId: "agent_evalbudget", rubricId: rubric.id,
    // A budget of zero: true spend starts at 0, which is already >= 0, so the first pump stops
    // it. The point is which reason it records, not the arithmetic.
    targets: [{ provider: "fake", model: "fake" }], budgetUsd: 0,
  });
  if ("error" in started) {
    check(false, `start failed: ${started.error}`);
  } else {
    for (let i = 0; i < 80; i++) {
      const e = await evalStore.getEvalRun(ctx, started.evalId);
      if (e?.status === "aborted_over_budget") break;
      await sleep(20);
    }
    const evalRun = await evalStore.getEvalRun(ctx, started.evalId);
    check(evalRun?.status === "aborted_over_budget", "an eval over its own budget stops too");
    check(
      (evalRun?.error ?? "").includes("budget") && !(evalRun?.error ?? "").includes("ceiling"),
      "and names ITS budget rather than the workspace's — raising the wrong number twice is the failure",
    );
  }
}

console.log("\na hold is settled from true spend, not from the comparison figure");

{
  const ctx = await workspace();
  await billing.addCredit(ctx, 20);
  const decision = await gate.mayStart(ctx, { estimateUsd: 3, purpose: "eval" });
  check(decision.ok && decision.holdId !== undefined, "an eval with credit takes a hold");

  const datasetId = await datasetOf(ctx, "agent_settle", 1);
  const rubric = await evalStore.putRubric(ctx, { dataset_id: null, name: "r", criteria: [] });
  const evalRun = await evalStore.createEvalRun(ctx, {
    dataset_id: datasetId, agent_id: "agent_settle", rubric_id: rubric.id,
    targets: [{ provider: "fake", model: "fake" }], budget_usd: null,
  });
  const [job] = await evalStore.createJobs(ctx, evalRun.id, [
    { example_id: (await evalStore.listExamples(ctx, datasetId))[0]!.id, provider: "fake", model: "fake" },
  ]);
  // One failed attempt that spent, then a succeeded one. `cost_usd` describes only the final
  // attempt; `spent_usd` accumulates. Settling on the comparison figure would hand back the
  // money the first attempt burned — which is exactly when the difference is largest.
  await evalStore.finishJob(ctx, job!.id, "failed", { cost_usd: 0.4 });
  await evalStore.finishJob(ctx, job!.id, "succeeded", { cost_usd: 0.6 });
  await evalStore.addJudgeCost(ctx, evalRun.id, 0.1);

  const trueSpend = await evalStore.trueSpend(ctx, evalRun.id);
  check(Math.abs(trueSpend - 1.1) < 1e-9, `true spend counts both attempts plus the judge (${trueSpend})`);

  if (decision.ok && decision.holdId) {
    await balances.release(ctx, decision.holdId, { settleUsd: trueSpend });
    const after = await billing.balance(ctx);
    check(Math.abs(after.balance_usd - 18.9) < 1e-9, "the balance drops by true spend, not by the final attempt's cost");
    check(after.reserved_usd === 0, "and the hold is fully released");
  }
}

await db.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
