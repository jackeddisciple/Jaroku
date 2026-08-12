// Exporting eval results (doc §6.4: "export results (CSV/JSON)").
//
// The one rule that matters here: AN EXPORT MUST NOT LAUNDER AN UNCERTAIN NUMBER INTO A
// CLEAN ONE. Everything the dashboard qualifies on screen — cost unknown, cost incomplete,
// unscored — has to survive the trip into a spreadsheet, because that is exactly where the
// caveat gets lost and a "0" starts being quoted as fact.
//
// So: unknown cost is an empty cell WITH a `cost_known` column beside it, never a 0. An
// unscored run is an empty score WITH the judge's reason. Both are machine-readable and
// neither can be mistaken for a measurement.

import type { EvalResults, UsageSnapshot } from "../types.ts";

/** RFC-4180 field: quote when the value contains a delimiter, quote, or newline. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rows(rows: unknown[][]): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

/**
 * Per-cell CSV: one row per (example × provider). The analyzable shape — a provider
 * summary is a pivot away, but the reverse isn't recoverable.
 */
export function resultsToCsv(results: EvalResults): string {
  const header = [
    "example", "input", "expected",
    "provider", "model", "status", "attempt",
    "score", "score_known", "score_note",
    "cost_usd", "cost_known", "cost_complete",
    "latency_ms", "run_id", "error",
  ];

  const body: unknown[][] = [];
  results.rows.forEach((row, i) => {
    for (const c of row.cells) {
      const scoreKnown = c.score !== null;
      const costKnown = c.costUsd !== null;
      body.push([
        i + 1,
        row.input,
        row.expected ?? "",
        c.provider,
        c.model,
        c.status,
        c.attempt + 1,
        // Empty, not 0 — and the flag beside it says which.
        scoreKnown ? c.score : "",
        scoreKnown ? "yes" : "no",
        scoreKnown ? "" : (c.scoreError ?? "not scored"),
        costKnown ? c.costUsd : "",
        costKnown ? "yes" : "no",
        // A THIRD state, and it is not a refinement of the other two. `cost_known: no` means we
        // could not price this cell at all; `cost_complete: no` means we priced SOME of it and
        // the number beside it is a floor. Without this column that second case exported as a
        // clean measurement — the exact laundering this file exists to prevent, and it was
        // happening on the per-cell export for as long as the per-leg rollup has flagged it.
        c.costComplete ? "yes" : "no",
        c.latencyMs ?? "",
        c.runId ?? "",
        c.error ?? "",
      ]);
    }
  });

  return rows([header, ...body]);
}

/** Provider-summary CSV: the comparison table as it appears on screen, caveats intact. */
export function summaryToCsv(results: EvalResults): string {
  const header = [
    "provider", "model",
    "quality_mean", "scored", "unscored",
    "comparison_cost_usd", "cost_per_run_usd", "cost_known", "cost_complete",
    "spent_usd", "tokens",
    "latency_p50_ms", "latency_p95_ms",
    "succeeded", "failed", "total", "success_rate",
  ];
  const body = results.providers.map((p) => [
    p.provider, p.model,
    p.qualityScore ?? "", p.scored, p.unscored,
    p.costUnknown ? "" : (p.comparisonCostUsd ?? ""),
    p.costUnknown ? "" : (p.costPerRunUsd ?? ""),
    p.costUnknown ? "no" : "yes",
    // A floor is not a total; the flag is the only thing carrying that once the ≥ is gone.
    p.costIncomplete ? "no" : "yes",
    p.spentUsd, p.tokens,
    p.latencyP50Ms ?? "", p.latencyP95Ms ?? "",
    p.succeeded, p.failed, p.total, p.successRate.toFixed(4),
  ]);

  // Totals as a trailing block: true spend and judge cost are properties of the eval, not
  // of any provider, and folding them into a provider row would misattribute them.
  const totals: unknown[][] = [
    [],
    ["eval_id", results.evalId],
    ["status", results.status],
    ["agent_spend_usd", results.totals.agentSpendUsd],
    ["judge_cost_usd", results.totals.judgeCostUsd],
    ["true_spend_usd", results.totals.trueSpendUsd],
    ["budget_usd", results.totals.budgetUsd ?? ""],
  ];

  return rows([header, ...body, ...totals]);
}

/**
 * The usage dashboard, as a spreadsheet, with every caveat intact.
 *
 * Same rule as the eval exports and the same reason it needs restating: a spend figure lands in
 * a spreadsheet and is quoted as fact, and the qualification that made it honest on screen is
 * the first thing to fall off. So `cost_known` rides beside every total here too, at every level
 * — the period, each agent, each run, each kind — and an unpriced row is an EMPTY cell rather
 * than a zero.
 *
 * Sections rather than one wide table. An agent, a run and a kind are different units and a
 * single flat sheet would need a `type` column and a lot of empty ones; a spreadsheet reader
 * splits on the blank line, and a human reads it top to bottom.
 */
export function usageToCsv(usage: UsageSnapshot): string {
  const out: unknown[][] = [
    ["period_start", usage.periodStart],
    ["period_end", usage.periodEnd],
    ["plan", usage.plan.id],
    // Empty, not zero, when nothing could be priced at all. `cost_known` beside it is what
    // distinguishes "we spent nothing" from "we cannot tell you what we spent".
    ["spent_usd", usage.spentUsd],
    ["cost_known", usage.costKnown ? "yes" : "no"],
    ["ceiling_usd", usage.ceilingUsd ?? ""],
    ["headroom_usd", usage.headroomUsd ?? ""],
    ["over_ceiling", usage.overCeiling ? "yes" : "no"],
    ["platform_spent_usd", usage.platformSpentUsd],
    ["platform_ceiling_usd", usage.platformCeilingUsd ?? ""],
    ["credit_available_usd", usage.availableUsd],
    ["credit_reserved_usd", usage.reservedUsd],
    [],
    ["agent", "runs", "tokens", "cost_usd", "cost_known"],
    ...usage.byAgent.map((a) => [
      a.label, a.runs, a.tokens, a.costKnown ? a.usd : "", a.costKnown ? "yes" : "no",
    ]),
    [],
    ["run_id", "agent", "tokens", "cost_usd", "cost_known"],
    ...usage.byRun.map((r) => [
      r.runId, r.label ?? "", r.tokens, r.costKnown ? r.usd : "", r.costKnown ? "yes" : "no",
    ]),
    [],
    ["kind", "payer", "tokens", "cost_usd", "cost_known"],
    ...usage.byKind.map((k) => [
      k.kind, k.payer, k.tokens, k.costKnown ? k.usd : "", k.costKnown ? "yes" : "no",
    ]),
  ];
  return rows(out);
}

/** Short, sortable filename stem for a usage export. */
export function usageStem(usage: UsageSnapshot): string {
  return `jaroku-usage-${usage.periodStart.slice(0, 10)}`;
}

/** Everything, unmodified — the lossless form. */
export function resultsToJson(results: EvalResults): string {
  return JSON.stringify(results, null, 2);
}

/** Trigger a client-side download. No server round trip; the data is already here. */
export function download(filename: string, contents: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Short, sortable filename stem for an eval's exports. */
export function exportStem(results: EvalResults): string {
  const when = (results.startedAt ?? "").slice(0, 19).replace(/[:T]/g, "-");
  return `jaroku-eval-${when || results.evalId.slice(0, 8)}`;
}
