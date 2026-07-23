// Command palette + keyboard nav (doc §4.5, Week 5). One place for every fast action, with the
// shortcuts shown inline so they teach themselves. The global key handler also drives J/K trace
// navigation and Enter-to-expand, which work whether or not the palette is open.
//
//   Cmd+K  palette            J / K   prev / next trace step
//   Cmd+P  file switcher      Enter   expand selected step
//   Cmd+/  focus chat         R       re-run (owned by RunTrigger)

import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { orderedSteps, useTraceStore } from "../store/traceStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { RUN_PROVIDERS, useUiStore } from "../store/uiStore.ts";
import { inputKey } from "./RunTrigger.tsx";
import { sendRun } from "../lib/socket.ts";

function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/** Move the trace selection by ±1 in seq order (J/K). */
function moveStep(delta: 1 | -1): void {
  const st = useTraceStore.getState();
  if (!st.activeRunId) return;
  const steps = orderedSteps(st.stepsByRun[st.activeRunId]);
  if (steps.length === 0) return;
  const idx = steps.findIndex((s) => s.id === st.selectedStepId);
  const next = idx === -1 ? (delta === 1 ? 0 : steps.length - 1) : Math.min(steps.length - 1, Math.max(0, idx + delta));
  const target = steps[next];
  if (target) st.selectStep(target.id);
}

/** Expand (or collapse) the currently-selected step (Enter). */
function toggleExpandSelected(): void {
  const st = useTraceStore.getState();
  if (!st.selectedStepId) return;
  st.setExpandedStep(st.expandedStepId === st.selectedStepId ? null : st.selectedStepId);
}

function runActiveAgent(): void {
  const { provider, model } = useUiStore.getState();
  const agentId = useBuildStore.getState().activeAgentId;
  if (!agentId) return;
  const input = localStorage.getItem(inputKey(agentId)) ?? "";
  sendRun(input.trim(), provider, model, agentId);
}

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const setRightTab = useUiStore((s) => s.setRightTab);
  const setProvider = useUiStore((s) => s.setProvider);
  const focusChat = useUiStore((s) => s.focusChat);

  // Files for the "Jump to file" switcher come straight from the loaded project.
  const fileOrder = useBuildStore((s) => s.fileOrder);
  const openInCode = useBuildStore((s) => s.openInCode);
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId));

  const [mode, setMode] = useState<"root" | "files">("root");

  // Global shortcuts. Registered once; reads live store state so no stale closures.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMode("root");
        useUiStore.getState().setPaletteOpen(!useUiStore.getState().paletteOpen);
        return;
      }
      if (mod && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setMode("files");
        useUiStore.getState().setPaletteOpen(true);
        return;
      }
      if (mod && e.key === "/") {
        e.preventDefault();
        useUiStore.getState().focusChat();
        return;
      }
      // Non-modified keys are trace navigation — but never while typing or in the palette.
      if (useUiStore.getState().paletteOpen || isTypingTarget(e.target)) return;
      if (e.key === "j" || e.key === "J") { e.preventDefault(); moveStep(1); }
      else if (e.key === "k" || e.key === "K") { e.preventDefault(); moveStep(-1); }
      else if (e.key === "Enter") { toggleExpandSelected(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      overlayClassName="fixed inset-0 bg-black/50"
      contentClassName="relative w-[min(560px,92vw)] bg-panel rounded-lg overflow-hidden shadow-2xl"
    >
      <Command loop>
        <Command.Input
          autoFocus
          placeholder={mode === "files" ? "Jump to file…" : "Type a command or search…"}
          className="w-full bg-transparent text-ink placeholder:text-faint px-4 py-3 outline-none text-[13px] border-b border-hair"
        />
        <Command.List className="max-h-[52vh] overflow-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-muted text-[12px]">No results.</Command.Empty>

          {mode === "files" ? (
            <Command.Group heading="Files" className="mb-1">
              {fileOrder.map((path) => (
                <Item key={path} onSelect={run(() => openInCode(path))}>
                  <span className="truncate">{path}</span>
                </Item>
              ))}
            </Command.Group>
          ) : (
            <>
              <Command.Group heading="Run" className="mb-1">
                <Item onSelect={run(runActiveAgent)} disabled={!agent?.runnable} kbd="R">
                  Run {agent?.name ?? "agent"}
                </Item>
              </Command.Group>

              <Command.Group heading="Provider" className="mb-1">
                {RUN_PROVIDERS.map((p) => (
                  <Item key={p.id} onSelect={run(() => setProvider(p.id))}>
                    Switch to {p.label}
                  </Item>
                ))}
              </Command.Group>

              <Command.Group heading="View" className="mb-1">
                <Item onSelect={run(() => setRightTab("graph"))}>Open Graph</Item>
                <Item onSelect={run(() => setRightTab("trace"))}>Open Trace</Item>
                <Item onSelect={run(() => { setMode("files"); })} kbd="⌘P">Jump to file…</Item>
                <Item onSelect={run(focusChat)} kbd="⌘/">Focus chat</Item>
              </Command.Group>
            </>
          )}
        </Command.List>
      </Command>
    </Command.Dialog>
  );
}

function Item({
  children,
  onSelect,
  kbd,
  disabled,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  kbd?: string;
  disabled?: boolean;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      disabled={disabled}
      className="flex items-center justify-between gap-3 px-3 py-2 rounded text-[13px] text-muted rounded cursor-pointer data-[selected=true]:bg-active data-[selected=true]:text-ink data-[disabled=true]:opacity-40"
    >
      <span className="flex items-center gap-2 min-w-0">{children}</span>
      {kbd && <span className="text-faint text-[11px] tabular-nums shrink-0">{kbd}</span>}
    </Command.Item>
  );
}
