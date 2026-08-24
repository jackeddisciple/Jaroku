// Reasoning effort — the one adapter between Jaroku's four levels and whatever a provider calls
// the same idea.
//
// §3.2: "Effort is a Jaroku-level abstraction that must be translated per provider at request
// time, in one adapter module — never inline at the call site." The reason that instruction is
// worth obeying is what happens when it is not: the translation appears at the generation call,
// then at the planner, then in the runner's spawn, each one slightly different, and the level a
// user picked means three things depending on what they were doing when they picked it.
//
// THREE SHAPES OF PROVIDER, and the table lives in runtime/pricing.json rather than here:
//
//   thinking  an extended-thinking token budget (Claude, Gemini 2.5). Low means OFF, not a small
//             budget — a thinking block of a few hundred tokens is the cost of the feature with
//             none of the benefit.
//   effort    a named level the API takes directly (OpenAI's `reasoning_effort`). Three levels,
//             which is why XHigh clamps.
//   null      no reasoning control at all. §6.2: the composer OMITS the chip entirely rather than
//             showing a meaningless "Low".
//
// DEGRADATION IS VISIBLE, NEVER SILENT, and that is the property this module exists to make
// possible. It returns what was REQUESTED and what was APPLIED as two separate fields, so the
// turn record can store both and the metadata row can render `High ⌄` with "XHigh requested; this
// model caps at High." §3.2's rule is one sentence: "Never report an effort that wasn't used."
//
// EVERY BUDGET IS VALIDATED AGAINST THE MODEL'S MAX OUTPUT TOKENS before dispatch. A thinking
// budget larger than the response it has to fit inside is a 400 from the provider, and a failed
// run is a worse answer than a clamp somebody can see.
//
//   npm run test:effort

import { capabilityFor, reasoningBudgets, type Capability } from "./pricing.ts";

/** The four levels, in order. The order is load-bearing — `relativeCost` and the clamp read it. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;

export type Effort = (typeof EFFORT_LEVELS)[number];

export function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/** What Jaroku defaults to when nothing has been chosen. Balanced, and the spec's own default. */
export const DEFAULT_EFFORT: Effort = "medium";

/**
 * How a request should be shaped, and what to tell the user was actually done.
 *
 * `applied` is the field the turn record stores and the metadata row reads. It is deliberately not
 * derivable from `requested` at render time: the model may have changed since, and re-deriving
 * would report the level the CURRENT toolbar would produce rather than the one this response was
 * generated with.
 */
export interface EffortPlan {
  /** What the user asked for. */
  requested: Effort;
  /** What the provider was actually asked for. Equal to `requested` unless something clamped. */
  applied: Effort;
  /** Whether the model exposes a reasoning control at all. False → the chip is omitted. */
  supported: boolean;
  /** True when `applied` is below `requested`. Drives §6.2's clamp marker. */
  clamped: boolean;
  /** The tooltip, in words, or null when nothing needs explaining. */
  reason: string | null;
  /** Anthropic / Gemini: the extended-thinking block, already validated against max output. */
  thinking: { type: "enabled"; budget_tokens: number } | { type: "disabled" } | null;
  /** OpenAI: the named level, already clamped to the three the API accepts. */
  reasoningEffort: "low" | "medium" | "high" | null;
}

/**
 * The three levels an `effort`-shaped provider accepts. XHigh is not among them, which is the
 * whole of §3.2's "Level clamps (XHigh → High)".
 */
const EFFORT_API_LEVELS = new Set(["low", "medium", "high"]);

/**
 * Translate a level for a model.
 *
 * `displayName` is only ever used to build the tooltip. It is a parameter rather than a lookup so
 * this module stays free of the model-metadata display strings, which §6.1 says come from the
 * shared file and must never be hardcoded.
 */
export function planEffort(
  modelId: string,
  requested: Effort,
  displayName?: string,
): EffortPlan {
  return planForCapability(capabilityFor(modelId), requested, displayName ?? modelId);
}

/**
 * The translation itself, against a capability record rather than a model id.
 *
 * SPLIT OUT SO THE CLAMP CAN BE ASSERTED. §12.5 — "XHigh on a clamping model completes and the
 * metadata row shows High with the clamp marker" — is about `reasoning_effort`-shaped providers,
 * and Jaroku's shipped catalogue currently has none: every OpenAI model in runtime/pricing.json is
 * a non-reasoning one. A suite that could only reach this branch through a model id would report
 * the criterion as passing while never executing a line of it, which is the worst kind of green.
 *
 * It is also the honest shape. Everything below is a pure function of the capability record and
 * the requested level; the model id was only ever a way of looking one up.
 */
