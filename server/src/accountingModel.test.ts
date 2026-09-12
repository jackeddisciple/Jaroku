// §11.2 — every call is priced against the model that made it, and v0.1.10's open issue is closed.
//
// WHAT v0.1.10 RECORDED, VERBATIM: "Known and left open deliberately: the generation model used for
// cost accounting is fixed in one place regardless of what is configured, and the plan step
// inherits the same issue."
//
// THE ONE PLACE WAS `claude.ts`'s `GENERATION_MODEL`, and `summarizeUsage` priced every platform
// call against it — the generation, the plan and the edit — while each of those resolves its own
// model from its own environment variable. So pointing `JAROKU_EDIT_MODEL` at `claude-opus-5`
// produced an edit that really cost five times what the card said.
//
// §11.2 ASKS FOR A TEST THAT FAILS AGAINST THE OLD BEHAVIOUR, which is a sharper requirement than
// "a test that passes now": a suite asserting only that a figure is correct would have passed
// before, because the fallback and the default are the same id. So every assertion below uses a
// model whose price DIFFERS from the fallback's — and each one names the figure the old code would
// have produced, so a regression reads as that number rather than as a mismatch.
//
//   npm run test:accounting-model

import { readFileSync } from "node:fs";

import { summarizeUsage, GENERATION_MODEL as FALLBACK } from "./claude.ts";
import { costFor, isPriced } from "./pricing.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const COUNTS = { input_tokens: 10_000, output_tokens: 2_000 };
/** Five times the fallback's input rate and five times its output rate — see runtime/pricing.json. */
const DEARER = "claude-opus-5";

console.log("\n§11.2 — a call is priced against its own model");
{
  check("the fallback and the dearer model are both priced", isPriced(FALLBACK) && isPriced(DEARER));

  const cheap = summarizeUsage(FALLBACK, COUNTS).cost_usd;
  const dear = summarizeUsage(DEARER, COUNTS).cost_usd;
  const expected = costFor(DEARER, { inputTokens: COUNTS.input_tokens, outputTokens: COUNTS.output_tokens }) ?? 0;

  check("the dearer model costs more", dear > cheap, `${dear} vs ${cheap}`);
  check("...and is priced at ITS OWN rate", Math.abs(dear - expected) < 1e-9, `${dear} vs ${expected}`);
  // THE ASSERTION THAT FAILS AGAINST THE OLD BEHAVIOUR. Before §11.2 this call returned the
  // FALLBACK's figure whatever model was named, so `dear === cheap` — which is the exact number a
  // regression would produce, named here so the failure reads as the bug rather than as a mismatch.
  check(`...rather than the fallback's ($${cheap.toFixed(5)}), which is what v0.1.10 reported`,
    Math.abs(dear - cheap) > 1e-9, `both ${dear}`);

  // AND AN UNPRICED MODEL STILL COALESCES TO 0 IN THIS FIGURE, which is right HERE and wrong in the
  // ledger. `UsageSummary.cost_usd` is a `number` because it feeds a card; `meterModelCall` writes
  // `costFor`'s null as null. Two functions, two rules, on purpose.
  check("an unpriced model reports 0 in the display figure, not NaN",
    summarizeUsage("some-model-nobody-priced", COUNTS).cost_usd === 0);
  // ...AND THE LEDGER'S ANSWER FOR THE SAME MODEL IS `null`, which is the rule that matters for
  // money. Asserted here beside its sibling so the split is visible in one place.
  check("...while the ledger's answer for it is unknown",
    costFor("some-model-nobody-priced", { inputTokens: 1, outputTokens: 1 }) === null);

  // A CALLER THAT NAMES NOTHING FALLS BACK rather than throwing or returning NaN. The fallback is
  // the cheapest model this product uses, which under-reports rather than over-reports — the safe
  // way to be wrong about somebody else's money.
  check("an empty model falls back", summarizeUsage("", COUNTS).cost_usd === cheap, String(summarizeUsage("", COUNTS).cost_usd));
}

