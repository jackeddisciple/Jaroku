// Left sidebar — the agent/run library (doc §4.1). Top: New Agent, search, and status filter
// tabs over the agent list. A flexible middle holds recent runs (how you re-open a past trace).
// Bottom-anchored: Settings and the user/plan chip. Restraint-first: rows float on the panel,
// separated by spacing and a thin accent on the active one — never boxed.

import { useState } from "react";
import { orderedRuns, useTraceStore } from "../store/traceStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import type { AgentSummary, RunSummary, RunStatus } from "../types.ts";
import { relTime } from "../lib/format.ts";
import { agentStatus, type AgentStatus } from "../lib/agentStatus.ts";
import { ProviderMark, ConnectorDot } from "../lib/icons.tsx";
import { sendLoadRun } from "../lib/socket.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { useUiStore } from "../store/uiStore.ts";
import { Chip } from "./Chip.tsx";
import { Truncate } from "./Truncate.tsx";
import { StatusDot } from "./StatusBadge.tsx";
import { EmptyState } from "./EmptyState.tsx";
import {
  ActivityIcon, ChevronRightIcon, GitForkIcon, LoaderIcon, PlusIcon, SearchIcon, SettingsIcon,
  SparklesIcon, XIcon,
} from "./panelIcons.tsx";

type Filter = "all" | "running" | "deployed" | "drafts";

// A run's outcome, in the same three marks the rest of the app uses for the same three facts.
// It was three font characters — a pulsing ●, a ✗ and a ✓ — which sat on the text baseline at
// whatever weight the row happened to be and never optically matched the icons two panels over.
function StatusGlyph({ status }: { status: RunStatus }) {
  if (status === "running") {
    return <StatusDot state="pending" icon={LoaderIcon} pulse title="running" />;
  }
  if (status === "error") return <StatusDot state="error" icon={XIcon} title="error" />;
  return <StatusDot state="ok" title="completed" />;
}

