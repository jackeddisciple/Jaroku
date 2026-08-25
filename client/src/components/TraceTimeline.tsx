import { useEffect, useMemo, useState } from "react";
import { orderedSteps, useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { Step } from "../types.ts";
import { fmtCost, fmtDuration, fmtTokens } from "../lib/format.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { StepRow } from "./StepRow.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { PauseResumeControls } from "./PauseResumeControls.tsx";
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

/** Re-render on an interval while `active` (drives the live "Working Xs" ticker). */
function useTick(active: boolean, ms = 200): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

function aggregate(steps: Step[]): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const s of steps) {
    if (s.tokens != null) tokens += s.tokens;
    if (s.cost != null) cost += s.cost;
  }
  return { tokens, cost };
}

export function TraceTimeline() {
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const run = useTraceStore((s) => (activeRunId ? s.runs[activeRunId] : undefined));
  const bucket = useTraceStore((s) => (activeRunId ? s.stepsByRun[activeRunId] : undefined));

  const steps = useMemo(() => orderedSteps(bucket), [bucket]);
  const { tokens, cost } = useMemo(() => aggregate(steps), [steps]);

  const running = run?.status === "running";
  const now = useTick(running);

  const elapsed = useMemo(() => {
    if (!run) return 0;
    const start = Date.parse(run.started_at);
    const end = run.ended_at ? Date.parse(run.ended_at) : now;
    return Math.max(0, end - start);
  }, [run, now]);

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-hair px-6 py-3">
        <span className={TYPE.panelLabel}>Trace</span>
        {run ? (
          <>
            {/* A provider, a model id and a run id are all identifiers. */}
            <span className="text-tiny text-muted">
              {run.provider}/{run.model} · {run.id.slice(0, 8)}
            </span>
            <span className="ml-auto flex items-center gap-4 text-tiny tabular-nums">
              <PauseResumeControls />
              {running ? (
                <span className="text-run">Working {fmtDuration(elapsed)}</span>
              ) : run.status === "paused" ? (
                <span className="text-run">Paused</span>
              ) : (
                <span className="text-muted">Ran in {fmtDuration(elapsed)}</span>
              )}
              <span className="text-muted">{fmtTokens(tokens)}</span>
              <span className="text-muted">{fmtCost(cost)}</span>
            </span>
          </>
        ) : (
          <span className="text-muted text-caption">no run selected</span>
        )}
      </div>

      {/* timeline body */}
      <div className="scroll-fade flex-1 overflow-auto px-6 pb-4">
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
            <div className="relative">
              {/* thin vertical connector line — steps float on it, no bordered table */}
              <div className="absolute left-[9px] top-3 bottom-3 w-px bg-hair" />
              {steps.map((s) => (
                <StepRow key={s.id} step={s} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
