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
//   npm run test:effort

import {
  DEFAULT_EFFORT, EFFORT_LEVELS, effortLabel, isEffort, planEffort, planForCapability, relativeCost,
} from "./effort.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { capabilityFor, contextWindowFor, reasoningBudgets, type Capability } from "./pricing.ts";

/**
 * A `reasoning_effort`-shaped model, because the shipped catalogue has none.
 *
 * Every OpenAI entry in runtime/pricing.json is a non-reasoning model today, so §12.5's clamp
 * branch is unreachable through a model id. Constructed here rather than added to the shared
 * pricing file: putting a model into that table makes it appear in the product's model selector,
 * and a model shipped so that a test can reach a branch is a model somebody eventually runs a real
 * job on, at a price nobody verified.
 */
const EFFORT_MODEL: Capability = {
  id: "o-series-test",
  reasoning: "effort",
  maxOutputTokens: 65536,
  contextWindow: 200000,
};

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nthe capability table loaded, and it is the shared pricing file");
{
  // §3.2: "Concrete budget numbers belong in the same shared pricing/capability file as model
  // metadata, not hardcoded in the adapter." If this fails, everything below is testing defaults.
  const budgets = reasoningBudgets();
  check("the budget table is present", Object.keys(budgets).length === 4, JSON.stringify(budgets));
  check("low is OFF, not a small budget", budgets.low === 0);
  check("...and the rest ascend", (budgets.medium ?? 0) < (budgets.high ?? 0) && (budgets.high ?? 0) < (budgets.xhigh ?? 0));

  check("every level is a known level", EFFORT_LEVELS.every(isEffort));
  check("...and nothing else is", !isEffort("extreme") && !isEffort("") && !isEffort(3));
  check("the default is balanced", DEFAULT_EFFORT === "medium");

  // Every model in the table answers the capability question, one way or the other. A model with
  // no record is treated as unsupported, which is safe — but silently unsupported for a model the
  // product ships is a feature that went missing without anybody deciding to remove it.
  for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "gpt-4o", "gemini-2.5-pro", "fake-dry-run"]) {
    const cap = capabilityFor(id);
    check(`${id} has a capability record`, cap !== null);
    check(`...with a max output ceiling`, (cap?.maxOutputTokens ?? 0) > 0, String(cap?.maxOutputTokens));
    check(`...and a context window`, (contextWindowFor(id) ?? 0) > 0, String(contextWindowFor(id)));
  }
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

  // A model nobody has recorded is unsupported for the same reason, and says a different thing —
  // "we have never checked this" is not "this model cannot reason".
  const unknown = planEffort("some-model-shipped-tomorrow", "xhigh");
  check("an unrecorded model is unsupported too", !unknown.supported);
  check("...and says why it is different", (unknown.reason ?? "").includes("no capability record"), unknown.reason ?? "");
}

console.log("\nextended-thinking providers get a budget, and Low means off");
{
  const low = planEffort("claude-opus-5", "low");
  check("Low disables thinking outright", low.supported && low.thinking?.type === "disabled");
  check("...and is not a clamp", !low.clamped && low.applied === "low");

  for (const level of ["medium", "high", "xhigh"] as const) {
    const p = planEffort("claude-opus-5", level);
    check(`${level} enables thinking`, p.thinking?.type === "enabled", JSON.stringify(p.thinking));
    check(`...at the shared file's budget`,
      p.thinking?.type === "enabled" && p.thinking.budget_tokens === reasoningBudgets()[level]);
    check(`...with no OpenAI field set`, p.reasoningEffort === null);
  }

  // The budgets ascend in the plan, not only in the table.
  const spent = (["medium", "high", "xhigh"] as const).map((l) => {
    const t = planEffort("claude-opus-5", l).thinking;
    return t?.type === "enabled" ? t.budget_tokens : 0;
  });
  check("a higher level really does buy more thinking", spent[0]! < spent[1]! && spent[1]! < spent[2]!, spent.join(" < "));
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

  // The three levels the API does accept pass through untouched. A clamp marker on a level that
  // was honoured would train people to ignore the marker.
  for (const level of ["low", "medium", "high"] as const) {
    const q = planForCapability(EFFORT_MODEL, level, "o-series");
    check(`${level} passes through unclamped`, !q.clamped && q.applied === level && q.reasoningEffort === level);
    check("...and needs no explanation", q.reason === null);
  }

  // And an unsupported model does not pretend to clamp — §6.2 omits the chip instead.
  const none = planEffort("gpt-4o", "xhigh", "GPT-4o");
  check("an unsupported model does not fake a clamp", !none.supported && !none.clamped);
}

