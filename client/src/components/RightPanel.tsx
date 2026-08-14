// Tabbed right panel (doc §4.1): Graph · Trace · Evals · MCP · Connections — one visible at a
// time, never
// stacked.
// Trace is the hero and the default. Code is NOT a tab here; it opens as an on-demand overlay
// (CodeOverlay) from a diff-card row or Cmd+P. Clicking a trace step slides in Step Details
// over this panel.

import { useEffect, useRef } from "react";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore, type RightTab } from "../store/uiStore.ts";
import { TraceTimeline } from "./TraceTimeline.tsx";
import { GraphView } from "./GraphView.tsx";
import { EvalsPanel } from "./EvalsPanel.tsx";
import { McpPanel } from "./McpPanel.tsx";
import { ConnectionsPanel } from "./ConnectionsPanel.tsx";
import { DeployPanel } from "./DeployPanel.tsx";
import { UsagePanel } from "./UsagePanel.tsx";
import { SecretsPanel } from "./SecretsPanel.tsx";
import { useDeployStore } from "../store/deployStore.ts";
import { needsAttention, useSecretsStore } from "../store/secretsStore.ts";
import { isDeployInFlight } from "../types.ts";
import { StepDetailPanel } from "./StepDetailPanel.tsx";

const TABS: { id: RightTab; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "trace", label: "Trace" },
  { id: "evals", label: "Evals" },
  { id: "mcp", label: "MCP" },
  // Beside MCP rather than beside Usage: both tabs answer "what does this workspace reach
  // outside itself", and the two are the pair somebody audits together.
  { id: "connections", label: "Connections" },
  { id: "deploy", label: "Deploy" },
  // Beside Connections, for the reason Connections sits beside MCP: the three answer "what does
  // this workspace reach outside itself, and with whose credentials", and they are audited
  // together.
  { id: "secrets", label: "Secrets" },
  { id: "usage", label: "Usage" },
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

  // Same idiom for a deploy: a NEW one steals the tab, once. Diffed against a ref rather than
  // fired on every deploy message, so selecting an old deployment by hand does not yank the
  // panel away from whatever the user was reading.
  const deployId = useDeployStore((s) => s.selectedId);
  const deployRunning = useDeployStore((s) => s.deployments.some((d) => isDeployInFlight(d.status)));
  const prevDeployId = useRef(deployId);
  useEffect(() => {
    if (deployId && deployId !== prevDeployId.current && deployRunning) setTab("deploy");
    prevDeployId.current = deployId;
  }, [deployId, deployRunning, setTab]);

  const secretsNeedAttention = useSecretsStore((s) => needsAttention(s.health));

  const tabClass = (t: RightTab) =>
    `px-3 py-1.5 text-[12px] rounded-control transition-colors ${
      tab === t ? "bg-active text-ink" : "text-muted hover:text-ink"
    }`;

  // overflow-CLIP, not hidden. Step Details parks itself off the right edge when it is closed
  // (`translate-x-full`), so 340px of this element's content sits past its right edge. `hidden`
  // clips that from view but still makes this a scroll container — and a scroll container with
  // no scrollbar is a trap. StepRow calls scrollIntoView when a step is selected; the browser
  // found the phantom 340px scrollable and slid the whole column — tabs, header, trace — to the
  // left, where it stayed, with nothing to scroll it back. `clip` renders identically and
  // creates no scroll container at all, so there is nothing to scroll.
  return (
    <div className="relative flex h-full flex-col bg-bg overflow-clip">
      <div className="flex shrink-0 items-center gap-1 border-b border-hair px-4 py-2">
        {TABS.map((t) => (
          <button key={t.id} className={tabClass(t.id)} onClick={() => setTab(t.id)}>
            {t.label}
            {/* THE ONE BADGE IN THIS BAR, and it is computable while the tab is locked — the
                health route answers in counts, without elevation, so somebody is not asked for a
                passcode to be told whether they need to care. Carries a title as well as a colour,
                because a coloured dot alone says nothing to a screen reader. */}
            {t.id === "secrets" && secretsNeedAttention ? (
              <span
                title="A credential needs attention"
                aria-label="A credential needs attention"
                role="img"
                className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-run align-middle"
              />
            ) : null}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {tab === "graph" ? <GraphView />
          : tab === "evals" ? <EvalsPanel />
          : tab === "mcp" ? <McpPanel />
          : tab === "connections" ? <div className="h-full overflow-y-auto px-4 py-3"><ConnectionsPanel /></div>
          : tab === "deploy" ? <DeployPanel />
          : tab === "secrets" ? <SecretsPanel />
          : tab === "usage" ? <UsagePanel />
          : <TraceTimeline />}
      </div>

      {/* Step Details slides in over this panel when a step is expanded. */}
      <StepDetailPanel />
    </div>
  );
}
