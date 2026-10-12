// The run in three figures: how long, how many tokens, how much.
//
// THEY WERE THREE GREY NUMBERS AT THE END OF THE HEADER — `Ran in 15.2s  2,701 tok  $0.00868` — the
// same size as the identifiers beside them, so the one thing most people open a trace to check was
// read by finding it. Now each has a word over it and a column of its own.
//
// THE SAME ACCOUNTING AS BEFORE, NOT A NEW ONE. Duration is the run's own two timestamps (or now,
// while it runs); tokens and cost are summed over the steps by `traceTotals`, which only model calls
// carry, so nothing is counted twice and the figure moves as the run does. What changed is that an
// unmeasured figure says so: a run whose calls were never priced shows "—", not `$0.00`.

import { useEffect, useMemo, useState } from "react";

import { fmtCost, fmtDuration } from "../lib/format.ts";
import { traceTotals } from "../lib/traceView.ts";
import type { RunSummary, Step } from "../types.ts";

/** Re-render on an interval while `active` (drives the live duration). */
function useTick(active: boolean, ms = 200): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function Metric({ label, value, title, tone = "text-ink" }: { label: string; value: string; title: string; tone?: string }) {
  return (
    <div className="min-w-0 px-3 py-2" title={title}>
      <div className="truncate text-tiny text-faint">{label}</div>
      <div className={`truncate text-label tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

export function TraceMetrics({ run, steps }: { run: RunSummary; steps: readonly Step[] }) {
  const live = run.status === "running" || run.status === "paused";
  const now = useTick(run.status === "running");
  const totals = useMemo(() => traceTotals(steps), [steps]);

  const start = Date.parse(run.started_at);
  const end = run.ended_at ? Date.parse(run.ended_at) : now;
  const elapsed = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;

  const calls = plural(totals.llmCalls, "model call");
  const tokensTitle = totals.tokens == null
    ? totals.llmCalls === 0 ? "No model calls yet" : `None of the ${calls} reported tokens`
    : `Across ${calls} · the input/output split isn't recorded`;
  const costTitle = totals.cost == null
    ? totals.llmCalls === 0 ? "No model calls yet" : "Not priced: the pricing table doesn't know this model"
    : totals.unpricedCalls > 0
      ? `${plural(totals.unpricedCalls, "model call")} had no price, so this total leaves them out`
      : `Across ${calls}`;

  return (
    <div className="shrink-0 px-6 pt-3">
      <div className="grid grid-cols-3 divide-x divide-hair rounded-card border border-hair bg-panel">
        <Metric
          label={live ? "Elapsed" : "Duration"}
          value={elapsed == null ? "—" : fmtDuration(elapsed)}
          // THE GRAPH ALONE, and saying so: a deployed job's detail shows a longer figure for the
          // same run, measured end to end, and the two read as a contradiction.
          title="The agent's graph alone, from its first step to its last"
          tone={run.status === "running" ? "text-run" : "text-ink"}
        />
        <Metric label="Tokens" value={totals.tokens == null ? "—" : totals.tokens.toLocaleString()} title={tokensTitle} />
        <Metric
          label={totals.unpricedCalls > 0 && totals.cost != null ? "Cost (partial)" : "Cost"}
          value={fmtCost(totals.cost)}
          title={costTitle}
        />
      </div>
    </div>
  );
}
