// Step Details — the slide-in overlay from the right (doc §4.1, not a permanent column). Opens
// when a step is "expanded" (row click or Enter); shows the overview key-values, then the
// step's input / output / state diff and the One-Click Fix button. Reuses StepDetail for the
// body so there's a single source of truth for how a step renders.

import { useEffect } from "react";
import { useTraceStore } from "../store/traceStore.ts";
import { fmtCost, fmtDuration, fmtTokens, typeBadge } from "../lib/format.ts";
import { StepDetail } from "./StepDetail.tsx";

function glyphForType(type: string): string {
  switch (type) {
    case "llm_call": return "✦";
    case "tool_call": return "⚙";
    case "router": return "⑃";
    default: return "◆"; // state_update
  }
}

function Kv({ label, value, tag }: { label: string; value: string; tag?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-1 text-[12px]">
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-2">
        <span className="text-ink tabular-nums">{value}</span>
        {tag && <span className="text-[9px] text-faint bg-active rounded px-1 py-px uppercase tracking-wide">this step</span>}
      </span>
    </div>
  );
}

export function StepDetailPanel() {
  const expandedStepId = useTraceStore((s) => s.expandedStepId);
  const step = useTraceStore((s) => {
    const id = s.expandedStepId;
    const run = s.activeRunId;
    return id && run ? s.stepsByRun[run]?.[id] : undefined;
  });
  const setExpandedStep = useTraceStore((s) => s.setExpandedStep);
  const open = Boolean(expandedStepId && step);

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedStep(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setExpandedStep]);

  // Keep the element mounted for the slide-out transition; just translate it off-screen.
  return (
    <div
      className={`absolute top-0 right-0 bottom-0 w-[340px] max-w-[85%] bg-panel z-20 flex flex-col
        shadow-[-8px_0_24px_rgba(0,0,0,0.35)] transition-transform duration-150 ease-out
        ${open ? "translate-x-0" : "translate-x-full pointer-events-none"}`}
      aria-hidden={!open}
    >
      {step && (
        <>
          <div className="flex items-center gap-2 px-4 py-3 shrink-0">
            <span className="text-[11px] uppercase tracking-widest text-faint">Step Details</span>
            <button
              onClick={() => setExpandedStep(null)}
              className="ml-auto text-muted hover:text-ink text-[13px]"
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>

          <div className="px-4 pb-3 shrink-0">
            <div className="flex items-center gap-2">
              <span className={`text-[13px] ${step.error ? "text-err" : "text-run"}`}>{glyphForType(step.type)}</span>
              <span className="text-ink truncate">{step.name}</span>
              <span className={`ml-auto text-[11px] px-1.5 py-px rounded ${typeBadge(step.type)}`}>{step.type}</span>
            </div>
            <div className="mt-1 text-[11px]">
              {step.error ? <span className="text-err">● failed</span> : <span className="text-ok">● ok</span>}
            </div>
          </div>

          <div className="flex-1 overflow-auto px-4 pb-6">
            <div className="border-t border-hair pt-2">
              <Kv label="Step ID" value={step.id.slice(0, 8)} />
              <Kv label="Type" value={step.type} />
              <Kv label="Seq" value={`#${step.seq}`} />
              {step.tokens != null && <Kv label="Tokens" value={fmtTokens(step.tokens)} tag />}
              {step.cost != null && <Kv label="Cost" value={fmtCost(step.cost)} tag />}
              <Kv label="Duration" value={fmtDuration(step.latency_ms)} tag />
            </div>
            <div className="mt-3">
              <StepDetail step={step} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
