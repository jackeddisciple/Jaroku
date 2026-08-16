// A quality check's arithmetic, with no eval engine and no GitHub anywhere.
//
// EVERY ASSERTION BELOW IS ABOUT AN ABSENCE, and that is not an accident of what is easy to test —
// it is where the whole feature can quietly lie. A delta against a baseline that does not exist is
// the mistake §B.1.1 names: the check "still runs and posts absolute numbers with a plain note,
// rather than fabricating a delta against nothing". A `+0%` beside a first-ever check is a claim
// that nothing changed, made about a comparison that never happened — and it is indistinguishable,
// on the pull request, from a real one.
//
// THREE METRICS, THREE INDEPENDENT ANSWERS. A dry run is unpriced, so its cost is null beside a
// pass rate that is perfectly real; an eval where nothing was scored has no pass rate beside a cost
// that is. Anything that treated "has a baseline" as one boolean per check would get both wrong.
//
// AND THE CONCLUSION, which is the one place this file is allowed to gate anything: the check fails
// when the pass rate went DOWN and never over cost or latency. An agent that got 4% better for 10%
// more money is a trade a person makes, not one a check makes for them.
//
//   npm run test:eval-check

import { compareToBaseline, conclusionFor, summaryFor, titleFor, type CheckMetrics } from "./evalCheck.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const m = (passRate: number | null, cost: number | null, latency: number | null): CheckMetrics => ({
  passRate,
  costPerRunUsd: cost,
  latencyP50Ms: latency,
});

console.log("\nno baseline: absolute numbers and a note, never a delta");
{
  const now = m(0.96, 0.0028, 795);
  const c = compareToBaseline(now, null);
  check(!c.hasBaseline, "the comparison says so explicitly");
  check(c.deltas.passRate === null && c.deltas.cost === null && c.deltas.latency === null,
    "and all three deltas are null rather than zero", JSON.stringify(c.deltas));

  const text = summaryFor(c, null);
  check(text.includes("96%"), "the absolute pass rate is still reported");
  check(text.includes("$0.0028") && text.includes("795ms"), "and so are the other two");
  // §B.1.1's exact sentence. Without it a first check looks broken rather than first.
  check(text.includes("no baseline yet; this run establishes one"), "with the note that says why there is no arrow", text);
  check(!text.includes("→") && !text.includes("(+") && !text.includes("(−"),
    "and nothing that looks like a comparison", text);

  // Neutral, never success: GitHub draws a neutral check grey, which is right for "this ran and
  // there was nothing to compare it to". §3.9's rule one feature over — rendering an absent verdict
  // as a passing one is how a gate becomes decoration.
  check(conclusionFor(c) === "neutral", "and the conclusion is neutral rather than a green tick");
}

console.log("\nwith a baseline: §B.1.1's own mock");
{
  const before = m(0.92, 0.0031, 820);
  const c = compareToBaseline(m(0.96, 0.0028, 795), before);
  const text = summaryFor(c, before);

  check(text.includes("pass-rate    92% → 96% (+4)"), "pass-rate in POINTS, because a percentage of a percentage is ambiguous", text);
  check(text.includes("$0.0031 → $0.0028"), "cost as an arrow between two amounts");
  check(/cost \/ run.*\(−10%\)/.test(text), "and its delta as a proportion, since cost has no natural point", text);
  check(/p50 latency.*\(−3%\)/.test(text), "same for latency", text);
  check(!text.includes("no baseline"), "and no note, because there is a baseline");
  check(conclusionFor(c) === "success", "a pass rate that went up passes");
}

console.log("\nzero is a real delta and prints its sign");
{
  const before = m(0.92, 0.0031, 820);
  const c = compareToBaseline(m(0.92, 0.0031, 820), before);
  const text = summaryFor(c, before);
  // The distinction the whole file turns on: a run that scored identically genuinely did not move,
  // and rendering that as nothing would make it indistinguishable from having no baseline at all.
  check(text.includes("(+0)"), "an unchanged pass rate reports +0 rather than nothing", text);
  check(text.includes("(+0%)"), "and so does an unchanged cost", text);
  check(conclusionFor(c) === "success", "unchanged is not a regression");
}

console.log("\na regression, and the two things that are not one");
{
  const before = m(0.96, 0.0028, 795);
  check(conclusionFor(compareToBaseline(m(0.92, 0.0028, 795), before)) === "failure",
    "the pass rate going down fails the check");

  // Deliberately not a failure. A threshold here would be a number nobody could justify and
  // everybody would learn to override, which is how a gate stops being one.
  check(conclusionFor(compareToBaseline(m(0.96, 0.02, 795), before)) === "success",
    "a cost increase is reported and does not fail");
  check(conclusionFor(compareToBaseline(m(0.96, 0.0028, 4000), before)) === "success",
    "and neither does a latency increase");
}

console.log("\none metric absent while the others are not");
{
  const before = m(0.92, 0.0031, 820);
  // A dry run is unpriced. Its pass rate is perfectly real and its cost is not zero.
  const dry = compareToBaseline(m(0.96, null, 795), before);
  check(dry.deltas.passRate !== null, "the pass-rate delta survives an absent cost");
  check(dry.deltas.cost === null, "…and the cost delta does not exist rather than being 0");
  const text = summaryFor(dry, before);
  check(text.includes("pass-rate") && !text.includes("cost / run"),
    "a null metric simply does not appear — a line reading `—` is a line to explain", text);
  check(text.includes("p50 latency"), "and the third one is unaffected");

  // The mirror: an eval where the judge scored nothing has no pass rate. "Unscored", not "zero".
  const unscored = compareToBaseline(m(null, 0.0028, 795), before);
  check(conclusionFor(unscored) === "neutral",
    "no pass rate means neutral — reporting success would report a measurement nobody took");
  check(summaryFor(unscored, before).includes("cost / run"), "while the numbers that do exist are still shown");
}

console.log("\nnothing measurable at all");
{
  const c = compareToBaseline(m(null, null, null), null);
  const text = summaryFor(c, null);
  check(text.includes("no scored results"), "says so, rather than leaving an empty block under a neutral check", text);
  check(!text.includes("no baseline yet"), "and does not also claim to be establishing a baseline it did not measure");
  check(conclusionFor(c) === "neutral", "neutral, obviously");
}

console.log("\na baseline of zero cannot be a denominator");
{
  const before = m(0.92, 0, 0);
  const text = summaryFor(compareToBaseline(m(0.96, 0.0028, 795), before), before);
  check(text.includes("$0.0000 → $0.0028"), "the arrow still renders, because zero is a real baseline", text);
  // A percentage change from zero is undefined, and rendering it as infinity or as 100% would both
  // be inventions.
  check(!/cost \/ run.*\(/.test(text), "and the proportion is omitted rather than invented", text);
}

console.log("\nthe dry-run note, and the title");
{
  const c = compareToBaseline(m(0.96, null, 795), m(0.92, null, 820));
  const text = summaryFor(c, m(0.92, null, 820), { providerMode: "dry_run" });
  // §B.1.3's boundary, said on the check rather than only in the settings: a pass rate from the
  // fake provider proves every tool imports and executes, and nothing about what a model answers.
  check(text.includes("free dry-run provider"), "a dry run says so on the check itself", text);
  check(!summaryFor(c, m(0.92, null, 820), { providerMode: "paid" }).includes("dry-run provider"),
    "and a paid run does not carry the note");

  check(titleFor("weather-agent-suite") === "Jaroku eval · weather-agent-suite", "the title names the dataset");
  check(titleFor(null) === "Jaroku eval", "and degrades rather than printing a null");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
