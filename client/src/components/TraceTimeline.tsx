import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CANCELLED_BY_USER, orderedSteps, useTraceStore } from "../store/traceStore.ts";
import type { RunSummary, Step } from "../types.ts";
import { useUiStore } from "../store/uiStore.ts";
import { COL, StepRow, columnsFor, type BarPlace, type FoldSummary, type RowTier } from "./StepRow.tsx";
import { buildTraceTree, descendantSteps, runWindow, stepWindow, traceTotals, visibleRows, type TimeWindow, type VisibleRow } from "../lib/traceView.ts";
import { EmptyState } from "./EmptyState.tsx";
import { TraceHeader } from "./TraceHeader.tsx";
import { TraceMetrics } from "./TraceMetrics.tsx";
import { TraceFilters } from "./TraceFilters.tsx";
import { TraceResult } from "./TraceResult.tsx";
import { traceMarks } from "./traceMarks.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { Icon } from "../lib/icons/registry.ts";
import { fmtDuration } from "../lib/format.ts";

/** Re-render on an interval while `active`. */
function useTick(active: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

/** A step's place in the run's span, or null when either has no readable times. */
function barFor(step: Step, span: TimeWindow | null): BarPlace | null {
  const w = stepWindow(step);
  if (!w || !span) return null;
  const total = span.end - span.start;
  return {
    left: Math.min(1, Math.max(0, (w.start - span.start) / total)),
    width: Math.min(1, Math.max(0, (w.end - w.start) / total)),
    offsetMs: Math.max(0, w.start - span.start),
  };
}

/** The list's own width, as the tier its rows can afford. Measured, because the panel is resizable. */
function useRowTier(ref: React.RefObject<HTMLDivElement | null>): RowTier {
  const [tier, setTier] = useState<RowTier>("wide");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const w = el.clientWidth;
      setTier(w >= 540 ? "full" : w >= 480 ? "wide" : w >= 380 ? "medium" : "narrow");
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return tier;
}

/**
 * The steps, as a tree a keyboard can walk.
 *
 * NESTED THE WAY THEY RAN. A model call, tool call or routing decision sits under the node it ran
 * inside (`parent_step_id`), and a node folds away to one row that still says how many steps it
 * holds, what they cost, and whether any of them failed.
 *
 * ONE ROW IS IN THE TAB ORDER — the selected one, or the first — and ↑/↓ move the selection and the
 * focus together, ← folds a node (or climbs to it), → unfolds it (or steps into it). J/K walk the same
 * visible rows from anywhere (CommandPalette), and Enter on a row opens its details.
 */
function StepList({ run, steps }: { run: RunSummary | undefined; steps: readonly Step[] }) {
  const selectedStepId = useTraceStore((s) => s.selectedStepId);
  const filter = useTraceStore((s) => s.stepFilter);
  const query = useTraceStore((s) => s.stepQuery);
  // A live run's span grows, so its bars are re-placed once a second; a finished one never moves.
  const now = useTick(run?.status === "running", 1000);
  const span = useMemo(() => (run ? runWindow(run, steps, now) : null), [run, steps, now]);
  const collapsed = useTraceStore((s) => s.collapsedStepIds);
  // MEASURED ON A BOX THAT IS ALWAYS THERE. The tree unmounts while "No steps match" shows, and an
  // observer left on it would keep reading the detached element after the filter is cleared.
  const frame = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const tier = useRowTier(frame);

  const tree = useMemo(() => buildTraceTree(steps), [steps]);
  const connectors = useBuildStore((s) => s.agents.find((a) => a.agent_id === run?.agent_id)?.connectors);
  const marks = useMemo(() => traceMarks(steps, connectors ?? []), [steps, connectors]);
  const rows = useMemo(() => visibleRows(tree, { collapsed, filter, query }), [tree, collapsed, filter, query]);
  const folds = useMemo(() => {
    const out: Record<string, FoldSummary> = {};
    for (const row of rows) {
      if (!row.collapsed) continue;
      const inside = descendantSteps(tree, row.step.id);
      const totals = traceTotals(inside);
      out[row.step.id] = {
        steps: inside.length,
        tokens: totals.tokens,
        cost: totals.cost,
        failed: inside.filter((s) => s.error != null).length,
      };
    }
    return out;
  }, [rows, tree]);
  const tabbableId = rows.some((r) => r.step.id === selectedStepId) ? selectedStepId : (rows[0]?.step.id ?? null);
  // A top-level row starts a card and takes every row after it until the next top-level one.
  const groups = useMemo(() => {
    const out: VisibleRow[][] = [];
    for (const r of rows) {
      if (r.depth === 0 || out.length === 0) out.push([r]);
      else out[out.length - 1]!.push(r);
    }
    return out;
  }, [rows]);

  const focusRow = (id: string): void => {
    useTraceStore.getState().selectStep(id);
    useUiStore.getState().setSelectedNodeId(null);
    // After the store has re-rendered the rows — a fold changes which ones exist.
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-step-id="${id}"]`)?.focus());
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    if (e.target instanceof HTMLElement && e.target.getAttribute("role") !== "treeitem") return;
    e.preventDefault();
    const at = rows.findIndex((r) => r.step.id === useTraceStore.getState().selectedStepId);
    const row = rows[at];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = rows[at === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) focusRow(next.step.id);
      return;
    }
    if (!row) return;
    const group = row.childIds.length > 0;
    if (e.key === "ArrowLeft") {
      if (group && !row.collapsed) useTraceStore.getState().setCollapsed(row.step.id, true);
      else if (row.parentId) focusRow(row.parentId);
    } else if (group && row.collapsed) {
      useTraceStore.getState().setCollapsed(row.step.id, false);
    } else if (group) {
      focusRow(row.childIds[0]!);
    }
  };

  // THE FILTERS STICK, so they stay in reach however far down somebody has scrolled.
  const header = (
    <div className="sticky top-0 z-10 -mx-1 mb-1 bg-bg px-1">
      <TraceFilters steps={steps} />
    </div>
  );

  if (rows.length === 0) {
    return (
      <div ref={frame}>
      {header}
      <div className="flex flex-col items-start gap-1.5 px-2 py-6">
        <p className="text-caption text-ink">No steps match</p>
        <p className="text-tiny text-muted">
          {query.trim() ? `Nothing in this run matches “${query.trim()}”` : "This run has no steps of that kind"}
          {filter !== "all" && query.trim() ? " with that filter on." : "."}
        </p>
        <button
          type="button"
          onClick={() => {
            useTraceStore.getState().setStepFilter("all");
            useTraceStore.getState().setStepQuery("");
          }}
          className="mt-1 rounded-control border border-hair px-2.5 py-1 text-tiny text-ink transition-colors hover:bg-active focus-visible:outline-none focus-visible:shadow-focusring"
        >
          Clear filters
        </button>
      </div>
      </div>
    );
  }

  return (
    <div ref={frame}>
    {header}
    <div ref={ref} role="tree" aria-label="Steps" className="flex flex-col gap-1.5" onKeyDown={onKeyDown}>
      {/* ONE CARD PER NODE — the product owner's call on 2026-10-12: a node and the steps that ran
          inside it read as one block, and the run as a stack of them. The cards are presentation
          only (`role="none"`): the rows are still the tree's items, and every line is drawn inside
          its own row, so a card's padding moves a row without moving anything relative to it. */}
      {groups.map((group) => (
        <div key={group[0]!.step.id} role="none" className="rounded-card border border-hair bg-panel p-1">
          {group.map((r) => (
            <StepRow
              key={r.step.id}
              row={r}
              tabbable={r.step.id === tabbableId}
              tier={tier}
              fold={folds[r.step.id]}
              bar={barFor(r.step, span)}
              provider={run?.provider}
              mark={marks.get(r.step.name)}
            />
          ))}
        </div>
      ))}
    </div>
    {run && (
      <div className="mt-1.5">
        <LiveTail run={run} steps={steps} span={span} tier={tier} />
      </div>
    )}
    </div>
  );
}

/**
 * WHAT THE RUN IS DOING NOW, below what it has done.
 *
 * A step is emitted when it FINISHES, so the timeline is always a list of things that are over — and
 * for the seconds a model call takes, a live run looked stalled after its last row. Each node boundary
 * says which nodes run next (`nextByRun`, the same word the graph's live mark uses); this row says it
 * here too. Paused, it is where the run will continue; stopped, where it stood.
 */
function LiveTail({ run, steps, span, tier }: { run: RunSummary; steps: readonly Step[]; span: TimeWindow | null; tier: RowTier }) {
  const next = useTraceStore((s) => s.nextByRun[run.id]);
  const stopped = run.status === "error" && run.error === CANCELLED_BY_USER;
  const state = run.status === "running" ? "running" : run.status === "paused" ? "paused" : stopped && next?.length ? "stopped" : null;
  if (!state) return null;

  const names = next?.length ? next.join(", ") : null;
  const name = names ?? (steps.length === 0 ? "The first step" : "The next step");
  const word =
    state === "running" ? (steps.length === 0 ? "Running now — steps appear here as they finish" : "Running now — it appears above when it finishes")
      : state === "paused" ? "Paused here — Resume continues from this step"
        : "Stopped here, before this step ran";
  // Its bar runs from the last thing that finished to now: the time the run has spent on it so far.
  let bar: { left: number; width: number } | null = null;
  let soFar: number | null = null;
  if (state === "running" && span) {
    const lastEnd = Math.max(span.start, ...steps.map((st) => stepWindow(st)?.end ?? span.start));
    const total = span.end - span.start;
    bar = { left: Math.min(1, (lastEnd - span.start) / total), width: Math.max(0, (span.end - lastEnd) / total) };
    soFar = Math.max(0, span.end - lastEnd);
  }
  const show = columnsFor(tier);

  return (
    // Its own card, DASHED: it stands where the next node's card will be, and is not one yet.
    <div
      className={`rounded-card border border-dashed p-1 ${state === "running" ? "border-run/50 bg-run/[0.04]" : "border-edge bg-panel"}`}
      aria-live="polite"
    >
    <div className="flex items-center gap-2 rounded-control py-1.5 pl-2 pr-1">
      <span className="w-7 shrink-0" />
      <span className="flex shrink-0 items-center" style={{ paddingLeft: 20 }}>
        <span
          aria-hidden
          className={`flex h-[22px] w-[22px] items-center justify-center rounded-sm border border-dashed ${
            state === "running" ? "border-run/60 bg-run/10" : "border-grip bg-void"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${state === "running" ? "animate-stream-pulse bg-run motion-reduce:animate-none" : "bg-grip"}`}
          />
        </span>
      </span>
      <span className="min-w-[4.5rem] flex-1">
        <span className="block truncate text-caption font-medium text-ink" title={name}>{name}</span>
        <span className={`block truncate text-tiny ${state === "running" ? "text-run" : "text-faint"}`}>{word}</span>
      </span>
      {/* THE STEPS' OWN COLUMNS, so its time and bar sit under the headers: the time it has run so
          far, in amber, and its bar from the last finished step to now. */}
      <span className="flex shrink-0 items-center gap-2 text-tiny tabular-nums">
        {show.tokens && <span className={COL.tokens} />}
        {show.cost && <span className={COL.cost} />}
        <span className={`${COL.time} text-right ${state === "running" ? "text-run" : "text-faint"}`}>
          {soFar == null ? "" : fmtDuration(soFar)}
        </span>
        {show.timeline && (
          <span className={`relative h-1.5 shrink-0 rounded-full bg-void ${COL.timeline}`} aria-hidden>
            {bar && (
              <span
                className="absolute bottom-0 top-0 animate-stream-pulse rounded-full bg-run motion-reduce:animate-none"
                style={{ left: `${bar.left * 100}%`, width: `max(2px, ${bar.width * 100}%)`, opacity: 0.55 }}
              />
            )}
          </span>
        )}
      </span>
      {show.actions && <span className={`${COL.actions} shrink-0`} />}
    </div>
    </div>
  );
}

export function TraceTimeline() {
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const run = useTraceStore((s) => (activeRunId ? s.runs[activeRunId] : undefined));
  const bucket = useTraceStore((s) => (activeRunId ? s.stepsByRun[activeRunId] : undefined));

  const steps = useMemo(() => orderedSteps(bucket), [bucket]);

  return (
    <div className="flex h-full flex-col bg-bg">
      <TraceHeader run={run} />
      {run && <TraceMetrics run={run} steps={steps} />}

      {/* timeline body */}
      {/* NO `scroll-fade` HERE: the filter row sticks to the top of this region, and a mask over the
          first 16px would dim the controls it is meant to keep in reach. */}
      {/* The padding is on the INNER box: a sticky child sticks to the scroller's padding edge, so
          top padding here would leave a strip above the filter row for steps to scroll through. */}
      <div className="flex-1 overflow-auto px-6 pb-4">
        <div className="pt-3">
          {steps.length === 0 ? (
            run?.status === "running" || run?.status === "paused" ? (
              // A RUN WITH NOTHING FINISHED YET is not an empty trace: it is a trace whose first row has
              // not landed. Say what is happening, and that rows arrive as their steps finish.
              <>
                <TraceResult run={run} steps={steps} />
                <LiveTail run={run} steps={steps} span={null} tier="narrow" />
              </>
            ) : (
              <EmptyState
                size="line"
                icon={Icon.trace.empty}
                title={run ? "This run recorded no steps" : "No trace yet"}
                hint={
                  run
                    ? "It ended before any step finished, so there is nothing to inspect. Its outcome is in the header."
                    : "Run the agent below. Each model call, tool call, state update and routing decision appears here, in order, as it finishes."
                }
              />
            )
          ) : (
            <>
              {run && <TraceResult run={run} steps={steps} />}
              <StepList run={run} steps={steps} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
