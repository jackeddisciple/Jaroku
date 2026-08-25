// Comparison dashboard (doc §6.4): quality / cost / latency per provider.
//
// This is the screen the doc's cost warning is aimed at — "wrong cost numbers destroy trust
// instantly" — so the rendering rules are as load-bearing as the arithmetic behind them:
//
//   * An unpriced model shows "unknown", never "$0.00". Those are different claims, and a
//     $0.00 in a comparison reads as "this provider is free".
//   * A partially-priced run shows its cost with a "≥" — the figure is a floor, not a total.
//   * Quality averages only what was actually scored, and says how many weren't. A judge
//     that failed says nothing about the provider and must not be averaged in as a zero.
//   * The comparison cost and the true spend are shown as separate things, because they
//     answer different questions: "which is cheaper per run" and "what did this cost me".

import { fmtCost, fmtLatency, fmtPercent } from "../lib/format.ts";
import {
  download,
  exportStem,
  resultsToCsv,
  resultsToJson,
  summaryToCsv,
} from "../lib/evalExport.ts";
import { ICON } from "../lib/tokens.ts";
import { TYPE } from "../lib/tokens.ts";
import { CheckIcon } from "./panelIcons.tsx";
import type { EvalResults, ProviderMetrics } from "../types.ts";

/**
 * "This one leads the column." A green check rather than the `●` it replaces: a coloured bullet
 * character is the same shape as every other bullet on the screen, and this one is the only mark
 * in the table that means something. Same check the rest of the app uses for "this is the good
 * one", at the same weight.
 */
function LeadMark({ title }: { title: string }) {
  return (
    <span className="ml-1 inline-flex align-middle text-ok" title={title}>
      <CheckIcon size={ICON.xs} />
    </span>
  );
}

/** Cost cell. The three states — known, unknown, floor — must stay visually distinct. */
function CostCell({ p }: { p: ProviderMetrics }) {
  if (p.costUnknown) {
    return (
      <span className="text-faint" title={`No pricing entry for ${p.model} — cost is unknown, not zero`}>
        unknown
      </span>
    );
  }
  return (
    <span className="text-ink tabular-nums" title={p.costIncomplete ? "Some steps could not be priced — this is a floor" : undefined}>
      {p.costIncomplete && <span className="text-run">≥</span>}
      {fmtCost(p.comparisonCostUsd ?? 0)}
    </span>
  );
}

function QualityCell({ p }: { p: ProviderMetrics }) {
  if (p.qualityScore === null) {
    return (
      <span className="text-faint" title={p.unscored ? `${p.unscored} run(s) unscored` : "not scored"}>
        —
      </span>
    );
  }
  // Colour only at the extremes; the doc's palette reserves status colours for meaning.
  const tone = p.qualityScore >= 0.8 ? "text-ok" : p.qualityScore < 0.4 ? "text-err" : "text-ink";
  return (
    <span className={`${tone} tabular-nums`}>
      {(p.qualityScore * 100).toFixed(0)}
      <span className="text-faint text-tiny ml-0.5">
        /100{p.unscored > 0 && ` · ${p.unscored} unscored`}
      </span>
    </span>
  );
}

/** The best (lowest cost / highest quality / fastest) leg, for a subtle lead marker. */
function leaders(providers: ProviderMetrics[]) {
  const priced = providers.filter((p) => !p.costUnknown && p.comparisonCostUsd !== null && p.succeeded > 0);
  const scored = providers.filter((p) => p.qualityScore !== null);
  const timed = providers.filter((p) => p.latencyP50Ms !== null);
  return {
    // Cheapest is per-run, not total: totals differ if some legs had more failures.
    cheapest: priced.length
      ? priced.reduce((a, b) => ((a.costPerRunUsd ?? Infinity) <= (b.costPerRunUsd ?? Infinity) ? a : b)).model
      : null,
    best: scored.length
      ? scored.reduce((a, b) => ((a.qualityScore ?? 0) >= (b.qualityScore ?? 0) ? a : b)).model
      : null,
    fastest: timed.length
      ? timed.reduce((a, b) => ((a.latencyP50Ms ?? Infinity) <= (b.latencyP50Ms ?? Infinity) ? a : b)).model
      : null,
  };
}

