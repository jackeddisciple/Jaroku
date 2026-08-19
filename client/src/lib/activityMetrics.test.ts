// The metric registry, as claims.
//
// §3.3 IS THE SUITE'S REASON FOR EXISTING. There is no global "up is bad" rule, so the only thing
// standing between this page and a lie is that each metric declares its own polarity and every badge
// reads it. The four the specification names are asserted by name here — spend up is bad, tokens up
// is neutral, success down is bad, latency down is good — because a fifth metric added with the
// wrong `goodWhen` looks completely correct until the week it moves.
//
// AND §3.5, WHICH IS THE OTHER HALF. A figure that is unknown renders `--`, never `0`, never
// `$0.00`, never an empty chart implying a flat line at zero. That rule is one v0.1.9 paid for when
// an unpriced model rendered as a false `$0`; here every figure is screenshotted and quoted, so it
// is asserted for every unit rather than for the one somebody remembered.
//
// The delta's three "no comparison" cases are all real and all render `--`: a window the workspace
// is younger than, a figure that is unknown, and a previous window of zero — because a percentage
// against zero is not a large number, it is an undefined one.
//
//   npm run test:activity-metrics

import {
  EMPTY_FIGURE,
  METRICS,
  RANGE_LABEL,
  deltaOf,
  formatDelta,
  formatMetric,
  metric,
  type MetricId,
} from "./activityMetrics.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\npolarity is declared per metric, and the four the specification names are right");
{
  check("spend: up is bad", METRICS.spend.goodWhen === "down");
  check("tokens: neither direction is a verdict", METRICS.tokens.goodWhen === "neutral");
  check("success rate: down is bad", METRICS.successRate.goodWhen === "up");
  check("p95: down is good", METRICS.p95.goodWhen === "down");
  check("cached tokens: up is the pricing layer working", METRICS.cached.goodWhen === "up");
}

console.log("\nevery metric is complete, because a half-declared one renders as a component guess");
{
  const ids = Object.keys(METRICS) as MetricId[];
  check(`the registry has ${ids.length} metrics`, ids.length > 0);
  for (const id of ids) {
    const m = metric(id);
    const ok =
      typeof m.label === "string" && m.label.length > 0 &&
      typeof m.unit === "string" &&
      ["up", "down", "neutral"].includes(m.goodWhen) &&
      typeof m.empty === "string" && m.empty.length > 0 &&
      typeof m.context === "function" && m.context("the last 7 days").length > 0;
    check(`${id} declares unit, polarity, context and empty`, ok);
  }
  // §1: "each card states its window in its context line so a screenshot is never ambiguous". The
  // context is a function of the range for exactly that reason, so it has to actually use it.
  for (const id of ids) {
    check(
      `${id}'s context line names its window`,
      metric(id).context("the last 30 days").includes("the last 30 days"),
    );
  }
  check("every range has a prose label", ["24h", "7d", "30d", "custom"].every((r) => !!RANGE_LABEL[r]));
}

console.log("\nunknown is not zero, for every unit");
{
  for (const unit of ["usd", "tokens", "count", "percent", "ms"] as const) {
    check(`${unit}: null renders ${EMPTY_FIGURE}`, formatMetric(unit, null) === EMPTY_FIGURE);
    check(`${unit}: undefined renders ${EMPTY_FIGURE}`, formatMetric(unit, undefined) === EMPTY_FIGURE);
    check(`${unit}: NaN renders ${EMPTY_FIGURE}`, formatMetric(unit, Number.NaN) === EMPTY_FIGURE);
  }
  // A REAL zero is a different claim and must still render as a number. "Nobody spent anything" and
  // "we do not know what was spent" are the two sentences this page must never confuse.
  check("a real zero is still a number", formatMetric("usd", 0) === "$0.00");
  check("...and so is a zero count", formatMetric("count", 0) === "0");
}

