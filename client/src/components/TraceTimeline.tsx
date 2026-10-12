import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { orderedSteps, useTraceStore } from "../store/traceStore.ts";
import type { Step } from "../types.ts";
import { useUiStore } from "../store/uiStore.ts";
import { ICON } from "../lib/tokens.ts";
import { StepRow, tileCentre, type FoldSummary, type RowTier } from "./StepRow.tsx";
import { buildTraceTree, descendantSteps, traceTotals, visibleRows } from "../lib/traceView.ts";
import { EmptyState } from "./EmptyState.tsx";
import { TraceHeader } from "./TraceHeader.tsx";
import { TraceMetrics } from "./TraceMetrics.tsx";
import { TraceResult } from "./TraceResult.tsx";
import { ActivityIcon, XIcon } from "./panelIcons.tsx";

/**
 * The one-time line beside a user's first trace.
 *
 * A sentence, not a tour. The timeline is the thing the whole product is built around, and the
 * first time it fills in, it is a dense column of rows whose significance has to be inferred.
 * One line names what it is; everything after that the panel teaches by being used.
 *
 * Shown once ever, per browser, and recorded the moment it renders — so it does not reappear
 * for the second agent, or after a server restart, or on a reload two minutes later. Because
 * the right panel is not mounted until step 4 of onboarding, the boot autorun cannot burn it.
 */
function FirstTraceHint() {
  const shown = useUiStore((s) => s.onboardingHintsShown.includes("trace"));
  const markHintShown = useUiStore((s) => s.markHintShown);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!shown) markHintShown("trace");
  }, [shown, markHintShown]);

  // `shown` was read on the first render, before the effect above wrote it — so this component
  // renders once and never again in a later session.
  const [visible] = useState(!shown);
  if (!visible || dismissed) return null;

  return (
    <div className="mb-3 flex items-start gap-2 rounded-card border border-edge bg-panel px-3 py-2">
      <p className="text-caption leading-[1.55] text-muted">
        This is your agent’s execution — every decision it made, in order.
      </p>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        title="Dismiss"
        className="ml-auto shrink-0 text-faint transition-colors hover:text-ink"
      >
        <XIcon size={ICON.xs} />
      </button>
    </div>
  );
}

/** The list's own width, as the tier its rows can afford. Measured, because the panel is resizable. */
function useRowTier(ref: React.RefObject<HTMLDivElement | null>): RowTier {
  const [tier, setTier] = useState<RowTier>("wide");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const w = el.clientWidth;
      setTier(w >= 500 ? "wide" : w >= 380 ? "medium" : "narrow");
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
function StepList({ steps }: { steps: readonly Step[] }) {
  const selectedStepId = useTraceStore((s) => s.selectedStepId);
  const collapsed = useTraceStore((s) => s.collapsedStepIds);
  const ref = useRef<HTMLDivElement>(null);
  const tier = useRowTier(ref);

  const tree = useMemo(() => buildTraceTree(steps), [steps]);
  const rows = useMemo(() => visibleRows(tree, { collapsed }), [tree, collapsed]);
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

  return (
    <div ref={ref} role="tree" aria-label="Steps" className="relative" onKeyDown={onKeyDown}>
      {/* The timeline's line, through the centre of every top-level step's tile. */}
      <div aria-hidden className="absolute bottom-4 top-4 w-px bg-hair" style={{ left: tileCentre(0) - 0.5 }} />
      {rows.map((r) => (
        <StepRow key={r.step.id} row={r} tabbable={r.step.id === tabbableId} tier={tier} fold={folds[r.step.id]} />
      ))}
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
      <div className="scroll-fade flex-1 overflow-auto px-6 pb-4 pt-3">
        {steps.length === 0 ? (
          <EmptyState
            size="line"
            icon={ActivityIcon}
            title="No trace yet"
            hint="Run the agent below and every LLM call, tool call and routing decision it makes streams in here."
          />
        ) : (
          // The hint sits OUTSIDE the positioned wrapper below: that wrapper is what the step
          // connector line is measured against, and a banner inside it would drag the line's
          // top edge up beside the text.
          <>
            <FirstTraceHint />
            {run && <TraceResult run={run} steps={steps} />}
            <StepList steps={steps} />
          </>
        )}
      </div>
    </div>
  );
}
