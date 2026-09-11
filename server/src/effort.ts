// Reasoning effort — the one adapter between Jaroku's five levels and whatever a provider calls
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
//   thinking  an extended-thinking token budget, for a model that takes budgets rather than effort
//             names (none in the shipped catalogue). Low means OFF, not a small budget — a
//             thinking block of a few hundred tokens is the cost of the feature with none of the
//             benefit.
//   effort    a named level the API takes directly — Claude's `output_config.effort`, OpenAI's
//             `reasoning.effort`. Which levels, per model, is `effort_levels`; an entry that lists
//             none takes three, which is where XHigh and Max clamp.
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

/**
 * The five levels, in order. The order is load-bearing — `relativeCost` and the clamp read it.
 *
 * `max` IS THE FIFTH SINCE 2026-09-11: Claude's Sonnet 5, Opus 5 and Fable 5.1 and OpenAI's GPT-6
 * Astra and GPT-5.6 all take a level above XHigh, and the composer offers it. What a provider CALLS
 * each one — "Ultra", "Max effort" — is `reasoning.labels` in pricing.json, not this list.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

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
  /** Anthropic: the extended-thinking block, already validated against max output. */
  thinking: { type: "enabled"; budget_tokens: number } | { type: "disabled" } | null;
  /** OpenAI / Meta: the named level, already clamped to the ones the model takes. */
  reasoningEffort: Effort | null;
}

/**
 * The levels an `effort`-shaped model takes when its price-sheet entry lists none — the three every
 * such API has accepted. XHigh is not among them, which is the whole of §3.2's "Level clamps (XHigh
 * → High)". A model that takes more says so in `effort_levels`.
 */
const DEFAULT_EFFORT_LEVELS: readonly string[] = ["low", "medium", "high"];

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
  /**
   * The `max_tokens` THIS CALL will send, when it is smaller than the model's ceiling.
   *
   * Every caller sets its own: the planner asks for 600, an explain for 700, a generation for
   * 16,000. A thinking budget has to leave room for an answer INSIDE THAT, not inside whatever the
   * model could theoretically produce — a 4,000-token thinking block on a 600-token request is a
   * 400 from the provider, and a failed dispatch is a worse answer than a visible clamp. So the
   * ceiling is per request rather than per model, and the plan reports the level it stepped down
   * to, which is what makes §3.2's "never report an effort that wasn't used" true here as well.
   *
   * Omitted, this is exactly what it always was: the model's own maximum.
   */
  maxOutputTokens?: number,
): EffortPlan {
  const cap = capabilityFor(modelId);
  const scoped = cap && maxOutputTokens !== undefined && maxOutputTokens < cap.maxOutputTokens
    ? { ...cap, maxOutputTokens }
    : cap;
  return planForCapability(scoped, requested, displayName ?? modelId);
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
    // THE HIGHEST LEVEL THE MODEL TAKES AT OR BELOW THE ONE ASKED FOR — never above it, which would
    // spend more than somebody chose. models.py applies the same rule to the same list.
    const accepted = cap.effortLevels ?? DEFAULT_EFFORT_LEVELS;
    const applied: Effort = EFFORT_LEVELS
      .slice(0, EFFORT_LEVELS.indexOf(requested) + 1)
      .reverse()
      .find((l) => accepted.includes(l)) ?? requested;
    const clamped = applied !== requested;
    return {
      requested,
      applied,
      supported: true,
      clamped,
      // The exact sentence §6.2 asks for, so the tooltip is written where the decision is made
      // rather than reconstructed in the client from a boolean.
      reason: clamped ? `${effortLabel(requested)} requested; ${name} caps at ${effortLabel(applied)}.` : null,
      thinking: null,
      reasoningEffort: applied,
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
    reason: `${effortLabel(requested)} requested; ${name} caps at ${effortLabel(applied)}.`,
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
  return relativeCostFor(capabilityFor(modelId), level);
}

/** `relativeCost` against a capability record, so a shape the catalogue does not ship can be asserted. */
export function relativeCostFor(cap: Capability | null, level: Effort): string | null {
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

/**
 * The levels the composer's slider offers for a model — the stops somebody can actually pick.
 *
 * For an `effort` model, the ones its entry lists (three when it lists none, the clamp's default).
 * For a `thinking` model, the ones whose budget fits inside half its output allowance, because a
 * stop the plan would always clamp is a stop that lies. None for a model with no reasoning control —
 * Muse Spark, by the product owner's call, and Haiku 4.5, which takes no effort at all.
 */
export function offeredLevels(modelId: string): Effort[] {
  const cap = capabilityFor(modelId);
  if (!cap || cap.reasoning === null) return [];
  if (cap.reasoning === "effort") {
    const accepted = cap.effortLevels ?? DEFAULT_EFFORT_LEVELS;
    return EFFORT_LEVELS.filter((l) => accepted.includes(l));
  }
  const budgets = reasoningBudgets();
  const ceiling = Math.floor(cap.maxOutputTokens / 2);
  return EFFORT_LEVELS.filter((l) => (budgets[l] ?? 0) <= ceiling);
}
