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
import { ICON } from "../lib/tokens.ts";
import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  DollarSignIcon,
  GitBranchIcon,
  GithubIcon,
  KeyIcon,
  PlugIcon,
  RefreshIcon,
  RocketIcon,
  SparklesIcon,
  WrenchIcon,
} from "./panelIcons.tsx";
import { FlaskIcon } from "./inboxIcons.tsx";

// TEN DESTINATIONS IN 40px OF WIDTH, as glyphs in a vertical rail rather than as ten words in a
// horizontal strip.
//
// The strip spent about 570px of the header on the words `Agent Graph Trace Evals MCP Connections
// Deploy Secrets GitHub Usage`, which is what capped how narrow this pane could go — and because
// the Agent tab appears and disappears with the grid's selection, every other tab shifted sideways
// when somebody opened an agent, moving the click target they were reaching for. A rail is fixed
// width by construction, so nothing in it moves when the set changes.
//
// The order is unchanged, and so is the reasoning for it, which is recorded per entry below.
// Nothing is added, removed, merged or re-parented — this is the same ten destinations, drawn.
const TABS: { id: RightTab; label: string; Icon: (p: { size?: number }) => React.ReactElement }[] = [
  // FIRST, AND ONLY WHEN AN AGENT IS OPEN — see `agentOpen` below. §6's detail is a tab rather
  // than a fourth column, and it leads the row because arriving from the Agents grid is what puts it
  // there: the panel should already be showing what was clicked.
  { id: "agent", label: "Agent", Icon: SparklesIcon },
  { id: "graph", label: "Graph", Icon: GitBranchIcon },
  { id: "trace", label: "Trace", Icon: ActivityIcon },
  { id: "evals", label: "Evals", Icon: FlaskIcon },
  { id: "mcp", label: "MCP", Icon: WrenchIcon },
  // Beside MCP rather than beside Usage: both tabs answer "what does this workspace reach
  // outside itself", and the two are the pair somebody audits together.
  { id: "connections", label: "Connections", Icon: PlugIcon },
  { id: "deploy", label: "Deploy", Icon: RocketIcon },
  // Beside Connections, for the reason Connections sits beside MCP: the three answer "what does
  // this workspace reach outside itself, and with whose credentials", and they are audited
  // together.
  { id: "secrets", label: "Secrets", Icon: KeyIcon },
  // Last in the row, and beside Deploy rather than beside Graph. The three tabs to its left answer
  // "what does this workspace reach outside itself"; this one answers "where does its code go",
  // which is the same kind of question about the same kind of boundary.
  { id: "github", label: "GitHub", Icon: GithubIcon },
  { id: "usage", label: "Usage", Icon: DollarSignIcon },
];

/**
 * The GitHub tab's badge, drawn.
 *
 * The server decides what the badge SAYS — `githubSync.badgeFor` owns the state table, and a
 * second opinion here about what ↕ means is exactly what that comment warns against. What it does
 * not get to decide is how the mark is drawn: it was arriving as literal `⟳ ⚠ ↕ ↑ ↓` characters
 * set in the text font, so the one mark in this rail that is not a real icon rendered at the
 * font's weight rather than at ICON.strokeWidth, beside nine glyphs that do.
 *
 * So: the leading character picks a glyph and the numeric tail stays text. The tone is unchanged —
 * amber for anything in flight, the error tone for a stopped state, and diverged is deliberately
 * NOT amber, because it is not something working, it is something waiting for a person.
 */
