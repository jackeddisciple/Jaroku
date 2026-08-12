// What a run costs, recorded from its steps — and the four ways that can go wrong.
//
// The suite is written around the failures rather than around the happy path, because the
// happy path here is one INSERT and the failures are all silent:
//
//   1. Billing from `runs.cost` instead of `steps.cost`. A run that crashes mid-graph never
//      emits run_end, so its row reads 0 while its steps record real money already spent —
//      the exact population a retry storm produces, silently un-billed.
//   2. Billing a redelivered batch twice. Ingestion is at-least-once by design.
//   3. Dropping an unpriced call, so an unpriced model looks like a model nobody used and the
//      workspace's total is a confident undercount rather than a flagged one.
//   4. Metering a branch's copied steps, which are rows for calls that already happened once.
//
//   npm run test:metering

import { randomUUID } from "node:crypto";
import { openTestSqlite, testContext } from "../db/testDb.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { TraceStore } from "../store.ts";
import type { Run, Step, StepType } from "../types.ts";
import { UsageMeter, usageKey } from "./usage.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const db = await openTestSqlite();
const ctx = testContext();
const store = new TraceStore(db);
await store.init();
const billing = new BillingRepository(db);
const meter = new UsageMeter(billing, async (c, runId) => {
  const run = await store.getRun(c, runId);
  return run ? { provider: run.provider, model: run.model } : null;
});

const EPOCH = "1970-01-01T00:00:00.000Z";

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: randomUUID(),
    agent_id: "billing_agent",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    status: "running",
    started_at: new Date().toISOString(),
    ended_at: null,
    // Deliberately a lie in some tests below: nothing may read this number.
    cost: 0,
    tokens: 0,
    error: null,
    ...over,
  };
}

function makeStep(runId: string, seq: number, over: Partial<Step> = {}): Step {
  return {
    id: randomUUID(),
    run_id: runId,
    seq,
    type: "llm_call" as StepType,
    name: "model",
    input: null,
    output: null,
    state_before: null,
    state_after: null,
    tokens: 1_000,
    cost: 0.01,
    latency_ms: 12,
    error: null,
    parent_step_id: null,
    started_at: new Date().toISOString(),
    ...over,
  };
}

console.log("\none row per model call, priced from the step");

{
  const run = makeRun();
  await store.upsertRun(ctx, run);
  meter.noteRun(run.id, run.provider, run.model);

  const steps = [
    makeStep(run.id, 0, { cost: 0.01, tokens: 1_000 }),
    makeStep(run.id, 1, { cost: 0.02, tokens: 2_000 }),
  ];
  for (const s of steps) {
    await store.insertStep(ctx, s);
    await meter.meterStep(ctx, s);
  }

  const rows = await billing.eventsForRun(ctx, run.id);
  check(rows.length === 2, "two llm_call steps produce two usage rows");
  check(rows.every((r) => r.kind === "llm.provider"), "both are llm.provider");
  check(rows.every((r) => r.provider === "anthropic" && r.model === "claude-sonnet-4-5"),
    "each carries the provider and model from the run, which the step does not");
  check(rows.every((r) => r.cost_known), "both are priced");
  check(
    Math.abs(rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0) - 0.03) < 1e-9,
    "and their costs are the steps' own",
  );
  check(rows.reduce((s, r) => s + (r.total_tokens ?? 0), 0) === 3_000,
    "the combined token figure survives, since the frozen schema has no split to record");
  check(rows.every((r) => r.input_tokens === null && r.output_tokens === null),
    "...and the split columns stay null rather than being invented");
}

console.log("\ncost comes from the steps, never from runs.cost");

{
  // The case the rule exists for: a run that died mid-graph. No run_end ever arrived, so the
  // row still reads 0 — while its steps record money that was really spent.
  const run = makeRun({ status: "error", cost: 0, tokens: 0, error: "crashed" });
  await store.upsertRun(ctx, run);
  meter.noteRun(run.id, run.provider, run.model);
  const s = makeStep(run.id, 0, { cost: 0.5, tokens: 40_000 });
  await store.insertStep(ctx, s);
  await meter.meterStep(ctx, s);

  const rows = await billing.eventsForRun(ctx, run.id);
  check(rows.length === 1, "a crashed run's step is still metered");
  check(rows[0]?.cost_usd === 0.5, "at what the STEP says, not the 0 on the run row");
  check((await store.getRun(ctx, run.id))?.cost === 0, "...and the run row is still the 0 that would have lost it");
}

