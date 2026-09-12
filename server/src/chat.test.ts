// The chat route's own facts — §2, §8.1 and §11.1's floor.
//
// WHAT IS WORTH A SUITE HERE. Not the stream: `streamExplain` is the engine and has its own
// coverage. What this asserts is the three things that fail SILENTLY.
//
//   THE MODEL IS PRICED. `costFor` returns null for a model with no entry in
//   `runtime/pricing.json`, and null renders as "unknown" everywhere in this product. A default
//   chat model that nothing prices would make every chat turn's cost unknown, forever, and the
//   only symptom would be an absent figure that looks like a rendering choice.
//
//   THE MODEL IS INDEPENDENT. §11.1: "The chat model is separate from the eval, plan and generation
//   models. Changing one must not change another." A constant that read one of the others would
//   make that false the first time somebody set an env var, silently.
//
//   THE RULES ARE STILL IN THE PROMPT. A prompt is code that is never compiled, so a deleted
//   paragraph produces no error anywhere — the only thing that notices is something that looks for
//   it. `test:convo-honesty` does exactly this for `CONVERSATION_SYSTEM`; this is its sibling.
//
//   npm run test:chat

import { readFileSync } from "node:fs";

import { CHAT_MAX_TOKENS, CHAT_MODEL, chatContext } from "./chat.ts";
import { CHAT_SYSTEM, chatClosing } from "./prompt.ts";
import { allPrices, capabilityFor, costFor, isPriced, priceFor } from "./pricing.ts";
import { EXPLAIN_MODEL } from "./explainer.ts";
import { PLAN_MODEL } from "./planner.ts";
import { EDIT_MODEL } from "./editor.ts";

let fail = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

// --- the model ------------------------------------------------------------------------------

console.log("\nthe chat model");
{
  check("has a pricing entry", isPriced(CHAT_MODEL), CHAT_MODEL);
  // §10: "An unpriced chat model shows cost unknown and is excluded from totals rather than
  // contributing zero." That is the right behaviour for a model somebody points us at; it must not
  // be the behaviour of the DEFAULT, which would make the cost line permanently absent.
  const cost = costFor(CHAT_MODEL, { inputTokens: 1000, outputTokens: 200 });
  check("...so a chat turn's cost is a number, not unknown", cost !== null && cost > 0, cost);

  // §11.1's default: the cheapest model among the ones Jaroku's own thinking can reach, which is
  // Anthropic-only — see providers.ts's note about which calls the platform makes.
  const chat = priceFor(CHAT_MODEL);
  const cheapest = allPrices()
    .filter((m) => m.provider === "anthropic")
    .reduce<number | null>((lo, m) => (lo === null || m.input < lo ? m.input : lo), null);
  check("...and the cheapest Anthropic one there is", chat !== null && chat.input === cheapest,
    { chat: chat?.input, cheapest });
  check("it is an Anthropic model", chat?.provider === "anthropic", chat?.provider);

  // THE CEILING IS VALIDATED AGAINST A REAL NUMBER. The effort adapter clamps a thinking budget
  // against what THIS call sends, so a ceiling above the model's own maximum would be a budget
  // validated against nothing.
  const cap = capabilityFor(CHAT_MODEL);
  check("the chat ceiling fits the model's own maximum",
    cap !== null && CHAT_MAX_TOKENS <= cap.maxOutputTokens, { CHAT_MAX_TOKENS, max: cap?.maxOutputTokens });
}

// --- §11.1: separate from the other four ----------------------------------------------------
//
// READ OFF THE SOURCE rather than by setting env vars, because the constants are resolved at import
// time and a suite cannot re-import a module with a different environment. What can be asserted is
// the thing that actually goes wrong: that `chat.ts` does not resolve its model THROUGH one of the
// others. `PLAN_MODEL` falls through `JAROKU_GEN_MODEL` deliberately and says so; this must not.

