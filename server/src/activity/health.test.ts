// §4's definitional care, as claims — because these numbers will be quoted.
//
// FOUR RULES, AND EVERY ONE OF THEM IS A COUNT THAT LOOKS CORRECT UNTIL YOU KNOW THE CASE:
//
//   A PAUSED-AND-RESUMED RUN IS ONE RUN. Resuming continues under the same run identity and emits
//   no new start event, so the row is the count — but a strip that counted `run_start`s, or
//   distinct run ids in the step table across two segments, would report two. Half a workspace's
//   throughput invented, on the card its throughput is read from.
//
//   A BRANCH IS ONE RUN AND DOES NOT INHERIT ITS PREFIX'S SECONDS. `copyRunPrefix` copies the
//   parent's steps into the child under fresh ids, so a naive SUM charges the branch for work the
//   parent already did and both runs then carry the same seconds into the p95.
//
//   AN INTERRUPTED RUN IS NOT A FAILED ONE. A restart writes `status = 'error'` on every run it
//   killed, correctly — and a failure rate that counted them reports the server bouncing as the
//   agents being broken.
//
//   LATENCY IS SUMMED STEP TIME, NOT WALL CLOCK. A run paused for four hours and resumed has four
//   hours of wall clock and seconds of work, and a p95 from `ended_at - started_at` would make it
//   the slowest run of the month.
//
// AND THE PERCENTILE ARITHMETIC ITSELF, asserted against `agentHealth.percentiles` rather than
// against hand-written expectations: the SQL is nearest-rank in integer division and the agent card
// is nearest-rank in JavaScript, and a p95 that meant two different things on two surfaces of one
// product is worse than either being wrong.
//
//   npm run test:activity-health

import { randomUUID } from "node:crypto";

import { openTestSqlite } from "../db/testDb.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { TraceStore } from "../store.ts";
import { percentiles } from "../agentHealth.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import type { Run, Step } from "../types.ts";
import { ActivityStore } from "./activityStore.ts";
import { resolveWindow } from "./range.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const NOW = new Date("2026-08-19T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

const db = await openTestSqlite();
const identity = new IdentityRepository(db);
const agents = new AgentRepository(db);
const trace = new TraceStore(db);
const store = new ActivityStore(db);
const w = resolveWindow("24h", NOW, null);

async function workspace(name: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `${name} ${randomUUID().slice(0, 6)}`,
  });
  const ctx = systemContextFor(ws.id, newRequestId());
  await agents.upsertFromDisk(ctx, { slug: "worker", display_name: "Worker" });
  return ctx;
}

/** A run with a given status and a list of per-step latencies, one step per entry. */
async function runWith(
  ctx: TenantContext,
  opts: {
    status: Run["status"] | "paused";
    at: string;
    latencies: number[];
    error?: string | null;
    id?: string;
    parentRunId?: string | null;
    branchFromSeq?: number | null;
    firstSeq?: number;
  },
): Promise<string> {
  const runId = opts.id ?? randomUUID();
  await trace.upsertRun(ctx, {
    id: runId, agent_id: "worker", provider: "anthropic", model: "claude-haiku-4-5",
    status: opts.status as Run["status"], started_at: opts.at,
    ended_at: opts.status === "completed" || opts.status === "error" ? opts.at : null,
    cost: 0, tokens: 0, error: opts.error ?? null,
  } as Run);
  const first = opts.firstSeq ?? 0;
  for (let i = 0; i < opts.latencies.length; i++) {
    await trace.insertStep(ctx, {
      id: randomUUID(), run_id: runId, seq: first + i, type: "llm_call", name: "call_model",
      input: null, output: null, state_before: null, state_after: null,
      tokens: 1, cost: 0, latency_ms: opts.latencies[i]!, error: null,
      parent_step_id: null, started_at: opts.at,
    } as Step);
  }
  return runId;
}

// --- one run, whatever the pause did ------------------------------------------------------------

