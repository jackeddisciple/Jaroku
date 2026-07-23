import { useEffect, useRef } from "react";
import type { Step } from "../types.ts";
import { fmtCost, fmtDuration, fmtTokens, typeBadge } from "../lib/format.ts";
import { StepDetail } from "./StepDetail.tsx";
import { useTraceStore } from "../store/traceStore.ts";

export function StepRow({ step }: { step: Step }) {
  const open = useTraceStore((s) => s.expandedStepId === step.id);
  const selected = useTraceStore((s) => s.selectedStepId === step.id);
  const selectStep = useTraceStore((s) => s.selectStep);
  const setExpandedStep = useTraceStore((s) => s.setExpandedStep);
  const rowRef = useRef<HTMLDivElement>(null);

  // When selected from elsewhere (a graph-node click), bring the row into view.
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const meta: string[] = [];
  if (step.tokens != null) meta.push(fmtTokens(step.tokens));
  if (step.cost != null) meta.push(fmtCost(step.cost));
  meta.push(fmtDuration(step.latency_ms));

  return (
    <div ref={rowRef} className="relative pl-7 py-1.5 animate-slide-in">
      {/* connector node on the timeline's vertical line */}
      <span
        className={`absolute left-[6px] top-[11px] w-[7px] h-[7px] rounded-full ring-2 ring-bg ${
          step.error ? "bg-err" : selected ? "bg-run" : "bg-[#3f3f46]"
        }`}
      />
      {/* 2px left accent + subtle fill when this step is the sync focus (never a full-color fill) */}
      {selected && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-run rounded" />}
      <div
        className={`flex items-baseline gap-3 cursor-pointer select-none rounded ${
          selected ? "bg-active -mx-2 px-2" : ""
        }`}
        onClick={() => {
          selectStep(step.id);
          setExpandedStep(open ? null : step.id);
        }}
      >
        <span className="text-faint w-9 shrink-0 tabular-nums">#{step.seq}</span>
        <span className={`text-[11px] px-1.5 py-px rounded ${typeBadge(step.type)}`}>
          {step.type}
        </span>
        <span className="text-ink truncate">{step.name}</span>
        <span className="ml-auto text-muted text-[12px] whitespace-nowrap tabular-nums">
          {meta.join(" · ")}
          {step.error && <span className="text-err ml-2">ERROR</span>}
        </span>
      </div>
      {open && <StepDetail step={step} />}
    </div>
  );
}
