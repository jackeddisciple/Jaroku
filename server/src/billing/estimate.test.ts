// The estimate, hosted: still a range, still says what it is based on, still null for an
// unpriced model — and now also says whether the workspace can afford it.
//
// The three original rules are asserted here rather than assumed, because this is the commit
// that widened the shape and a widening is exactly when a rule gets lost. The fourth is the new
// one: THE ESTIMATE INFORMS, THE CEILING ENFORCES. Every affordability figure comes from the
// same `BudgetGate.status` the gate decides with, so the dialog before the button and the
// refusal after it are reading one computation. A budget feature where those two disagree is
// untrustworthy even when both halves are individually right.
//
//   npm run test:estimate

import { randomUUID } from "node:crypto";
import { openTestSqlite } from "../db/testDb.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { TraceStore } from "../store.ts";
import { EvalStore } from "../evalStore.ts";
import { estimateEval, estimateRun } from "../evalEstimate.ts";
import { Balances } from "./balances.ts";
import { BudgetGate } from "./gate.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();
const evalStore = new EvalStore(store.database());
await evalStore.init();
const billing = new BillingRepository(db);
const balances = new Balances(db, billing);
const identity = new IdentityRepository(db);
const gate = new BudgetGate(billing, balances, identity);

const PRICED = "claude-haiku-4-5";
/** A second model that is genuinely in runtime/pricing.json. Naming one that is NOT would make
 *  every "does it fit" assertion below come back `null` — correctly, and for the wrong reason. */
const SECOND_PRICED = "claude-sonnet-5";
const UNPRICED = "a-model-nobody-has-priced";

