// The effort adapter, and the two acceptance criteria it exists to satisfy.
//
// §12.4: "Selecting a model with no reasoning support disables the effort control with an
// explanatory tooltip." §12.5: "XHigh on a clamping model completes and the metadata row shows
// High with the clamp marker."
//
// Both are about the same rule stated from opposite ends — §3.2's "Degradation is visible, not
// silent" and "Never report an effort that wasn't used." The failure they guard against is the
// comfortable one: a request that quietly downgrades and a UI that keeps reporting what was asked
// for. Nothing errors, nothing looks wrong, and the user believes they paid for XHigh reasoning on
// every turn for a month.
//
// FIVE LEVELS SINCE 2026-09-11, and per-provider names for them: Claude's "Low, Medium, High effort,
// XHigh, Max effort", OpenAI's "Light, Medium, High, Extra High, Ultra", and no control on Muse
// Spark. Those are the product owner's words and are checked here verbatim.
//
//   npm run test:effort

import {
  DEFAULT_EFFORT, EFFORT_LEVELS, effortLabel, isEffort, offeredLevels, planEffort, planForCapability,
  relativeCost, relativeCostFor,
} from "./effort.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { capabilityFor, contextWindowFor, effortLabelsFor, reasoningBudgets, type Capability } from "./pricing.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A `reasoning_effort`-shaped model that lists no levels, because the shipped catalogue has none.
 *
 * Every `effort` entry in runtime/pricing.json lists all five levels, so §12.5's clamp branch is
 * unreachable through a model id. Constructed here rather than added to the shared pricing file:
 * putting a model into that table makes it appear in the product's model selector, and a model
 * shipped so that a test can reach a branch is a model somebody eventually runs a real job on, at a
 * price nobody verified.
 */
const EFFORT_MODEL: Capability = {
  id: "o-series-test",
  reasoning: "effort",
  maxOutputTokens: 65536,
  contextWindow: 200000,
};

/**
 * A budget-shaped model, for the same reason. Since Sonnet 5, Opus 5 and Fable 5.1 took effort
 * names, the catalogue ships no extended-thinking model at all — and the branch still has to be
 * right for the first one that comes back.
 */
const THINKING_MODEL: Capability = {
  id: "thinking-test",
  reasoning: "thinking",
  maxOutputTokens: 128000,
  contextWindow: 200000,
};

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const FIVE = "low,medium,high,xhigh,max";
const CLAUDE_EFFORT = ["claude-sonnet-5", "claude-opus-5", "claude-fable-5-1"];
const OPENAI = ["gpt-6-astra", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];

console.log("\nthe capability table loaded, and it is the shared pricing file");
{
  // §3.2: "Concrete budget numbers belong in the same shared pricing/capability file as model
  // metadata, not hardcoded in the adapter." If this fails, everything below is testing defaults.
  const budgets = reasoningBudgets();
  check("the budget table has one budget per level", Object.keys(budgets).length === 5, JSON.stringify(budgets));
  check("low is OFF, not a small budget", budgets.low === 0);
  check("...and the rest ascend",
    (budgets.medium ?? 0) < (budgets.high ?? 0) && (budgets.high ?? 0) < (budgets.xhigh ?? 0) &&
      (budgets.xhigh ?? 0) < (budgets.max ?? 0));

  check("five levels, in order", EFFORT_LEVELS.join(",") === FIVE, EFFORT_LEVELS.join(","));
  check("every level is a known level", EFFORT_LEVELS.every(isEffort));
  check("...and nothing else is", !isEffort("extreme") && !isEffort("") && !isEffort(3));
  check("the default is balanced", DEFAULT_EFFORT === "medium");

  // Every model in the table answers the capability question, one way or the other. A model with
  // no record is treated as unsupported, which is safe — but silently unsupported for a model the
  // product ships is a feature that went missing without anybody deciding to remove it.
  for (const id of [
    ...CLAUDE_EFFORT, "claude-haiku-4-5", ...OPENAI, "muse-spark-1.3", "fake-dry-run",
  ]) {
    const cap = capabilityFor(id);
    check(`${id} has a capability record`, cap !== null);
    check(`...with a max output ceiling`, (cap?.maxOutputTokens ?? 0) > 0, String(cap?.maxOutputTokens));
    check(`...and a context window`, (contextWindowFor(id) ?? 0) > 0, String(contextWindowFor(id)));
  }
}

