// §7's leaderboard, and what it costs.
//
// THE IRREPLACEABLE ASSERTION IS THE STATEMENT COUNT. §5.2: "One aggregate query per module, not per
// agent. The leaderboard is one grouped query. Test that query count is constant in the number of
// agents, exactly as the Agents grid aggregate is tested." A leaderboard is the most natural place
// in the whole product to write an N+1, because every row wants a per-agent figure — and an N+1
// here is invisible in review and instantly visible in a real workspace. The number itself is not
// the claim; "the same for one agent as for forty" is, and that cannot be satisfied by accident.
//
// THE SECOND CLAIM IS THAT THE ROWS AGREE WITH THE STRIP ABOVE THEM. The leaderboard's per-agent
// rule and the health strip's workspace rule are the same expression on purpose — same per-run CTE,
// same branch-prefix bound, same interrupted-is-not-failed split — because a table whose rows do not
// add up to the headline is the fastest way to make somebody stop believing both.
//
//   npm run test:activity-leaderboard

import { randomUUID } from "node:crypto";

import { countingDb, openTestSqlite } from "../db/testDb.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { TraceStore } from "../store.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import type { Db } from "../db/db.ts";
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
const w = resolveWindow("24h", NOW, null);

const raw = await openTestSqlite();
const meter = countingDb(raw);