console.log("\nat-least-once delivery cannot bill twice");

{
  const run = makeRun();
  await store.upsertRun(ctx, run);
  meter.noteRun(run.id, run.provider, run.model);
  const s = makeStep(run.id, 0, { cost: 0.04 });

  const first = await meter.meterStep(ctx, s);
  const second = await meter.meterStep(ctx, s);
  const third = await meter.meterStep(ctx, s);
  check(first, "the first delivery records a row");
  check(!second && !third, "redeliveries record nothing, and say so rather than throwing");
  check((await billing.eventsForRun(ctx, run.id)).length === 1, "one row, three deliveries");
  check(
    (await billing.eventsForRun(ctx, run.id))[0]?.idempotency_key === usageKey("llm.provider", s.id),
    "keyed by the step's own id — the one thing that survives redelivery",
  );
}

console.log("\nunknown is not zero, and not absent either");

{
  const run = makeRun({ provider: "openai", model: "some-model-nobody-priced" });
  await store.upsertRun(ctx, run);
  meter.noteRun(run.id, run.provider, run.model);
  // Tokens, no cost: the interceptor metered a real call against a model with no pricing row.
  const s = makeStep(run.id, 0, { tokens: 5_000, cost: null });
  await store.insertStep(ctx, s);
  check(await meter.meterStep(ctx, s), "an unpriced call is still metered");

  const [row] = await billing.eventsForRun(ctx, run.id);
  check(row?.cost_usd === null, "with a null cost");
  check(row?.cost_known === false, "and cost_known false, so a total built from it can say it is a floor");
  check(row?.total_tokens === 5_000, "the tokens are known even though the price is not");

  const spend = await billing.spendSince(ctx, EPOCH);
  check(!spend.costKnown, "the workspace's rollup reports itself as incomplete");
  check(spend.unpricedEvents >= 1, "and names how many rows it could not price");
}

console.log("\nonly model calls are metered");

{
  const run = makeRun();
  await store.upsertRun(ctx, run);
  meter.noteRun(run.id, run.provider, run.model);
  const quiet: Step[] = [
    makeStep(run.id, 0, { type: "tool_call", name: "search", tokens: null, cost: null }),
    makeStep(run.id, 1, { type: "state_update", name: "merge", tokens: null, cost: null }),
    makeStep(run.id, 2, { type: "router", name: "route", tokens: null, cost: null }),
    // An llm_call the interceptor could not extract usage from at all. Nothing to bill and
    // nothing to flag — a row here would claim a call we cannot describe.
    makeStep(run.id, 3, { type: "llm_call", tokens: null, cost: null }),
  ];
  for (const s of quiet) {
    await store.insertStep(ctx, s);
    check(!(await meter.meterStep(ctx, s)), `a ${s.type} with no usage is not metered`);
  }
  check((await billing.eventsForRun(ctx, run.id)).length === 0, "and the run has no usage rows at all");
}

console.log("\na branch copies rows, not calls");

{
  const parent = makeRun();
  await store.upsertRun(ctx, parent);
  meter.noteRun(parent.id, parent.provider, parent.model);
  const s = makeStep(parent.id, 0, { cost: 0.07 });
  await store.insertStep(ctx, s);
  await meter.meterStep(ctx, s);
  await store.setCheckpointUpto(ctx, parent.id, 0, "cp-1");

  const before = await billing.spendSince(ctx, EPOCH);
  const branchId = randomUUID();
  await store.copyRunPrefix(ctx, parent.id, branchId, 0, 0);
  const after = await billing.spendSince(ctx, EPOCH);

  check((await store.stepsForRun(ctx, branchId)).length === 1, "the branch has the parent's step");
  check((await billing.eventsForRun(ctx, branchId)).length === 0, "and no usage rows of its own");
  check(after.usd === before.usd, "branching costs nothing — money is metered where a call happens");
}

console.log("\nthe run's model is resolved even with nothing cached");

{
  const run = makeRun({ provider: "openai", model: "gpt-5" });
  await store.upsertRun(ctx, run);
  // No noteRun: exactly the state a resumed segment or a restarted process is in.
  const s = makeStep(run.id, 0, { cost: 0.03 });
  await store.insertStep(ctx, s);
  await meter.meterStep(ctx, s);
  const [row] = await billing.eventsForRun(ctx, run.id);
  check(row?.provider === "openai" && row?.model === "gpt-5",
    "a cache miss falls back to the run row rather than recording an anonymous charge");
}

await db.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