function AgentDot({ status }: { status: AgentStatus }) {
  const color = status === "running" ? "bg-run" : status === "draft" ? "bg-faint" : "bg-ok";
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${color} ${status === "running" ? "animate-stream-pulse motion-reduce:animate-none" : ""}`} />;
}

function RunRow({ run }: { run: RunSummary }) {
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const selectRun = useTraceStore((s) => s.selectRun);
  const needsLoad = useTraceStore((s) => s.needsLoad);
  const active = run.id === activeRunId;

  return (
    <button
      onClick={() => { if (needsLoad(run.id)) sendLoadRun(run.id); selectRun(run.id); }}
      className={`relative w-full text-left px-4 py-2 transition-colors ${active ? "bg-active" : "hover:bg-active/40"}`}
    >
      {active && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-ink" />}
      {/* Branches (debug depth) are indented under the run they forked from, with a fork mark. */}
      <div className={`flex items-center gap-2 ${run.parent_run_id ? "pl-3" : ""}`}>
        {run.parent_run_id && (
          <span className="shrink-0 text-faint" title="branch">
            <GitForkIcon size={ICON.xs} />
          </span>
        )}
        <StatusGlyph status={run.status} />
        <Truncate className="text-ink text-[12px]" title={run.agent_id}>{run.agent_id}</Truncate>
        <span className="ml-auto text-faint text-[11px] shrink-0">{relTime(run.started_at)}</span>
      </div>
      <div className={`mt-0.5 text-[11px] text-muted flex items-center gap-1.5 ${run.parent_run_id ? "pl-7" : "pl-4"}`}>
        {/* The same bare chip the agent row uses for the same fact, so a run and the agent it
            belongs to name their provider identically. */}
        <Chip size="sm" tone="faint" mono variant="bare">{run.provider}</Chip>
        {run.step_count != null && <><span className="text-faint">·</span><span>{run.step_count} steps</span></>}
        {run.parent_run_id != null && run.branch_from_seq != null && (
          <><span className="text-faint">·</span><span className="text-faint">branch @{run.branch_from_seq}</span></>
        )}
      </div>
    </button>
  );
}

function AgentRow({ agent }: { agent: AgentSummary }) {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const selectAgent = useBuildStore((s) => s.selectAgent);
  const runs = useTraceStore((s) => s.runs);
  const active = agent.agent_id === activeAgentId;
  const status = agentStatus(agent.agent_id, runs);

  // Newest run for this agent → last-active timestamp.
  let last: RunSummary | undefined;
  for (const r of Object.values(runs)) {
    if (r.agent_id === agent.agent_id && (!last || r.started_at > last.started_at)) last = r;
  }

  return (
    <button
      onClick={() => selectAgent(agent.agent_id)}
      className={`relative w-full text-left px-4 py-2.5 transition-colors ${active ? "bg-active" : "hover:bg-active/40"}`}
    >
      {active && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-ink" />}
      <div className="flex items-center gap-2">
        {agent.runnable ? (
          <AgentDot status={status} />
        ) : (
          <StatusDot state="error" icon={XIcon} title="missing agent.py" />
        )}
        <Truncate className="text-ink" title={agent.name}>{agent.name}</Truncate>
        {last && <span className="ml-auto text-faint text-[11px] shrink-0">{relTime(last.started_at)}</span>}
      </div>
      {/* A provider and a connector are both names of things this agent is wired to — the same
          kind of label the plan card puts on a reviewed tool. Bare rather than filled: a row of
          four filled chips under every agent would out-weigh the agent's own name above it. */}
      <div className="mt-0.5 pl-2 flex flex-wrap items-center gap-0.5">
        <Chip
          size="sm"
          tone="faint"
          mono
          variant="bare"
          icon={<ProviderMark provider={agent.default_provider} size={10} />}
        >
          {agent.default_provider}
        </Chip>
        {agent.connectors.map((c) => (
          <Chip key={c} size="sm" tone="faint" mono variant="bare" icon={<ConnectorDot id={c} />}>
            {c}
          </Chip>
        ))}
      </div>
    </button>
  );
}

export function Sidebar() {
  const runs = useTraceStore((s) => s.runs);
  const agents = useBuildStore((s) => s.agents);
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const selectAgent = useBuildStore((s) => s.selectAgent);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const counts = { running: 0, drafts: 0 };
  for (const a of agents) {
    const st = agentStatus(a.agent_id, runs);
    if (st === "running") counts.running++;
    else if (st === "draft") counts.drafts++;
  }

  const q = query.trim().toLowerCase();
  const visible = agents.filter((a) => {
    if (q && !(`${a.name} ${a.agent_id}`.toLowerCase().includes(q))) return false;
    if (filter === "all") return true;
    const st = agentStatus(a.agent_id, runs);
    if (filter === "running") return st === "running";
    if (filter === "drafts") return st === "draft";
    return false; // "deployed": no deploy backend yet — always empty
  });

  const runList = orderedRuns(runs);
  const tab = (id: Filter, label: string, count?: number) => (
    <button
      onClick={() => setFilter(id)}
      className={`text-[11px] px-2 py-1 rounded-control transition-colors ${filter === id ? "bg-active text-ink" : "text-muted hover:text-ink"}`}
    >
      {label}{count != null && count > 0 && <span className="ml-1 text-faint">{count}</span>}
    </button>
  );

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* New Agent */}
      <div className="px-3 pt-3 shrink-0">
        <button
          onClick={() => selectAgent(null)}
          className={`w-full text-left text-[13px] rounded-control px-3 py-2 transition-colors flex items-center gap-2 ${
            activeAgentId === null ? "bg-active text-ink" : "text-muted hover:bg-active/50 hover:text-ink"
          }`}
        >
          <PlusIcon size={ICON.sm} /> New Agent
        </button>
      </div>

      {/* search */}
      <div className="px-3 pt-2 shrink-0">
        <div className="flex items-center gap-2 bg-active rounded-control px-2.5 py-1.5">
          <span className="shrink-0 text-faint"><SearchIcon size={ICON.xs} /></span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents…"
            className="flex-1 min-w-0 bg-transparent text-ink placeholder:text-faint text-[12px] outline-none"
          />
          <span className="text-faint text-[11px]">⌘K</span>
        </div>
      </div>

      {/* filter tabs */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-1 shrink-0">
        {tab("all", "All")}
        {tab("running", "Running", counts.running)}
        {tab("deployed", "Deployed")}
        {tab("drafts", "Drafts", counts.drafts)}
      </div>

      {/* agent list */}
      <div className="max-h-[38%] overflow-auto shrink-0">
        {visible.length === 0 ? (
          <EmptyState
            size="inline"
            icon={agents.length === 0 ? SparklesIcon : SearchIcon}
            title={agents.length === 0 ? "No agents yet" : "Nothing here"}
            hint={
              agents.length === 0
                ? "Describe one in the composer and you’ll get a plan to approve first."
                : undefined
            }
          />
        ) : (
          visible.map((a) => <AgentRow key={a.agent_id} agent={a} />)
        )}
      </div>

      {/* runs — how you re-open a past trace */}
      <div className="mt-1 flex shrink-0 items-center border-t border-hair px-4 py-2">
        <span className={TYPE.panelLabel}>Runs</span>
        <span className="ml-auto text-faint text-[11px]">{runList.length}</span>
      </div>
      <div className="flex-1 overflow-auto">
        {runList.length === 0 ? (
          <EmptyState size="inline" icon={ActivityIcon} title="No runs yet" />
        ) : (
          runList.map((r) => <RunRow key={r.id} run={r} />)
        )}
      </div>

      {/* bottom-anchored: settings + user/plan */}
      <div className="shrink-0 space-y-1 border-t border-hair px-3 py-2.5">
        {/* Was a dead affordance. It now opens the one thing this app actually has settings for
            — the provider keys — which is also where onboarding told a user to come back to. */}
        <button
          onClick={() => useUiStore.getState().setProviderPanel(true)}
          title="Provider keys"
          className="w-full flex items-center gap-2 text-[12px] text-muted hover:text-ink transition-colors px-2 py-1.5"
        >
          <SettingsIcon size={ICON.sm} /> Settings
          <span className="ml-auto text-faint"><ChevronRightIcon size={ICON.xs} /></span>
        </button>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="w-5 h-5 rounded-control bg-active text-ink text-[11px] flex items-center justify-center">J</span>
          <span className="text-[12px] text-ink">jaroku</span>
          <Chip caps size="sm" tone="faint" className="ml-auto">Free</Chip>
        </div>
      </div>
    </div>
  );
}
