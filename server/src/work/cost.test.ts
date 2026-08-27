// What a job cost, and every assertion here is chosen so it could not pass against a `runs.cost`
// read.
//
// THAT IS THE WHOLE DESIGN OF THIS FILE. `runs.cost` is written by `run_end`, so it agrees with the
// steps for every run that finished normally — which means a suite built out of happy paths would
// pass identically against the wrong column and prove nothing. So every case below is one where
// the two DISAGREE: a run that crashed mid-graph, one whose container went quiet, one that is
// still executing, and one whose model has no price at all.
//
// AND THE STATEMENT COUNT, which §16 asks for by name: "The Agents grid's statement count is
// asserted equal for one agent and for forty; hold that line here." Forty jobs is the same number
// of queries as one, and the assertion is equality rather than a threshold — a threshold is a
// budget somebody spends.
//
//   npm run test:work-cost

import { randomUUID } from "node:crypto";

import { countingDb, openTestSqlite, testContext } from "../db/testDb.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { DeployStore } from "../deployStore.ts";
import { TraceStore } from "../store.ts";
import { newRequestId, systemContext, type TenantContext } from "../db/tenant.ts";
import type { Run, Step } from "../types.ts";
import { costsForItems } from "./cost.ts";
import { WorkStore, type WorkItem } from "./workStore.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** In `pricing.json`, so a real figure comes out. */
const PRICED = "claude-haiku-4-5";
/** Deliberately not. §11.1's "unknown is not zero" needs a model nothing knows the price of. */
const UNPRICED = "some-model-nobody-priced";

const base = await openTestSqlite();
const counting = countingDb(base);
const db = counting.db;
const trace = new TraceStore(db);
await trace.init();
const work = new WorkStore(db);

const identity = new IdentityRepository(db);
const agents = new AgentRepository(db);
const deploys = new DeployStore(db);
const person = await identity.provisionUser(systemContext(newRequestId()), {
  externalId: `cost-${randomUUID().slice(0, 8)}`,
  email: `cost-${randomUUID().slice(0, 8)}@example.com`,
});
const ctx: TenantContext = { ...testContext(), actorUserId: person.user.id };
const agent = await agents.upsertFromDisk(ctx, { slug: "cost_agent", display_name: "cost" });

/** A deployment on a named model, so an item's price is the deployment's decision. */
async function deploymentOn(model: string): Promise<string> {
  // BY SLUG, as `DeployManager` writes it. Nothing in this suite joins through it — costs are
  // read by deployment id — but a fixture that spelled a column differently from production is
  // one somebody copies into a suite where it does matter.
  const row = await deploys.create(ctx, { agentId: agent.slug, provider: "anthropic", model, envKeys: [] });
  await deploys.patch(ctx, row.id, { status: "live", url: "http://127.0.0.1:1" });
  return row.id;
}

const HAIKU_DEPLOYMENT = await deploymentOn(PRICED);
const UNPRICED_DEPLOYMENT = await deploymentOn(UNPRICED);

const modelByDeployment = new Map<string, string>([
  [HAIKU_DEPLOYMENT, PRICED],
  [UNPRICED_DEPLOYMENT, UNPRICED],
]);
const modelFor = (item: WorkItem): string | undefined => modelByDeployment.get(item.deployment_id);

const runRow = (runId: string, status: Run["status"], cost: number, error: string | null = null): Run => ({
  id: runId, agent_id: "cost_agent", provider: "anthropic", model: PRICED,
  status, started_at: "2026-02-03T10:00:00.000Z",
  ended_at: status === "running" ? null : "2026-02-03T10:00:04.000Z",
  cost, tokens: 0, error,
});

const step = (runId: string, seq: number, o: { cost: number | null; tokens: number | null; type?: Step["type"] }): Step => ({
  id: randomUUID(), run_id: runId, seq, type: o.type ?? "llm_call", name: "agent",
  input: null, output: null, state_before: null, state_after: null,
  tokens: o.tokens, cost: o.cost, latency_ms: 10, error: null, parent_step_id: null,
  started_at: "2026-02-03T10:00:01.000Z",
});