async function workspace(): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `estimate ${randomUUID().slice(0, 8)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

async function datasetOf(ctx: TenantContext, agentId: string, n: number): Promise<string> {
  const ds = await evalStore.createDataset(ctx, agentId, `${agentId} cases`);
  for (let i = 0; i < n; i++) await evalStore.addExample(ctx, ds.id, `a reasonably typical case ${i}`, null, null);
  return ds.id;
}

/** A completed run with real token usage, so the estimator has history to calibrate from. */
async function historicRun(ctx: TenantContext, agentId: string, model: string, tokens: number): Promise<void> {
  const runId = randomUUID();
  const at = new Date().toISOString();
  await store.upsertRun(ctx, {
    id: runId, agent_id: agentId, provider: "anthropic", model, status: "completed",
    started_at: at, ended_at: at, cost: 0, tokens, error: null,
  });
  await store.insertStep(ctx, {
    id: randomUUID(), run_id: runId, seq: 0, type: "llm_call", name: "model",
    input: null, output: null, state_before: null, state_after: null,
    tokens, cost: 0.01, latency_ms: 5, error: null, parent_step_id: null, started_at: at,
  });
}

console.log("\nestimateRun keeps every rule estimateEval has");

{
  const ctx = await workspace();
  const cold = await estimateRun(ctx, store, { agentId: "agent_cold", model: PRICED });
  check(cold.basis === "default", "with no history it says so rather than pretending to measure");
  check(cold.sampleSize === 0, "and reports no sample");
  check(
    cold.lowUsd !== null && cold.highUsd !== null && cold.highUsd > cold.lowUsd,
    "it is a range, not a point",
  );

  for (let i = 0; i < 3; i++) await historicRun(ctx, "agent_warm", PRICED, 12_000);
  const warm = await estimateRun(ctx, store, { agentId: "agent_warm", model: PRICED });
  check(warm.basis === "measured", "with history on this model, the basis is measured");
  check(warm.sampleSize === 3, "and it names how many runs informed it");
  check(
    (warm.highUsd! - warm.lowUsd!) / warm.highUsd! < (cold.highUsd! - cold.lowUsd!) / cold.highUsd!,
    "a measured projection is narrower than a default one",
  );

  const other = await estimateRun(ctx, store, { agentId: "agent_warm", model: SECOND_PRICED });
  check(other.basis === "other-model", "history on a different model is labelled as such, not as measured");

  const unpriced = await estimateRun(ctx, store, { agentId: "agent_warm", model: UNPRICED });
  check(unpriced.lowUsd === null && unpriced.highUsd === null, "an unpriced model estimates to null");
  check(!unpriced.priced, "and says it is unpriced, so a caller cannot mistake null for free");
}

console.log("\nwithout a budget, affordability is absent rather than empty");

{
  // The local path. Reporting a workspace with no ceiling and no credit would be a different
  // and more alarming claim than reporting nothing.
  const ctx = await workspace();
  const datasetId = await datasetOf(ctx, "agent_local", 2);
  const e = await estimateEval(ctx, store, evalStore, {
    datasetId, agentId: "agent_local", targets: [{ provider: "anthropic", model: PRICED }],
    judgeEnabled: false,
  });
  check(e.affordability === null, "no budget in, no affordability out");
  check(e.totalHighUsd > e.totalLowUsd, "the estimate itself is unchanged");
}

console.log("\nwith a budget, it reports the same numbers the gate decides with");

{
  const ctx = await workspace(); // free plan: $5 ceiling
  const datasetId = await datasetOf(ctx, "agent_afford", 2);
  const status = await gate.status(ctx);
  const e = await estimateEval(ctx, store, evalStore, {
    datasetId, agentId: "agent_afford", targets: [{ provider: "anthropic", model: PRICED }],
    judgeEnabled: false, budget: status,
  });
  const a = e.affordability!;
  check(a !== null, "affordability is reported");
  check(a.ceilingUsd === status.ceilingUsd, "the ceiling is the gate's");
  check(a.headroomUsd === status.headroomUsd, "so is the headroom");
  check(a.spentUsd === status.spentUsd && a.spentIsComplete === status.costKnown, "and the spend, with its completeness");
  check(!a.wouldRefuse && a.refusalMessage === null, "a workspace with room is not warned");
  check(a.mayNotFinish === false, "and a small eval fits");
}

console.log("\nan eval that would be refused says so before the button, in the same words");

{
  const ctx = await workspace();
  await billing.record(ctx, {
    kind: "llm.provider", idempotencyKey: `est-${randomUUID()}`, costUsd: 6,
  });
  const datasetId = await datasetOf(ctx, "agent_refused", 2);
  const status = await gate.status(ctx);
  const e = await estimateEval(ctx, store, evalStore, {
    datasetId, agentId: "agent_refused", targets: [{ provider: "anthropic", model: PRICED }],
    judgeEnabled: false, budget: status,
  });
  const a = e.affordability!;
  check(a.wouldRefuse, "the estimate knows the eval would be refused");
  const decision = await gate.mayStart(ctx, { estimateUsd: e.totalHighUsd, purpose: "eval" });
  check(!decision.ok, "and the gate refuses it");
  check(
    a.refusalMessage === decision.message,
    "with the identical sentence — one computation, so the dialog and the refusal cannot disagree",
  );
}

console.log("\nan eval bigger than the room left is flagged, not refused");

{
  // Distinct states, and the distinction matters: this one STARTS. It may stop part-way, which
  // leaves the comparison incomplete rather than wrong, and a user is better off knowing that
  // in advance than discovering it at job 300.
  const ctx = await workspace();
  await billing.record(ctx, {
    kind: "llm.provider", idempotencyKey: `est-${randomUUID()}`, costUsd: 4.999,
  });
  const datasetId = await datasetOf(ctx, "agent_big", 40);
  const e = await estimateEval(ctx, store, evalStore, {
    datasetId, agentId: "agent_big",
    targets: [{ provider: "anthropic", model: PRICED }, { provider: "anthropic", model: SECOND_PRICED }],
    judgeEnabled: true, budget: await gate.status(ctx),
  });
  const a = e.affordability!;
  check(!a.wouldRefuse, "it is not refused — the workspace is still under its ceiling");
  check(a.mayNotFinish === true, "but it is flagged as possibly not finishing");
  check(
    e.notes.some((n) => n.includes("may")),
    "and the note says what that means rather than leaving a boolean to be interpreted",
  );
}

console.log("\nan unpriced target makes 'will it fit' unknown, not false");

{
  const ctx = await workspace();
  const datasetId = await datasetOf(ctx, "agent_unpriced", 2);
  const e = await estimateEval(ctx, store, evalStore, {
    datasetId, agentId: "agent_unpriced",
    targets: [{ provider: "anthropic", model: PRICED }, { provider: "openai", model: UNPRICED }],
    judgeEnabled: false, budget: await gate.status(ctx),
  });
  check(e.hasUnpricedTarget, "the estimate flags the unpriced target");
  check(
    e.affordability?.mayNotFinish === null,
    "and whether it fits is null — reporting false would be the same lie as pricing it at zero",
  );
  check(
    e.notes.some((n) => n.includes("no pricing")),
    "the note about unpriced targets survives the widening",
  );
}

await db.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
