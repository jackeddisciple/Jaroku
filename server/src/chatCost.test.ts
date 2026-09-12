// §10 — a chat turn's cost, and the one mismatch §10 calls a blocker.
//
// "CHAT COST ROLLS INTO THE THREAD'S TOTAL, which the Threads row already displays — the two
// figures must agree. A MISMATCH BETWEEN A THREAD'S ROW TOTAL AND THE SUM OF ITS TURNS IS A
// BLOCKER-CLASS DEFECT." That is the property this suite exists for, and it is not a property of
// either figure on its own: each is correct in isolation and they can still disagree, because they
// are summed over different rows by different code. `turn_variants.cost_usd` is what a TURN
// records; `usage_events` is what the LEDGER records; and the only thing making them agree is that
// both price the same counts through the same `costFor`.
//
// SO EVERY CASE HERE IS ONE OF §16's, BY NAME: "thread row total vs sum of turns after: a stopped
// stream, a failed turn, three regenerations, an unpriced model, a model switch mid-thread."
//
// AND THE UNPRICED CASE IS THE ONE WITH TWO RIGHT ANSWERS THAT MUST NOT BE CONFUSED. §10: "an
// unpriced chat model shows cost unknown and is EXCLUDED from totals rather than contributing
// zero." So the turn's column is null, the ledger's row is null, `SUM` skips both, and the thread
// reports `costKnown: false` — a floor rather than a total. A zero anywhere in that chain would
// read as "this was free", which is the single failure v0.1.9 exists to prevent.
//
//   npm run test:chat-cost

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "./db/testDb.ts";
import { BillingRepository } from "./db/repositories/billing.ts";
import { UsageMeter } from "./billing/usage.ts";
import { ThreadStore } from "./threadStore.ts";
import { TurnVariantStore } from "./turnVariants.ts";
import { costFor, isPriced } from "./pricing.ts";
import { CHAT_MODEL } from "./chat.ts";
import type { Db } from "./db/db.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();
const AT = "2026-01-01T00:00:00.000Z";
/** Close enough for money rounded to eight decimals by `round8` before it is stored. */
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

async function harness(): Promise<{
  db: Db; threads: ThreadStore; variants: TurnVariantStore;
  billing: BillingRepository; meter: UsageMeter; close: () => Promise<void>;
}> {
  const db = await openTestSqlite();
  const billing = new BillingRepository(db);
  return {
    db, threads: new ThreadStore(db), variants: new TurnVariantStore(db),
    billing,
    //  FOR THE RUN LOOKUP, because nothing here meters a RUN. That parameter
    // answers "what provider and model is this run on" for the cache-miss path, and every call
    // below is a platform call with its model named on it —  passes the same stub
    // for the same reason.
    meter: new UsageMeter(billing, async () => null),
    close: () => db.close(),
  };
}

/**
 * One chat answer, recorded BOTH ways — exactly as `chatWithJaroku` does it.
 *
 * THE POINT OF DOING BOTH IN ONE HELPER is that the production path does both in one callback, from
 * one set of counts: `meterPlatformCall` writes the ledger row and `settle` writes the turn's
 * column, and both price through `costFor`. A helper that wrote them from two different numbers
 * would be testing a bug this suite could never then detect.
 */
async function answer(
  h: Awaited<ReturnType<typeof harness>>,
  turnId: string,
  threadId: string,
  model: string,
  tokens: { input: number; output: number },
): Promise<number | null> {
  const cost = costFor(model, { inputTokens: tokens.input, outputTokens: tokens.output });
  const v = await h.variants.begin(ctx, turnId, { modelId: model, provider: "anthropic" });
  await h.variants.settle(ctx, v.id, { tokensIn: tokens.input, tokensOut: tokens.output, costUsd: cost, body: "an answer" });
  await h.meter.meterModelCall(ctx, "llm.explain", {
    model, inputTokens: tokens.input, outputTokens: tokens.output, threadId,
  });
  return cost;
}

/** What the Threads row shows. */
const rowTotal = async (h: Awaited<ReturnType<typeof harness>>, threadId: string) =>
  (await h.billing.spendByThread(ctx)).get(threadId) ?? { usd: 0, costKnown: true };

/** The sum of the turns, as the per-turn lines report them. */
async function sumOfTurns(
  h: Awaited<ReturnType<typeof harness>>, threadId: string,
): Promise<{ usd: number; anyUnknown: boolean }> {
  const items = await h.threads.itemsFor(ctx, threadId);
  const byTurn = await h.variants.forTurns(ctx, items.map((i) => i.id));
  let usd = 0;
  let anyUnknown = false;
  for (const list of byTurn.values()) {
    // §10: "ALL SIBLINGS COUNT TOWARD THE THREAD TOTAL — regenerating three times cost three
    // calls, and the total must say so." So this sums every variant, not the selected one — which
    // is the opposite of what the per-turn LINE shows, and deliberately: the line describes one
    // response, the total describes the conversation.
    for (const v of list) {
      if (v.cost_usd === null) anyUnknown = true;
      else usd += v.cost_usd;
    }
  }
  return { usd, anyUnknown };
}

