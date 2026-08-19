// §3.1's workspace pulse, as claims.
//
// THE ONE PROPERTY THAT MATTERS MOST: THE COLUMNS ADD UP TO THE HERO ROW. A pulse band whose total
// disagreed with the spend figure directly above it would be two answers to one question on one
// screen, and the whole page is built on there being exactly one window. So every assertion here is
// ultimately about that: the same rows, bucketed, still summing to the same numbers.
//
// AND THE FOLD FROM GRAIN TO COLUMN, which is the non-obvious part of the implementation. The query
// groups by minute, hour or day — the three grains `substr` produces identically on both dialects —
// and `columnFor` folds those cells into columns. That is exact only because the column grid is
// epoch-aligned and every column is a whole multiple of its grain; if either were untrue a cell
// would straddle two columns and the chart would be quietly smeared.
//
//   npm run test:activity-pulse

import { randomUUID } from "node:crypto";

import { openTestSqlite } from "../db/testDb.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { TraceStore } from "../store.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import type { Run } from "../types.ts";
import { ActivityStore } from "./activityStore.ts";
import { resolveWindow } from "./range.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const HOUR = 3_600_000;
const db = await openTestSqlite();
const identity = new IdentityRepository(db);
const agents = new AgentRepository(db);
const billing = new BillingRepository(db);
const trace = new TraceStore(db);
const store = new ActivityStore(db);

async function workspace(name: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `${name} ${randomUUID().slice(0, 6)}`,
  });
  const ctx = systemContextFor(ws.id, newRequestId());
  await agents.upsertFromDisk(ctx, { slug: "worker", display_name: "Worker" });
  return ctx;
}

async function runAt(
  ctx: TenantContext,
  at: string,
  opts: { status?: Run["status"]; usd?: number | null; tokens?: number; withUsage?: boolean } = {},
): Promise<void> {
  const runId = randomUUID();
  await trace.upsertRun(ctx, {
    id: runId, agent_id: "worker", provider: "anthropic", model: "claude-haiku-4-5",
    status: opts.status ?? "completed", started_at: at, ended_at: at,
    cost: 0, tokens: 0, error: opts.status === "error" ? "boom" : null,
  } as Run);
  if (opts.withUsage === false) return;
  await billing.record(ctx, {
    kind: "llm.provider", idempotencyKey: `pulse-${runId}`, runId,
    provider: "anthropic", model: "claude-haiku-4-5",
    totalTokens: opts.tokens ?? 10, costUsd: opts.usd ?? 0.01, occurredAt: at,
  });
}

// --- the shape of the series ---------------------------------------------------------------------

console.log("\nevery column exists, including the empty ones");
{
  const NOW = new Date("2026-08-19T12:00:00.000Z");
  const w = resolveWindow("24h", NOW, null);
  const ctx = await workspace("shape");
  await runAt(ctx, new Date(NOW.getTime() - 3 * HOUR).toISOString());

  const series = await store.pulse(ctx, w);
  check(`the series has one column per bucket (${series.length})`, series.length === w.buckets);
  check("...which for 24h is twenty-four hours", series.length === 24 && w.bucketMs === HOUR);
  check("each column names its own start", series.every((c) => typeof c.at === "string" && c.at.endsWith("Z")));
  check("the starts ascend", series.every((c, i) => i === 0 || c.at > series[i - 1]!.at));
  // A gap drawn as a narrower column would read as a shorter period rather than as a quiet one.
  check("columns with nothing in them are present and zero", series.filter((c) => c.runs === 0).length === 23);
  check("and the one with the run in it has it", series.filter((c) => c.runs === 1).length === 1);
}

// --- the columns add up to the hero row ------------------------------------------------------------

console.log("\nthe columns sum to what the cards above them say");
{
  const NOW = new Date("2026-08-19T12:00:00.000Z");
  const w = resolveWindow("24h", NOW, null);
  const ctx = await workspace("sums");
  for (let h = 1; h <= 20; h++) {
    await runAt(ctx, new Date(NOW.getTime() - h * HOUR).toISOString(), {
      status: h % 5 === 0 ? "error" : "completed",
      usd: 0.25,
      tokens: 100,
    });
  }

  const series = await store.pulse(ctx, w);
  const health = await store.runHealth(ctx, w);
  const spend = await store.spend(ctx, w);
  const tokens = await store.tokens(ctx, w);
  const sum = (pick: (c: (typeof series)[number]) => number): number => series.reduce((n, c) => n + pick(c), 0);

  check(`the run counts agree (${sum((c) => c.runs)} vs ${health.runs})`, sum((c) => c.runs) === health.runs);
  check(`the error counts agree (${sum((c) => c.errors)})`, sum((c) => c.errors) === health.failed);
  check(
    `the spend agrees ($${sum((c) => c.usd).toFixed(2)} vs $${spend.usd.toFixed(2)})`,
    Math.round(sum((c) => c.usd) * 100) === Math.round(spend.usd * 100),
  );
  check(`the token volume agrees (${sum((c) => c.tokens)})`, sum((c) => c.tokens) === tokens.total);
}

