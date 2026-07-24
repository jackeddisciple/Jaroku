// The center pane — the doc §4.1 conversation flow. One scrolling thread per agent:
// your message → Jaroku's response → inline diff cards, with a fixed prompt box at the
// bottom. The same box builds and fixes: no agent selected → generate a new one; agent
// selected → propose an edit to it (the fix loop). Generation becomes the first turn of
// the new agent's conversation.
//
// Connector selection stays explicit UI rather than something the model infers from the
// prompt: the reviewed templates are copied in verbatim, so which ones are included is a
// decision the user makes, not a guess the generation re-rolls each time.

import { useCallback, useEffect, useRef, useState } from "react";
import { orderedFiles, useBuildStore } from "../store/buildStore.ts";
import { threadFor, useChatStore, type ChatTurn, type GenTurn, type ReplyTurn } from "../store/chatStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { inputKey, RUN_PROVIDERS, useUiStore } from "../store/uiStore.ts";
import { sendBranchRun, sendEdit, sendExplain, sendGenerate, sendRun } from "../lib/socket.ts";
import { classifyIntent, fixPrompt, routeLabel } from "../lib/intent.ts";
import { DiffCard } from "./DiffCard.tsx";
import { ArrowUpIcon, ChevronDownIcon, MicIcon } from "./composerIcons.tsx";
import { useVoiceInput } from "../lib/useVoiceInput.ts";
import { VoiceWaveform } from "./VoiceWaveform.tsx";

// Mirrors runtime/tool_templates/catalog.json. The server validates the ids it receives
// against the catalog, so a stale entry here can never inject an unreviewed connector.
const CONNECTORS = [
  { id: "gmail", label: "Gmail", hint: "search mail, draft replies" },
  { id: "slack", label: "Slack", hint: "read channels, post messages" },
  { id: "postgres", label: "Postgres", hint: "read-only SQL" },
];