function GithubBadge({ badge, syncing }: { badge: string; syncing: boolean }) {
  const head = badge[0] ?? "";
  const count = badge.slice(1);
  const Glyph =
    head === "⟳" ? RefreshIcon
      : head === "⚠" ? AlertTriangleIcon
      : head === "↕" ? ArrowUpDownIcon
      : head === "↑" ? ArrowUpIcon
      : ArrowDownIcon;
  const tone = head === "⟳" ? "text-run" : head === "⚠" || head === "↕" ? "text-err" : "text-muted";
  return (
    <span
      title={`GitHub: ${badge}`}
      className={`absolute -right-1 -top-1 inline-flex items-center rounded-chip bg-bg px-0.5 leading-none ${tone}`}
    >
      {/* The circular arrow IS the spinner — it is drawn as three quarters of a turn for exactly
          that reason, and a refresh mark that does not turn while something is refreshing is the
          one glyph in the app whose shape makes a promise its motion breaks. */}
      <Glyph size={ICON.badge} className={syncing ? "animate-spin motion-reduce:animate-none" : undefined} />
      {count && <span className="font-mono text-[10px] tabular-nums">{count}</span>}
    </span>
  );
}

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

  const visible = TABS.filter((t) => t.id !== "agent" || agentOpen);

  // overflow-CLIP, not hidden. Step Details parks itself off the right edge when it is closed
  // (`translate-x-full`), so 340px of this element's content sits past its right edge. `hidden`
  // clips that from view but still makes this a scroll container — and a scroll container with
  // no scrollbar is a trap. StepRow calls scrollIntoView when a step is selected; the browser
  // found the phantom 340px scrollable and slid the whole column — tabs, header, trace — to the
  // left, where it stayed, with nothing to scroll it back. `clip` renders identically and
  // creates no scroll container at all, so there is nothing to scroll.
  return (
    <div className="flex h-full bg-bg">
      <div className="relative flex min-w-0 flex-1 flex-col overflow-clip">
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

      {/* A TABLIST, AND REACHABLE THE WAY ONE IS. Ten plain buttons meant ten Tab presses to cross
          the rail and no announcement of which one was chosen; the pattern is one stop for the
          whole set, arrows to move inside it. `roving` is the index Tab lands on — the selected
          cell, so returning to the rail returns you where you were. */}
      <div
        role="tablist"
        aria-label="Panel"
        aria-orientation="vertical"
        onKeyDown={(e) => {
          const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
          if (!step) return;
          e.preventDefault();
          const at = visible.findIndex((t) => t.id === tab);
          const next = visible[(at + step + visible.length) % visible.length];
          if (next) setTab(next.id);
        }}
        className="flex w-10 shrink-0 flex-col items-center gap-0.5 border-l border-hair py-2"
      >
        {visible.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              ref={(el) => {
                // Focus follows selection only while the rail already has it — an arrow press
                // should move the focus ring with the choice, but a click from the trace pane
                // must not yank focus out of what somebody was reading.
                if (active && el && el.parentElement?.contains(document.activeElement)) el.focus();
              }}
              // The tooltip is not decoration here — it is the label. A glyph nobody can name is
              // a worse control than the word it replaced, so every cell in this rail carries
              // both a title for the pointer and a name for assistive tech.
              title={t.label}
              aria-label={t.label}
              onClick={() => setTab(t.id)}
              className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-control transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
                active ? "bg-active text-accent" : "text-muted hover:bg-active/40 hover:text-ink"
              }`}
            >
              <t.Icon size={ICON.md} />
              {/* THE ONE BADGE IN THIS RAIL, and it is computable while the tab is locked — the
                  health route answers in counts, without elevation, so somebody is not asked for a
                  passcode to be told whether they need to care. Carries a title as well as a colour,
                  because a coloured dot alone says nothing to a screen reader. */}
              {/* Amber for anything in flight, the error tone for a stopped state. Diverged is NOT
                  amber, deliberately: it is not something working, it is something waiting for a
                  person, and wearing the running colour would make it read as progress. */}
              {t.id === "github" && githubBadge ? (
                <GithubBadge badge={githubBadge} syncing={githubBadge === "⟳"} />
              ) : null}
              {t.id === "secrets" && secretsNeedAttention ? (
                <span
                  title="A credential needs attention"
                  aria-label="A credential needs attention"
                  role="img"
                  className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-run"
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
