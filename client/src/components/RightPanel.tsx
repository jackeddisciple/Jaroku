// Tabbed right panel (doc §4.1): Graph · Trace · Evals — one visible at a time, never stacked.
// Trace is the hero and the default. Code is NOT a tab here; it opens as an on-demand overlay
// (CodeOverlay) from a diff-card row or Cmd+P. Clicking a trace step slides in Step Details
// over this panel.

import { useEffect, useRef } from "react";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore, type RightTab } from "../store/uiStore.ts";
import { TraceTimeline } from "./TraceTimeline.tsx";
import { GraphView } from "./GraphView.tsx";
import { DatasetBuilder } from "./DatasetBuilder.tsx";
import { StepDetailPanel } from "./StepDetailPanel.tsx";

const TABS: { id: RightTab; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "trace", label: "Trace" },
  { id: "evals", label: "Evals" },
];

export function RightPanel() {
  const tab = useUiStore((s) => (s.rightTab === "code" ? "trace" : s.rightTab));
  const setTab = useUiStore((s) => s.setRightTab);
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const prevRunId = useRef(activeRunId);

  // A new run starts -> show its trace. That is the moment the product is about.
  useEffect(() => {
    if (activeRunId && activeRunId !== prevRunId.current) setTab("trace");
    prevRunId.current = activeRunId;
  }, [activeRunId, setTab]);

  const tabClass = (t: RightTab) =>
    `px-3 py-1.5 text-[12px] rounded transition-colors ${
      tab === t ? "bg-active text-ink" : "text-muted hover:text-ink"
    }`;

  return (
    <div className="relative flex h-full flex-col bg-bg overflow-hidden">
      <div className="flex items-center gap-1 px-4 py-2 shrink-0">
        {TABS.map((t) => (
          <button key={t.id} className={tabClass(t.id)} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {tab === "graph" ? <GraphView /> : tab === "evals" ? <DatasetBuilder /> : <TraceTimeline />}
      </div>

      {/* Step Details slides in over this panel when a step is expanded. */}
      <StepDetailPanel />
    </div>
  );
}
