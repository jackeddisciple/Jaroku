// Every figure on the Activity tab, as data: what it is measured in, how it is written down, which
// direction is good, and what it renders when there is nothing.
//
// §3.3 IS THE WHOLE REASON THIS FILE EXISTS. "There is no global 'up is bad' or 'green is down'
// rule, and applying one would make this page lie." Spend up 18% is bad. Tokens up 94% is neutral —
// it is a fact about how busy the workspace is, not a verdict. Success rate down 3% is bad. Latency
// down is good. Four metrics, four different answers to the same arrow, and a component that decided
// with a conditional would get one of them wrong the day a fifth metric is added beside it.
//
// So polarity is declared NEXT TO THE METRIC, as `goodWhen`, and the badge renders from that. The
// component asks what tone to draw and never asks what the number means.
//
// EMPTY IS NOT ZERO, AND IT IS DECLARED HERE TOO (§3.5). A new workspace, or a range with nothing in
// it, renders an em dash and a short line of context — never `0`, never `$0.00`, never a chart axis
// implying a flat line at zero. That is the same rule v0.1.9 established when an unpriced model
// rendered as a false `$0`, and on a dashboard it matters more, because every figure here will be
// screenshotted and quoted. A formatter that coerced null to zero would undo it silently, so `null`
// is a value every formatter below handles first and explicitly.
//
// PURE, AND ITS OWN MODULE FOR THE REASON `inboxBoard.ts` AND `agentTags.ts` ARE. Each rule looks
// obviously right in a screenshot and is wrong in the case nobody had that day: a delta against a
// previous window of zero, a percentage of a percentage, a token count that has to stay legible at
// four digits and at nine.

import { shortCount } from "./format.ts";

/** What a figure is measured in. The unit decides the formatter, never the component. */
export type MetricUnit = "usd" | "tokens" | "count" | "percent" | "ms";

/**
 * Which direction of change is good news.
 *
 * `neutral` IS NOT "WE HAVE NOT DECIDED". It is a positive claim that the metric has no good
 * direction — token volume going up means the workspace is busier, which is neither a win nor a
 * problem, and painting it green would congratulate somebody for a retry storm.
 */
export type MetricPolarity = "up" | "down" | "neutral";

export interface MetricDef {
  /** The label the card leads with. Sentence case; the card's own type styling uppercases it. */
  label: string;
  unit: MetricUnit;
  goodWhen: MetricPolarity;
  /**
   * The line under the big figure when there IS data. Short, factual, present tense.
   *
   * A FUNCTION OF THE WINDOW rather than a constant, because §1 requires every card to state its own
   * window: "each card states its window in its context line so a screenshot is never ambiguous".
   */
  context: (rangeLabel: string) => string;
  /** §3.5's line when the figure is `--`. Says why there is nothing, never apologises for it. */
  empty: string;
}

/** How a range writes itself into a context line. The control's labels, in prose form. */
export const RANGE_LABEL: Record<string, string> = {
  "24h": "the last 24 hours",
  "7d": "the last 7 days",
  "30d": "the last 30 days",
  custom: "the selected range",
};

/**
 * The registry. Every figure the hero row, the health strip and the leaderboard put in large type.
 *
 * Keyed by a stable id rather than by label, because the label is a rendering and the id travels: a
 * delta badge, a skeleton and an empty state all name the same metric and must not disagree about
 * which one they are drawing.
 */
