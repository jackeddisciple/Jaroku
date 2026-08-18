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
import { GitHubPanel } from "./GitHubPanel.tsx";
import { useDeployStore } from "../store/deployStore.ts";
import { needsAttention, useSecretsStore } from "../store/secretsStore.ts";
import { badgeFor, useGithubStore } from "../store/githubStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { fetchHealth } from "../lib/secrets.ts";
import { isDeployInFlight } from "../types.ts";
import { StepDetailPanel } from "./StepDetailPanel.tsx";
import { AgentDetail } from "./AgentDetail.tsx";
import { useAgentGridStore } from "../store/agentGridStore.ts";

const TABS: { id: RightTab; label: string }[] = [
  // FIRST, AND ONLY WHEN AN AGENT IS OPEN — see `agentTabVisible` below. §6's detail is a tab rather
  // than a fourth column, and it leads the row because arriving from the Agents grid is what puts it
  // there: the panel should already be showing what was clicked.
  { id: "agent", label: "Agent" },
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
  // Last in the row, and beside Deploy rather than beside Graph. The three tabs to its left answer
  // "what does this workspace reach outside itself"; this one answers "where does its code go",
  // which is the same kind of question about the same kind of boundary.
  { id: "github", label: "GitHub" },
  { id: "usage", label: "Usage" },
];

export function RightPanel() {
  const rightTab = useUiStore((s) => s.rightTab);
  /**
   * Whether §6's detail has an agent to show.
   *
   * THE TAB IS ABSENT RATHER THAN DISABLED WHEN NOTHING IS OPEN, which is a deliberate exception to
   * this product's state-what-is-true rule and worth saying why. That rule is about a control whose
   * ACTION is refused — a Push button with nothing to push says so instead of vanishing. This is not
   * a refused action, it is a view of an object that has not been chosen: an "Agent" tab standing
   * permanently in the bar with nothing behind it would be a ninth tab that never does anything,
   * and the door to it is the Agents grid rather than this row.
   */
  const agentOpen = useAgentGridStore((s) => s.openAgentId !== null);
  const tab = rightTab === "code" ? "trace" : rightTab === "agent" && !agentOpen ? "trace" : rightTab;
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

  // §0: THE TAB LABEL CARRIES LIVE STATE, so you never open the tab just to check. It is read off
  // the view the server already computed rather than derived here — see githubStore's `badgeFor`.
  //
  // A GLYPH RATHER THAN A DOT, unlike Secrets beside it, and the difference is what each has to
  // say. Secrets needs one bit: something needs attention. This needs a DIRECTION and a COUNT —
  // ↑2 and ↓1 send you to different buttons — and a coloured dot cannot carry either.
  const githubAgentId = useBuildStore((s) => s.activeAgentId);
  const githubBadge = useGithubStore((s) => badgeFor(s.views, githubAgentId));

  // THE BADGE HAS TO BE COMPUTED BY SOMETHING THAT IS ALWAYS MOUNTED, and until now the only
  // caller of `/secrets/health` was SecretsPanel — which exists only while the Secrets tab is the
  // one on screen. So the dot appeared exactly when somebody was already reading the health strip
  // that says the same thing at more length, and never when they were somewhere else, which is the
  // entire moment it exists for.
  //
  // IT IS THE ONE SECRETS ANSWER SERVED WITHOUT ELEVATION, and that is what makes this possible:
  // counts, no names, so polling it from the tab bar asks nobody for a passcode to be told whether
  // they need to care. A minute, because expiry moves in days and this runs for every open client.
  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        const health = await fetchHealth();
        if (!cancelled) useSecretsStore.getState().setHealth(health);
      } catch {
        /* a badge is not worth an error strip — and before sign-in there is nothing to ask */
      }
    };
    void read();
    const poll = setInterval(() => void read(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, []);

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
        {TABS.filter((t) => t.id !== "agent" || agentOpen).map((t) => (
          <button key={t.id} className={tabClass(t.id)} onClick={() => setTab(t.id)}>
            {t.label}
            {/* THE ONE BADGE IN THIS BAR, and it is computable while the tab is locked — the
                health route answers in counts, without elevation, so somebody is not asked for a
                passcode to be told whether they need to care. Carries a title as well as a colour,
                because a coloured dot alone says nothing to a screen reader. */}
            {/* Amber for anything in flight, the error tone for a stopped state. Diverged is NOT
                amber, deliberately: it is not something working, it is something waiting for a
                person, and wearing the running colour would make it read as progress. */}
            {t.id === "github" && githubBadge ? (
              <span
                title={`GitHub: ${githubBadge}`}
                className={`ml-1.5 align-middle font-mono text-[10px] tabular-nums ${
                  githubBadge === "⟳" ? "text-run" : githubBadge === "⚠" || githubBadge === "↕" ? "text-err" : "text-muted"
                }`}
              >
                {githubBadge}
              </span>
            ) : null}
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
        {tab === "agent" ? <AgentDetail />
          : tab === "graph" ? <GraphView />
          : tab === "evals" ? <EvalsPanel />
          : tab === "mcp" ? <McpPanel />
          : tab === "connections" ? <div className="h-full overflow-y-auto px-4 py-3"><ConnectionsPanel /></div>
          : tab === "deploy" ? <DeployPanel />
          : tab === "secrets" ? <SecretsPanel />
          : tab === "github" ? <GitHubPanel />
          : tab === "usage" ? <UsagePanel />
          : <TraceTimeline />}
      </div>

      {/* Step Details slides in over this panel when a step is expanded. */}
      <StepDetailPanel />
    </div>
  );
}