function GenTurnView({ turn, isLive }: { turn: GenTurn; isLive: boolean }) {
  const files = useBuildStore((s) => s.files);
  const fileOrder = useBuildStore((s) => s.fileOrder);
  const streamingFile = useBuildStore((s) => s.streamingFile);

  if (turn.status === "error") {
    return (
      <div className="text-[12px]">
        <div className="text-err">Generation failed — {turn.error}</div>
        {turn.problems && turn.problems.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-muted">
            {turn.problems.map((p, i) => (
              <li key={i} className="pl-3">· {p}</li>
            ))}
          </ul>
        )}
        <div className="mt-1.5 text-faint">Nothing was written — any previous agent is untouched.</div>
      </div>
    );
  }

  if (turn.status === "generating" && isLive) {
    const list = orderedFiles({ files, fileOrder });
    return (
      <div className="text-[12px]">
        <div className="text-run">Generating…</div>
        <div className="mt-1 space-y-0.5">
          {list.map((f) => (
            <div key={f.path} className="flex items-center gap-2 animate-slide-in">
              <span className={f.complete ? "text-ok" : "text-run animate-pulse"}>
                {f.complete ? "✓" : "●"}
              </span>
              <span className="text-muted truncate">{f.path}</span>
              <span className="ml-auto text-faint text-[11px] tabular-nums">
                {f.path === streamingFile ? "writing…" : `${f.content.length} B`}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Finished (or a generation from earlier in the session).
  return (
    <div className="text-[12px]">
      <span className="text-ok">Generated</span>{" "}
      <span className="text-muted">
        {turn.files.length} files
        {turn.usage && (
          <>
            {" · "}
            {turn.usage.output_tokens.toLocaleString()} output tokens · $
            {turn.usage.cost_usd.toFixed(4)}
            {turn.usage.cache_read_input_tokens > 0 && <span className="text-faint"> · cache hit</span>}
          </>
        )}
      </span>
    </div>
  );
}

// "explain" answer — streaming prose with a caret while live (doc §4.3: everything streams).
function ReplyTurnView({ turn }: { turn: ReplyTurn }) {
  return (
    <div className={`text-[13px] whitespace-pre-wrap break-words leading-relaxed ${turn.status === "error" ? "text-err" : "text-ink"}`}>
      {turn.text}
      {turn.status === "streaming" && <span className="text-faint animate-pulse">▋</span>}
    </div>
  );
}

function Turn({ turn, isLastGen }: { turn: ChatTurn; isLastGen: boolean }) {
  if (turn.role === "user") {
    return (
      <div className="flex gap-2">
        <span className="text-faint select-none">›</span>
        <span className="text-ink text-[13px] whitespace-pre-wrap break-words min-w-0">{turn.text}</span>
      </div>
    );
  }
  if (turn.kind === "gen") return <div className="pl-4"><GenTurnView turn={turn} isLive={isLastGen} /></div>;
  if (turn.kind === "proposal") return <div className="pl-4"><DiffCard turn={turn} /></div>;
  if (turn.kind === "reply") return <div className="pl-4"><ReplyTurnView turn={turn} /></div>;
  return (
    <div className={`pl-4 text-[12px] ${turn.tone === "error" ? "text-err" : "text-faint"}`}>
      {turn.text}
    </div>
  );
}

// Bare model-selector: just a label + chevron, opening a small popover of RUN_PROVIDERS → models.
// It sets the run provider/model (Test mode / the palette); no border or background of its own.
function ModelSelector({
  provider,
  model,
  setProvider,
  setModel,
}: {
  provider: string;
  model: string;
  setProvider: (id: string) => void;
  setModel: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = provider === "fake" ? "Dry run (free)" : model;
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Run model"
        className="flex items-center gap-1 text-[12px] text-muted hover:text-ink transition-colors"
      >
        {label}
        <ChevronDownIcon size={13} />
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 left-0 z-30 min-w-[190px] rounded-lg bg-panel border border-[#2a2a30] shadow-2xl py-1">
          {RUN_PROVIDERS.map((p) => (
            <div key={p.id}>
              <div className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-faint">{p.label}</div>
              {p.models.map((m) => {
                const active = provider === p.id && model === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setProvider(p.id); // resets model to the provider's default…
                      setModel(m); // …then pin the chosen one
                      setOpen(false);
                    }}
                    className={`w-full text-left px-3 py-1 text-[12px] transition-colors ${
                      active ? "text-ink bg-active" : "text-muted hover:text-ink hover:bg-active/40"
                    }`}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function BuildPane() {
  // One composer, two send modes. Each mode keeps its OWN draft so toggling never clobbers text
  // (a half-typed chat message can't be sent as agent input, and vice-versa). `text`/`setText`
  // are the active mode's draft, so the rest of the component is unchanged.
  const composerMode = useUiStore((s) => s.composerMode);
  const setComposerMode = useUiStore((s) => s.setComposerMode);
  const [chatDraft, setChatDraft] = useState("");
  const [testDraft, setTestDraft] = useState("");
  const text = composerMode === "test" ? testDraft : chatDraft;
  const setText = composerMode === "test" ? setTestDraft : setChatDraft;

  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const focusChatNonce = useUiStore((s) => s.focusChatNonce);
  const chatPrefillNonce = useUiStore((s) => s.chatPrefillNonce);

  // Run config (Test mode) — lives in uiStore so the palette shares it.
  const provider = useUiStore((s) => s.provider);
  const model = useUiStore((s) => s.model);
  const setProvider = useUiStore((s) => s.setProvider);
  const setModel = useUiStore((s) => s.setModel);

  // Cmd+/ (and the palette) focus the composer.
  useEffect(() => {
    if (focusChatNonce > 0) composerRef.current?.focus();
  }, [focusChatNonce]);

  // One-Click Fix pre-fills the composer (Chat mode), then focuses it so the user reviews and sends.
  useEffect(() => {
    if (chatPrefillNonce > 0) {
      setComposerMode("chat");
      setChatDraft(useUiStore.getState().chatPrefill);
      composerRef.current?.focus();
    }
  }, [chatPrefillNonce, setComposerMode]);

  const connected = useTraceStore((s) => s.connection === "open");
  const genStatus = useBuildStore((s) => s.status);
  const agents = useBuildStore((s) => s.agents);
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const threads = useChatStore((s) => s.threads);
  const pendingThread = useChatStore((s) => s.pending);
  const streamingAgentId = useChatStore((s) => s.streamingAgentId);

  const agent = agents.find((a) => a.agent_id === activeAgentId);
  const mode: "generate" | "edit" = activeAgentId ? "edit" : "generate";
  const busy = genStatus === "generating" || streamingAgentId !== null;
  const turns = threadFor({ threads, pending: pendingThread }, activeAgentId);

  // Unified-composer context: what the user last selected. A graph node takes precedence for
  // "explain"; otherwise the selected trace step is the context.
  const selectedNodeId = useUiStore((s) => s.selectedNodeId);
  const selectedStepId = useTraceStore((s) => s.selectedStepId);
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const selectedStep = useTraceStore((s) =>
    selectedStepId && activeRunId ? s.stepsByRun[activeRunId]?.[selectedStepId] : undefined,
  );
  const clearContext = () => {
    useTraceStore.getState().selectStep(null);
    useUiStore.getState().setSelectedNodeId(null);
  };

  // Route the CURRENT text by (intent + context) — recomputed live so the composer can show where
  // ⌘↵ will send it. Pure heuristics; no per-keystroke network/LLM cost.
  const intent = classifyIntent(text, { agentId: activeAgentId, step: selectedStep, nodeId: selectedNodeId });
  const contextLabel = selectedNodeId
    ? `node: ${selectedNodeId}`
    : selectedStep
      ? `step #${selectedStep.seq} · ${selectedStep.type}${selectedStep.error ? " · error" : ""}`
      : null;

  // Keep the newest turn in view — the conversation scrolls up like a terminal.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, genStatus]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // --- Test mode (runs) + voice, folded in from the old run-bar ------------------
  const canRun = connected && Boolean(activeAgentId) && (agent?.runnable ?? false);

  // Restore the remembered test input when the agent changes (the persisted last-test-input).
  useEffect(() => {
    setTestDraft(localStorage.getItem(inputKey(activeAgentId)) ?? "");
  }, [activeAgentId]);

  // R re-runs the last test input (doc §4.5) when focus isn't in a field — reads localStorage, so
  // it's independent of the composer's live draft and works from any mode.
  const rerunLast = useCallback(() => {
    if (!canRun) return;
    const last = localStorage.getItem(inputKey(activeAgentId)) ?? "";
    sendRun(last.trim(), provider, model, activeAgentId ?? undefined);
  }, [canRun, activeAgentId, provider, model]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "r" && e.key !== "R") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      rerunLast();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rerunLast]);

  // Voice input → append the transcript at the caret of the active draft (never wipes typed text).
  // While recording, the input slot shows a live waveform + a caption preview of the transcript;
  // `recordHeight` pins that view to the textarea's height at record-start so nothing jumps.
  const [liveTranscript, setLiveTranscript] = useState("");
  const [recordHeight, setRecordHeight] = useState(48);
  const voiceBase = useRef<{ base: string; caret: number }>({ base: "", caret: 0 });
  const voice = useVoiceInput({
    onStart: () => {
      const el = composerRef.current;
      voiceBase.current = { base: text, caret: el?.selectionStart ?? text.length };
      setRecordHeight(el?.offsetHeight ?? 48);
      setLiveTranscript("");
    },
    onTranscript: (t) => {
      const { base, caret } = voiceBase.current;
      setText(base.slice(0, caret) + t + base.slice(caret));
      setLiveTranscript(t);
    },
  });
  const showWave = voice.listening && voice.hasAnalyser;

  // Auto-grow the textarea with content (min ~2 lines; generous cap then scroll — never clips).
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // One dispatch point: route the message by (selection context + intent) into the EXISTING
  // mechanisms. Only "explain" is a new path; edit/fix reuse sendEdit, rerun reuses branchRun.
  const submit = () => {
    const trimmed = text.trim();
    if (!connected || !trimmed) return;

    // Test mode: the text is the agent's runtime input (a Run), NOT an instruction to Jaroku.
    // Persist it as the last-test-input (what R re-run / eval promotion read) and keep the draft.
    if (composerMode === "test") {
      if (!canRun) return;
      localStorage.setItem(inputKey(activeAgentId), testDraft);
      sendRun(trimmed, provider, model, activeAgentId ?? undefined);
      return;
    }

    // Chat mode: talk to Jaroku — route by intent + context.
    if (busy) return;
    switch (intent.kind) {
      case "generate":
        sendGenerate(trimmed, selected, name.trim() || undefined);
        break;
      case "edit":
        if (activeAgentId) sendEdit(activeAgentId, trimmed);
        break;
      case "fix":
        // The old One-Click Fix, now reached by typing "fix this" with a failed step selected.
        if (activeAgentId) sendEdit(activeAgentId, `${fixPrompt(intent.step)}\n\nAlso from the developer: ${trimmed}`);
        break;
      case "rerun":
        sendBranchRun(intent.step.run_id, intent.step.seq);
        break;
      case "explain": {
        if (!activeAgentId) break;
        const s = intent.subject;
        sendExplain(
          activeAgentId,
          trimmed,
          s.kind === "step"
            ? { kind: "step", step: { name: s.step.name, type: s.step.type, seq: s.step.seq, error: s.step.error, input: s.step.input, output: s.step.output } }
            : s,
        );
        break;
      }
    }
    setChatDraft("");
  };

  const lastGenId = [...turns].reverse().find((t) => t.role === "jaroku" && t.kind === "gen")?.id;

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="px-6 pt-4 pb-2 shrink-0 flex items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-widest text-faint">
          {mode === "generate" ? "New agent" : "Fix"}
        </span>
        {agent && <span className="text-[12px] text-muted truncate">{agent.name}</span>}
      </div>

      {/* conversation */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-6 py-2 space-y-4">
        {turns.length === 0 && (
          <div className="text-[12px] text-muted pt-4">
            {mode === "generate" ? (
              <>Describe the agent you want and it will be generated as a real LangGraph project.</>
            ) : (
              <>
                Describe a change to this agent — e.g. “add Redis conversation memory” or
                “the SQL tool needs a LIMIT clause”. You’ll get a reviewable diff to apply or
                discard; nothing is changed until you apply it.
              </>
            )}
          </div>
        )}
        {turns.map((t) => (
          <Turn key={t.id} turn={t} isLastGen={t.id === lastGenId} />
        ))}
      </div>

      {/* composer — ONE input; the Chat/Test toggle folds in what used to be the run-bar */}
      <div className="px-6 pb-4 pt-2 shrink-0">
        {/* connectors + name — new-agent generation only (Chat mode, no agent selected) */}
        {composerMode === "chat" && mode === "generate" && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-faint mr-1">Connectors</span>
            {CONNECTORS.map((c) => {
              const on = selected.includes(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => toggle(c.id)}
                  disabled={busy}
                  title={c.hint}
                  className={`rounded px-2.5 py-1 text-[12px] transition-colors disabled:opacity-50 ${
                    on ? "bg-active text-ink" : "bg-panel text-muted hover:text-ink"
                  }`}
                >
                  {on ? "✓ " : ""}
                  {c.label}
                </button>
              );
            })}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              placeholder="name (optional)"
              className="ml-auto w-40 bg-panel text-ink placeholder:text-faint rounded px-2.5 py-1 text-[12px] outline-none focus:ring-1 focus:ring-[#2a2a2e] disabled:opacity-50"
            />
          </div>
        )}

        {/* context chip + live routing hint (Chat mode) — so the one composer stays transparent */}
        {composerMode === "chat" && (contextLabel || (text.trim() && activeAgentId)) && (
          <div className="mb-2 flex items-center gap-2 text-[11px]">
            {contextLabel && (
              <span className="inline-flex items-center gap-1 bg-active rounded px-2 py-0.5 text-muted">
                <span className="text-faint">▸</span>
                {contextLabel}
                <button onClick={clearContext} className="text-faint hover:text-ink ml-0.5" title="Clear context">
                  ×
                </button>
              </span>
            )}
            {text.trim() && <span className="text-faint ml-auto">⌘↵ will {routeLabel(intent)}</span>}
          </div>
        )}

        {/* the card — textarea sits directly in it; only the toggle + send read as solid elements */}
        <div className="rounded-2xl bg-panel border border-[#2a2a30]" style={{ padding: "14px 16px 12px" }}>
          {/* input slot: the textarea and the live waveform crossfade in place (~200ms) so the
              transition from typing to recording is smooth and the card doesn't jump. */}
          <div className="relative" style={{ height: showWave ? recordHeight : undefined }}>
            <textarea
              ref={composerRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={2}
              placeholder={
                composerMode === "test"
                  ? `Run ${agent?.name ?? "the agent"} on… — ⌘↵ to run`
                  : mode === "generate"
                    ? "Describe the agent you want — e.g. “a support agent that reads Gmail, looks up orders in Postgres, and drafts replies”"
                    : contextLabel
                      ? "Ask about or act on the selection — e.g. “why did this fail?”, “fix this”, “re-run from here”"
                      : `Describe a change to ${agent?.name ?? "this agent"} — ⌘↵ to send`
              }
              className="w-full resize-none bg-transparent text-ink placeholder:text-muted outline-none leading-[1.5] transition-opacity duration-200"
              style={{
                fontSize: "14.5px",
                minHeight: "44px",
                maxHeight: "200px",
                overflowY: "auto",
                opacity: showWave ? 0 : 1,
                pointerEvents: showWave ? "none" : "auto",
                position: showWave ? "absolute" : "relative",
                inset: showWave ? 0 : undefined,
              }}
            />
            <div
              className="absolute inset-0 transition-opacity duration-200"
              style={{ opacity: showWave ? 1 : 0, pointerEvents: "none" }}
              aria-hidden={!showWave}
            >
              <VoiceWaveform
                analyserRef={voice.analyserRef}
                active={showWave}
                transcript={liveTranscript}
                height={recordHeight}
              />
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between">
            {/* left — bare mic + model selector, no boxes */}
            <div className="flex items-center gap-3.5">
              <button
                type="button"
                onClick={voice.toggle}
                disabled={!voice.supported}
                title={
                  voice.supported
                    ? voice.listening
                      ? "Stop voice input"
                      : "Voice input"
                    : "Voice input isn't supported in this browser"
                }
                className={`transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                  voice.listening ? "text-run animate-pulse" : "text-muted hover:text-ink"
                }`}
              >
                <MicIcon size={17} />
              </button>
              <ModelSelector provider={provider} model={model} setProvider={setProvider} setModel={setModel} />
            </div>

            {/* right — the only two solid elements: mode toggle + send circle */}
            <div className="flex items-center gap-2.5">
              <div className="flex items-center rounded-[20px] bg-active p-0.5">
                {(["chat", "test"] as const).map((m) => {
                  const active = composerMode === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setComposerMode(m)}
                      className={`rounded-[16px] text-[12px] transition-colors ${active ? "" : "text-muted hover:text-ink"}`}
                      style={{ padding: "5px 11px", background: active ? "#e4e4e7" : "transparent", color: active ? "#0d0d0f" : undefined }}
                    >
                      {m === "chat" ? "Chat" : "Test"}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={submit}
                disabled={!connected || !text.trim() || (composerMode === "test" ? !canRun : busy)}
                title={composerMode === "test" ? "Run the agent on this input" : "Send"}
                className="flex items-center justify-center rounded-full transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ width: 30, height: 30, background: "#e4e4e7", color: "#0d0d0f" }}
              >
                <ArrowUpIcon size={15} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
