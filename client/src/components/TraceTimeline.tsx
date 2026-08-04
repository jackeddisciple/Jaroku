import { useEffect, useMemo, useState } from "react";
import { orderedSteps, useTraceStore } from "../store/traceStore.ts";
import type { Step } from "../types.ts";
import { fmtCost, fmtDuration, fmtTokens } from "../lib/format.ts";
import { StepRow } from "./StepRow.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { PauseResumeControls } from "./PauseResumeControls.tsx";
import { ActivityIcon } from "./panelIcons.tsx";

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
      <div className="flex items-center gap-3 px-6 py-3 shrink-0">
        <span className="text-[11px] uppercase tracking-widest text-faint">Trace</span>
        {run ? (
          <>
            <span className="text-muted text-[12px]">
              {run.provider}/{run.model} · {run.id.slice(0, 8)}
            </span>
            <span className="ml-auto flex items-center gap-4 text-[12px] tabular-nums">
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
          <span className="text-muted text-[12px]">no run selected</span>
        )}
      </div>

      {/* timeline body */}
      <div className="flex-1 overflow-auto px-6 pb-4">
        {steps.length === 0 ? (
          <EmptyState
            icon={ActivityIcon}
            title="No trace yet"
            hint="Run the agent below and every LLM call, tool call and routing decision it makes streams in here."
          />
        ) : (
          <div className="relative">
            {/* thin vertical connector line — steps float on it, no bordered table */}
            <div className="absolute left-[9px] top-3 bottom-3 w-px bg-hair" />
            {steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