export const METRICS = {
  spend: {
    label: "Spend",
    unit: "usd",
    // The one figure on this page with an unambiguous direction. Money going up is money going up.
    goodWhen: "down",
    context: (r) => `across the workspace, ${r}`,
    empty: "nothing has been billed in this range",
  },
  tokens: {
    label: "Tokens",
    unit: "tokens",
    // NEUTRAL, DELIBERATELY. §3.3 names this one: volume is how much work happened, and a workspace
    // that doubled its throughput and a workspace that doubled its retries produce the same arrow.
    goodWhen: "neutral",
    context: (r) => `input and output, ${r}`,
    empty: "no model calls in this range",
  },
  cached: {
    label: "Cached",
    unit: "tokens",
    // Up is good: a cache read bills at a fraction of a fresh one, so this rising is the pricing
    // layer working. It is the cheapest real insight on the page — nothing else in the product
    // surfaces whether prompt caching is actually engaging.
    goodWhen: "up",
    context: (r) => `read from cache, ${r}`,
    empty: "no call in this range recorded a cache split",
  },
  runs: {
    label: "Runs",
    unit: "count",
    goodWhen: "neutral",
    context: (r) => `started ${r}`,
    empty: "nothing has run in this range",
  },
  successRate: {
    label: "Success rate",
    unit: "percent",
    goodWhen: "up",
    context: (r) => `of settled runs, ${r}`,
    // A rate needs a denominator, and the honest empty is that there was one of nothing — not 0%,
    // which claims every run failed.
    empty: "no run has settled in this range",
  },
  p50: {
    label: "p50",
    unit: "ms",
    goodWhen: "down",
    context: (r) => `per run, from step timings, ${r}`,
    empty: "no run has settled in this range",
  },
  p95: {
    label: "p95",
    unit: "ms",
    goodWhen: "down",
    context: (r) => `per run, from step timings, ${r}`,
    empty: "no run has settled in this range",
  },
  failures: {
    label: "Failures",
    unit: "count",
    goodWhen: "down",
    context: (r) => `runs that ended in error, ${r}`,
    empty: "nothing has run in this range",
  },
} as const satisfies Record<string, MetricDef>;

export type MetricId = keyof typeof METRICS;

export function metric(id: MetricId): MetricDef {
  return METRICS[id];
}

// --- formatting -------------------------------------------------------------------------------
//
// §3.2: "Every card leads with one large figure in the mono face using tabular figures." The mono
// face and the tabular figures are the component's business; what is decided here is how many
// characters the number is allowed to be, because a hero figure that grows from `$9.40` to
// `$12,481.02` and pushes its own delta badge off the card is a layout bug that only appears in a
// busy workspace.

