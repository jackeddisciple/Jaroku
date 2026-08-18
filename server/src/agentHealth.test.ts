// The rules behind an agent's card, exercised as rules rather than as pixels.
//
// WHAT THIS IS FOR. §5.3 asks for every card state to be built and looked at, and §10 asks for the
// health derivation, the drift calculation and the missing-credential derivation to be tested. Every
// one of those is a rule that looks obviously right in a screenshot and is wrong in the case nobody
// had that day: an agent that is idle AND failing, a deploy that is AHEAD of the current version, a
// credential whose name differs only in case. This is where those cases live, because they are
// unreachable from a rendered card and trivial here.
//
// NO DATABASE, NO PROCESS. `agentHealth.ts` is pure on purpose, and the whole point of that split is
// that this file runs in a second on the laptop where the rules get written.
//
//   npm run test:agent-health

import {
  ACTIVITY_BUCKETS, FAILING_ERROR_RATE, activityOf, driftOf, healthOf, missingCredentials,
  percentiles, runtimeOf, type RunOutcome,
} from "./agentHealth.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** A window of outcomes, oldest first, written the way a sparkline reads. */
const bars = (s: string): RunOutcome[] =>
  [...s].map((c) => (c === "x" ? "error" : c === "r" ? "running" : c === "p" ? "paused" : "ok"));

console.log("\nhealth reads the validator AND the record, because either alone lies");
{
  check("a published version with a clean record is healthy",
    healthOf({ outcomes: bars("ooooo"), versionSource: "generation" }) === "healthy");

  // §7.5's own argument, as an assertion: the validator alone would call this healthy while every
  // one of its last five runs failed.
  check("a version that validated and whose every run failed is FAILING, not healthy",
    healthOf({ outcomes: bars("xxxxx"), versionSource: "generation" }) === "failing");

  // The other half of the same argument. A hand-dropped project nobody has run is not "fine".
  check("a version nobody validated and nothing has run is unverified, not healthy",
    healthOf({ outcomes: [], versionSource: "import" }) === "unverified");
  check("...and so is an agent with no version row at all",
    healthOf({ outcomes: [], versionSource: null }) === "unverified");

  check("an unverified version with a clean record stays unverified — we have not looked",
    healthOf({ outcomes: bars("ooooo"), versionSource: "import" }) === "unverified");
  // Evidence beats the absence of it.
  check("...but an unverified version that is failing is FAILING, because failures are evidence",
    healthOf({ outcomes: bars("oxxxx"), versionSource: "import" }) === "failing");

  check("one failure among many, with a clean run after it, is degraded rather than failing",
    healthOf({ outcomes: bars("xooooooooo"), versionSource: "edit" }) === "degraded",
    healthOf({ outcomes: bars("xooooooooo"), versionSource: "edit" }));

  // THE CASE ARITHMETIC GETS WRONG. Four failures in twenty is a rate of 0.2 — comfortably
  // "degraded" — and the four are the four most recent. Somebody looking at that screen is looking
  // at an agent that is failing right now.
  check("...unless the LAST one failed, which is what failing means to somebody looking at it",
    healthOf({ outcomes: bars("oooooooooooooooo" + "xxxx"), versionSource: "edit" }) === "failing");

  check(`half is the line: ${FAILING_ERROR_RATE}`,
    healthOf({ outcomes: bars("xxoooo"), versionSource: "edit" }) === "degraded" &&
    healthOf({ outcomes: bars("xxxooo"), versionSource: "edit" }) === "failing",
    "an even split with a clean last run is failing; one below it is degraded");

  // A RUN THAT IS STILL GOING IS NOT AN OUTCOME. It has not succeeded and it has not failed, so it
  // must not dilute an error rate in either direction.
  check("running and paused runs are excluded from the rate rather than counted as successes",
    healthOf({ outcomes: bars("xrp"), versionSource: "edit" }) === "failing",
    "one settled outcome, and it failed");
}