export function planForCapability(
  cap: Capability | null,
  requested: Effort,
  name: string,
): EffortPlan {

  // UNKNOWN MODELS ARE UNSUPPORTED, not "probably fine". A model the capability table has never
  // heard of is a model nobody has checked, and the failure directions are not symmetric: hiding
  // a control that would have worked costs a feature, while sending a thinking budget to a model
  // that rejects it costs the run.
  if (!cap || cap.reasoning === null) {
    return {
      requested,
      applied: requested,
      supported: false,
      clamped: false,
      reason: cap
        ? `${name} doesn't expose a reasoning control.`
        : `Jaroku has no capability record for ${name}, so the reasoning control is off.`,
      thinking: null,
      reasoningEffort: null,
    };
  }

  if (cap.reasoning === "effort") {
    const clamped = !EFFORT_API_LEVELS.has(requested);
    const applied: Effort = clamped ? "high" : requested;
    return {
      requested,
      applied,
      supported: true,
      clamped,
      // The exact sentence §6.2 asks for, so the tooltip is written where the decision is made
      // rather than reconstructed in the client from a boolean.
      reason: clamped ? `XHigh requested; ${name} caps at High.` : null,
      thinking: null,
      reasoningEffort: applied as "low" | "medium" | "high",
    };
  }

  // --- extended thinking --------------------------------------------------------------------
  const budgets = reasoningBudgets();
  const wanted = budgets[requested] ?? 0;

  // LOW MEANS OFF. A few hundred thinking tokens is the cost of the feature with none of its
  // benefit, and the spec's table says "thinking off" rather than "smallest budget".
  if (wanted <= 0) {
    return {
      requested, applied: requested, supported: true, clamped: false, reason: null,
      thinking: { type: "disabled" }, reasoningEffort: null,
    };
  }

  // The budget has to leave room for an answer. A thinking block that consumes the entire output
  // allowance produces a response the provider truncates, which reads to a user as the model
  // giving up mid-sentence — a failure mode with no error attached to it.
  const ceiling = Math.floor(cap.maxOutputTokens / 2);
  if (wanted <= ceiling) {
    return {
      requested, applied: requested, supported: true, clamped: false, reason: null,
      thinking: { type: "enabled", budget_tokens: wanted }, reasoningEffort: null,
    };
  }

  // It does not fit. Step down until one does, and REPORT the level that was actually spent
  // rather than the one that was asked for.
  let applied: Effort = requested;
  for (let i = EFFORT_LEVELS.indexOf(requested) - 1; i >= 0; i--) {
    const level = EFFORT_LEVELS[i]!;
    if ((budgets[level] ?? 0) <= ceiling) { applied = level; break; }
    applied = level;
  }
  const budget = budgets[applied] ?? 0;
  return {
    requested,
    applied,
    supported: true,
    clamped: applied !== requested,
    reason: `${requested === "xhigh" ? "XHigh" : requested[0]!.toUpperCase() + requested.slice(1)} requested; ` +
      `${name} caps at ${applied === "xhigh" ? "XHigh" : applied[0]!.toUpperCase() + applied.slice(1)}.`,
    thinking: budget > 0 ? { type: "enabled", budget_tokens: budget } : { type: "disabled" },
    reasoningEffort: null,
  };
}

/**
 * Roughly how much more this level costs than Medium, for §3.2's inline hint in the popover.
 *
 * A MULTIPLE, DELIBERATELY NOT A DOLLAR FIGURE. The spec is explicit: "Do not show a fake precise
 * dollar figure pre-flight." Nobody knows how many tokens a request will spend before it runs, and
 * a precise-looking number that turns out wrong costs more trust than a vague one that turns out
 * right — doc §8's "wrong cost numbers destroy trust instantly", applied ahead of the fact.
 *
 * Null when the model has no reasoning control, because then the levels do not differ at all and a
 * hint would be describing a difference that does not exist.
 */
export function relativeCost(modelId: string, level: Effort): string | null {
  const cap = capabilityFor(modelId);
  if (!cap || cap.reasoning === null) return null;
  if (level === "medium") return null;

  if (cap.reasoning === "effort") {
    // Named levels expose no budget to compare, so the honest hint is directional rather than
    // numeric. Inventing a multiple here would be the fake precision the spec rules out.
    return level === "low" ? "cheaper than Medium" : "more than Medium";
  }

  const budgets = reasoningBudgets();
  const base = budgets.medium ?? 0;
  const here = budgets[level] ?? 0;
  if (base <= 0) return null;
  if (here <= 0) return "no thinking tokens";
  const ratio = here / base;
  // One decimal below 2x, whole numbers above: "~1.5x" is a real distinction and "~8.3x" is not.
  return `~${ratio < 2 ? ratio.toFixed(1) : Math.round(ratio)}× tokens vs Medium`;
}

/** The label the metadata row and the popover show. Capitalised as the spec writes them. */
export function effortLabel(level: Effort): string {
  return level === "xhigh" ? "XHigh" : level[0]!.toUpperCase() + level.slice(1);
}
