// Tabbed right panel (doc §4: Graph / Trace / Evals live here as they land).
// Two ship now: Trace — the existing timeline, unchanged — and Code, the read-only viewer
// for the generated project.
//
// The tab auto-follows the work: a generation switches to Code so the user watches files
// land, and a run switches back to Trace. Manual selection is respected until the other
// kind of activity starts.

import { useEffect, useRef } from "react";
import { useBuildStore } from "../store/buildStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore, type RightTab } from "../store/uiStore.ts";
import { TraceTimeline } from "./TraceTimeline.tsx";
import { CodeViewer } from "./CodeViewer.tsx";
import { GraphView } from "./GraphView.tsx";

type Tab = RightTab;

export function RightPanel() {
  // Tab lives in uiStore so the command palette / shortcuts can switch it; the auto-follow
  // effects below still drive it for generation and new runs.
  const tab = useUiStore((s) => s.rightTab);
  const setTab = useUiStore((s) => s.setRightTab);
  const genStatus = useBuildStore((s) => s.status);
  const codeFocus = useBuildStore((s) => s.codeFocus);
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const prevRunId = useRef(activeRunId);

  // Generation starts -> show the code streaming in.
  useEffect(() => {
    if (genStatus === "generating") setTab("code");
  }, [genStatus]);

  // A diff-card file row asked for the Code tab (fix loop).
  useEffect(() => {
    if (codeFocus > 0) setTab("code");
  }, [codeFocus]);

  // A new run starts -> show its trace. That is the moment the product is about.
  useEffect(() => {
    if (activeRunId && activeRunId !== prevRunId.current) setTab("trace");
    prevRunId.current = activeRunId;
  }, [activeRunId]);

  const tabClass = (t: Tab) =>
    `px-3 py-1.5 text-[12px] rounded transition-colors ${
      tab === t ? "bg-active text-ink" : "text-muted hover:text-ink"
    }`;

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex items-center gap-1 px-4 py-2 shrink-0">
        <button className={tabClass("graph")} onClick={() => setTab("graph")}>
          Graph
        </button>
        <button className={tabClass("trace")} onClick={() => setTab("trace")}>
          Trace
        </button>
        <button className={tabClass("code")} onClick={() => setTab("code")}>
          Code
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {tab === "graph" ? <GraphView /> : tab === "trace" ? <TraceTimeline /> : <CodeViewer />}
      </div>
    </div>
  );
}
