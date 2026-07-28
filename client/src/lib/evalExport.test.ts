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

import { resultsToCsv, resultsToJson, summaryToCsv } from "./evalExport.ts";
import { parseCsv } from "./csv.ts";
import type { EvalResults } from "../types.ts";

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
        { jobId: "j1", provider: "anthropic", model: "claude-haiku-4-5", status: "succeeded", runId: "r1",
          costUsd: 0.00269, latencyMs: 4100, attempt: 0, error: null, score: 0.18, scoreError: null,
          perCriterion: { correctness: 1, grounding: 2, tone: 2 }, rationale: 'Partly right, comma, "quoted"' },
        { jobId: "j2", provider: "mystery", model: "unreleased-x", status: "succeeded", runId: "r2",
          costUsd: null, latencyMs: 700, attempt: 0, error: null, score: null,
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