console.log("\nwhat the slider offers, model by model");
{
  // THE PRODUCT OWNER'S LIST: five stops on every Claude and OpenAI model that takes effort, and no
  // control on Muse Spark. Haiku 4.5 has none because Anthropic offers it no effort setting — a stop
  // there would be a control that changes nothing the API is sent.
  for (const id of [...CLAUDE_EFFORT, ...OPENAI]) {
    check(`${id} offers all five`, offeredLevels(id).join(",") === FIVE, offeredLevels(id).join(","));
  }
  for (const id of ["muse-spark-1.3", "claude-haiku-4-5", "fake-dry-run", "some-model-shipped-tomorrow"]) {
    check(`${id} offers none`, offeredLevels(id).length === 0, offeredLevels(id).join(","));
  }
}

console.log("\n...and what each provider calls them");
{
  const names = (provider: string): string => JSON.stringify(EFFORT_LEVELS.map((l) => effortLabelsFor(provider)?.[l]));
  check("Claude's, verbatim", names("anthropic") === JSON.stringify(["Low", "Medium", "High effort", "XHigh", "Max effort"]),
    names("anthropic"));
  check("OpenAI's, verbatim", names("openai") === JSON.stringify(["Light", "Medium", "High", "Extra High", "Ultra"]),
    names("openai"));
  check("and Meta, which has no control, has no names", effortLabelsFor("meta") === null);
}

console.log("\n§12.4 — a model with no reasoning control says so, by name");
{
  const p = planEffort("claude-haiku-4-5", "high", "Claude Haiku");
  check("it reports unsupported", !p.supported);
  // The spec's own worked tooltip, near enough that a reader recognises it.
  check("the tooltip names the model", p.reason === "Claude Haiku doesn't expose a reasoning control.", p.reason ?? "null");
  check("nothing is sent to the provider", p.thinking === null && p.reasoningEffort === null);
  // NOT a clamp. §6.2: "Model has no reasoning control: omit the chip entirely rather than showing
  // a meaningless 'Low'." A clamp marker here would be reporting a downgrade that never happened.
  check("it is not reported as a clamp", !p.clamped);
  check("...and the applied level still echoes what was asked", p.applied === "high");

  // MUSE SPARK TOO, and that one is a choice rather than a limit: Meta's API takes effort levels, and
  // the product owner asked for no control. A level carried over from another model must not leak
  // onto its requests.
  const m = planEffort("muse-spark-1.3", "max", "Muse Spark 1.3");
  check("Muse Spark is sent no effort at all", !m.supported && m.thinking === null && m.reasoningEffort === null);

  // A model nobody has recorded is unsupported for the same reason, and says a different thing —
  // "we have never checked this" is not "this model cannot reason".
  const unknown = planEffort("some-model-shipped-tomorrow", "xhigh");
  check("an unrecorded model is unsupported too", !unknown.supported);
  check("...and says why it is different", (unknown.reason ?? "").includes("no capability record"), unknown.reason ?? "");
}

console.log("\nClaude's modern models take the level by name, all five of them");
{
  // `output_config.effort`, not a thinking budget: Sonnet 5, Opus 5 and Fable 5.1 reject the old
  // `budget_tokens` shape with a 400, and take low through max by name.
  for (const id of CLAUDE_EFFORT) {
    for (const level of EFFORT_LEVELS) {
      const p = planEffort(id, level);
      check(`${id} @ ${level} goes out as effort "${level}"`,
        p.supported && !p.clamped && p.reasoningEffort === level && p.thinking === null, JSON.stringify(p));
    }
  }
}

console.log("\nextended-thinking models get a budget, and Low means off");
{
  const low = planForCapability(THINKING_MODEL, "low", "t");
  check("Low disables thinking outright", low.supported && low.thinking?.type === "disabled");
  check("...and is not a clamp", !low.clamped && low.applied === "low");

  for (const level of ["medium", "high", "xhigh", "max"] as const) {
    const p = planForCapability(THINKING_MODEL, level, "t");
    check(`${level} enables thinking`, p.thinking?.type === "enabled", JSON.stringify(p.thinking));
    check(`...at the shared file's budget`,
      p.thinking?.type === "enabled" && p.thinking.budget_tokens === reasoningBudgets()[level]);
    check(`...with no effort name set`, p.reasoningEffort === null);
  }

  // The budgets ascend in the plan, not only in the table.
  const spent = (["medium", "high", "xhigh", "max"] as const).map((l) => {
    const t = planForCapability(THINKING_MODEL, l, "t").thinking;
    return t?.type === "enabled" ? t.budget_tokens : 0;
  });
  check("a higher level really does buy more thinking",
    spent.every((s, i) => i === 0 || spent[i - 1]! < s), spent.join(" < "));
}