// --- the four paths, read off the source ------------------------------------------------------
//
// WHY SOURCE-READING AND NOT BEHAVIOURAL. Each of these call sites resolves its model from an
// environment variable at import time, so a behavioural test would have to re-import three modules
// under three environments — and what actually went wrong was never the arithmetic. It was that
// three call sites passed a CONSTANT. That is a property of the text, and it is the property that
// regressed silently for a whole release.

console.log("\n§11.2 — every platform call site names its own model");
{
  const read = (f: string): string => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");

  for (const [file, want] of [
    ["planner.ts", "PLAN_MODEL"],
    ["generator.ts", "GENERATION_MODEL"],
    ["editor.ts", "EDIT_MODEL"],
  ] as const) {
    const src = read(file);
    check(`${file} prices against ${want}`, src.includes(`summarizeUsage(${want}, final.usage)`), "");
  }

  const index = read("index.ts");

  /**
   * Every `meterPlatformCall(...)` in the file, as the text between its name and its closing brace.
   *
   * ANCHORED ON THE CALL RATHER THAN ON THE KIND STRING, which is the correction this block needed:
   * `"llm.plan"` also appears in the `UsageKind` union that reaches this file through a type, and an
   * `indexOf` on the string found the union — several hundred characters from any `model:` field, so
   * every row failed for the wrong reason.
   */
  const meters = [...index.matchAll(/meterPlatformCall\([\s\S]{0,900}?\n\s*\}\);/g)].map((m) => m[0]);
  check(`there are meter calls to read (${meters.length})`, meters.length >= 4, String(meters.length));

  // THE LEDGER'S FOUR SITES. `costFor` prices whatever id it is handed, so a meter naming the
  // constant was v0.1.10's issue reaching the BILL as well as the card.
  for (const [kind, want] of [
    ["llm.plan", "PLAN_MODEL"],
    ["llm.generation", "GEN_MODEL_ACTUAL"],
    ["llm.edit", "EDIT_MODEL"],
    // THE THREE `llm.explain` SITES — explain, Part 3's answers and the chat route — all take the
    // model off the USAGE EVENT, which is the model the provider actually answered on. That is
    // stronger than naming a constant: it cannot disagree with the call even if the caller's
    // resolution changes between dispatch and completion.
    ["llm.explain", "u.model"],
  ] as const) {
    const mine = meters.filter((m) => m.includes(`"${kind}"`));
    check(`the ${kind} meter exists`, mine.length > 0, String(mine.length));
    check(`...and names ${want}`, mine.every((m) => m.includes(`model: ${want}`)),
      mine.map((m) => /model: [^,\n]+/.exec(m)?.[0] ?? "none").join(" | "));
  }

  // AND NO METER ANYWHERE NAMES THE CONSTANT. The rows above say what each one DOES name; this says
  // there is no fifth site that was missed — which is the shape of the original bug, three call
  // sites quietly sharing one wrong answer.
  check("no meter call prices against claude.ts's constant",
    meters.every((m) => !/model: GENERATION_MODEL\b/.test(m)),
    meters.filter((m) => /model: GENERATION_MODEL\b/.test(m)).length + " offender(s)");

  // AND THE CONSTANT IS NO LONGER REACHED FROM THIS FILE AT ALL, which is the visible half of the
  // fix: four sites read it — three meters and the attachment budget's model — and each has a model
  // of its own now. Comments mention it; nothing imports it.
  check("index.ts no longer imports claude.ts's constant",
    !/import \{[^}]*\bGENERATION_MODEL\b[^}]*\} from "\.\/claude\.ts"/.test(index), "");
  // THE ALIAS IS WHAT MAKES THE TWO NAMES DISTINGUISHABLE. `claude.ts` and `generator.ts` both
  // export `GENERATION_MODEL` and only one of them resolves it — which is the confusion §11.2 is
  // about, so the resolved one is imported under a name that says so.
  check("...and imports the generator's RESOLVED one under a distinct name",
    /GENERATION_MODEL as GEN_MODEL_ACTUAL/.test(index), "");

  // §11.2's OTHER HALF: "the chat model is separate from the eval, plan and generation models.
  // Changing one must not change another." Asserted as the absence of a fall-through in the one
  // resolution that could have had one — `test:chat` holds the full version of this claim.
  const chat = read("chat.ts");
  const resolution = /export const CHAT_MODEL\s*=([^;]*);/.exec(chat)?.[1] ?? "";
  check("the chat model resolves independently",
    resolution.includes("JAROKU_CHAT_MODEL") && !/JAROKU_(GEN|PLAN|EDIT|EXPLAIN)_MODEL/.test(resolution),
    resolution);
}

