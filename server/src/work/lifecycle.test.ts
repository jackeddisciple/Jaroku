// The trace drives the state, and this is what proves it rather than asserting it.
//
// EVERY TRANSITION IS DRIVEN BY AN EVENT A CONTAINER ACTUALLY PUSHED, through the real control
// plane routes, off the real bus, into the real store. That is the whole claim §6.5 makes — "from
// here the trace drives the state, not the HTTP response" — and a suite that called
// `lifecycle.onRunEnd(ctx, run)` by hand would be asserting that a method works, which nobody
// doubted. What is worth checking is that the events the product already ingests reach it.
//
// THE HARDEST ONE IS THE CANCELLATION, and it is the reason this file exists in the shape it does.
// The frozen schema has three run statuses and a cancelled run is stored as `error` with a
// sentence against it, so `cancelled` and `failed` arrive as the same event. What separates them
// is the `ctrl: "cancelled"` line the runner emits at the boundary FIRST — and the assertion that
// matters is the negative one beside it: the same `run_end` with no boundary line before it is a
// failure, not a cancellation.
//
//   npm run test:work-lifecycle

import { randomBytes, randomUUID } from "node:crypto";

import { DeployReconciler, STOPPED_REPORTING } from "../deployReconcile.ts";
import { DeployRuns } from "../deployRuns.ts";
import { DeployStore } from "../deployStore.ts";
import { RunEventBus } from "../sandbox/eventBus.ts";
import { RunTokenRevocationList } from "../sandbox/runTokens.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { openTestSqlite, testContext } from "../db/testDb.ts";
import { newRequestId, systemContext, type TenantContext } from "../db/tenant.ts";
import { TraceStore } from "../store.ts";
import { SCHEMA_VERSION, type Run, type Step } from "../types.ts";
import { WorkLifecycle } from "./lifecycle.ts";
import { WorkStore, type WorkItem } from "./workStore.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const db = await openTestSqlite();
const trace = new TraceStore(db);
await trace.init();
const work = new WorkStore(db);

const identity = new IdentityRepository(db);
const agents = new AgentRepository(db);
const deploys = new DeployStore(db);
const person = await identity.provisionUser(systemContext(newRequestId()), {
  externalId: `lifecycle-${randomUUID().slice(0, 8)}`,
  email: `lifecycle-${randomUUID().slice(0, 8)}@example.com`,
});
const ctx: TenantContext = { ...testContext(), actorUserId: person.user.id };
const agent = await agents.upsertFromDisk(ctx, { slug: "lifecycle_agent", display_name: "lifecycle" });
const deployment = await deploys.create(ctx, {
  agentId: agent.id, provider: "anthropic", model: "claude-haiku-4-5", envKeys: [],
});
await deploys.patch(ctx, deployment.id, { status: "live", url: "http://127.0.0.1:1" });

const lifecycle = new WorkLifecycle({ work, steps: (c, runId) => trace.stepsForRun(c, runId) });

// THE INGEST CHAIN, AS index.ts WIRES IT — persist what arrives, attributed by the entry that
// registered it, then move the work item. Written out here rather than imported because index.ts
// is a module with a server in it; what is being reproduced is the ORDER, which is the part that
// matters: the run row is written before the lifecycle reads its steps.
const bus = new RunEventBus();
const revocations = new RunTokenRevocationList();
const deployRuns = new DeployRuns({ signingKey: randomBytes(32), revocations, bus });
const pending: Promise<unknown>[] = [];
deployRuns.on("event", ({ runId, event }) => {
  const claimed = event.kind === "step" ? event.step.run_id : event.run.id;
  if (claimed !== runId) return;
  pending.push((async () => {
    if (event.kind === "step") await trace.insertStep(ctx, event.step);
    else await trace.upsertRun(ctx, event.run);
    if (event.kind === "run_end") await lifecycle.onRunEnd(ctx, event.run);
  })());
});
deployRuns.on("control", ({ runId, ctrl }) => {
  // The one branch the Cockpit adds to index.ts's control handler. Everything else there is
  // already Part 1's.
  if (ctrl["ctrl"] === "cancelled") lifecycle.noteCancelledAtBoundary(runId);
});

const settle = async (): Promise<void> => { await Promise.all(pending.splice(0)); };

/** A dispatched job, opened on the bus the way the dispatcher opens one. */
async function dispatched(input: string): Promise<{ item: WorkItem; runId: string }> {
  const runId = randomUUID();
  const item = await work.create(ctx, {
    agentId: agent.id, deploymentId: deployment.id, runId, input,
  });
  deployRuns.open({ runId, workspaceId: ctx.workspaceId, deploymentId: deployment.id, agentId: agent.id });
  await work.markRunning(ctx, item.id);
  return { item, runId };
}

const runRow = (runId: string, status: Run["status"], error: string | null = null): Run => ({
  id: runId, agent_id: "lifecycle_agent", provider: "anthropic", model: "claude-haiku-4-5",
  status, started_at: new Date().toISOString(),
  ended_at: status === "running" ? null : new Date().toISOString(),
  cost: 0, tokens: 0, error,
});