console.log("\na paused-and-resumed run is one run");
{
  const ctx = await workspace("resume");
  const runId = await runWith(ctx, { status: "paused", at: ago(3 * HOUR), latencies: [500, 500] });

  const paused = await store.runHealth(ctx, w);
  check("while paused it counts once, and as paused", paused.runs === 1 && paused.paused === 1);
  check("...and has not settled, so there is no rate yet", paused.successRate === null);

  // RESUMING IS THE SAME ROW AND MORE STEPS. The subprocess continues the timeline from the run's
  // highest seq — no `run_start`, no second row — so the honest simulation is exactly this.
  const resumeFrom = (await trace.maxSeqForRun(ctx, runId)) + 1;
  await trace.upsertRun(ctx, {
    id: runId, agent_id: "worker", provider: "anthropic", model: "claude-haiku-4-5",
    status: "completed", started_at: ago(3 * HOUR), ended_at: ago(HOUR),
    cost: 0, tokens: 0, error: null,
  } as Run);
  for (let i = 0; i < 2; i++) {
    await trace.insertStep(ctx, {
      id: randomUUID(), run_id: runId, seq: resumeFrom + i, type: "llm_call", name: "call_model",
      input: null, output: null, state_before: null, state_after: null,
      tokens: 1, cost: 0, latency_ms: 500, error: null, parent_step_id: null, started_at: ago(HOUR),
    } as Step);
  }

  const after = await store.runHealth(ctx, w);
  check("after resuming it is still one run, not two", after.runs === 1, `${after.runs}`);
  check("...and it is a success", after.ok === 1 && after.successRate === 1);
  // The wall clock across this run is two hours. Its work is four half-second steps.
  check(
    "and its latency is the work, not the two hours it was paused for",
    after.p50 === 2000,
    `${after.p50}ms`,
  );
}

// --- a branch is one run, and only its own work -------------------------------------------------

console.log("\na branch counts as one run and does not inherit its prefix's seconds");
{
  const ctx = await workspace("branch");
  // A parent with four steps of a second each.
  const parent = await runWith(ctx, { status: "completed", at: ago(4 * HOUR), latencies: [1000, 1000, 1000, 1000] });
  const parentOnly = await store.runHealth(ctx, w);
  check("the parent's latency is its own four seconds", parentOnly.p50 === 4000, `${parentOnly.p50}ms`);

  // Branch at seq 1, exactly as `branchRun` does: the prefix `seq <= 1` is copied under fresh ids
  // and `branch_from_seq` records where the copy stops.
  const branchId = randomUUID();
  await trace.copyRunPrefix(ctx, parent, branchId, 1, 1);
  await trace.upsertRun(ctx, {
    id: branchId, agent_id: "worker", provider: "anthropic", model: "claude-haiku-4-5",
    status: "completed", started_at: ago(2 * HOUR), ended_at: ago(2 * HOUR),
    cost: 0, tokens: 0, error: null,
  } as Run);
  // Its own new work: one step, half a second, past the branch point.
  await trace.insertStep(ctx, {
    id: randomUUID(), run_id: branchId, seq: 2, type: "llm_call", name: "call_model",
    input: null, output: null, state_before: null, state_after: null,
    tokens: 1, cost: 0, latency_ms: 500, error: null, parent_step_id: null, started_at: ago(2 * HOUR),
  } as Step);

  const both = await store.runHealth(ctx, w);
  check("the branch is a run of its own", both.runs === 2, `${both.runs}`);
  // The whole point: the branch's own latency is 500ms, not 2,500ms. The two copied steps belong
  // to the parent's total and to nobody else's.
  check(
    "and carries only its own 500ms, not the two seconds it inherited",
    both.p50 === 500,
    `p50 ${both.p50}ms, p95 ${both.p95}ms`,
  );
  check("the parent still carries all four of its own seconds", both.p95 === 4000, `${both.p95}ms`);
}

// --- interrupted is not failed --------------------------------------------------------------------