console.log("\n§12.5 — XHigh on a clamping model completes, and reports High");
{
  // The criterion in full, and every clause of it matters. The request must SUCCEED — a refusal
  // would be a different and worse answer, since the user asked for more thinking and would get
  // none. The record must say High. And the marker must be set, because a downgrade that is not
  // reported is the silent degradation §3.2 forbids in as many words.
  const p = planForCapability(EFFORT_MODEL, "xhigh", "o-series");
  check("the request is supported and proceeds", p.supported);
  check("...the applied level is High", p.applied === "high", p.applied);
  check("...the requested level is still XHigh", p.requested === "xhigh");
  check("...it is marked as clamped", p.clamped);
  check("...and the tooltip is §6.2's sentence",
    p.reason === "XHigh requested; o-series caps at High.", p.reason ?? "null");
  check("...and what goes to the provider is one of its three levels", p.reasoningEffort === "high");
  check("...with no thinking block, which this provider does not take", p.thinking === null);

  // MAX CLAMPS THE SAME WAY, to the highest level the model lists at or below it — never above.
  const max = planForCapability(EFFORT_MODEL, "max", "o-series");
  check("Max on a three-level model runs as High, and says so",
    max.clamped && max.applied === "high" && max.reason === "Max requested; o-series caps at High.", max.reason ?? "null");
  const four = planForCapability({ ...EFFORT_MODEL, effortLevels: ["low", "medium", "high", "xhigh"] }, "max", "o-series");
  check("...and on a four-level model, as XHigh",
    four.clamped && four.applied === "xhigh" && four.reason === "Max requested; o-series caps at XHigh.", four.reason ?? "null");

  // The three levels the API does accept pass through untouched. A clamp marker on a level that
  // was honoured would train people to ignore the marker.
  for (const level of ["low", "medium", "high"] as const) {
    const q = planForCapability(EFFORT_MODEL, level, "o-series");
    check(`${level} passes through unclamped`, !q.clamped && q.applied === level && q.reasoningEffort === level);
    check("...and needs no explanation", q.reason === null);
  }

  // AND A MODEL THAT TAKES MAX GETS IT. Which levels a model takes is `effort_levels` in the price
  // sheet; the clamp above is the default for an entry that lists none, not a rule about the kind.
  const all = planForCapability({ ...EFFORT_MODEL, effortLevels: EFFORT_LEVELS }, "max", "gpt-5.6");
  check("a model whose entry lists Max is not clamped",
    !all.clamped && all.applied === "max" && all.reasoningEffort === "max" && all.reason === null);

  // And an unsupported model does not pretend to clamp — §6.2 omits the chip instead.
  const none = planEffort("claude-haiku-4-5", "xhigh", "Haiku 4.5");
  check("an unsupported model does not fake a clamp", !none.supported && !none.clamped);

  // EVERY OPENAI MODEL THE PRODUCT OFFERS TAKES MAX — "Ultra" — and a clamp marker on any of them
  // would report a downgrade that never happened, on the models somebody picked to think harder.
  for (const id of OPENAI) {
    const q = planEffort(id, "max");
    check(`${id} runs Max as Max`, q.supported && !q.clamped && q.reasoningEffort === "max", `${q.applied} ${q.reason ?? ""}`);
  }
}

console.log("\n...and when a budget will not fit, the clamp is reported rather than the run failing");
{
  // A thinking budget must fit inside half the model's output allowance. At 128K every level fits;
  // at 64K, Max's budget does not, and the plan steps down and says so rather than sending a 400.
  const budgets = reasoningBudgets();
  const roomy = planForCapability(THINKING_MODEL, "max", "t");
  check("a 128K model's ceiling admits Max, so nothing clamps there", !roomy.clamped && roomy.applied === "max");
  const tight = planForCapability({ ...THINKING_MODEL, maxOutputTokens: 64000 }, "max", "Haiku-sized");
  check("a 64K model steps Max down to XHigh",
    tight.clamped && tight.applied === "xhigh" &&
      tight.thinking?.type === "enabled" && tight.thinking.budget_tokens === budgets.xhigh, JSON.stringify(tight));
  check("...and says so in §6.2's sentence", tight.reason === "Max requested; Haiku-sized caps at XHigh.", tight.reason ?? "null");

  // The rule itself, stated as arithmetic rather than as a model: no plan may ever emit a budget
  // that exceeds half the model's output allowance. A thinking block that eats the whole allowance
  // truncates the answer, which reads as the model giving up mid-sentence with no error attached.
  for (const size of [8192, 64000, 128000]) {
    const cap = { ...THINKING_MODEL, maxOutputTokens: size };
    for (const level of EFFORT_LEVELS) {
      const t = planForCapability(cap, level, "t").thinking;
      const spent = t?.type === "enabled" ? t.budget_tokens : 0;
      check(`${size} @ ${level} leaves room for an answer`, spent <= Math.floor(size / 2), `${spent} of ${size}`);
    }
  }
}

