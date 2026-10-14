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

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { fmtCost, fmtDuration } from "../lib/format.ts";
import { isInherited, ownSteps, runElapsed, traceTotals } from "../lib/traceView.ts";
import { useRunClock } from "../lib/useRunClock.ts";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";
import { ICON } from "../lib/tokens.ts";
import type { RunSummary, Step } from "../types.ts";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function Metric({ label, value, title, tone = "text-ink", Mark }: { label: string; value: string; title: string; tone?: string; Mark?: IconComponent }) {
  return (
    <div className="min-w-0 px-3 py-2" title={title}>
      <div className="flex min-w-0 items-center gap-1.5 text-tiny text-faint">
        {Mark && <span aria-hidden className="shrink-0"><Mark size={ICON.xs} /></span>}
        <span className="truncate">{label}</span>
      </div>
      <div className={`truncate text-label tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

/**
 * One of the strip's figures: its mark and its word, then the number, large — the number is what
 * somebody opens a trace to read (the product owner's call on 2026-10-12, "richer metrics").
 */
function Figure({ Mark, label, value, title, tone = "text-ink" }: { Mark: IconComponent; label: string; value: string; title: string; tone?: string }) {
  return (
    <div className="min-w-0 px-3 py-2.5" title={title}>
      <div className="flex min-w-0 items-center gap-1.5 text-tiny text-faint">
        <span aria-hidden className="shrink-0"><Mark size={ICON.xs} /></span>
        <span className="truncate">{label}</span>
      </div>
      <div className={`mt-0.5 truncate text-section tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

/** Below this width the strip keeps the three figures a run is judged by and drops the two counts. */
const ALL_FIVE_FROM = 460;

export function TraceMetrics({ run, steps }: { run: RunSummary; steps: readonly Step[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [roomy, setRoomy] = useState(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setRoomy(el.clientWidth >= ALL_FIVE_FROM);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const live = run.status === "running" || run.status === "paused";
  // The live duration, on the run's own clock: see useRunClock for why not `Date.now()`.
  const now = useRunClock(run.id, run.status === "running", 200);
  // A BRANCH'S OWN WORK, ONE SCOPE FOR EVERY FIGURE. Its tokens and cost summed the steps it copied
  // from its parent — which that run spent — while its Duration covered only its own, so the strip
  // mixed two scopes. The inherited figures are named in the tooltips instead (the product owner's
  // call, 2026-10-14).
  const own = useMemo(() => ownSteps(run, steps), [run, steps]);
  const totals = useMemo(() => traceTotals(own), [own]);
  const inheritedSteps = steps.length - own.length;
  const parent = useMemo(
    () => (inheritedSteps > 0 ? traceTotals(steps.filter((s) => isInherited(s, run))) : null),
    [inheritedSteps, steps, run],
  );
  const fromParent = (what: string | null): string =>
    parent && what ? ` · leaves out ${what} from the ${plural(inheritedSteps, "step")} inherited from its parent run` : "";

  const elapsed = runElapsed(run, steps, now);

  const calls = plural(totals.llmCalls, "model call");
  const tokensTitle = (totals.tokens == null
    ? totals.llmCalls === 0 ? "No model calls yet" : `None of the ${calls} reported tokens`
    : `Across ${calls} · the input/output split isn't recorded`)
    + fromParent(parent?.tokens != null ? `${parent.tokens.toLocaleString()} tokens` : null);
  const costTitle = (totals.cost == null
    ? totals.llmCalls === 0 ? "No model calls yet" : "Not priced: the pricing table doesn't know this model"
    : totals.unpricedCalls > 0
      ? `${plural(totals.unpricedCalls, "model call")} had no price, so this total leaves them out`
      : `Across ${calls}`)
    + fromParent(parent?.cost != null ? fmtCost(parent.cost) : null);

  return (
    <div ref={ref} className="shrink-0 px-6 pt-3">
      <div
        className="grid divide-x divide-hair rounded-card border border-hair bg-panel"
        style={{ gridTemplateColumns: `repeat(${roomy ? 5 : 3}, minmax(0, 1fr))` }}
      >
        <Figure
          Mark={Icon.trace.time}
          label={live ? "Elapsed" : "Duration"}
          value={elapsed == null ? "—" : fmtDuration(elapsed)}
          // THE GRAPH ALONE, and saying so: a deployed job's detail shows a longer figure for the
          // same run, measured end to end, and the two read as a contradiction. A paused run has
          // stopped its clock at the last step it finished.
          title={
            run.status === "paused"
              ? "How long the agent's graph ran before it paused"
              : live
                ? "The agent's graph alone, from its start until now"
                : "The agent's graph alone, from its start to its end — any time it sat paused included"
          }
          tone={run.status === "running" ? "text-run" : "text-ink"}
        />
        <Figure
          Mark={Icon.trace.tokens}
          label="Tokens"
          value={totals.tokens == null ? "—" : totals.tokens.toLocaleString()}
          title={tokensTitle}
        />
        <Figure
          Mark={Icon.trace.metricCost}
          label={totals.unpricedCalls > 0 && totals.cost != null ? "Cost (partial)" : "Cost"}
          value={fmtCost(totals.cost)}
          title={costTitle}
        />
        {roomy && (
          <Figure
            Mark={Icon.trace.metricSteps}
            label="Steps"
            value={own.length.toLocaleString()}
            title={inheritedSteps > 0 ? `Every step this run ran · ${inheritedSteps} more inherited from its parent run` : "Every step this run recorded"}
          />
        )}
        {roomy && (
          <Figure
            Mark={Icon.trace.metricCalls}
            label="Model calls"
            value={totals.llmCalls.toLocaleString()}
            title="Calls to a model in this run, failed ones included"
          />
        )}
      </div>
    </div>
  );
}