async function workspace(db: Db, name: string): Promise<TenantContext> {
  const ws = await new IdentityRepository(db).createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `${name} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

async function agentWithRuns(
  db: Db,
  ctx: TenantContext,
  slug: string,
  opts: { runs: number; usd: number; latencyMs: number; failures?: number; model?: string; hoursAgo?: number },
): Promise<void> {
  await new AgentRepository(db).upsertFromDisk(ctx, { slug, display_name: `Agent ${slug}` });
  const trace = new TraceStore(db);
  const billing = new BillingRepository(db);
  for (let i = 0; i < opts.runs; i++) {
    const runId = randomUUID();
    const at = ago(((opts.hoursAgo ?? 1) + i) * HOUR);
    const failed = i < (opts.failures ?? 0);
    await trace.upsertRun(ctx, {
      id: runId, agent_id: slug, provider: "anthropic", model: opts.model ?? "claude-haiku-4-5",
      status: failed ? "error" : "completed", started_at: at, ended_at: at,
      cost: 0, tokens: 0, error: failed ? "boom" : null,
    } as Run);
    await trace.insertStep(ctx, {
      id: randomUUID(), run_id: runId, seq: 0, type: "llm_call", name: "call_model",
      input: null, output: null, state_before: null, state_after: null,
      tokens: 10, cost: opts.usd, latency_ms: opts.latencyMs, error: null,
      parent_step_id: null, started_at: at,
    } as Step);
    await billing.record(ctx, {
      kind: "llm.provider", idempotencyKey: `lb-${runId}`, runId,
      provider: "anthropic", model: opts.model ?? "claude-haiku-4-5",
      totalTokens: 10, costUsd: opts.usd, occurredAt: at,
    });
  }
}

// --- the cost of a leaderboard load ------------------------------------------------------------

console.log("\nthe statement count is constant in the number of agents");
{
  const store = new ActivityStore(meter.db);

  const small = await workspace(meter.db, "one agent");
  await agentWithRuns(meter.db, small, "solo", { runs: 3, usd: 0.1, latencyMs: 400 });
  meter.reset();
  const oneRows = await store.leaderboard(small, w);
  const one = meter.count();

  const big = await workspace(meter.db, "forty agents");
  for (let i = 0; i < 40; i++) {
    await agentWithRuns(meter.db, big, `agent_${i}`, { runs: 2, usd: 0.05, latencyMs: 300 + i });
  }
  meter.reset();
  const fortyRows = await store.leaderboard(big, w);
  const forty = meter.count();

  check(`one agent costs ${one} statement(s)`, one > 0 && one < 10, `${one}`);
  check(`forty agents cost the same ${forty}`, forty === one, `${one} vs ${forty}`);
  // The counter has to be capable of seeing a difference, or the equality above is meaningless.
  check("and the fixture really does hold forty agents", fortyRows.length === 40, `${fortyRows.length}`);
  check("...against the one that holds one", oneRows.length === 1);
}

// --- the rows say what the strip says --------------------------------------------------------------

console.log("\nthe rows agree with the health strip above them");
{
  const ctx = await workspace(raw, "agreement");
  const store = new ActivityStore(raw);
  await agentWithRuns(raw, ctx, "steady", { runs: 4, usd: 0.25, latencyMs: 500, failures: 1 });
  await agentWithRuns(raw, ctx, "flaky", { runs: 4, usd: 0.10, latencyMs: 900, failures: 3, hoursAgo: 6 });

  const rows = await store.leaderboard(ctx, w);
  const health = await store.runHealth(ctx, w);
  const spend = await store.spend(ctx, w);

  check("every agent that ran has a row", rows.length === 2);
  check(
    "the rows' runs sum to the strip's total",
    rows.reduce((n, r) => n + r.runs, 0) === health.runs,
  );
  check(
    "the rows' failures sum to the strip's failures",
    rows.reduce((n, r) => n + r.failed, 0) === health.failed,
  );
  check(
    "the rows' spend sums to the rollup",
    Math.round(rows.reduce((n, r) => n + r.usd, 0) * 100) === Math.round(spend.usd * 100),
  );

  const flaky = rows.find((r) => r.agentId === "flaky")!;
  const steady = rows.find((r) => r.agentId === "steady")!;
  check("the flaky agent's rate is its own", flaky.successRate === 0.25, `${flaky.successRate}`);
  check("the steady one's too", steady.successRate === 0.75, `${steady.successRate}`);
  check("each carries its own p95", flaky.p95 === 900 && steady.p95 === 500);
  check("and its display name, not its slug", steady.name === "Agent steady");
  check("and when it last ran, inside the window", typeof steady.lastActive === "string");
}

// --- ranking is what the card grid cannot do -----------------------------------------------------

console.log("\nthe default order answers the question a grid of cards cannot");
{
  const ctx = await workspace(raw, "ranking");
  const store = new ActivityStore(raw);
  await agentWithRuns(raw, ctx, "cheap", { runs: 10, usd: 0.01, latencyMs: 100 });
  await agentWithRuns(raw, ctx, "expensive", { runs: 2, usd: 1.50, latencyMs: 100, hoursAgo: 12 });

  const rows = await store.leaderboard(ctx, w);
  check("the most expensive agent leads", rows[0]!.agentId === "expensive", rows.map((r) => r.agentId).join(" > "));
  check("...even though it ran a fifth as often", rows[0]!.runs < rows[1]!.runs);
}

// --- an agent that did nothing is not a row --------------------------------------------------------

console.log("\nan agent with no runs in the window is absent, not zeroed");
{
  const ctx = await workspace(raw, "idle");
  const store = new ActivityStore(raw);
  await new AgentRepository(raw).upsertFromDisk(ctx, { slug: "never_run", display_name: "Never Run" });
  await agentWithRuns(raw, ctx, "busy", { runs: 2, usd: 0.2, latencyMs: 100 });

  const rows = await store.leaderboard(ctx, w);
  check("only the agent that ran has a row", rows.length === 1 && rows[0]!.agentId === "busy");
  // §3.5: a table padded with `0 runs / $0.00` rows renders zeros for agents that were simply not
  // used, which is the false-zero rule appearing as a whole row rather than as a figure.
  check("the idle one is absent rather than shown at zero", !rows.some((r) => r.agentId === "never_run"));
}

// --- an unpriced model marks the row it is on, and only that row -------------------------------------

console.log("\nan unpriced model makes one row a floor, not the whole table");
{
  const ctx = await workspace(raw, "mixed pricing");
  const store = new ActivityStore(raw);
  await agentWithRuns(raw, ctx, "priced", { runs: 2, usd: 0.30, latencyMs: 100 });

  await new AgentRepository(raw).upsertFromDisk(ctx, { slug: "mystery", display_name: "Mystery" });
  const trace = new TraceStore(raw);
  const billing = new BillingRepository(raw);
  const runId = randomUUID();
  await trace.upsertRun(ctx, {
    id: runId, agent_id: "mystery", provider: "nobody", model: "nobody/frontier-9",
    status: "completed", started_at: ago(2 * HOUR), ended_at: ago(2 * HOUR), cost: 0, tokens: 0, error: null,
  } as Run);
  await trace.insertStep(ctx, {
    id: randomUUID(), run_id: runId, seq: 0, type: "llm_call", name: "call_model",
    input: null, output: null, state_before: null, state_after: null,
    tokens: 500, cost: null, latency_ms: 700, error: null, parent_step_id: null, started_at: ago(2 * HOUR),
  } as Step);
  await billing.record(ctx, {
    kind: "llm.provider", idempotencyKey: `unp-${runId}`, runId,
    provider: "nobody", model: "nobody/frontier-9", totalTokens: 500, costUsd: null, occurredAt: ago(2 * HOUR),
  });

  const rows = await store.leaderboard(ctx, w);
  const mystery = rows.find((r) => r.agentId === "mystery")!;
  const priced = rows.find((r) => r.agentId === "priced")!;
  check("the unpriced agent's row says its spend is incomplete", !mystery.costKnown);
  check("...and shows nothing rather than $0 having been invented", mystery.usd === 0);
  check("the priced agent's row is unaffected", priced.costKnown && Math.round(priced.usd * 100) === 60);
  // §2: excluded from every RANKING. The unpriced row must not lead the table on a zero.
  check("and the unpriced row does not outrank the priced one", rows[0]!.agentId === "priced");
}

// --- what the cross-highlight needs ------------------------------------------------------------------

console.log("\neach row carries the models it ran, so a hover fetches nothing");
{
  const ctx = await workspace(raw, "models");
  const store = new ActivityStore(raw);
  await agentWithRuns(raw, ctx, "haiku_only", { runs: 2, usd: 0.1, latencyMs: 100, model: "claude-haiku-4-5" });
  await agentWithRuns(raw, ctx, "both", { runs: 2, usd: 0.4, latencyMs: 100, model: "claude-opus-4-8", hoursAgo: 5 });
  await agentWithRuns(raw, ctx, "both", { runs: 1, usd: 0.1, latencyMs: 100, model: "claude-haiku-4-5", hoursAgo: 9 });

  const rows = await store.leaderboard(ctx, w);
  const both = rows.find((r) => r.agentId === "both")!;
  const one = rows.find((r) => r.agentId === "haiku_only")!;
  check("an agent that ran two models lists both", both.models.join() === "claude-haiku-4-5,claude-opus-4-8");
  check("one that ran one lists one", one.models.join() === "claude-haiku-4-5");
  // §3.4: "Nothing is clicked. Nothing changes. Nothing is fetched." The list is in the payload for
  // exactly that reason — a hover that had to ask the server would break the rule in one round trip.
  check("...which is what makes the hover free", both.models.length === 2 && one.models.length === 1);
}

await raw.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