// --- and it still adds up when the window is not on the hour ------------------------------------------

console.log("\nthe partial first and last columns lose nothing");
{
  // 14:37, which is what "the last 24 hours" means most of the time and is where an unaligned fold
  // would silently drop or double a row.
  const NOW = new Date("2026-08-19T14:37:11.500Z");
  const w = resolveWindow("24h", NOW, null);
  const ctx = await workspace("offgrid");

  // One run in the partial FIRST column, one in the partial LAST, and one squarely in the middle.
  await runAt(ctx, new Date(Date.parse(w.from) + 60_000).toISOString());
  await runAt(ctx, new Date(Date.parse(w.to) - 60_000).toISOString());
  await runAt(ctx, new Date(NOW.getTime() - 12 * HOUR).toISOString());
  // And one just OUTSIDE the window but inside the grid's first column, which is the row an
  // aligned grid would pick up if the query were bounded by the grid rather than by the window.
  await runAt(ctx, new Date(Date.parse(w.bucketFrom) + 1_000).toISOString());

  const series = await store.pulse(ctx, w);
  const health = await store.runHealth(ctx, w);
  const total = series.reduce((n, c) => n + c.runs, 0);
  check(`the window holds three runs (${health.runs})`, health.runs === 3);
  check(`and the series holds the same three (${total})`, total === 3);
  check("...so the row before the window is in neither", total !== 4);
  check("the first column carries the one just inside the window", series[0]!.runs === 1);
  check("the last column carries the one just before now", series[series.length - 1]!.runs === 1);
}

// --- a longer range, on a coarser grain ---------------------------------------------------------------

console.log("\na 30-day range folds day cells into day columns");
{
  const NOW = new Date("2026-08-19T14:37:00.000Z");
  const w = resolveWindow("30d", NOW, null);
  const ctx = await workspace("month");
  for (let d = 1; d <= 10; d++) {
    await runAt(ctx, new Date(NOW.getTime() - d * 24 * HOUR).toISOString(), { usd: 0.5, tokens: 50 });
  }

  const series = await store.pulse(ctx, w);
  check(`thirty-one columns, because the window straddles a day boundary (${series.length})`, series.length === 31);
  check("ten of them have a run", series.filter((c) => c.runs > 0).length === 10);
  check("each of those has exactly one", series.filter((c) => c.runs > 0).every((c) => c.runs === 1));
  const spend = await store.spend(ctx, w);
  check(
    "and the spend still adds up",
    Math.round(series.reduce((n, c) => n + c.usd, 0) * 100) === Math.round(spend.usd * 100),
  );
}

// --- money with no run behind it ------------------------------------------------------------------------

console.log("\nspend with no run is still on the chart");
{
  const NOW = new Date("2026-08-19T12:00:00.000Z");
  const w = resolveWindow("24h", NOW, null);
  const ctx = await workspace("platform");
  const at = new Date(NOW.getTime() - 2 * HOUR).toISOString();
  // A generation: real money, no run, and a join through `runs` would drop it entirely.
  await billing.record(ctx, {
    kind: "llm.generation", idempotencyKey: `gen-${randomUUID()}`, runId: null,
    provider: "anthropic", model: "claude-haiku-4-5",
    inputTokens: 900, outputTokens: 100, totalTokens: 1_000, costUsd: 0.04, occurredAt: at,
  });

  const series = await store.pulse(ctx, w);
  const spent = series.reduce((n, c) => n + c.usd, 0);
  const ran = series.reduce((n, c) => n + c.runs, 0);
  check("the money is on the chart", Math.round(spent * 100) === 4, `$${spent}`);
  check("...in a column with no runs in it at all", ran === 0);
  check("...which is the column it happened in", series.filter((c) => c.usd > 0).length === 1);
}

// --- an unpriced row contributes volume and not cost -----------------------------------------------------

console.log("\nan unpriced row adds tokens to the chart and nothing to the money");
{
  const NOW = new Date("2026-08-19T12:00:00.000Z");
  const w = resolveWindow("24h", NOW, null);
  const ctx = await workspace("unpriced pulse");
  const at = new Date(NOW.getTime() - HOUR).toISOString();
  const runId = randomUUID();
  await trace.upsertRun(ctx, {
    id: runId, agent_id: "worker", provider: "anthropic", model: "nobody/frontier-9",
    status: "completed", started_at: at, ended_at: at, cost: 0, tokens: 0, error: null,
  } as Run);
  await billing.record(ctx, {
    kind: "llm.provider", idempotencyKey: `unp-${runId}`, runId,
    provider: "nobody", model: "nobody/frontier-9",
    totalTokens: 700, costUsd: null, occurredAt: at,
  });

  const series = await store.pulse(ctx, w);
  check("its tokens are drawn", series.reduce((n, c) => n + c.tokens, 0) === 700);
  check("its cost is not invented", series.reduce((n, c) => n + c.usd, 0) === 0);
  check("and the run is counted", series.reduce((n, c) => n + c.runs, 0) === 1);
}

await db.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
