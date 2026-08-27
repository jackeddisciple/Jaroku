// THE SHARED FORMATTERS, WHICH HAD NO SUITE AND ARE READ MORE OFTEN THAN ANYTHING ELSE IN THE UI.
//
// `fmtDuration` had no unit above the minute. That is a ceiling nothing states, and every caller
// inherits it silently — there is no error, no warning, and no wrong-looking output until somebody
// hands it a span longer than an hour. The Deploy panel did: it passed the age of a service that had
// been live since the 15th and printed `live in 15989m 30s` as the headline fact about it. Five
// digits of minutes is not a duration a person reads, it is a division a person has to do.
//
// `GitHubSync`'s progress rail calls the same function, which is why the rung belongs to the helper
// rather than to the one caller that noticed. A push that stalls for ninety minutes has the same
// ceiling for the same reason.
//
// AND THE SAME FILE HOLDS THE MONEY RULE, because the second defect on this surface was two
// formatters over one currency that disagreed at exactly one input: `fmtCost(0)` returned `"$0"`
// while Activity's SPEND card rendered `"$0.00"`, both on screen in the same session, on the two
// places this product reports spend. Neither was wrong; they simply did not agree.
//
// THE ASSERTIONS AT EACH BOUNDARY ARE THE POINT. A rung is added by writing one comparison, and the
// two ways to write it wrong — `<=` where `<` belongs, the remainder taken off the wrong unit —
// both produce output that is correct on the examples somebody tries by hand and wrong for exactly
// one second either side of each threshold.
//
//   npm run test:format

import { ZERO_COST, fmtCost, fmtDuration } from "./format.ts";
import { formatMetric } from "./activityMetrics.ts";
import { fmtCostPerRun } from "./agentFormat.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const is = (ms: number, want: string): void => {
  const got = fmtDuration(ms);
  check(`${ms}ms → ${want}`, got === want, got);
};

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;

console.log("\nthe rungs that already existed, unchanged");
{
  is(0, "0ms");
  is(820, "820ms");
  is(999, "999ms");
  is(2400, "2.4s");
  is(59_900, "59.9s");
  is(90 * SEC, "1m 30s");
  // The zero-pad the trace column is aligned on.
  is(65 * SEC, "1m 05s");
  is(59 * MIN + 59 * SEC, "59m 59s");
}

console.log("\nthe hour rung, which did not exist");
{
  is(HOUR, "1h 00m");
  is(HOUR + 12 * MIN, "1h 12m");
  is(3 * HOUR + 12 * MIN + 45 * SEC, "3h 12m");
  is(23 * HOUR + 59 * MIN, "23h 59m");
  // The one the Deploy panel produced. Eleven days used to render as a five-digit minute count.
  check("eleven days is not a minute count", !fmtDuration(11 * DAY).includes("15840m"), fmtDuration(11 * DAY));
}

console.log("\nthe day rung, which is where the audit's number lives");
{
  is(DAY, "1d 00h");
  is(DAY + 4 * HOUR, "1d 04h");
  is(11 * DAY + 4 * HOUR, "11d 04h");
  // 15,989 minutes 30 seconds — the exact figure the panel printed for a service live since the
  // 15th, read back in units somebody can act on.
  is(15_989 * MIN + 30 * SEC, "11d 02h");
  is(365 * DAY, "365d 00h");
}

console.log("\nthe boundaries, both sides");
{
  is(SEC - 1, "999ms");
  is(SEC, "1.0s");
  is(MIN - 1, "60.0s");   // rounds up in the seconds rung rather than crossing early
  is(MIN, "1m 00s");
  is(HOUR - SEC, "59m 59s");
  is(HOUR, "1h 00m");
  is(DAY - MIN, "23h 59m");
  is(DAY, "1d 00h");
}

console.log("\ntwo units, never three");
{
  // Each rung shows its own unit and the next one down. A deploy panel asking for a duration is not
  // asking for `11d 04h 07m 12s`.
  for (const ms of [90 * SEC, 3 * HOUR + 12 * MIN, 11 * DAY + 4 * HOUR]) {
    const parts = fmtDuration(ms).split(" ");
    check(`${fmtDuration(ms)} is two parts`, parts.length === 2, String(parts.length));
  }
  check("a sub-minute duration is one part", fmtDuration(2400).split(" ").length === 1);
}

console.log("\nno duration renders as a negative or a NaN");
{
  // Callers clamp with Math.max(0, …) before calling, and this is the other half of that contract:
  // a clock skew that produced a negative must not print one.
  check("zero is zero", fmtDuration(0) === "0ms");
  check("a rounded sub-millisecond is still ms", fmtDuration(0.4) === "0ms", fmtDuration(0.4));
  const rendered = [0, SEC, MIN, HOUR, DAY].map(fmtDuration);
  check("nothing renders NaN", rendered.every((r) => !r.includes("NaN")), rendered.join(" | "));
}

console.log("\nmoney — one currency, two formatters, and they used to disagree at zero");
{
  // `fmtCost(0)` returned `"$0"` and Activity's SPEND card rendered `"$0.00"`, both on screen in
  // the same session, on the two surfaces this product uses to report spend.
  check("the two formatters agree at zero", fmtCost(0) === formatMetric("usd", 0),
    `${fmtCost(0)} vs ${formatMetric("usd", 0)}`);
  check("...on the spelling money has", fmtCost(0) === "$0.00", fmtCost(0));
  check("...which is the shared constant", ZERO_COST === "$0.00");
  // And the third one, on the Agents surface. Three spellings of nothing spent is the same defect
  // as two, so the sweep below is over every money formatter this client has.
  check("the Agents cost-per-run agrees too", fmtCostPerRun(0) === ZERO_COST, fmtCostPerRun(0));
  check("...and its unknown is still a dash", fmtCostPerRun(null) === "—");
  check("...and its own precision is untouched", fmtCostPerRun(0.0002) === "$0.0002", fmtCostPerRun(0.0002));
}

console.log("\nand the distinction the cost accounting actually cares about is untouched");
{
  // NOTHING MEASURED IS NOT NOTHING SPENT. This is the rule v0.1.9 paid for, and it is the one the
  // zero spelling must not blur: an unpriced model rendering as a confident `$0.00` is the false
  // zero, and the dash is what stops it.
  check("unknown is a dash", fmtCost(null) === "—");
  check("...and undefined too", fmtCost(undefined) === "—");
  check("a real zero is not a dash", fmtCost(0) !== "—");
}

console.log("\nnon-zero costs keep the precision each surface needs");
{
  // Unifying the zero must not unify the precision: the Usage panel reports what one run cost, and
  // a run that cost three ten-thousandths of a dollar is not `$0.00`.
  check("under a cent keeps five decimals", fmtCost(0.0031) === "$0.00310", fmtCost(0.0031));
  check("a cent and over keeps four", fmtCost(1.5) === "$1.5000", fmtCost(1.5));
  check("...and neither is the zero string", fmtCost(0.0031) !== ZERO_COST && fmtCost(1.5) !== ZERO_COST);
  // Activity keeps its own shape above zero — a workspace total is not a per-run figure.
  check("Activity still shortens six figures", formatMetric("usd", 123_456) === "$123k",
    formatMetric("usd", 123_456));
  check("...and still keeps four decimals under a cent", formatMetric("usd", 0.0031) === "$0.0031");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
