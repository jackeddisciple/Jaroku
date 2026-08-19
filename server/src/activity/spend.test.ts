// §2's four honesty rules, each one a bug this product has already shipped once.
//
// They are asserted here rather than trusted to the comment above the query, because all four fail
// SILENTLY: the number is present, plausible, and wrong, on a card whose whole purpose is to be
// screenshotted and quoted.
//
//   COST IS SUMMED FROM WHAT WAS ACTUALLY SPENT, never read off a run-level field. `runs.cost` is
//   written by `run_end`, and the fixture here deliberately leaves it at zero — so a query that read
//   it would report nothing at all and this suite would say so.
//
//   A CRASHED RUN STILL CONTRIBUTED COST. It died mid-graph, `run_end` never fired, and its
//   completed steps hold real spend. A crashed run reporting zero was a shipped bug.
//
//   CACHED TOKENS BILL AT THE CACHED RATE. Billing them at the full input rate overstated cost by up
//   to ten times. That arithmetic lives in `pricing.costFor` and nowhere else, and the assertion
//   here is that this tab reads what that produced rather than recomputing it — a second calculator
//   is the failure, not a wrong multiplier.
//
//   AN UNPRICED MODEL IS COST UNKNOWN AND IS EXCLUDED FROM EVERY RANKING. It never renders as $0.
//   The total that omits it says so, by name and by count, so the card can write `$12.40 · 2 agents
//   unpriced` rather than a number that quietly leaves them out.
//
// AND §3'S CACHED SPLIT, which has a subtler version of the same problem: a usage row records a
// cache breakdown only when the caller had one, so a null there means "not measured" and not "none
// cached". A card that read it as zero would report that prompt caching is not engaging in a
// workspace where nobody has looked.
//
//   npm run test:activity-spend

import { randomUUID } from "node:crypto";

import { openTestSqlite } from "../db/testDb.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { TraceStore } from "../store.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import type { Run, Step } from "../types.ts";
import { costFor, isPriced } from "../pricing.ts";
import { ActivityStore } from "./activityStore.ts";
import { resolveWindow } from "./range.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const NOW = new Date("2026-08-19T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;
const cents = (n: number): number => Math.round(n * 100);

const db = await openTestSqlite();
const identity = new IdentityRepository(db);
const billing = new BillingRepository(db);
const agents = new AgentRepository(db);
const trace = new TraceStore(db);
const store = new ActivityStore(db);
const w = resolveWindow("24h", NOW, null);