console.log("\nfigures stay legible at both ends of their range");
{
  check("money under a cent keeps four decimals", formatMetric("usd", 0.0031) === "$0.0031");
  check("ordinary money is two decimals with separators", formatMetric("usd", 12481.5) === "$12,481.50");
  check("very large money is thousands", formatMetric("usd", 250_000) === "$250k");

  check("small token counts are exact", formatMetric("tokens", 842) === "842");
  // Lowercase `k`, matching the money formatter two lines above it and `format.shortCount`, which
  // both figures now go through. It was `K` here and `k` there, in one file.
  check("thousands are shortened", formatMetric("tokens", 35_300) === "35.3k");
  check("millions are shortened", formatMetric("tokens", 4_182_993) === "4.2M");

  check("a rate is whole percents", formatMetric("percent", 0.9412) === "94%");
  check("sub-second latency is milliseconds", formatMetric("ms", 820) === "820ms");
  check("seconds past a thousand", formatMetric("ms", 2_400) === "2.4s");
  check("minutes past sixty seconds", formatMetric("ms", 185_000) === "3.1m");
}

console.log("\na delta renders from polarity, never from direction");
{
  const up = deltaOf(118, 100, "down");
  check("spend up is bad", up?.direction === "up" && up?.tone === "bad");
  const down = deltaOf(82, 100, "down");
  check("spend down is good", down?.direction === "down" && down?.tone === "good");

  const busier = deltaOf(194, 100, "neutral");
  check("tokens up is neither", busier?.direction === "up" && busier?.tone === "neutral");

  const slower = deltaOf(2400, 1200, "down");
  check("latency up is bad", slower?.tone === "bad");
  const faster = deltaOf(600, 1200, "down");
  check("latency down is good", faster?.tone === "good");

  const dropped = deltaOf(0.91, 0.94, "up");
  check("success rate down is bad", dropped?.direction === "down" && dropped?.tone === "bad");
}

console.log("\nno change is no news, whatever the polarity");
{
  const flat = deltaOf(100, 100, "down");
  check("an unmoved figure is flat", flat?.direction === "flat");
  // The trap: `goodWhen: "down"` plus "did not go up" is not good news.
  check("...and neutral rather than good", flat?.tone === "neutral");
  check("it writes itself as 0%", formatDelta(flat) === "0%");
  check(
    "a change under half a percent is rounding, not a direction",
    deltaOf(100.3, 100, "down")?.direction === "flat",
  );
}

console.log("\nthe three ways there is no comparison, and all three render the dash");
{
  check(
    "a workspace younger than the previous window",
    deltaOf(500, 100, "neutral", false) === null,
  );
  check("an unknown current figure", deltaOf(null, 100, "neutral") === null);
  check("an unknown previous figure", deltaOf(500, null, "neutral") === null);
  // The one that is easiest to get wrong: going from nothing to something is not "+100%".
  check("a previous window of zero", deltaOf(500, 0, "neutral") === null);
  check("none of them renders 0%", formatDelta(null) === EMPTY_FIGURE);
}

console.log("\na delta writes itself signed, and cannot reflow the card it sits on");
{
  check("up is signed", formatDelta(deltaOf(118, 100, "down")) === "+18%");
  check("down is signed", formatDelta(deltaOf(82, 100, "down")) === "-18%");
  // Past ten times a percentage stops being readable, so the badge says what somebody would say.
  check("a twelve-fold rise is a multiplier", formatDelta(deltaOf(1_200, 100, "neutral")) === "×12");
  check(
    "a first week against an almost-empty one stays four characters wide",
    formatDelta(deltaOf(41_800, 1, "neutral")) === "×42k",
  );
  // And the direction that cannot overflow: every figure here is a count, a sum or a rate, so a
  // fall can never be worse than -100%.
  check("a total collapse is -100%", formatDelta(deltaOf(0, 940, "down")) === "-100%");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
// The same exit the other client suites use: this runs under tsx with no node types in scope.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