// --- the ordinary case ------------------------------------------------------------------------

console.log("\n§10 — the row total and the sum of the turns agree");
{
  const h = await harness();
  const t = await h.threads.create(ctx, { title: "a conversation" });
  for (const q of ["why did it fail?", "and the cost?", "thanks"]) {
    const turn = await h.threads.addItem(ctx, t.id, { kind: "message", role: "user", body: q });
    await answer(h, turn, t.id, CHAT_MODEL, { input: 1200, output: 90 });
  }
  const row = await rowTotal(h, t.id);
  const sum = await sumOfTurns(h, t.id);
  check("three answers cost something", row.usd > 0, String(row.usd));
  check("the two figures agree", near(row.usd, sum.usd), `row ${row.usd} vs turns ${sum.usd}`);
  check("...and the row calls it complete", row.costKnown === true);
  await h.close();
}

// --- §16: three regenerations ------------------------------------------------------------------

console.log("\n§16 — after three regenerations");
{
  const h = await harness();
  const t = await h.threads.create(ctx, { title: "regenerated" });
  const turn = await h.threads.addItem(ctx, t.id, { kind: "message", role: "user", body: "which model?" });
  // FOUR ANSWERS TO ONE QUESTION. §10: "regenerating three times cost three calls, and the total
  // must say so" — so the thread's figure must be four calls, not one.
  for (let n = 0; n < 4; n++) await answer(h, turn, t.id, CHAT_MODEL, { input: 1000, output: 50 });

  const one = costFor(CHAT_MODEL, { inputTokens: 1000, outputTokens: 50 }) ?? 0;
  const row = await rowTotal(h, t.id);
  const sum = await sumOfTurns(h, t.id);
  check("the thread was charged for four calls", near(row.usd, one * 4), `${row.usd} vs ${one * 4}`);
  check("...and the sum of the turns agrees", near(row.usd, sum.usd), `row ${row.usd} vs turns ${sum.usd}`);
  // AND ONE TURN, NOT FOUR. The cost is four calls; the conversation is one exchange.
  check("on one turn", (await h.threads.itemsFor(ctx, t.id)).length === 1);
  check("...with four variants", (await h.variants.forTurn(ctx, turn)).length === 4);
  // EACH SIBLING CARRIES ITS OWN FIGURE (§10), so the per-turn line can attribute them individually.
  check("each sibling has its own cost",
    (await h.variants.forTurn(ctx, turn)).every((v) => v.cost_usd !== null && near(v.cost_usd, one)));
  await h.close();
}

// --- §16: a stopped stream and a failed turn --------------------------------------------------

console.log("\n§16 — after a stopped stream and a failed turn");
{
  const h = await harness();
  const t = await h.threads.create(ctx, { title: "interrupted" });

  // A STOPPED ANSWER SPENT WHAT IT SPENT. §6.1: "records the cost actually incurred, not zero and
  // not the full projected amount." Fewer output tokens than a finished one, and a real figure.
  const stopped = await h.threads.addItem(ctx, t.id, { kind: "message", role: "user", body: "explain the graph" });
  const stoppedCost = await answer(h, stopped, t.id, CHAT_MODEL, { input: 1400, output: 12 });

  // A FAILED TURN THAT CONSUMED INPUT TOKENS DID COST MONEY (§7.3). Output zero, input real.
  const failed = await h.threads.addItem(ctx, t.id, { kind: "message", role: "user", body: "and again" });
  const failedCost = await answer(h, failed, t.id, CHAT_MODEL, { input: 1400, output: 0 });

  check("a stopped answer has a real cost", (stoppedCost ?? 0) > 0, String(stoppedCost));
  check("...and it is below a finished one's", (stoppedCost ?? 0) < (costFor(CHAT_MODEL, { inputTokens: 1400, outputTokens: 500 }) ?? 0));
  check("a failed turn's input tokens are charged", (failedCost ?? 0) > 0, String(failedCost));
  const row = await rowTotal(h, t.id);
  const sum = await sumOfTurns(h, t.id);
  check("the two figures still agree", near(row.usd, sum.usd), `row ${row.usd} vs turns ${sum.usd}`);
  await h.close();
}

// --- §16: an unpriced model, and a model switch mid-thread ------------------------------------