async function workspace(name: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `${name} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

/** A run and its one model step, with `runs.cost` left at zero on purpose. See the header. */
async function run(
  ctx: TenantContext,
  opts: {
    agent: string;
    status: "completed" | "error";
    at: string;
    model: string;
    tokens: number;
    /** `null` is an unpriced model: the ledger records the tokens and no cost. */
    costUsd: number | null;
    cachedInputTokens?: number | null;
    latencyMs?: number;
  },
): Promise<string> {
  const runId = randomUUID();
  await trace.upsertRun(ctx, {
    id: runId, agent_id: opts.agent, provider: "anthropic", model: opts.model,
    status: opts.status, started_at: opts.at,
    ended_at: opts.status === "error" ? null : new Date(Date.parse(opts.at) + 1_000).toISOString(),
    cost: 0, tokens: 0, error: opts.status === "error" ? "boom" : null,
  } as Run);
  await trace.insertStep(ctx, {
    id: randomUUID(), run_id: runId, seq: 0, type: "llm_call", name: "call_model",
    input: null, output: null, state_before: null, state_after: null,
    tokens: opts.tokens, cost: opts.costUsd, latency_ms: opts.latencyMs ?? 500, error: null,
    parent_step_id: null, started_at: opts.at,
  } as Step);
  await billing.record(ctx, {
    kind: "llm.provider",
    idempotencyKey: `spend-${runId}`,
    runId,
    provider: "anthropic",
    model: opts.model,
    totalTokens: opts.tokens,
    cachedInputTokens: opts.cachedInputTokens ?? null,
    costUsd: opts.costUsd,
    occurredAt: opts.at,
  });
  return runId;
}

// --- the crashed run, and the run-level field nothing may read ---------------------------------

console.log("\na run that crashed partway still contributed cost");
{
  const ctx = await workspace("crashed");
  await agents.upsertFromDisk(ctx, { slug: "worker", display_name: "Worker" });
  await run(ctx, { agent: "worker", status: "completed", at: ago(2 * HOUR), model: "claude-haiku-4-5", tokens: 100, costUsd: 0.10 });
  // Died mid-graph: no `ended_at`, no `run_end`, and therefore nothing ever wrote `runs.cost`.
  await run(ctx, { agent: "worker", status: "error", at: ago(HOUR), model: "claude-haiku-4-5", tokens: 250, costUsd: 0.25 });

  const s = await store.spend(ctx, w);
  check("both runs' spend is counted", cents(s.usd) === cents(0.35), `$${s.usd}`);
  // The specific claim: dropping the crashed run gives $0.10, and reading `runs.cost` gives $0.00.
  check("...which is not just the run that finished", cents(s.usd) !== cents(0.10));
  check("...and not the run-level field, which is zero on both rows", cents(s.usd) !== 0);

  const t = await store.tokens(ctx, w);
  check("its tokens are counted too", t.total === 350, String(t.total));
}

// --- the unpriced model ------------------------------------------------------------------------

console.log("\nan unpriced model is unknown, and never $0");
{
  const ctx = await workspace("unpriced");
  await agents.upsertFromDisk(ctx, { slug: "priced_agent", display_name: "Priced" });
  await agents.upsertFromDisk(ctx, { slug: "mystery_agent", display_name: "Mystery" });
  await run(ctx, { agent: "priced_agent", status: "completed", at: ago(3 * HOUR), model: "claude-haiku-4-5", tokens: 100, costUsd: 0.40 });
  // No pricing entry: the meter recorded the tokens and a null cost. This is the row that used to
  // render as `$0.00` and read as "this provider is free".
  await run(ctx, { agent: "mystery_agent", status: "completed", at: ago(2 * HOUR), model: "nobody/frontier-9", tokens: 900, costUsd: null });

  const s = await store.spend(ctx, w);
  check("the total is the priced part only", cents(s.usd) === cents(0.40), `$${s.usd}`);
  check("...and says it is a floor", !s.costKnown);
  check("the unpriced rows are counted", s.unpricedEvents === 1);
  check("the model is named, so the card can say which", s.unpricedModels.join() === "nobody/frontier-9");
  check("and how many agents are short by it", s.unpricedAgents === 1);
  // The other half: an unpriced model still MOVED tokens, and volume is not a cost question.
  const t = await store.tokens(ctx, w);
  check("its tokens are still counted, because volume is knowable when cost is not", t.total === 1000);

  // The claim behind the exclusion, asserted against the one calculator rather than restated:
  // `costFor` returns null for this model, which is why the ledger row carries null.
  check("the pricing table genuinely has no entry for it", !isPriced("nobody/frontier-9"));
  check("...so the one calculator answers unknown", costFor("nobody/frontier-9", { inputTokens: 900, outputTokens: 0 }) === null);
}

// --- there is exactly one calculator -----------------------------------------------------------

console.log("\nthe dashboard reads what the meter computed; it does not compute");
{
  const ctx = await workspace("one calculator");
  await agents.upsertFromDisk(ctx, { slug: "cached_agent", display_name: "Cached" });

  // A call with a real cache split, priced through the SAME function the interceptor uses. §5.2:
  // there must be exactly one place in this codebase that turns tokens into dollars.
  const split = { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 9_000, cacheWriteTokens: 0 };
  const expected = costFor("claude-haiku-4-5", split);
  check("the shared table prices this call", expected !== null);

  const runId = randomUUID();
  await trace.upsertRun(ctx, {
    id: runId, agent_id: "cached_agent", provider: "anthropic", model: "claude-haiku-4-5",
    status: "completed", started_at: ago(HOUR), ended_at: ago(HOUR), cost: 0, tokens: 0, error: null,
  } as Run);
  await billing.record(ctx, {
    kind: "llm.provider", idempotencyKey: `calc-${runId}`, runId,
    provider: "anthropic", model: "claude-haiku-4-5",
    inputTokens: split.inputTokens, outputTokens: split.outputTokens,
    cachedInputTokens: split.cacheReadTokens,
    totalTokens: split.inputTokens + split.outputTokens + split.cacheReadTokens,
    costUsd: expected, occurredAt: ago(HOUR),
  });

  const s = await store.spend(ctx, w);
  check(
    "the dashboard's figure is byte-identical to the meter's",
    s.usd === expected,
    `${s.usd} vs ${expected}`,
  );

  // AND THE RATE ITSELF, asserted where it lives. Charging 9,000 cache reads at the full input rate
  // is the overstatement v0.1.9 fixed; the comparison below is what makes the multiplier real
  // rather than a claim in a comment.
  const atFullRate = costFor("claude-haiku-4-5", { inputTokens: 10_000, outputTokens: 500 });
  check(
    "cache reads cost meaningfully less than the same tokens fresh",
    expected !== null && atFullRate !== null && expected < atFullRate,
    `${expected} vs ${atFullRate}`,
  );
}

// --- the cached split is honest about its own coverage ------------------------------------------

console.log("\na null cache split is not zero cached");
{
  const ctx = await workspace("split");
  await agents.upsertFromDisk(ctx, { slug: "agent_a", display_name: "A" });
  // What `meterStep` writes: one combined token figure, because the frozen event schema gives a
  // step one number and no breakdown under it.
  await run(ctx, { agent: "agent_a", status: "completed", at: ago(3 * HOUR), model: "claude-haiku-4-5", tokens: 400, costUsd: 0.10, cachedInputTokens: null });

  const unmeasured = await store.tokens(ctx, w);
  check("the volume is counted", unmeasured.total === 400);
  check("the cached figure is zero...", unmeasured.cached === 0);
  check(
    "...but every token is declared unsplit, so the card renders a dash rather than claiming none cached",
    unmeasured.unsplitTokens === 400,
  );

  // And a workspace where the split IS recorded.
  await run(ctx, { agent: "agent_a", status: "completed", at: ago(2 * HOUR), model: "claude-haiku-4-5", tokens: 600, costUsd: 0.05, cachedInputTokens: 500 });
  const measured = await store.tokens(ctx, w);
  check("a measured split adds to the cached figure", measured.cached === 500);
  check("the unsplit tokens stay separate", measured.unsplitTokens === 400);
  check("and the total is everything", measured.total === 1000);
}

// --- empty is not zero --------------------------------------------------------------------------

console.log("\nan empty range is not a zero one");
{
  const ctx = await workspace("empty");
  const s = await store.spend(ctx, w);
  const t = await store.tokens(ctx, w);
  check("no rows means no events", s.events === 0 && t.events === 0);
  check("the cost is complete, because there is nothing missing from it", s.costKnown);
  check("and there is no previous window to compare against", s.previousUsd === null && t.previousTotal === null);

  // The distinction the `events` field exists for: a range with rows that cost nothing is a REAL
  // $0.00, and must not render as `--`.
  await agents.upsertFromDisk(ctx, { slug: "free_agent", display_name: "Free" });
  await run(ctx, { agent: "free_agent", status: "completed", at: ago(HOUR), model: "claude-haiku-4-5", tokens: 0, costUsd: 0 });
  const real = await store.spend(ctx, w);
  check("a range that billed nothing has an event and a genuine zero", real.events === 1 && real.usd === 0);
  check("...and is therefore distinguishable from an empty one", real.events !== s.events);
}

// --- the previous window is the previous window --------------------------------------------------

console.log("\nthe delta baseline is the equivalent window before this one");
{
  const ctx = await workspace("previous");
  await agents.upsertFromDisk(ctx, { slug: "steady", display_name: "Steady" });
  await run(ctx, { agent: "steady", status: "completed", at: ago(2 * HOUR), model: "claude-haiku-4-5", tokens: 200, costUsd: 1.00 });
  // Inside the previous 24 hours, not this one.
  await run(ctx, { agent: "steady", status: "completed", at: ago(30 * HOUR), model: "claude-haiku-4-5", tokens: 100, costUsd: 0.50 });
  // Outside both, so it must appear in neither figure.
  await run(ctx, { agent: "steady", status: "completed", at: ago(72 * HOUR), model: "claude-haiku-4-5", tokens: 900, costUsd: 9.00 });

  const s = await store.spend(ctx, w);
  check("the current window holds only what is in it", cents(s.usd) === 100, `$${s.usd}`);
  check("the previous window holds only what is in that", cents(s.previousUsd ?? -1) === 50, `$${s.previousUsd}`);
  check("and the run outside both is in neither", cents(s.usd) !== 1000 && cents(s.previousUsd ?? 0) !== 900);

  const t = await store.tokens(ctx, w);
  check("volume splits the same way", t.total === 200 && t.previousTotal === 100);
}

await db.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
