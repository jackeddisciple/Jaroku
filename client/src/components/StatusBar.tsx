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

  // A MIDDLE DOT, NOT A PIPE. A `|` drawn in the divider colour is a glyph doing a border's job:
  // it sits on the text baseline at the font's own weight, so seven of them down a strip read as
  // a set of drawn rules that are all very slightly the wrong height.
  const sep = <span className="text-faint" aria-hidden>·</span>;

  return (
    // `font-sans` on the strip, `font-mono` on the figures. The whole row used to be code font —
    // including the words `connected`, `connecting…` and `deploying <agent>`, which are English.
    // Monospace is what marks something as an identifier; setting sentences in it removes the one
    // signal it carries.
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-hair px-4 text-[11px] text-muted">
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
          {/* The one variable-width element in the row, and the only one that may shrink. A long
              model id used to push the cost and the duration off the right edge, because the strip
              is a flex row with no `min-w-0` anywhere in it. */}
          <span className="min-w-0 truncate font-mono" title={`${run.provider}/${run.model}`}>
            {run.provider}/{run.model}
          </span>
          {sep}
          <span>{run.status}</span>
          {sep}
          <span className="shrink-0 font-mono tabular-nums">Step {count}</span>
          {sep}
          <span className="shrink-0 font-mono tabular-nums">{fmtTokens(tokens)}</span>
          {sep}
          <span className="shrink-0 font-mono tabular-nums">{fmtCost(cost)}</span>
          {sep}
          <span className="shrink-0 font-mono tabular-nums">{fmtDuration(duration)}</span>
        </>
      )}
      {/* A deploy is the one thing that happens outside this machine, and it can be running
          while the user is reading something else entirely. It gets the far end of the strip
          so it never pushes the run's own figures around. */}
      {deploying && (
        <>
          <span className="ml-auto shrink-0 text-run">deploying <span className="font-mono">{deploying.agent_id}</span></span>
          {sep}
          <span className="shrink-0 text-run">{deployStage ?? deploying.status}</span>
        </>
      )}
      {!deploying && live > 0 && (
        <span className="ml-auto shrink-0"><span className="font-mono tabular-nums">{live}</span> deployed</span>
      )}
    </div>
  );
}