/** A job with a run, its steps, and whatever ending it got. */
async function job(opts: {
  deploymentId: string;
  steps: { cost: number | null; tokens: number | null; type?: Step["type"] }[];
  /** Omitted means the job is still running — no run_end, no ended_at, no duration. */
  ending?: { status: Run["status"]; runCost: number; work: "succeeded" | "failed" | "cancelled"; error?: string };
}): Promise<WorkItem> {
  const runId = randomUUID();
  const item = await work.create(ctx, {
    agentId: agent.id, deploymentId: opts.deploymentId, runId, input: "x", at: "2026-02-03T10:00:00.000Z",
  });
  await work.markRunning(ctx, item.id, "2026-02-03T10:00:00.000Z");
  await trace.upsertRun(ctx, runRow(runId, "running", 0));
  for (const [i, s] of opts.steps.entries()) await trace.insertStep(ctx, step(runId, i, s));
  if (opts.ending) {
    await trace.upsertRun(ctx, runRow(runId, opts.ending.status, opts.ending.runCost, opts.ending.error ?? null));
    await work.finish(ctx, item.id, {
      status: opts.ending.work, error: opts.ending.error ?? null, at: "2026-02-03T10:00:04.000Z",
    });
  }
  return (await work.get(ctx, item.id))!;
}

const costOf = async (item: WorkItem) =>
  (await costsForItems(ctx, db.forWorkspace(ctx.workspaceId), [item], modelFor)).get(item.id)!;

// --- 1. a run that crashed mid-graph -------------------------------------------------------------
//
// THE CASE THE WHOLE RULE EXISTS FOR. `run_end` never wrote a cost, so the run's own column reads
// whatever `run_start` put there — zero — while its steps record money that really was spent.

console.log("\na run that crashed mid-graph");
{
  const item = await job({
    deploymentId: HAIKU_DEPLOYMENT,
    steps: [{ cost: 0.00012, tokens: 120 }, { cost: 0.00031, tokens: 240 }],
    ending: { status: "error", runCost: 0, work: "failed", error: "KeyError" },
  });
  const cost = await costOf(item);
  check("its cost is the sum of its steps", cost.cost_usd === 0.00043, String(cost.cost_usd));
  check("...which its own run row does not agree with", (await trace.getRun(ctx, item.run_id!))?.cost === 0);
  check("...and its tokens are summed too", cost.tokens === 360, String(cost.tokens));
  check("...and the figure is complete, because every call was priced", cost.cost_complete === true);
}

// --- 2. unknown is not zero -----------------------------------------------------------------------

console.log("\nunknown is not zero");
{
  const item = await job({
    deploymentId: UNPRICED_DEPLOYMENT,
    steps: [{ cost: null, tokens: 500 }],
    ending: { status: "completed", runCost: 0, work: "succeeded" },
  });
  const cost = await costOf(item);
  // §11.1. Rendered `—`, never `$0.00` — an unpriced model beside a priced one as FREE is not a
  // rounding error, it is a different claim about somebody's bill.
  check("an unpriced model reports null, not zero", cost.cost_usd === null, String(cost.cost_usd));
  check("...while its tokens are still a real number", cost.tokens === 500, String(cost.tokens));
}
{
  // AND PRICED-AND-FREE IS GENUINELY $0. The gate is whether the model is in the table, not
  // whether the sum came out empty — collapsing the two would make "free" and "unknown" the same
  // cell, which is the distinction the whole rule is about.
  const item = await job({
    deploymentId: HAIKU_DEPLOYMENT,
    steps: [{ cost: 0, tokens: 0 }],
    ending: { status: "completed", runCost: 0, work: "succeeded" },
  });
  const cost = await costOf(item);
  check("a priced model that spent nothing reports zero, not unknown", cost.cost_usd === 0, String(cost.cost_usd));
}

// --- 3. partial pricing is a floor, and says so ---------------------------------------------------