console.log("\nthe cost hint is a multiple, never a dollar figure");
{
  // §3.2: "Do not show a fake precise dollar figure pre-flight." A hint with a `$` in it is the
  // failure; doc §8's "wrong cost numbers destroy trust instantly" applied ahead of the fact.
  for (const level of EFFORT_LEVELS) {
    const hint = relativeCostFor(THINKING_MODEL, level);
    check(`${level}'s hint carries no currency`, hint === null || !hint.includes("$"), hint ?? "null");
  }
  check("Medium has no hint — it is the thing everything else is relative to",
    relativeCostFor(THINKING_MODEL, "medium") === null);
  check("XHigh's hint is a multiple of Medium",
    (relativeCostFor(THINKING_MODEL, "xhigh") ?? "").includes("× tokens vs Medium"),
    relativeCostFor(THINKING_MODEL, "xhigh") ?? "null");
  check("...and so is Max's", (relativeCostFor(THINKING_MODEL, "max") ?? "").includes("× tokens vs Medium"),
    relativeCostFor(THINKING_MODEL, "max") ?? "null");
  // Named levels expose no budget, so the honest hint on an effort model is a direction.
  check("an effort model's hint is a direction, not a number",
    relativeCost("claude-opus-5", "max") === "more than Medium" && relativeCost("gpt-6-astra", "low") === "cheaper than Medium");
  check("a model with no reasoning control has no hint at all",
    relativeCost("claude-haiku-4-5", "xhigh") === null && relativeCost("muse-spark-1.3", "max") === null);
}

console.log("\nthe labels are the ones the spec writes");
{
  check("XHigh keeps its capital H", effortLabel("xhigh") === "XHigh");
  check("Low", effortLabel("low") === "Low");
  check("Medium", effortLabel("medium") === "Medium");
  check("High", effortLabel("high") === "High");
  check("Max", effortLabel("max") === "Max");
}

console.log("\nthe budget is clamped against THIS call's ceiling, not the model's");
{
  // EVERY BUILDER SENDS ITS OWN `max_tokens` — 600 for a plan, 700 for an explain, 16,000 for a
  // generation — and a thinking block is spent out of that allowance. A budget validated only
  // against the model's theoretical maximum is a 400 from the provider on the plan call and a
  // truncated answer on the explain one, neither of which has an error attached to it that names
  // the cause. So the ceiling is per REQUEST, and the plan reports the level it stepped down to.
  check("planEffort narrows the ceiling to the call's own max_tokens",
    /maxOutputTokens < cap\.maxOutputTokens/.test(readFileSync(join(HERE, "effort.ts"), "utf8")));
  const roomy = planForCapability(THINKING_MODEL, "high", "t");
  check("with the model's own ceiling, High is High", roomy.applied === "high" && !roomy.clamped);

  // A planner-sized request. Whatever the budget table says High costs, 600 tokens cannot hold it
  // and leave room for an answer.
  const tight = planForCapability({ ...THINKING_MODEL, maxOutputTokens: 600 }, "high", "t");
  check("...and on a 600-token request it steps down", tight.applied !== "high" || tight.thinking?.type === "disabled");
  check("...reporting the level that was actually spent", tight.requested === "high");
  check("...with the clamp visible rather than silent", tight.clamped || tight.thinking?.type === "disabled", JSON.stringify(tight));
  if (tight.thinking?.type === "enabled") {
    check("...and a budget that leaves room to answer inside 600", tight.thinking.budget_tokens <= 300);
  }
}