console.log("\nruntime and health are separate axes and never collapse (§5.4)");
{
  // The state §5.4 names explicitly: "Idle · Failing is a valid and important state, and a card that
  // hides it is lying about the agent."
  const idleAndFailing =
    runtimeOf({ liveRuns: 0, pausedRuns: 0, building: false, deploying: false }) === "idle" &&
    healthOf({ outcomes: bars("xxx"), versionSource: "generation" }) === "failing";
  check("an agent can be idle and failing at once", idleAndFailing);

  check("a run in flight is running", runtimeOf({ liveRuns: 1, pausedRuns: 0, building: false, deploying: false }) === "running");
  check("a halted run is paused", runtimeOf({ liveRuns: 0, pausedRuns: 1, building: false, deploying: false }) === "paused");
  check("a streaming edit is generating", runtimeOf({ liveRuns: 0, pausedRuns: 0, building: true, deploying: false }) === "generating");
  // The order is by what a person would do next: a deploy in flight is the thing you wait for.
  check("a deploy in flight outranks everything else",
    runtimeOf({ liveRuns: 3, pausedRuns: 2, building: true, deploying: true }) === "deploying");
  check("nothing at all is idle", runtimeOf({ liveRuns: 0, pausedRuns: 0, building: false, deploying: false }) === "idle");
}

console.log("\nactivity is bucketed, so the footer says something rather than counts something");
{
  check("no runs is quiet", activityOf(0) === "quiet");
  check("just under the line is quiet", activityOf(ACTIVITY_BUCKETS.steady - 1) === "quiet");
  check("on the line is steady", activityOf(ACTIVITY_BUCKETS.steady) === "steady");
  check("under the high line is steady", activityOf(ACTIVITY_BUCKETS.high - 1) === "steady");
  check("on the high line is high", activityOf(ACTIVITY_BUCKETS.high) === "high");
}

console.log("\ndrift is the deployed version behind the current one, and nothing else");
{
  check("v5 live against v9 current is drift", JSON.stringify(driftOf(5, 9)) === JSON.stringify({ deployed: 5, current: 9 }));
  check("the same version is not drift", driftOf(9, 9) === null);
  // 041 is explicit that the column is never backfilled, because a guess there is a confident lie
  // about somebody's production.
  check("a deploy that recorded no version draws no badge", driftOf(null, 9) === null);
  // REACHABLE, AND NOT WHAT THE BADGE MEANS. An undo moves `current_version` backwards while the
  // container carries on serving what it was given.
  check("a deploy AHEAD of the current version draws no badge rather than a backwards one",
    driftOf(9, 5) === null);
}

console.log("\na missing credential is a NAME, matched exactly");
{
  check("a name with no configured row is missing",
    JSON.stringify(missingCredentials(["OPENAI_API_KEY"], new Set())) === JSON.stringify(["OPENAI_API_KEY"]));
  check("...and one with a configured row is not",
    missingCredentials(["OPENAI_API_KEY"], new Set(["OPENAI_API_KEY"])).length === 0);

  // THE FAILURE THIS EXISTS FOR. `secret_refs` holds a row for every name an agent has ever
  // DECLARED; only `configured` says a value landed. A membership test against the table would
  // report every declared credential as present and §5.2's warning line would never appear — which
  // is the line the specification calls the single most important one on the card.
  check("a DECLARED but unconfigured name is still missing — the caller passes configured names only",
    missingCredentials(["SLACK_TOKEN"], new Set(["OTHER"])).length === 1);

  // An environment variable name is case-sensitive to every process that will read one.
  check("matching is case-sensitive, because an environment variable name is",
    missingCredentials(["AIRTABLE_KEY"], new Set(["airtable_key"])).length === 1);

  check("duplicates in required_env are counted once",
    missingCredentials(["A", "A", "B"], new Set()).length === 2);
  check("the list is sorted, so two cards never disagree about the order",
    JSON.stringify(missingCredentials(["Z_KEY", "A_KEY"], new Set())) === JSON.stringify(["A_KEY", "Z_KEY"]));
  check("nothing required is nothing missing", missingCredentials([], new Set()).length === 0);

  // NAMES ONLY — there is no parameter here a value could travel in, and that is the design rather
  // than a discipline somebody has to remember. Asserted so a future signature change is loud.
  check("the function takes names and a set of names, and can therefore carry no value",
    missingCredentials.length === 2);
}

console.log("\npercentiles are nearest-rank, and unknown is not zero");
{
  const { p50, p95 } = percentiles([100, 200, 300, 400, 500]);
  check("p50 is a duration a run actually took", p50 === 300, String(p50));
  check("p95 likewise", p95 === 500, String(p95));
  check("no settled runs means no answer, never 0 ms",
    percentiles([]).p50 === null && percentiles([]).p95 === null);
  check("one run answers with itself", percentiles([42]).p50 === 42 && percentiles([42]).p95 === 42);
  check("a negative duration is discarded rather than believed", percentiles([-5]).p50 === null);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