console.log("\n...and when a budget will not fit, the clamp is reported rather than the run failing");
{
  // Haiku's ceiling is 8192, so half of it is 4096 — which admits Medium (4000) and refuses High
  // (16000). Haiku has no reasoning control, so the case is constructed on a thinking model with a
  // small ceiling instead: gemini-2.0-flash is 8192 but also unsupported. The property under test
  // is the arithmetic, so it is asserted through the one model that has both.
  const budgets = reasoningBudgets();
  const cap = capabilityFor("claude-opus-5")!;
  const ceiling = Math.floor(cap.maxOutputTokens / 2);
  check("Opus's ceiling admits XHigh, so nothing clamps there",
    (budgets.xhigh ?? 0) <= ceiling, `${budgets.xhigh} vs ${ceiling}`);
  const p = planEffort("claude-opus-5", "xhigh");
  check("...and the plan agrees", !p.clamped && p.applied === "xhigh" && p.reason === null);

  // The rule itself, stated as arithmetic rather than as a model: no plan may ever emit a budget
  // that exceeds half the model's output allowance. A thinking block that eats the whole allowance
  // truncates the answer, which reads as the model giving up mid-sentence with no error attached.
  for (const id of ["claude-opus-5", "claude-sonnet-5", "gemini-2.5-pro", "gemini-2.5-flash"]) {
    const c = capabilityFor(id)!;
    for (const level of EFFORT_LEVELS) {
      const t = planEffort(id, level).thinking;
      const spent = t?.type === "enabled" ? t.budget_tokens : 0;
      check(`${id} @ ${level} leaves room for an answer`,
        spent <= Math.floor(c.maxOutputTokens / 2), `${spent} of ${c.maxOutputTokens}`);
    }
  }
}

console.log("\nthe cost hint is a multiple, never a dollar figure");
{
  // §3.2: "Do not show a fake precise dollar figure pre-flight." A hint with a `$` in it is the
  // failure; doc §8's "wrong cost numbers destroy trust instantly" applied ahead of the fact.
  for (const level of EFFORT_LEVELS) {
    const hint = relativeCost("claude-opus-5", level);
    check(`${level}'s hint carries no currency`, hint === null || !hint.includes("$"), hint ?? "null");
  }
  check("Medium has no hint — it is the thing everything else is relative to",
    relativeCost("claude-opus-5", "medium") === null);
  check("XHigh's hint is a multiple of Medium",
    (relativeCost("claude-opus-5", "xhigh") ?? "").includes("× tokens vs Medium"),
    relativeCost("claude-opus-5", "xhigh") ?? "null");
  check("a model with no reasoning control has no hint at all",
    relativeCost("claude-haiku-4-5", "xhigh") === null);
}

console.log("\nthe labels are the ones the spec writes");
{
  check("XHigh keeps its capital H", effortLabel("xhigh") === "XHigh");
  check("Low", effortLabel("low") === "Low");
  check("Medium", effortLabel("medium") === "Medium");
  check("High", effortLabel("high") === "High");
}

