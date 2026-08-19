import { useMemo } from "react";
import { orderedSteps, useTraceStore } from "../store/traceStore.ts";
import { fmtCost, fmtDuration, fmtTokens } from "../lib/format.ts";
import { useDeployStore } from "../store/deployStore.ts";
import { isDeployInFlight } from "../types.ts";

const DOT: Record<string, string> = {
  open: "bg-ok",
  connecting: "bg-run",
  closed: "bg-err",
};
// ONE WORD ON SCREEN, THE SENTENCE ON HOVER. `disconnected — retrying…` is a sentence set in a
// code font in the app's chrome, and it was the widest thing in the strip at exactly the moment
// the product had least to say. The state is a colour and a word; what the product is doing about
// it is a detail, and a detail belongs in a tooltip.
const LABEL: Record<string, string> = {
  open: "connected",
  connecting: "connecting",
  closed: "disconnected",
};
const DETAIL: Record<string, string> = {
  open: "Connected to the server",
  connecting: "Connecting to the server…",
  closed: "Disconnected — retrying",
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

  const deploying = useDeployStore((s) => s.deployments.find((d) => isDeployInFlight(d.status)));
  const deployStage = useDeployStore((s) => (deploying ? (s.stage[deploying.id] ?? null) : null));
  const live = useDeployStore((s) => s.deployments.filter((d) => d.status === "live").length);

  const sep = <span className="text-hair">|</span>;

  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-hair px-4 font-mono text-[11px] text-muted tabular-nums">
      {/* The dot moves while it is connecting. Every other in-flight mark in this app pulses —
          the agent dot, the run glyph, the deploy chip — and this one indicator, the one that says
          whether any of the others can update at all, was static in all three states with only its
          colour changing. */}
      <span className="flex items-center gap-1.5 font-sans" title={DETAIL[connection]}>
        <span
          className={`h-1.5 w-1.5 rounded-full ${DOT[connection]} ${
            connection === "connecting" ? "animate-stream-pulse motion-reduce:animate-none" : ""
          }`}
        />
        <span className="text-[10px] text-faint">{LABEL[connection]}</span>
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
      {/* A deploy is the one thing that happens outside this machine, and it can be running
          while the user is reading something else entirely. It gets the far end of the strip
          so it never pushes the run's own figures around. */}
      {deploying && (
        <>
          <span className="ml-auto text-run">deploying {deploying.agent_id}</span>
          {sep}
          <span className="text-run">{deployStage ?? deploying.status}</span>
        </>
      )}
      {!deploying && live > 0 && (
        <span className="ml-auto">{live} deployed</span>
      )}
    </div>
  );
}
