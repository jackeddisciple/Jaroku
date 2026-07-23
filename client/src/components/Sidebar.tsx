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

type Filter = "all" | "running" | "deployed" | "drafts";

function StatusGlyph({ status }: { status: RunStatus }) {
  if (status === "running") return <span className="text-run animate-pulse" title="running">●</span>;
  if (status === "error") return <span className="text-err" title="error">✗</span>;
  return <span className="text-ok" title="completed">✓</span>;
}

function AgentDot({ status }: { status: AgentStatus }) {
  const color = status === "running" ? "bg-run" : status === "draft" ? "bg-faint" : "bg-ok";
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${color} ${status === "running" ? "animate-pulse" : ""}`} />;
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
      <div className="flex items-center gap-2">
        <StatusGlyph status={run.status} />
        <span className="text-ink truncate text-[12px]">{run.agent_id}</span>
        <span className="ml-auto text-faint text-[11px] shrink-0">{relTime(run.started_at)}</span>
      </div>
      <div className="mt-0.5 pl-5 text-[11px] text-muted flex items-center gap-1.5">
        <span className="text-faint">{run.provider}</span>
        {run.step_count != null && <><span className="text-faint">·</span><span>{run.step_count} steps</span></>}
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
        {agent.runnable ? <AgentDot status={status} /> : <span className="text-err" title="missing agent.py">✗</span>}
        <span className="text-ink truncate">{agent.name}</span>
        {last && <span className="ml-auto text-faint text-[11px] shrink-0">{relTime(last.started_at)}</span>}
      </div>
      <div className="mt-0.5 pl-3.5 text-[11px] text-muted flex items-center gap-1.5">
        <ProviderMark provider={agent.default_provider} size={11} />
        <span className="text-faint">{agent.default_provider}</span>
        {agent.connectors.map((c) => (
          <span key={c} className="flex items-center gap-1"><ConnectorDot id={c} /><span className="text-faint">{c}</span></span>
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
      className={`text-[11px] px-2 py-1 rounded transition-colors ${filter === id ? "bg-active text-ink" : "text-muted hover:text-ink"}`}
    >
      {label}{count != null && count > 0 && <span className="ml-1 text-faint">{count}</span>}
    </button>
  );

  return (
    <div className="flex h-full flex-col bg-panel">
      {/* New Agent */}
      <div className="px-3 pt-3 shrink-0">
        <button
          onClick={() => selectAgent(null)}
          className={`w-full text-left text-[13px] rounded px-3 py-2 transition-colors flex items-center gap-2 ${
            activeAgentId === null ? "bg-active text-ink" : "text-muted hover:bg-active/50 hover:text-ink"
          }`}
        >
          <span className="text-[15px] leading-none">+</span> New Agent
        </button>
      </div>

      {/* search */}
      <div className="px-3 pt-2 shrink-0">
        <div className="flex items-center gap-2 bg-active rounded px-2.5 py-1.5">
          <span className="text-faint text-[12px]">⌕</span>
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
          <div className="px-4 py-4 text-muted text-[12px]">
            {agents.length === 0 ? "No agents yet — describe one to get started." : "Nothing here."}
          </div>
        ) : (
          visible.map((a) => <AgentRow key={a.agent_id} agent={a} />)
        )}
      </div>

      {/* runs — how you re-open a past trace */}
      <div className="px-4 py-2 shrink-0 flex items-center">
        <span className="text-[11px] uppercase tracking-widest text-faint">Runs</span>
        <span className="ml-auto text-faint text-[11px]">{runList.length}</span>
      </div>
      <div className="flex-1 overflow-auto">
        {runList.length === 0 ? (
          <div className="px-4 py-4 text-muted text-[12px]">No runs yet.</div>
        ) : (
          runList.map((r) => <RunRow key={r.id} run={r} />)
        )}
      </div>

      {/* bottom-anchored: settings + user/plan */}
      <div className="shrink-0 px-3 py-2.5 space-y-1">
        <button className="w-full flex items-center gap-2 text-[12px] text-muted hover:text-ink transition-colors px-2 py-1.5">
          <span className="text-[13px]">⚙</span> Settings <span className="ml-auto text-faint">›</span>
        </button>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="w-5 h-5 rounded bg-active text-ink text-[11px] flex items-center justify-center">J</span>
          <span className="text-[12px] text-ink">jaroku</span>
          <span className="ml-auto text-[10px] text-faint bg-active rounded px-1.5 py-0.5">Free</span>
        </div>
      </div>
    </div>
  );
}