console.log("\na total that is a floor");
{
  const item = await job({
    deploymentId: HAIKU_DEPLOYMENT,
    steps: [
      { cost: 0.00012, tokens: 120 },
      // An `llm_call` with tokens and no cost: something in this run could not be priced.
      { cost: null, tokens: 400 },
    ],
    ending: { status: "completed", runCost: 0, work: "succeeded" },
  });
  const cost = await costOf(item);
  check("it reports what it could price", cost.cost_usd === 0.00012, String(cost.cost_usd));
  check("...and flags that the number is a floor rather than a total", cost.cost_complete === false);
}
{
  // A TOOL CALL WITH NO COST IS NOT UNPRICED. Only an `llm_call` costs money; a tool step has no
  // price by construction, and counting it would flag every run in the product as incomplete.
  const item = await job({
    deploymentId: HAIKU_DEPLOYMENT,
    steps: [{ cost: 0.00012, tokens: 120 }, { cost: null, tokens: null, type: "tool_call" }],
    ending: { status: "completed", runCost: 0, work: "succeeded" },
  });
  check("a tool call with no cost does not make the total a floor", (await costOf(item)).cost_complete === true);
}

// --- 4. duration is the JOB's, including the wait -------------------------------------------------

console.log("\nhow long the job took");
{
  const item = await job({
    deploymentId: HAIKU_DEPLOYMENT,
    steps: [{ cost: 0.0001, tokens: 100 }],
    ending: { status: "completed", runCost: 0, work: "succeeded" },
  });
  check("a finished job reports its own wall clock", (await costOf(item)).duration_ms === 4_000,
    String((await costOf(item)).duration_ms));
}
{
  // NULL WHILE RUNNING rather than "so far". A card rendering a growing number would be reporting
  // a duration for something that has not got one, which is the same class of claim §11 refuses.
  const running = await job({ deploymentId: HAIKU_DEPLOYMENT, steps: [{ cost: 0.0001, tokens: 100 }] });
  const cost = await costOf(running);
  check("a running job has no duration yet", cost.duration_ms === null);
  check("...while the money it has already spent is readable", cost.cost_usd === 0.0001, String(cost.cost_usd));
}

// --- 5. a job that has not started ----------------------------------------------------------------

console.log("\na job with no steps at all");
{
  const runId = randomUUID();
  const item = await work.create(ctx, { agentId: agent.id, deploymentId: HAIKU_DEPLOYMENT, runId, input: "x" });
  const cost = await costOf((await work.get(ctx, item.id))!);
  // NULL RATHER THAN ZERO, and for the same reason an unpriced model is: nothing has happened yet,
  // so "$0.00" would be a claim about a job that has not run rather than a fact about one.
  check("a queued job reports no cost rather than zero", cost.cost_usd === null && cost.tokens === null);
  check("...and is not flagged as incomplete, because nothing is missing", cost.cost_complete === true);
}

// --- 6. the statement count, for one job and for forty --------------------------------------------

console.log("\none job and forty cost the same");
{
  const many: WorkItem[] = [];
  for (let i = 0; i < 40; i++) {
    many.push(await job({
      deploymentId: i % 2 === 0 ? HAIKU_DEPLOYMENT : UNPRICED_DEPLOYMENT,
      steps: [{ cost: 0.00012, tokens: 120 }],
      ending: { status: "completed", runCost: 0, work: "succeeded" },
    }));
  }

  const scoped = db.forWorkspace(ctx.workspaceId);
  counting.reset();
  await costsForItems(ctx, scoped, many.slice(0, 1), modelFor);
  const one = counting.count();

  counting.reset();
  const all = await costsForItems(ctx, scoped, many, modelFor);
  const forty = counting.count();

  check(`one job costs ${one} statement(s)`, one === 1, String(one));
  // EQUALITY, NOT A THRESHOLD. A threshold is a budget somebody spends; equality is the property.
  check(`forty cost the same (${forty})`, forty === one, `${one} vs ${forty}`);
  check("and every one of them got an answer", all.size === 40, String(all.size));
  check(
    "...with the priced half priced and the unpriced half null",
    many.filter((m) => all.get(m.id)!.cost_usd !== null).length === 20,
    String(many.filter((m) => all.get(m.id)!.cost_usd !== null).length),
  );
}

await base.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