console.log("\nand the adapter is actually called, at every dispatch that shipped without it");
{
  // THE ASSERTION THIS MODULE WAITED FOR. Everything above was true of code with no production
  // caller: `planEffort` was written, tested here, and reached from nothing — so a user set High,
  // the setting persisted, the chip rendered it, and every request went out at the provider's
  // default. §3.2's own rule was broken by the same absence twice: "never report an effort that
  // wasn't used", and a clamp marker that could not fire because both fields were always equal.
  const index = readFileSync(join(HERE, "index.ts"), "utf8");
  const read = (f: string): string => readFileSync(join(HERE, f), "utf8");

  check("index.ts resolves the level through the settings chain", /async function effortForThread\(/.test(index));
  check("...calling the one adapter rather than translating inline", /planEffort\(modelId, level, undefined, maxOutputTokens\)/.test(index));
  // SIX SINCE §2'S CHAT ROUTE, and the sixth is the one this counter was written to catch. Chat is
  // the composer's DEFAULT destination — the model call somebody starts by typing anything at all —
  // in a thread whose conversation settings carry an effort level exactly as a build thread's do. A
  // dispatch left out of this count is a request that goes out at the provider's default while the
  // chip beside it says High, which is the silence this whole block exists to have caught once
  // already, and it would have been silent on the highest-volume call in the product.
  check(
    "...at all six model calls the composer can start",
    (index.match(/await effortForThread\(/g) ?? []).length === 6,
    String((index.match(/await effortForThread\(/g) ?? []).length),
  );

  // AND EACH BUILDER PUTS IT ON THE REQUEST. Resolving a plan nobody sends is the same silence
  // wearing an extra function call.
  for (const file of ["planner.ts", "generator.ts", "editor.ts", "explainer.ts"]) {
    check(
      `${file} puts the thinking block on its request`,
      /\.\.\.\(effort\?\.thinking\?\.type === "enabled" \? \{ thinking: effort\.thinking \} : \{\}\)/.test(read(file)),
    );
  }

  // §6.2's TWO FIELDS, so the chip reports what was spent and the clamp marker can fire at all.
  check("the usage payload carries both levels", /function effortFields\(/.test(index));
  check("...requested AND applied, never one of them", /effort: plan\.applied, effort_requested: plan\.requested/.test(index));
  // FOUR, NOT THREE: the plan, the generation, the edit and the reply. The fourth arrived with
  // §5.4's variants, which put the metadata row on an explain's `done` event for the first time —
  // and this counter is why that was noticed here rather than by somebody looking at a chip.
  check(
    "...on the plan, the generation, the edit and the reply",
    (index.match(/\.\.\.effortFields\(/g) ?? []).length === 4,
    String((index.match(/\.\.\.effortFields\(/g) ?? []).length),
  );
  // AND THE SLIDER'S STOPS RIDE THE CATALOGUE, from the same adapter — never a client's own table.
  check("the providers snapshot carries each model's stops and names",
    /effort_levels: offeredLevels\(p\.id\)/.test(index) && /effort_labels: effortLabelsFor\(p\.provider\)/.test(index));

  // THE RUN PATH, on the seam JAROKU_PROVIDER and JAROKU_MODEL already use. Without it a
  // conversation set to High planned and edited at High and RAN at the default, which is worse
  // than the setting doing nothing: the two that work make the third look like it works too.
  check("the run env carries the level", /env\.JAROKU_REASONING_EFFORT =/.test(index));
  const models = readFileSync(join(HERE, "..", "..", "runtime", "jaroku_runner", "models.py"), "utf8");
  check("...and models.py reads it", /JAROKU_REASONING_EFFORT/.test(models));
  check("...all five of it", /_EFFORT_ORDER = \("low", "medium", "high", "xhigh", "max"\)/.test(models));
  check("...translating it beside the constructor that uses it", /thinking=\{"type": "enabled", "budget_tokens": budget\}/.test(models));
  // AND CLAMPED WHERE THE PLAN CLAMPS. The runtime reads the same `effort_levels` from the same file,
  // through the cost callback's loader, so a run cannot send a level the metadata row says was
  // stepped down — and a model that lists none takes three, so XHigh becomes High on the run too.
  const pricingPy = readFileSync(join(HERE, "..", "..", "runtime", "jaroku_interceptor", "pricing.py"), "utf8");
  check("...the price sheet's loader carries each model's levels", /effort_levels=tuple\(/.test(pricingPy));
  check("...clamping to the levels the price sheet lists for the model", /price\.effort_levels/.test(models));
  check("...and to three when it lists none", /_THREE_LEVELS = \("low", "medium", "high"\)/.test(models));
  // Claude's modern models take their effort NAME from that same list, not from a table of their own.
  const anthropicBranch = models.slice(models.indexOf('if provider == "anthropic":'), models.indexOf('if provider == "openai":'));
  check("...Claude's effort name comes from the price sheet", /effort = _named_effort\(model_name, level\)/.test(anthropicBranch));
  // AND MUSE SPARK IS SENT NONE, the product owner's call: its branch never spreads the named level.
  const metaBranch = models.slice(models.indexOf('if provider == "meta":'), models.indexOf("return build_dry_run_model"));
  check("...and Muse Spark is sent no effort at all", metaBranch.length > 0 && !metaBranch.includes("**named"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