console.log("\n§16 — an unpriced model");
{
  const h = await harness();
  const t = await h.threads.create(ctx, { title: "mixed" });
  check("the fixture model really is unpriced", !isPriced("some-model-nobody-priced"));

  const priced = await h.threads.addItem(ctx, t.id, { kind: "message", role: "user", body: "one" });
  const pricedCost = await answer(h, priced, t.id, CHAT_MODEL, { input: 1000, output: 60 });
  const unpriced = await h.threads.addItem(ctx, t.id, { kind: "message", role: "user", body: "two" });
  const unpricedCost = await answer(h, unpriced, t.id, "some-model-nobody-priced", { input: 1000, output: 60 });

  // §10: "AN UNPRICED CHAT MODEL SHOWS COST UNKNOWN AND IS EXCLUDED FROM TOTALS RATHER THAN
  // CONTRIBUTING ZERO." Null all the way down — the turn's column, the ledger's row, and the SUM
  // that skips them.
  check("an unpriced answer records no cost", unpricedCost === null, String(unpricedCost));
  const rows = await h.variants.forTurns(ctx, [priced, unpriced]);
  check("...and the turn's column is null, not 0",
    (rows.get(unpriced) ?? [])[0]?.cost_usd === null, String((rows.get(unpriced) ?? [])[0]?.cost_usd));
  check("...while the priced one keeps its figure",
    near((rows.get(priced) ?? [])[0]?.cost_usd ?? -1, pricedCost ?? -2));

  const row = await rowTotal(h, t.id);
  const sum = await sumOfTurns(h, t.id);
  // THE TOTAL IS THE PRICED HALF, AND IT SAYS SO. `costKnown: false` is what makes the row render
  // `$0.04+` — a floor rather than an answer — which §4.3 and §9 both insist on.
  check("the total is the priced turns only", near(row.usd, pricedCost ?? 0), `${row.usd} vs ${pricedCost}`);
  check("...and the row reports it as a floor", row.costKnown === false);
  check("...and the sum of the turns agrees", near(row.usd, sum.usd), `row ${row.usd} vs turns ${sum.usd}`);
  check("...and knows one was unknown", sum.anyUnknown === true);
  // NEVER ZERO. The whole rule, asserted as the absence it is.
  check("the unknown half contributed nothing rather than zero", !near(row.usd, 0) && row.usd > 0);
  await h.close();
}

console.log("\n§16 — a model switch mid-thread");
{
  const h = await harness();
  const t = await h.threads.create(ctx, { title: "switched" });
  // TWO DIFFERENT PRICED MODELS. Each turn prices at ITS OWN rate, which is §11's whole point and
  // the v0.1.10 bug in miniature: a total computed against one model for calls made on two.
  const a = await h.threads.addItem(ctx, t.id, { kind: "message", role: "user", body: "cheap" });
  const cheap = await answer(h, a, t.id, "claude-haiku-4-5", { input: 1000, output: 100 });
  const b = await h.threads.addItem(ctx, t.id, { kind: "message", role: "user", body: "dear" });
  const dear = await answer(h, b, t.id, "claude-opus-5", { input: 1000, output: 100 });

  check("the two turns priced differently", (dear ?? 0) > (cheap ?? 0), `${cheap} vs ${dear}`);
  const row = await rowTotal(h, t.id);
  const sum = await sumOfTurns(h, t.id);
  check("the total is the sum of the two rates", near(row.usd, (cheap ?? 0) + (dear ?? 0)), `${row.usd}`);
  check("...and the two figures agree", near(row.usd, sum.usd), `row ${row.usd} vs turns ${sum.usd}`);
  // AND NEITHER WAS PRICED AS THE OTHER — the assertion that fails against the v0.1.10 behaviour.
  const opusOnBoth = (costFor("claude-opus-5", { inputTokens: 1000, outputTokens: 100 }) ?? 0) * 2;
  check("neither turn was priced as the other", !near(row.usd, opusOnBoth), `${row.usd} vs ${opusOnBoth}`);
  await h.close();
}

// --- cached tokens bill at the cached rate (§10, v0.1.9) --------------------------------------

console.log("\ncached input");
{
  const plain = costFor(CHAT_MODEL, { inputTokens: 2000, outputTokens: 0 }) ?? 0;
  const cached = costFor(CHAT_MODEL, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 2000 }) ?? 0;
  // §10: "CACHED TOKENS BILL AT THE CACHED RATE, as v0.1.9 established." Charging a cache read at
  // the full input rate overstates cost by up to 10x, which is the reason the multipliers are in
  // `runtime/pricing.json` rather than in either language's reader.
  check("a cache read is cheaper than fresh input", cached < plain, `${cached} vs ${plain}`);
  check("...and is not free either", cached > 0, String(cached));
  const written = costFor(CHAT_MODEL, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 2000 }) ?? 0;
  check("a cache write costs more than fresh input", written > plain, `${written} vs ${plain}`);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
