// Export fidelity — the one rule this file exists to enforce: AN EXPORT MUST NOT LAUNDER
// AN UNCERTAIN NUMBER INTO A CLEAN ONE.
//
// A spreadsheet is exactly where a caveat gets lost. Every qualification the dashboard
// renders — cost unknown, cost incomplete, unscored — has to arrive as something a human
// AND a formula can tell apart from a measurement, or a blank starts getting summed as 0
// and quoted as fact.
//
// Also checks the CSV survives its own parser, since real inputs contain commas, quotes
// and newlines.
//
//   npm run test:export

import { resultsToCsv, resultsToJson, summaryToCsv, usageStem, usageToCsv } from "./evalExport.ts";
import { parseCsv } from "./csv.ts";
import type { EvalResults, UsageSnapshot } from "../types.ts";

/** The line ending RFC-4180 specifies and `evalExport` writes. Named so the assertions below
 *  are about the export's content rather than about whatever this file's own endings are. */
const CRLF = String.fromCharCode(13, 10);

let fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ok   ${n}`);
  else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); }
};

const results: EvalResults = {
  evalId: "ev1", datasetId: "ds1", agentId: "a1", status: "completed",
  startedAt: "2026-07-28T02:10:04.000Z", endedAt: "2026-07-28T02:10:20.000Z",
  providers: [
    { provider: "anthropic", model: "claude-haiku-4-5", total: 2, succeeded: 2, failed: 0, successRate: 1,
      comparisonCostUsd: 0.00539, costPerRunUsd: 0.00269, spentUsd: 0.00539, tokens: 3859,
      latencyP50Ms: 4100, latencyP95Ms: 4500, costUnknown: false, costIncomplete: true,
      qualityScore: 0.31, scored: 2, unscored: 0 },
    // An unpriced, unscored leg — every "we don't know" in one row.
    { provider: "mystery", model: "unreleased-x", total: 1, succeeded: 1, failed: 0, successRate: 1,
      comparisonCostUsd: null, costPerRunUsd: null, spentUsd: 0, tokens: 900,
      latencyP50Ms: 700, latencyP95Ms: 700, costUnknown: true, costIncomplete: false,
      qualityScore: null, scored: 0, unscored: 1 },
  ],
  totals: { trueSpendUsd: 0.0114, judgeCostUsd: 0.00597, agentSpendUsd: 0.00539, budgetUsd: 0.05 },
  rows: [
    { exampleId: "e1", input: `Where is order 1042, and "why" is it late?`, expected: "Shipped\nTuesday",
      cells: [
        // A cell we COULD price, and only partly: some step reported tokens and no cost, so
        // 0.00269 is a floor. The dangerous cell, because it looks exactly like a measurement.
        { jobId: "j1", provider: "anthropic", model: "claude-haiku-4-5", status: "succeeded", runId: "r1",
          costUsd: 0.00269, costComplete: false, latencyMs: 4100, attempt: 0, error: null, score: 0.18, scoreError: null,
          perCriterion: { correctness: 1, grounding: 2, tone: 2 }, rationale: 'Partly right, comma, "quoted"' },
        { jobId: "j2", provider: "mystery", model: "unreleased-x", status: "succeeded", runId: "r2",
          costUsd: null, costComplete: true, latencyMs: 700, attempt: 0, error: null, score: null,
          scoreError: "judge failed: rate limit", perCriterion: null, rationale: null },
      ] },
  ],
};

// --- the CSV must survive its own parser ---------------------------------------------
const parsed = parseCsv(resultsToCsv(results)).rows;
check("per-cell CSV round-trips through the parser", parsed.length === 3, `${parsed.length} rows`);
const header = parsed[0]!, r1 = parsed[1]!, r2 = parsed[2]!;
const col = (row: string[], name: string) => row[header.indexOf(name)];

check("embedded comma + quotes survive", col(r1, "input") === `Where is order 1042, and "why" is it late?`);
check("embedded newline survives", col(r1, "expected") === "Shipped\nTuesday");

// --- nothing uncertain becomes a clean number ----------------------------------------
check("known cost is exported as a number", col(r1, "cost_usd") === "0.00269");
check("UNKNOWN cost is empty, never 0", col(r2, "cost_usd") === "", JSON.stringify(col(r2, "cost_usd")));
check("cost_known flag distinguishes it", col(r1, "cost_known") === "yes" && col(r2, "cost_known") === "no");
check("UNSCORED is empty, never 0", col(r2, "score") === "", JSON.stringify(col(r2, "score")));
check("score_known flag distinguishes it", col(r1, "score_known") === "yes" && col(r2, "score_known") === "no");
check("the judge failure reason is carried", col(r2, "score_note") === "judge failed: rate limit");
check("run_id is exported so a row traces back to its trace", col(r1, "run_id") === "r1");

// THE THIRD STATE, and the one that used to be lost. `cost_known: no` means we could not price
// this cell at all. `cost_complete: no` means we priced SOME of it and the number beside it is a
// floor — which, without a column of its own, exported as a clean measurement.
check("a partly-priced cell exports its cost AND says the number is a floor",
  col(r1, "cost_usd") === "0.00269" && col(r1, "cost_known") === "yes" && col(r1, "cost_complete") === "no");
check("and a fully-priced-or-unpriced cell does not claim to be a floor",
  col(r2, "cost_complete") === "yes");

// --- usage ------------------------------------------------------------------------------
//
// The same rule on the newest surface. A spend figure lands in a spreadsheet and gets quoted as
// fact, and the qualification that made it honest on screen is the first thing to fall off.
{
  const usage: UsageSnapshot = {
    periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z",
    plan: { id: "free", label: "Free" },
    spentUsd: 4.2, costKnown: false,
    ceilingUsd: 5, headroomUsd: 0.8, overCeiling: false,
    balanceUsd: 0, reservedUsd: 0, availableUsd: 0,
    // The counted limits, which this export does not carry — a CSV of what was SPENT has no column
    // for how many runs are left. Present because the snapshot is one shape and a fixture that
    // omitted a field would be a fixture testing a shape nothing sends.
    quota: { runs: { used: 3, limit: 500 }, evalRuns: { used: 0, limit: 20 } },
    platformSpentUsd: 1.1, platformCeilingUsd: 2, ownKeyForPlatform: false,
    byAgent: [
      { agentId: "a1", label: "support_bot", usd: 3.1, tokens: 40_000, costKnown: true, runs: 4 },
      // An agent whose total could not be priced. Must not export as $0.
      { agentId: "a2", label: "mystery_bot", usd: 0, tokens: 900, costKnown: false, runs: 1 },
    ],
    byRun: [{ runId: "r1", label: "support_bot", usd: 1.4, tokens: 20_000, costKnown: true }],
    byKind: [{ kind: "llm.provider", payer: "workspace", usd: 3.1, tokens: 40_000, costKnown: true }],
    // The catalogue the panel offers a change from. Deliberately not exported to CSV: a plan is
    // what the workspace could be on, and this file is about what it spent.
    plans: [
      {
        id: "free", label: "Free", purchasable: false, current: true,
        monthlyCreditsUsd: 5, budgetCeilingUsd: 5, platformKeyCeilingUsd: 2,
        retentionDays: 14, seats: 3, deploy: false,
      },
    ],
    paymentsConfigured: false,
  };
  const lines = usageToCsv(usage).split(CRLF);
  const find = (k: string) => lines.find((l) => l.startsWith(`${k},`))?.split(",")[1];
  check("usage: the period total is exported", find("spent_usd") === "4.2");
  check("usage: with the flag that says it is a floor", find("cost_known") === "no");
  check("usage: the ceiling travels with it", find("ceiling_usd") === "5");
  check("usage: and what the PLATFORM paid is a separate figure", find("platform_spent_usd") === "1.1");

  const agentRows = parseCsv(
    lines.slice(lines.indexOf("agent,runs,tokens,cost_usd,cost_known")).join(CRLF),
  ).rows;
  const priced = agentRows.find((r) => r[0] === "support_bot")!;
  const unpriced = agentRows.find((r) => r[0] === "mystery_bot")!;
  check("usage: a priced agent exports its number", priced[3] === "3.1" && priced[4] === "yes");
  check("usage: an UNPRICED agent exports an empty cell, never 0",
    unpriced[3] === "" && unpriced[4] === "no", JSON.stringify(unpriced));
  check("usage: the stem names the period rather than the moment it was downloaded",
    usageStem(usage) === "jaroku-usage-2026-08-01");
}

// --- summary ---------------------------------------------------------------------------
const sum = parseCsv(summaryToCsv(results)).rows;
const sh = sum[0]!, sa = sum[1]!, sm = sum[2]!;
const scol = (row: string[], name: string) => row[sh.indexOf(name)];
check("summary: unknown-cost leg exports blank cost", scol(sm, "comparison_cost_usd") === "");
check("summary: cost_known flag present", scol(sa, "cost_known") === "yes" && scol(sm, "cost_known") === "no");
// The "≥" is a glyph; the flag is the only thing that carries "this is a floor" into a file.
check("summary: cost_complete carries the floor marker", scol(sa, "cost_complete") === "no");
check("summary: unscored leg exports blank quality", scol(sm, "quality_mean") === "");
check("summary: true spend + judge cost are eval-level totals, not provider rows",
  sum.filter((r) => r[0] === "true_spend_usd" || r[0] === "judge_cost_usd").length === 2);

// --- json --------------------------------------------------------------------------------
const back = JSON.parse(resultsToJson(results));
check("JSON is lossless", JSON.stringify(back) === JSON.stringify(results));
check("JSON keeps null cost as null, not 0", back.rows[0].cells[1].costUsd === null);

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
// `process` isn't in the client's DOM lib; this file only ever runs under tsx.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