/** How money is written. Two decimals under four figures, none above — see `formatMetric`. */
function usd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100_000) return `$${Math.round(value / 1000).toLocaleString("en-US")}k`;
  // Under a cent but not zero is the case that matters: a single cheap step is real spend, and
  // rounding it to `$0.00` is the false-zero rule reappearing one layer up from where v0.1.9 fixed
  // it. Four decimals is what the trace already shows for a single step.
  if (abs > 0 && abs < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * How a token count is written here: shortened, because the hero row is three figures across and a
 * nine-digit number makes the other two illegible on a phone.
 *
 * THE ARITHMETIC IS `format.shortCount` NOW. It was a second implementation of the same idea with
 * a different suffix case, which is how the same quantity came to read as `11.6K` on this tab and
 * `11,646 tok` in the Usage panel one screen away. What stays local is the decision that this
 * surface wants the short form and no unit suffix — the caption under each figure names the unit.
 */
function tokens(value: number): string {
  return shortCount(value);
}

/** Milliseconds, in the unit a person would say out loud. */
function duration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * The one place a metric's value becomes a string.
 *
 * NULL IS THE FIRST CASE AND IT RETURNS §3.5's DASH. Not "0", not "$0.00", not an empty string —
 * an em-dash-width `--` that reads as "there is nothing here" and cannot be mistaken for a figure.
 * Every caller goes through this, which is what makes the rule hold rather than be remembered at
 * eleven call sites.
 */
// THE SAME CHARACTER `format.ts` RETURNS FOR A MISSING VALUE. It was a pair of hyphens against
// that module's em dash, and both appear on the Activity tab at the same size — two different
// characters meaning exactly the same thing, a few pixels apart.
export const EMPTY_FIGURE = "—";

export function formatMetric(unit: MetricUnit, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY_FIGURE;
  switch (unit) {
    case "usd":
      return usd(value);
    case "tokens":
      return tokens(value);
    case "percent":
      // Whole percents. A success rate quoted to one decimal invites somebody to compare 94.2% with
      // 94.3% across two screenshots taken a minute apart, which is noise wearing precision.
      return `${Math.round(value * 100)}%`;
    case "ms":
      return duration(value);
    case "count":
      return Math.round(value).toLocaleString("en-US");
  }
}

// --- deltas -----------------------------------------------------------------------------------

/** What a badge draws: a signed percentage, and the tone its metric's polarity gives it. */
export interface Delta {
  /** Signed fraction — 0.18 is "up 18%". */
  fraction: number;
  direction: "up" | "down" | "flat";
  /** What the badge means, which is what decides its colour. Never derived from `direction`. */
  tone: "good" | "bad" | "neutral";
}

/**
 * §3.3's badge, from two figures and one polarity.
 *
 * `null` MEANS "NO COMPARISON", AND THE THREE WAYS TO GET IT ARE ALL REAL. The caller says the
 * window is not comparable (a workspace younger than the previous window). The previous figure is
 * unknown — an unpriced model, a range with no settled runs — which is the same claim one layer
 * down. Or the previous figure is zero, and a percentage against zero is not a large number, it is
 * an undefined one: going from nothing to something is not "up 100%", it is the first of them.
 *
 * A ZERO CHANGE IS `flat` AND `neutral` WHATEVER THE POLARITY IS. Spend that did not move is not
 * good news, it is no news, and painting it green because the metric's good direction is down would
 * congratulate a workspace for a week in which nothing happened.
 */
export function deltaOf(
  current: number | null | undefined,
  previous: number | null | undefined,
  goodWhen: MetricPolarity,
  comparable = true,
): Delta | null {
  if (!comparable) return null;
  if (current === null || current === undefined || !Number.isFinite(current)) return null;
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;

  const fraction = (current - previous) / Math.abs(previous);
  // A change smaller than half a percent renders as flat rather than as `0%` with an arrow on it.
  // An arrow claims a direction, and at this size the direction is rounding.
  if (Math.abs(fraction) < 0.005) return { fraction: 0, direction: "flat", tone: "neutral" };

  const direction = fraction > 0 ? "up" : "down";
  const tone =
    goodWhen === "neutral" ? "neutral" : direction === goodWhen ? "good" : "bad";
  return { fraction, direction, tone };
}

/** Where a percentage stops being a number anybody reads and becomes a multiplier. */
const MULTIPLIER_AT = 10;

/**
 * How a delta writes itself. Always signed, always whole percents, `--` when there is none.
 *
 * PAST TEN TIMES IT BECOMES A MULTIPLIER, because `+4179900%` is arithmetic rather than information
 * and is wide enough to reflow the card it sits on. A workspace's first busy week against a nearly
 * empty one produces exactly that, and `×42k` is both shorter and the sentence somebody would
 * actually say.
 *
 * ONLY UPWARDS, and that is a fact about the arithmetic rather than a decision. Every figure on this
 * page is a count, a sum or a rate, so none of them goes below zero — which means a downward
 * fraction can never be worse than -1, and there is no such thing as a divisor badge here. A branch
 * for one would be a branch nothing can reach.
 */
export function formatDelta(delta: Delta | null): string {
  if (!delta) return EMPTY_FIGURE;
  if (delta.direction === "flat") return "0%";
  const abs = Math.abs(delta.fraction);
  if (delta.direction === "up" && abs >= MULTIPLIER_AT) {
    const times = abs + 1;
    return `×${times >= 1000 ? `${Math.round(times / 1000)}k` : Math.round(times)}`;
  }
  return `${delta.direction === "up" ? "+" : "-"}${Math.round(abs * 100)}%`;
}