console.log("\nan interrupted run is a distinct outcome from a failure");
{
  const ctx = await workspace("interrupted");
  await runWith(ctx, { status: "completed", at: ago(5 * HOUR), latencies: [100] });
  await runWith(ctx, { status: "completed", at: ago(4 * HOUR), latencies: [100] });
  await runWith(ctx, { status: "completed", at: ago(3 * HOUR), latencies: [100] });
  // A genuine failure inside the agent.
  await runWith(ctx, { status: "error", at: ago(2 * HOUR), latencies: [100], error: "ValueError: no" });
  // And two the control plane closed out. Both write `status = 'error'` on the row.
  await runWith(ctx, { status: "error", at: ago(HOUR), latencies: [100], error: TraceStore.INTERRUPTED_BY_RESTART });
  await runWith(ctx, { status: "error", at: ago(HOUR), latencies: [100], error: TraceStore.CANCELLED_BY_USER });

  const h = await store.runHealth(ctx, w);
  check("every run is counted in the total", h.runs === 6, `${h.runs}`);
  check("only the real failure is a failure", h.failed === 1, `${h.failed}`);
  check("the restart and the cancellation are their own slice", h.interrupted === 2, `${h.interrupted}`);
  // 3 of 4 settled, not 3 of 6. The difference is the whole rule.
  check("the success rate is over failures only", h.successRate === 0.75, `${h.successRate}`);
  check(
    "...which is not what folding them in would give",
    h.successRate !== 0.5,
    "3/6 would read as a workspace half broken by a deploy",
  );
}

// --- a rate over nothing is not zero ---------------------------------------------------------------

console.log("\nnothing settled is not everything failed");
{
  const ctx = await workspace("unsettled");
  const empty = await store.runHealth(ctx, w);
  check("an empty range has no rate at all", empty.successRate === null);
  check("...and no percentiles", empty.p50 === null && empty.p95 === null);
  check("...and no runs", empty.runs === 0);

  await runWith(ctx, { status: "running", at: ago(HOUR), latencies: [200] });
  const live = await store.runHealth(ctx, w);
  check("a run still executing is counted in the total", live.runs === 1 && live.running === 1);
  check("...and still leaves the rate unknown rather than zero", live.successRate === null);
}

// --- the percentile means the same thing here and on an agent card ------------------------------

console.log("\nthe p50 and p95 are the same nearest-rank rule the agent card uses");
{
  const ctx = await workspace("percentiles");
  // Twenty runs of one step each, at distinct durations, so every rank is unambiguous.
  const durations = [80, 120, 140, 200, 240, 260, 300, 340, 380, 420, 460, 520, 580, 640, 700, 820, 960, 1_200, 1_800, 4_000];
  for (let i = 0; i < durations.length; i++) {
    await runWith(ctx, { status: "completed", at: ago((i + 1) * 120_000), latencies: [durations[i]!] });
  }

  const h = await store.runHealth(ctx, w);
  const expected = percentiles(durations);
  check(`p50 matches the pure module (${h.p50} vs ${expected.p50})`, h.p50 === expected.p50);
  check(`p95 matches the pure module (${h.p95} vs ${expected.p95})`, h.p95 === expected.p95);
  // Nearest-rank returns a duration a real run actually took, which is the property that makes it
  // findable in the list beside it.
  check("and both are durations a run actually took", durations.includes(h.p50!) && durations.includes(h.p95!));

  // An odd count and a count of one, which is where an off-by-one in `ceil(q × n)` shows up.
  const one = await workspace("one run");
  await runWith(one, { status: "completed", at: ago(HOUR), latencies: [333] });
  const single = await store.runHealth(one, w);
  check("one settled run is its own p50 and p95", single.p50 === 333 && single.p95 === 333);
}

// --- the previous window's rate, for the delta -----------------------------------------------------

console.log("\nthe delta baseline is the previous window's own rate");
{
  const ctx = await workspace("trend");
  // This window: 3 of 4.
  await runWith(ctx, { status: "completed", at: ago(2 * HOUR), latencies: [100] });
  await runWith(ctx, { status: "completed", at: ago(2 * HOUR), latencies: [100] });
  await runWith(ctx, { status: "completed", at: ago(2 * HOUR), latencies: [100] });
  await runWith(ctx, { status: "error", at: ago(2 * HOUR), latencies: [100], error: "nope" });
  // The previous 24 hours: 1 of 2.
  await runWith(ctx, { status: "completed", at: ago(30 * HOUR), latencies: [100] });
  await runWith(ctx, { status: "error", at: ago(30 * HOUR), latencies: [100], error: "nope" });

  const h = await store.runHealth(ctx, w);
  check("this window's rate", h.successRate === 0.75, `${h.successRate}`);
  check("the previous window's rate", h.previousSuccessRate === 0.5, `${h.previousSuccessRate}`);
  check("and this window's total excludes the previous one's runs", h.runs === 4, `${h.runs}`);
}

await db.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
