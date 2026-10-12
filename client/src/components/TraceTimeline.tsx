import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { orderedSteps, useTraceStore } from "../store/traceStore.ts";
import type { Step } from "../types.ts";
import { useUiStore } from "../store/uiStore.ts";
import { ICON } from "../lib/tokens.ts";
import { StepRow, type RowTier } from "./StepRow.tsx";
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
 * ONE ROW IS IN THE TAB ORDER — the selected one, or the first — and ↑/↓ move the selection and the
 * focus together, which is the tree pattern rather than eighty tab stops. J/K keep working from
 * anywhere (CommandPalette), and Enter on a row opens its details.
 */
function StepList({ steps }: { steps: readonly Step[] }) {
  const selectedStepId = useTraceStore((s) => s.selectedStepId);
  const ref = useRef<HTMLDivElement>(null);
  const tier = useRowTier(ref);
  const tabbableId = steps.some((s) => s.id === selectedStepId) ? selectedStepId : (steps[0]?.id ?? null);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const at = steps.findIndex((s) => s.id === useTraceStore.getState().selectedStepId);
    const next = steps[at === -1 ? 0 : Math.min(steps.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    useTraceStore.getState().selectStep(next.id);
    useUiStore.getState().setSelectedNodeId(null);
    ref.current?.querySelector<HTMLElement>(`[data-step-id="${next.id}"]`)?.focus();
  };

  return (
    <div ref={ref} role="tree" aria-label="Steps" className="relative" onKeyDown={onKeyDown}>
      {/* The timeline's line, through the centre of every step's tile. */}
      <div aria-hidden className="absolute bottom-4 left-[54px] top-4 w-px bg-hair" />
      {steps.map((s) => (
        <StepRow key={s.id} step={s} tabbable={s.id === tabbableId} tier={tier} />
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