const stepRow = (runId: string, seq: number, output: unknown): Step => ({
  id: randomUUID(), run_id: runId, seq, type: "llm_call", name: "agent",
  input: { q: "hi" }, output, state_before: null, state_after: null,
  tokens: 40, cost: 0.0001, latency_ms: 12, error: null, parent_step_id: null,
  started_at: new Date().toISOString(),
});

// --- 1. run_end closes the item ------------------------------------------------------------------

console.log("\nrun_end closes it");
{
  const { item, runId } = await dispatched("refund order 4471");
  check("the job is running while the container has it", (await work.get(ctx, item.id))?.status === "running");

  bus.pushTrace(runId, { kind: "run_start", schema_version: SCHEMA_VERSION, run: runRow(runId, "running") });
  bus.pushTrace(runId, {
    kind: "step", schema_version: SCHEMA_VERSION,
    step: stepRow(runId, 0, [{ content: "Refunded £41.20 to order 4471." }]),
  });
  bus.pushTrace(runId, { kind: "run_end", schema_version: SCHEMA_VERSION, run: runRow(runId, "completed") });
  await settle();

  const done = await work.get(ctx, item.id);
  check("a completed run_end closes it as succeeded", done?.status === "succeeded", done?.status);
  check("...with an ended_at", done?.ended_at !== null);
  // WHAT CAME BACK, through the same extraction the judge scores — one answer in this product
  // rather than two that can disagree about what the agent said.
  check("...carrying what the agent actually said", done?.output === "Refunded £41.20 to order 4471.", done?.output ?? "(null)");
  check("...and no failure kind", done?.failure_kind === null);
  check("...leaving nothing against the concurrency cap", (await work.inFlight(ctx)) === 0);

  // AT-LEAST-ONCE INGEST IS NOT HYPOTHETICAL — the relay redelivers a buffered batch on reconnect.
  // A second run_end must not move an item that has ended, or a job somebody cancelled would be
  // rewritten as succeeded by a redelivery.
  bus.pushTrace(runId, { kind: "run_end", schema_version: SCHEMA_VERSION, run: runRow(runId, "error", "boom") });
  await settle();
  check("a redelivered run_end does not rewrite the outcome", (await work.get(ctx, item.id))?.status === "succeeded");
}

// --- 2. an agent that raised ----------------------------------------------------------------------

console.log("\nan agent that raised");
{
  const { item, runId } = await dispatched("break something");
  bus.pushTrace(runId, { kind: "run_start", schema_version: SCHEMA_VERSION, run: runRow(runId, "running") });
  bus.pushTrace(runId, {
    kind: "run_end", schema_version: SCHEMA_VERSION,
    run: runRow(runId, "error", "KeyError: 'order_id'"),
  });
  await settle();

  const failed = await work.get(ctx, item.id);
  check("an errored run_end fails the job", failed?.status === "failed", failed?.status);
  check("...as agent_error, because the trace has the failing step", failed?.failure_kind === "agent_error");
  check("...carrying what the agent said went wrong", failed?.error === "KeyError: 'order_id'");
}

// --- 3. cancelled, and the negative beside it -----------------------------------------------------

console.log("\ncancelled at a node boundary");
{
  const { item, runId } = await dispatched("this one gets stopped");
  bus.pushTrace(runId, { kind: "run_start", schema_version: SCHEMA_VERSION, run: runRow(runId, "running") });
  // THE BOUNDARY LINE THE RUNNER EMITS BEFORE IT ENDS. Without it the run_end below is
  // indistinguishable from a crash — which is the assertion immediately after this block.
  bus.pushControlLine(runId, { ctrl: "cancelled", run_id: runId, seq_high: 1, checkpoint_id: "cp-1", next: [] });
  bus.pushTrace(runId, {
    kind: "run_end", schema_version: SCHEMA_VERSION,
    run: runRow(runId, "error", "Cancelled: the run was stopped at a node boundary"),
  });
  await settle();

  const cancelled = await work.get(ctx, item.id);
  check("a boundary cancellation closes the job as cancelled", cancelled?.status === "cancelled", cancelled?.status);
  // NO FAILURE KIND. The six kinds all answer "what went wrong", and nothing went wrong.
  check("...with no failure kind, because nothing failed", cancelled?.failure_kind === null);
  check("...keeping the sentence that explains why the last node finished", /node boundary/.test(cancelled?.error ?? ""));
}
{
  // THE SAME run_end WITH NO BOUNDARY LINE BEFORE IT. This is the assertion that makes the one
  // above mean something: if the cancellation were inferred from the error text, this would be a
  // cancellation too, and a crashing agent would report as "somebody stopped it".
  const { item, runId } = await dispatched("this one just dies");
  bus.pushTrace(runId, { kind: "run_start", schema_version: SCHEMA_VERSION, run: runRow(runId, "running") });
  bus.pushTrace(runId, {
    kind: "run_end", schema_version: SCHEMA_VERSION,
    run: runRow(runId, "error", "Cancelled: the run was stopped at a node boundary"),
  });
  await settle();
  const notCancelled = await work.get(ctx, item.id);
  check("the same ending with no boundary line is a failure, not a cancellation",
    notCancelled?.status === "failed" && notCancelled?.failure_kind === "agent_error", notCancelled?.status);
}