console.log("\nindependence from the other model paths");
{
  const src = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");
  // THE RESOLUTION EXPRESSION ALONE, not the whole file. The file NAMES the other four in the
  // comment that explains why it is separate from them, and a substring search over the source
  // would fail on the very paragraph that documents the property being asserted.
  const resolution = /export const CHAT_MODEL\s*=([^;]*);/.exec(src)?.[1] ?? "";
  check("there is a resolution to read", resolution.trim().length > 0, resolution);
  check("it reads JAROKU_CHAT_MODEL", resolution.includes("JAROKU_CHAT_MODEL"), resolution);
  for (const other of ["JAROKU_GEN_MODEL", "JAROKU_PLAN_MODEL", "JAROKU_EDIT_MODEL", "JAROKU_EXPLAIN_MODEL"]) {
    // `PLAN_MODEL` falls through `JAROKU_GEN_MODEL` on purpose and says so in its own comment.
    // This must not: §11.1's "changing one must not change another" is exactly that fall-through's
    // absence.
    check(`...and never falls through ${other}`, !resolution.includes(other), resolution);
  }
  check("...nor through another module's constant",
    !/EXPLAIN_MODEL|PLAN_MODEL|EDIT_MODEL|GENERATION_MODEL/.test(resolution), resolution);
  // The four are allowed to be the same id today — they all default to the cheapest Anthropic
  // model. What is asserted is that they are four INDEPENDENT resolutions, which the check above
  // establishes; this records the current alignment so a change to one is visible in a diff.
  check("today all five default to one id (recorded, not required)",
    new Set([CHAT_MODEL, EXPLAIN_MODEL, PLAN_MODEL, EDIT_MODEL]).size >= 1,
    { CHAT_MODEL, EXPLAIN_MODEL, PLAN_MODEL, EDIT_MODEL });
}

// --- §8.1: the context block says the absence out loud --------------------------------------

console.log("\nthe context block");
{
  const withAgent = chatContext({ agentName: "weather-agent" });
  check("names the agent", withAgent.includes("weather-agent"), withAgent);

  const none = chatContext({ agentName: null });
  // THE DECISION §8.1 NAMES. "When no agent is selected the block says that plainly rather than
  // being omitted, so the model knows the difference between 'no agent' and 'agent unknown'." An
  // omitted block is an absence a model fills in.
  check("an absent agent is stated, not omitted", none.trim().length > 0 && /none|no agent/i.test(none), none);
  check("...and the block is still labelled", none.includes("JAROKU CONTEXT"), none);
  check("...and it does not name an agent", !/weather/i.test(none), none);
}

// --- §2.2 and §8.3: the rules that keep the route honest ------------------------------------

console.log("\nthe rules in CHAT_SYSTEM");
{
  const rules: [string, RegExp][] = [
    // §8.3 — the rule this whole route is judged on.
    ["never invent a fact about their own system", /NEVER INVENT A FACT ABOUT THEIR OWN SYSTEM/],
    ["an explicit 'I don't have that' is offered", /can't see that from here/i],
    // §2.2 — the write boundary, stated as well as enforced.
    ["it cannot change anything", /CANNOT CHANGE ANYTHING/],
    ["...and must not claim to have", /Never say or imply that you have/i],
    // §8.3 / v0.1.9 — the cost rule, in the prompt as well as in pricing.ts.
    ["unknown is not zero", /UNKNOWN IS NOT ZERO/],
    ["...spelled with the figure that must never appear", /\$0\.00/],
    // §8.1 — a general question is answered as a general question.
    ["general questions are fair game", /General questions/i],
  ];
  for (const [name, re] of rules) check(name, re.test(CHAT_SYSTEM), name);
  // It is a set of RULES rather than a paragraph of tone. Four of the seven above are honesty
  // properties, and a prompt that lost the numbered structure would lose their ordering with it.
  check("the rules are ordered by damage", /IN ORDER OF HOW MUCH DAMAGE/.test(CHAT_SYSTEM));
}

console.log("\nthe closing paragraph");
{
  const named = chatClosing("weather-agent");
  check("names the agent it may speak about", named.includes("weather-agent"), named);
  check("...and repeats the two rules worth repeating",
    /cannot see it/i.test(named) && /cannot change anything/i.test(named), named);

  const anon = chatClosing(null);
  // §8.1 AGAIN, FROM THE OTHER SIDE. A closing that invented a name here would contradict the
  // context block that has just said there is no agent.
  check("an absent agent is said plainly", /no agent is open/i.test(anon), anon);
  check("...and no name is invented", !/"/.test(anon.split("—")[0] ?? anon), anon);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