console.log("\nthe budget is clamped against THIS call's ceiling, not the model's");
{
  // EVERY BUILDER SENDS ITS OWN `max_tokens` — 600 for a plan, 700 for an explain, 16,000 for a
  // generation — and a thinking block is spent out of that allowance. A budget validated only
  // against the model's theoretical maximum is a 400 from the provider on the plan call and a
  // truncated answer on the explain one, neither of which has an error attached to it that names
  // the cause. So the ceiling is per REQUEST, and the plan reports the level it stepped down to.
  // The same model the block above uses, for the same reason: it is a real entry in the shipped
  // catalogue and is thinking-shaped, so this exercises the branch the product actually takes.
  const model = "claude-opus-5";
  check("the model under test is thinking-shaped", capabilityFor(model)?.reasoning === "thinking");
  {
    const roomy = planEffort(model, "high");
    check("with the model's own ceiling, High is High", roomy.applied === "high" && !roomy.clamped);

    // A planner-sized request. Whatever the budget table says High costs, 600 tokens cannot hold
    // it and leave room for an answer.
    const tight = planEffort(model, "high", undefined, 600);
    check("...and on a 600-token request it steps down", tight.applied !== "high" || tight.thinking?.type === "disabled");
    check("...reporting the level that was actually spent", tight.requested === "high");
    check(
      "...with the clamp visible rather than silent",
      tight.clamped || tight.thinking?.type === "disabled",
      JSON.stringify(tight),
    );
    if (tight.thinking?.type === "enabled") {
      check("...and a budget that leaves room to answer inside 600", tight.thinking.budget_tokens <= 300);
    }

    // A ceiling ABOVE the model's own changes nothing — it is a floor of two, not a replacement.
    const generous = planEffort(model, "high", undefined, 10_000_000);
    check("a ceiling above the model's own is ignored", JSON.stringify(generous) === JSON.stringify(roomy));
  }
}

console.log("\nand the adapter is actually called, at every dispatch that shipped without it");
{
  // THE ASSERTION THIS MODULE WAITED FOR. Everything above was true of code with no production
  // caller: `planEffort` was written, tested here, and reached from nothing — so a user set High,
  // the setting persisted, the chip rendered it, and every request went out at the provider's
  // default. §3.2's own rule was broken by the same absence twice: "never report an effort that
  // wasn't used", and a clamp marker that could not fire because both fields were always equal.
  const HERE = dirname(fileURLToPath(import.meta.url));
  const index = readFileSync(join(HERE, "index.ts"), "utf8");
  const read = (f: string): string => readFileSync(join(HERE, f), "utf8");

  check("index.ts resolves the level through the settings chain", /async function effortForThread\(/.test(index));
  check("...calling the one adapter rather than translating inline", /planEffort\(modelId, level, undefined, maxOutputTokens\)/.test(index));
  // FIVE SINCE PART 3, and the fifth is the one worth naming: answering a question from the record
  // is a model call the composer can start, on `JAROKU_EXPLAIN_MODEL`, in a thread whose
  // conversation settings carry an effort level exactly as a build thread's do. A dispatch left out
  // of this count is a request that goes out at the provider's default while the chip beside it
  // says High — which is the silence this whole block exists to have caught once already.
  check(
    "...at all five model calls the composer can start",
    (index.match(/await effortForThread\(/g) ?? []).length === 5,
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

  // THE RUN PATH, on the seam JAROKU_PROVIDER and JAROKU_MODEL already use. Without it a
  // conversation set to High planned and edited at High and RAN at the default, which is worse
  // than the setting doing nothing: the two that work make the third look like it works too.
  check("the run env carries the level", /env\.JAROKU_REASONING_EFFORT =/.test(index));
  const models = readFileSync(join(HERE, "..", "..", "runtime", "jaroku_runner", "models.py"), "utf8");
  check("...and models.py reads it", /JAROKU_REASONING_EFFORT/.test(models));
  check("...translating it beside the constructor that uses it", /thinking=\{"type": "enabled", "budget_tokens": budget\}/.test(models));
  check("...and clamping XHigh for the three-level provider", /"xhigh": "high"/.test(models));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