export function ComparisonTable({
  results,
  onSelectProvider,
}: {
  results: EvalResults;
  onSelectProvider?: (p: ProviderMetrics) => void;
}) {
  const lead = leaders(results.providers);
  const { totals } = results;
  const overBudget = totals.budgetUsd !== null && totals.trueSpendUsd >= totals.budgetUsd;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-caption border-separate border-spacing-0">
          <thead>
            <tr className={TYPE.sectionLabel}>
              <th className="text-left font-normal pb-1.5 pr-3">Provider</th>
              <th className="text-right font-normal pb-1.5 px-2">Quality</th>
              <th className="text-right font-normal pb-1.5 px-2">Cost</th>
              <th className="text-right font-normal pb-1.5 px-2">Per run</th>
              <th className="text-right font-normal pb-1.5 px-2">p50</th>
              <th className="text-right font-normal pb-1.5 px-2">p95</th>
              <th className="text-right font-normal pb-1.5 pl-2">Passed</th>
            </tr>
          </thead>
          <tbody>
            {results.providers.map((p) => (
              <tr
                key={`${p.provider} ${p.model}`}
                onClick={() => onSelectProvider?.(p)}
                className={`${onSelectProvider ? "cursor-pointer hover:bg-active/40" : ""} transition-colors`}
              >
                {/* A model id is an identifier, so it breaks as a unit or not at all. While the
                    judge is still scoring, the quality column carries an extra "· N unscored" and
                    squeezes this one — which was enough to wrap "claude-haiku-4-5" after the
                    hyphen, leaving a row headed "claude-haiku-4-" over a lone "5". The name of the
                    thing being compared is the last text in a comparison table that should be
                    guessable. */}
                <td className="py-1.5 pr-3">
                  <span className="whitespace-nowrap text-ink">{p.model}</span>
                  <span className="text-faint ml-1.5 text-tiny">{p.provider}</span>
                </td>
                <td className="py-1.5 px-2 text-right">
                  <QualityCell p={p} />
                  {lead.best === p.model && p.qualityScore !== null && (
                    <LeadMark title="highest quality" />
                  )}
                </td>
                <td className="py-1.5 px-2 text-right"><CostCell p={p} /></td>
                <td className="py-1.5 px-2 text-right">
                  <span className="text-muted tabular-nums">
                    {p.costUnknown ? "—" : fmtCost(p.costPerRunUsd ?? 0)}
                  </span>
                  {lead.cheapest === p.model && !p.costUnknown && (
                    <LeadMark title="cheapest per run" />
                  )}
                </td>
                <td className="py-1.5 px-2 text-right text-muted tabular-nums">
                  {fmtLatency(p.latencyP50Ms)}
                  {lead.fastest === p.model && p.latencyP50Ms !== null && (
                    <LeadMark title="fastest" />
                  )}
                </td>
                <td className="py-1.5 px-2 text-right text-muted tabular-nums">{fmtLatency(p.latencyP95Ms)}</td>
                <td className="py-1.5 pl-2 text-right tabular-nums">
                  <span className={p.failed > 0 ? "text-err" : "text-muted"}>
                    {p.succeeded}/{p.total}
                  </span>
                  {p.failed > 0 && (
                    <span className="text-faint text-tiny ml-1">{fmtPercent(p.successRate, "share")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Spend, kept deliberately apart from the comparison figures above. The table answers
          "which provider is cheaper per run"; this answers "what did this eval cost me" —
          and includes the failed attempts and the judge, which the comparison excludes. */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-tiny pt-1">
        <span className={TYPE.sectionLabel}>Spent</span>
        <span className={overBudget ? "text-err" : "text-ink"}>
          {fmtCost(totals.trueSpendUsd)} total
        </span>
        <span className="text-muted">{fmtCost(totals.agentSpendUsd)} agent runs</span>
        <span className="text-muted">{fmtCost(totals.judgeCostUsd)} judge</span>
        {totals.budgetUsd !== null && (
          <span className={overBudget ? "text-err" : "text-faint"}>
            of {fmtCost(totals.budgetUsd)} budget{overBudget ? " — ceiling reached" : ""}
          </span>
        )}
        {results.providers.some((p) => p.costIncomplete) && (
          <span className="text-run">≥ some steps could not be priced</span>
        )}

        {/* Export. Every caveat above survives the trip — unknown cost is an empty cell
            with a cost_known flag beside it, never a 0 a spreadsheet would happily sum. */}
        <span className="ml-auto flex items-center gap-2">
          <span className={TYPE.sectionLabel}>Export</span>
          <button
            onClick={() => download(`${exportStem(results)}-summary.csv`, summaryToCsv(results), "text/csv")}
            className="text-faint hover:text-ink transition-colors"
          >
            summary.csv
          </button>
          <button
            onClick={() => download(`${exportStem(results)}-examples.csv`, resultsToCsv(results), "text/csv")}
            className="text-faint hover:text-ink transition-colors"
          >
            examples.csv
          </button>
          <button
            onClick={() => download(`${exportStem(results)}.json`, resultsToJson(results), "application/json")}
            className="text-faint hover:text-ink transition-colors"
          >
            json
          </button>
        </span>
      </div>
    </div>
  );
}
