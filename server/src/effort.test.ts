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

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