// --- 4. waiting on a person, and back -------------------------------------------------------------

console.log("\nwaiting on a person");
{
  const { item, runId } = await dispatched("refund this, it needs approval");
  bus.pushTrace(runId, { kind: "run_start", schema_version: SCHEMA_VERSION, run: runRow(runId, "running") });
  await settle();

  check("a confirmation request parks the job", (await lifecycle.onConfirmRequested(ctx, runId)) !== undefined);
  const waiting = await work.get(ctx, item.id);
  check("...as waiting, the one state a human is the blocker in", waiting?.status === "waiting", waiting?.status);
  check("...which is what the badge counts", (await work.countsByStatus(ctx)).waiting === 1);
  check("...and it is still in flight", (await work.inFlight(ctx)) >= 1);

  // A SECOND REQUEST ON THE SAME RUN MOVES NOTHING. The gate can ask twice — a graph calling two
  // high-impact tools — and the item is already parked.
  check("a second request while already waiting moves nothing", (await lifecycle.onConfirmRequested(ctx, runId)) === undefined);

  check("an answer puts it back to running", (await lifecycle.onConfirmResolved(ctx, runId)) !== undefined);
  check("...and only running, not finished", (await work.get(ctx, item.id))?.status === "running");
  // EVERY PATH THAT CLOSES A CONFIRMATION CALLS THIS — the resolve, the expiry sweep and the
  // runner's own tool_confirm_closed all arrive for one nonce. Only the first finds a waiting row.
  check("a second answer moves nothing", (await lifecycle.onConfirmResolved(ctx, runId)) === undefined);

  bus.pushTrace(runId, { kind: "run_end", schema_version: SCHEMA_VERSION, run: runRow(runId, "completed") });
  await settle();
  check("and the run_end that follows still closes it", (await work.get(ctx, item.id))?.status === "succeeded");
}
{
  // A CONFIRMATION FOR A RUN THAT IS NOT A WORK ITEM. Every local run in the product goes through
  // the same gate, so this path is walked constantly by runs the Cockpit knows nothing about.
  check("a confirmation on a run with no work item is ignored",
    (await lifecycle.onConfirmRequested(ctx, randomUUID())) === undefined);
}

// --- 5. the container that went quiet -------------------------------------------------------------

console.log("\nthe container that stopped reporting");
{
  let clock = Date.now();
  const sweepRuns = new DeployRuns({ signingKey: randomBytes(32), revocations, bus, now: () => clock });
  sweepRuns.on("event", ({ runId, event }) => {
    const claimed = event.kind === "step" ? event.step.run_id : event.run.id;
    if (claimed !== runId) return;
    pending.push((async () => {
      if (event.kind === "step") await trace.insertStep(ctx, event.step);
      else await trace.upsertRun(ctx, event.run);
      if (event.kind === "run_end") await lifecycle.onRunEnd(ctx, event.run);
    })());
  });
  const reconciler = new DeployReconciler({
    runs: sweepRuns, bus, store: trace, contextFor: () => ctx, now: () => clock,
  });

  const runId = randomUUID();
  const item = await work.create(ctx, {
    agentId: agent.id, deploymentId: deployment.id, runId, input: "this one goes quiet",
  });
  sweepRuns.open({ runId, workspaceId: ctx.workspaceId, deploymentId: deployment.id, agentId: agent.id });
  await work.markRunning(ctx, item.id);
  bus.pushTrace(runId, { kind: "run_start", schema_version: SCHEMA_VERSION, run: runRow(runId, "running") });
  bus.pushTrace(runId, { kind: "step", schema_version: SCHEMA_VERSION, step: stepRow(runId, 0, [{ content: "half done" }]) });
  await settle();

  clock += 20 * 60 * 1000;
  const closed = await reconciler.sweep();
  check("the sweep closes a container that has said nothing for twenty minutes", closed.length === 1, String(closed.length));
  await settle();

  const quiet = await work.get(ctx, item.id);
  // NOT `failed` AS A WORD, AND NOT `agent_error` AS A KIND. §11.3: it went quiet, it MAY have
  // completed, and it MAY have spent money. The kind is what the card reads to say so.
  check("the job is closed out as stopped_reporting", quiet?.failure_kind === "stopped_reporting", quiet?.failure_kind ?? "(none)");
  check("...with the reason that says what is known and what is not", quiet?.error === STOPPED_REPORTING);
  check("...and the step it managed to push is still on the trace",
    (await trace.stepsForRun(ctx, runId)).length === 1);
  check("...so what it spent before it went is still readable", (await trace.stepsForRun(ctx, runId))[0]!.cost === 0.0001);
}

await db.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
