// §6's model and provider mix, as claims.
//
// THE TWO SHARES DISAGREE, AND THAT IS THE POINT. A cheap model can be most of a workspace's volume
// and a tenth of its bill; an expensive one is the reverse. A mix that reported one number would be
// answering half the question, so both travel and the suite asserts they genuinely differ on a
// fixture built to make them.
//
// AND AN UNPRICED MODEL IS IN THE VOLUME VIEW AND OUT OF THE SPEND VIEW, labelled rather than
// dropped. Dropping it would make the two views disagree about which models the workspace even runs,
// and somebody comparing them would conclude one is broken. Its zero is also kept out of the spend
// DENOMINATOR, or the priced segments would sum to less than the bar and the gap would read as a
// model nobody had named.
//
//   npm run test:activity-model-mix

import { randomUUID } from "node:crypto";

import { openTestSqlite } from "../db/testDb.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
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

const db = await openTestSqlite();
const identity = new IdentityRepository(db);
const billing = new BillingRepository(db);
const store = new ActivityStore(db);

async function workspace(name: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `${name} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

async function call(
  ctx: TenantContext,
  opts: { model: string; provider?: string; usd: number | null; tokens: number; kind?: "llm.provider" | "llm.generation"; runId?: string | null },
): Promise<void> {
  await billing.record(ctx, {
    kind: opts.kind ?? "llm.provider",
    idempotencyKey: `mix-${randomUUID()}`,
    runId: opts.runId ?? null,
    provider: opts.provider ?? "anthropic",
    model: opts.model,
    totalTokens: opts.tokens,
    costUsd: opts.usd,
    occurredAt: ago(HOUR),
  });
}

// --- the two views answer different questions -------------------------------------------------

console.log("\nthe spend share and the volume share are not the same number");
{
  const ctx = await workspace("two views");
  // A cheap model doing most of the work.
  for (let i = 0; i < 10; i++) await call(ctx, { model: "claude-haiku-4-5", usd: 0.01, tokens: 1_000 });
  // An expensive one doing very little of it.
  await call(ctx, { model: "claude-opus-4-8", usd: 0.90, tokens: 500 });

  const mix = await store.modelMix(ctx, w);
  const haiku = mix.models.find((m) => m.model === "claude-haiku-4-5")!;
  const opus = mix.models.find((m) => m.model === "claude-opus-4-8")!;

  check("both models are segments", mix.models.length === 2);
  const spendShare = (m: typeof haiku): number => m.usd / mix.pricedUsd;
  const volumeShare = (m: typeof haiku): number => m.tokens / mix.totalTokens;

  check(`haiku is most of the volume (${Math.round(volumeShare(haiku) * 100)}%)`, volumeShare(haiku) > 0.9);
  check(`...and a tenth of the bill (${Math.round(spendShare(haiku) * 100)}%)`, spendShare(haiku) < 0.15);
  check(`opus is most of the bill (${Math.round(spendShare(opus) * 100)}%)`, spendShare(opus) > 0.85);
  check(`...and almost none of the volume (${Math.round(volumeShare(opus) * 100)}%)`, volumeShare(opus) < 0.1);
  // The bar's segments have to fill it, in both views.
  check("the spend shares sum to one", Math.abs(mix.models.reduce((n, m) => n + spendShare(m), 0) - 1) < 1e-9);
  check("the volume shares sum to one", Math.abs(mix.models.reduce((n, m) => n + volumeShare(m), 0) - 1) < 1e-9);
  // The default order is by spend, because "what are we spending on" is the question §6 names.
  check("the most expensive model leads", mix.models[0]!.model === "claude-opus-4-8");
}

// --- unpriced is labelled, not dropped -----------------------------------------------------------

console.log("\nan unpriced model is in the volume view and out of the spend one");
{
  const ctx = await workspace("unpriced mix");
  await call(ctx, { model: "claude-haiku-4-5", usd: 0.40, tokens: 1_000 });
  await call(ctx, { model: "nobody/frontier-9", provider: "nobody", usd: null, tokens: 4_000 });

  const mix = await store.modelMix(ctx, w);
  const mystery = mix.models.find((m) => m.model === "nobody/frontier-9")!;

  check("it is a segment, not a silence", mystery !== undefined);
  check("...labelled as unpriced", !mystery.priced);
  check("its volume is real and counted", mystery.tokens === 4_000);
  check("its spend is nothing, not a zero anybody computed", mystery.usd === 0);
  // The denominator is the assertion that matters: with the unpriced model's zero in it, the
  // priced segments would sum to 100% of a bar that is only 20% full.
  check("the spend denominator is the priced spend only", Math.round(mix.pricedUsd * 100) === 40);
  check("the volume denominator is everything", mix.totalTokens === 5_000);
  check(
    "so the priced segments still fill the spend bar",
    Math.abs(mix.models.filter((m) => m.priced).reduce((n, m) => n + m.usd / mix.pricedUsd, 0) - 1) < 1e-9,
  );
  check("and the unpriced one is most of the volume bar", mystery.tokens / mix.totalTokens === 0.8);
}

// --- the same model under two providers is two facts ------------------------------------------------

console.log("\nthe same model under two providers is two segments");
{
  const ctx = await workspace("two providers");
  await call(ctx, { model: "llama-3.3-70b", provider: "together", usd: 0.10, tokens: 1_000 });
  await call(ctx, { model: "llama-3.3-70b", provider: "groq", usd: 0.02, tokens: 1_000 });

  const mix = await store.modelMix(ctx, w);
  check("two segments, not one", mix.models.length === 2);
  check("each names its own provider", mix.models.map((m) => m.provider).sort().join() === "groq,together");
  check("and the cheaper host is visibly cheaper for the same work", mix.models[0]!.provider === "together");
}

// --- the platform's own calls are here and nowhere else ---------------------------------------------

console.log("\na model call with no run behind it is still in the mix");
{
  const ctx = await workspace("platform calls");
  // A generation: money, tokens, no run, and therefore no leaderboard row it could ever appear on.
  await call(ctx, { model: "claude-opus-4-8", usd: 0.20, tokens: 3_000, kind: "llm.generation", runId: null });

  const mix = await store.modelMix(ctx, w);
  const board = await store.leaderboard(ctx, w);
  check("the mix has it", mix.models.length === 1 && mix.models[0]!.tokens === 3_000);
  check("the leaderboard cannot, because it belongs to no agent", board.length === 0);
  // Which is the argument for the module existing: this is the one surface where that spend shows.
  check("so the mix is the only place it is visible", Math.round(mix.pricedUsd * 100) === 20);
}

// --- what is not a model is not in a model mix --------------------------------------------------------

console.log("\nusage with no model is not a segment labelled with nothing");
{
  const ctx = await workspace("no model");
  await call(ctx, { model: "claude-haiku-4-5", usd: 0.10, tokens: 500 });
  await billing.record(ctx, {
    kind: "sandbox.seconds", idempotencyKey: `sb-${randomUUID()}`,
    provider: null, model: null, quantity: 240, unit: "second", costUsd: 0.05, occurredAt: ago(HOUR),
  });

  const mix = await store.modelMix(ctx, w);
  const spend = await store.spend(ctx, w);
  check("the mix has one segment", mix.models.length === 1);
  check("...and it is the model", mix.models[0]!.model === "claude-haiku-4-5");
  // It is not lost — it is in the provider ring, which is where "what did we pay for" is answered.
  check("the sandbox money is still in the workspace total", Math.round(spend.usd * 100) === 15);
  check("...and in the provider ring", spend.byProvider.some((p) => p.provider === "platform"));
}

// --- an empty range is empty rather than zeroed ------------------------------------------------------

console.log("\nan empty range has no segments at all");
{
  const ctx = await workspace("empty mix");
  const mix = await store.modelMix(ctx, w);
  check("no models", mix.models.length === 0);
  // The card renders §3.5's dash from this, and a denominator of zero is what tells it to. What it
  // must never do is invent a segment.
  check("no denominators either", mix.pricedUsd === 0 && mix.totalTokens === 0);
}

await db.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
