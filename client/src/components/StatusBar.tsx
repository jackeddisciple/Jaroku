import { useMemo } from "react";
import { orderedSteps, useTraceStore } from "../store/traceStore.ts";
import { fmtCost, fmtDuration, fmtTokens } from "../lib/format.ts";

const DOT: Record<string, string> = {
  open: "bg-ok",
  connecting: "bg-run",
  closed: "bg-err",
};
const LABEL: Record<string, string> = {
  open: "connected",
  connecting: "connecting…",
  closed: "disconnected — retrying…",
};

export function StatusBar() {
  const connection = useTraceStore((s) => s.connection);
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const run = useTraceStore((s) => (activeRunId ? s.runs[activeRunId] : undefined));
  const bucket = useTraceStore((s) => (activeRunId ? s.stepsByRun[activeRunId] : undefined));

  const { tokens, cost, count, duration } = useMemo(() => {
    const steps = orderedSteps(bucket);
    let tk = 0;
    let ct = 0;
    for (const s of steps) {
      if (s.tokens != null) tk += s.tokens;
      if (s.cost != null) ct += s.cost;
    }
    let dur = 0;
    if (run) {
      const start = Date.parse(run.started_at);
      const end = run.ended_at ? Date.parse(run.ended_at) : start;
      dur = Math.max(0, end - start);
    }
    return { tokens: tk, cost: ct, count: steps.length, duration: dur };
  }, [bucket, run]);

  const sep = <span className="text-hair">|</span>;

  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-hair px-4 font-mono text-[11px] text-muted tabular-nums">
      <span className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full ${DOT[connection]}`} />
        {LABEL[connection]}
      </span>
      {run && (
        <>
          {sep}
          <span>{run.provider}/{run.model}</span>
          {sep}
          <span>{run.status}</span>
          {sep}
          <span>Step {count}</span>
          {sep}
          <span>{fmtTokens(tokens)}</span>
          {sep}
          <span>{fmtCost(cost)}</span>
          {sep}
          <span>{fmtDuration(duration)}</span>
        </>
      )}
    </div>
  );
}
