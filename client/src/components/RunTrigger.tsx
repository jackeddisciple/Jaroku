// Run bar: which agent, on which provider/model, with what input.
//
// This turns the stand-in into the second half of the loop — it now targets a *generated*
// agent (agentId) and forwards provider + model, so the same project can be run free on the
// dry-run model or against a real provider without regenerating anything.
//
// Fake is the default on purpose: the free path exercises every generated tool and costs
// nothing, so the reflex of pressing Run is never expensive.

import { useCallback, useEffect, useState } from "react";
import { useTraceStore } from "../store/traceStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { RUN_PROVIDERS, useUiStore } from "../store/uiStore.ts";
import { sendRun } from "../lib/socket.ts";

// Test-input persistence (doc §4.7.6): the fix loop means re-running 10–20 times per
// session — the last input per agent is remembered, and R re-runs it instantly.
export const inputKey = (agentId: string | null) => `jaroku.input.${agentId ?? "_"}`;

const PROVIDERS = RUN_PROVIDERS;

export function RunTrigger() {
  const [input, setInput] = useState("");
  // Provider/model live in uiStore so the command palette can run and switch provider too.
  const provider = useUiStore((s) => s.provider);
  const model = useUiStore((s) => s.model);
  const setProvider = useUiStore((s) => s.setProvider);
  const setModel = useUiStore((s) => s.setModel);
  const connected = useTraceStore((s) => s.connection === "open");
  const agents = useBuildStore((s) => s.agents);
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const selectAgent = useBuildStore((s) => s.selectAgent);

  const models = PROVIDERS.find((p) => p.id === provider)?.models ?? [];
  const agent = agents.find((a) => a.agent_id === activeAgentId);
  const canRun = connected && Boolean(activeAgentId) && (agent?.runnable ?? false);

  const onProvider = (id: string) => setProvider(id);

  // Restore the remembered input when the agent selection changes.
  useEffect(() => {
    setInput(localStorage.getItem(inputKey(activeAgentId)) ?? "");
  }, [activeAgentId]);

  const submit = useCallback(() => {
    if (!canRun) return;
    localStorage.setItem(inputKey(activeAgentId), input);
    // provider "fake" still forwards explicitly — the runner should never have to guess.
    sendRun(input.trim(), provider, model, activeAgentId ?? undefined);
  }, [canRun, input, provider, model, activeAgentId]);

  // R re-runs (doc §4.5) when focus isn't in a field — the fix loop's fastest gesture.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "r" && e.key !== "R") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      submit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submit]);

  const select =
    "bg-panel text-ink text-[12px] rounded px-2 py-2 outline-none focus:ring-1 focus:ring-[#2a2a2e] cursor-pointer";

  return (
    <div className="flex items-center gap-2 px-6 py-3 shrink-0 border-t border-hair">
      <select
        value={activeAgentId ?? ""}
        onChange={(e) => selectAgent(e.target.value || null)}
        className={select}
        title="Agent to run"
      >
        {agents.length === 0 && <option value="">no agents</option>}
        {agents.map((a) => (
          <option key={a.agent_id} value={a.agent_id}>
            {a.name}
          </option>
        ))}
      </select>

      <select value={provider} onChange={(e) => onProvider(e.target.value)} className={select} title="Provider">
        {PROVIDERS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>

      <select
        value={model}
        onChange={(e) => setModel(e.target.value)}
        disabled={provider === "fake"}
        className={`${select} disabled:opacity-40`}
        title="Model"
      >
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder="agent input — press Enter to run"
        className="flex-1 min-w-0 bg-panel text-ink placeholder:text-faint rounded px-3 py-2 outline-none focus:ring-1 focus:ring-[#2a2a2e]"
      />

      <button
        onClick={submit}
        disabled={!canRun}
        className="rounded px-4 py-2 bg-panel text-ink hover:bg-active disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Run
      </button>
    </div>
  );
}