// --- the effort adapter, which had the same hardcode -----------------------------------------

console.log("\n§11.2 reaches the effort adapter too");
{
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  // `planEffort` CLAMPS A THINKING BUDGET AGAINST THE MODEL'S OWN CEILING and reports the level
  // actually applied — so a generation resolved against a constant was clamped against the wrong
  // number, and §6.2's marker then reported a level nobody spent.
  const sites = index.match(/await effortForThread\(ctx, \w+, (\w+|u\.model)/g) ?? [];
  check(`all six effort resolutions name a model (${sites.length})`, sites.length === 6, sites.join(" | "));
  check("...and none names claude.ts's constant",
    !/await effortForThread\(ctx, \w+, GENERATION_MODEL\b/.test(index), "");
}


// --- A LIVE RUN: the read-back must not race its own write ------------------------------------
//
// §10's RULE IS THAT THE FIGURE ON SCREEN AND THE FIGURE IN THE TABLE ARE THE SAME NUMBER, and the
// chat route honours it by reading the row back rather than doing a second arithmetic on the way
// out. Against a real provider that read LOST: `settle` was fire-and-forget, so the `done` event
// went out carrying `turn_cost_usd: null` and no token count while the row already held 888 in, 44
// out and $0.002216. Every chat turn rendered "—" for a cost the database knew.
//
// SOURCE-READ, because reproducing it needs a provider, a socket and a database. What is checkable
// here is that the writes are awaited before the read and that both payloads carry the figures.

console.log("\n§10 — the read-back waits for the write");
{
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  // `settle` HANDS BACK ITS CHAIN, so a caller can wait for it. A `void` return is what made the
  // race possible, and there is nothing a caller could have done about it.
  check("openVariant returns a settle that can be awaited",
    /Promise<\(outcome: VariantOutcome\) => Promise<void>>/.test(index), "openVariant's signature");
  check("...and its writes are chained rather than fired in parallel",
    /chain = chain\.then\(\(\) =>/.test(index), "the chain");

  // BOTH PAYLOADS WAIT. One `.then` off the settle chain before the read-back, on the done path
  // and on the stopped path.
  check("the done payload reads back after its write lands",
    /void written\s*\n\s*\.then\(\(\) => Promise\.all\(\[variantCounts\(ctx, turn\), spentOnTurn\(ctx, turn\)\]\)\)/.test(index),
    "done's read-back");
  check("the stopped payload does too",
    /void stoppedWritten\s*\n\s*\.then\(\(\) => Promise\.all\(\[variantCounts\(ctx, turn\), spentOnTurn\(ctx, turn\)\]\)\)/.test(index),
    "stopped's read-back");

  // AND THE STOPPED EVENT DESCRIBES ITSELF THE WAY A FINISHED ONE DOES. A turn with no usage gets
  // no metadata row at all — `metaForTurn` returns null — so an empty payload is an invisible turn,
  // which is what a real stop produced while the row held 891 in, 2 out and $0.001802.
  const stoppedAt = index.indexOf('type: "stopped"');
  check("the stopped event exists", stoppedAt > 0, String(stoppedAt));
  const payload = index.slice(Math.max(0, stoppedAt - 400), stoppedAt + 500);
  for (const field of ["model, provider", "effortFields(effort)", "...counts", "...spent", 'route: "chat"']) {
    check(`...and carries ${field}`, payload.includes(field), payload.slice(0, 200));
  }
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
