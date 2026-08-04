// The center pane — the doc §4.1 conversation flow. One scrolling thread per agent:
// your message → Jaroku's response → inline diff cards, with a fixed prompt box at the
// bottom. The same box builds and fixes: no agent selected → generate a new one; agent
// selected → propose an edit to it (the fix loop). Generation becomes the first turn of
// the new agent's conversation.
//
// Connector selection stays explicit UI rather than something the model infers from the
// prompt: the reviewed templates are copied in verbatim, so which ones are included is a
// decision the user makes, not a guess the generation re-rolls each time.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { orderedFiles, useBuildStore } from "../store/buildStore.ts";
import {
  isPlanning, pendingPlanId, threadFor, useChatStore,
  type ChatTurn, type GenTurn, type ReplyTurn,
} from "../store/chatStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { inputKey, RUN_PROVIDERS, useUiStore } from "../store/uiStore.ts";
import { sendBranchRun, sendEdit, sendExplain, sendPlanAgent, sendPromoteTestInput, sendRun } from "../lib/socket.ts";
import { useEvalStore } from "../store/evalStore.ts";
import { classifyIntent, fixPrompt, routeLabel } from "../lib/intent.ts";
import { Chip } from "./Chip.tsx";
import { DiffCard } from "./DiffCard.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Prose } from "./InlineCode.tsx";
import { StreamingFileRow } from "./FileList.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { ArrowUpIcon, ChevronDownIcon, MicIcon, SaveToDatasetIcon } from "./composerIcons.tsx";
import { StatusDot } from "./StatusBadge.tsx";
import { StatRow, STAT_ICON, type Stat } from "./StatRow.tsx";
import {
  ChevronRightIcon, DollarSignIcon, FileIcon, HashIcon, PlugIcon, SparklesIcon, UserCircleIcon,
  WrenchIcon, XIcon, ZapIcon,
} from "./panelIcons.tsx";
import { useMcpStore, allMcpTools } from "../store/mcpStore.ts";
import { ACCENT, ICON, STATUS } from "../lib/tokens.ts";
import { displayTitle, fullTitle } from "../lib/title.ts";
import { useStreamedText } from "../lib/useStreamedText.ts";
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
          <ul className="mt-2 space-y-1 text-muted">
            {turn.problems.map((p, i) => (
              <li key={i} className="pl-3">· <Prose text={p} /></li>
            ))}
          </ul>
        )}
        <div className="mt-2 text-faint">Nothing was written — any previous agent is untouched.</div>
      </div>
    );
  }

  if (turn.status === "generating" && isLive) {
    const list = orderedFiles({ files, fileOrder });
    return (
      <div className="text-[12px]">
        <div className="text-run">Generating…</div>
        <div className="mt-2 space-y-0.5">
          {list.map((f) => (
            <StreamingFileRow
              key={f.path}
              path={f.path}
              // Three states, not two. A file that has arrived but is not the one streaming used
              // to look identical to the one being written this second.
              state={f.complete ? "done" : f.path === streamingFile ? "active" : "pending"}
              bytes={f.content.length}
            />
          ))}
        </div>
      </div>
    );
  }

  // Finished (or a generation from earlier in the session). The plan is part of what this
  // agent cost, so it's shown as its own term rather than folded in silently — the gate has to
  // be able to justify its own price.
  const planCost = turn.planUsage?.cost_usd ?? 0;
  const stats: Stat[] = [
    {
      icon: <FileIcon size={STAT_ICON} />,
      value: String(turn.files.length),
      label: turn.files.length === 1 ? "file" : "files",
    },
  ];
  if (turn.usage) {
    stats.push({
      icon: <HashIcon size={STAT_ICON} />,
      value: turn.usage.output_tokens.toLocaleString(),
      label: "output tokens",
    });
    // The cost shown is the total the user actually paid — planning included. Leading with the
    // generation's own figure and appending the plan as a correction made the honest number the
    // hardest one to read.
    stats.push({
      icon: <DollarSignIcon size={STAT_ICON} />,
      value: (turn.usage.cost_usd + planCost).toFixed(4),
      title:
        planCost > 0
          ? `$${turn.usage.cost_usd.toFixed(4)} to generate + $${planCost.toFixed(4)} to plan`
          : undefined,
    });
    if (turn.usage.cache_read_input_tokens > 0) {
      stats.push({
        icon: <ZapIcon size={STAT_ICON} />,
        value: turn.usage.cache_read_input_tokens.toLocaleString(),
        label: "cached",
        title: "Prompt prefix was reused — these input tokens were not charged at full rate",
        dim: true,
      });
    }
  }
  return (
    <StatRow leading={<span className="text-ok text-[12px]">Generated</span>} stats={stats} />
  );
}

// "explain" answer — streaming prose with a caret while live (doc §4.3: everything streams).
//
// The one prose slot in the panel that was never tokenized, and the one where it mattered most: an
// explanation is *about* named things, and the model writes them in backticks. Untouched, those
// backticks reached the screen as literal characters — so a reply reading "the `gmail_search` tool
// needs `GMAIL_CLIENT_ID`" sat directly below a diff-card summary where the same kind of name was a
// proper chip. Two Jaroku answers in one thread, two different typographic languages.
function ReplyTurnView({ turn }: { turn: ReplyTurn }) {
  // The store has the whole answer as of this frame; this is how much of it is painted. See
  // lib/useStreamedText.ts — an explanation arrives from the model in clause-sized chunks, and
  // without this the caret sits still for a second and then a paragraph appears at once.
  const text = useStreamedText(turn.text, turn.status === "streaming");
  return (
    <div className={`text-[13px] whitespace-pre-wrap break-words ${turn.status === "error" ? "text-err" : "text-ink"}`}>
      <Prose text={text} />
      {turn.status === "streaming" && <span className="text-faint animate-pulse">▋</span>}
    </div>
  );
}

/**
 * One turn, with its speaker in the gutter.
 *
 * A fix loop is a conversation, and a long one is where this mattered: five change requests and
 * five answers, told apart by a leading `›` on one and four pixels of indent on the other. Scanning
 * back for "what did I ask for" meant re-reading the messages themselves, because nothing about
 * their shape said who was talking.
 *
 * Both roles now sit on the same fixed gutter — one column, one mark per row, everything after it
 * aligned. That alignment is most of the win: a marker that shifts position between turns is a
 * thing to read rather than a thing to skim past.
 */
function TurnRow({ marker, children }: { marker?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      {/* Fixed width whether or not there is a mark, so the two roles never sit on different
          left edges. Nudged down to the cap height of the first line rather than its box. */}
      <span className="w-[18px] shrink-0 flex justify-center pt-[2px]" aria-hidden>
        {marker}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * Jaroku's mark.
 *
 * There is no Jaroku glyph anywhere in the app — only the wordmark in the top bar — so rather than
 * invent one, this reuses the sparkle the plan card already uses for bespoke tools. In that card it
 * means "a model wrote this", which is exactly what it means here; the panel gets a second use of
 * one idea instead of a second idea.
 *
 * Grey in a filled ring, not violet. Violet is the bespoke-tool accent and lives inside the card;
 * this sits outside it, saying who is speaking rather than what kind of thing something is. The
 * ring is what gives it the visual mass to answer a 14px face across the gutter — a bare sparkle
 * at that size reads as a speck.
 */
function JarokuMark() {
  return (
    <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-active text-muted">
      <SparklesIcon size={10} />
    </span>
  );
}

function Turn({ turn, isLastGen }: { turn: ChatTurn; isLastGen: boolean }) {
  if (turn.role === "user") {
    return (
      // The `›` it replaces was a prompt character — it said "input", not "you". At the top of a
      // scrolled-back thread, the question is whose turn this was, and a face answers that faster
      // than punctuation does.
      <TurnRow marker={<UserCircleIcon size={ICON.sm} className="text-faint" />}>
        <span className="text-ink text-[13px] whitespace-pre-wrap break-words">{turn.text}</span>
      </TurnRow>
    );
  }
  if (turn.kind === "plan") return <TurnRow marker={<JarokuMark />}><PlanCard turn={turn} /></TurnRow>;
  if (turn.kind === "gen") return <TurnRow marker={<JarokuMark />}><GenTurnView turn={turn} isLive={isLastGen} /></TurnRow>;
  if (turn.kind === "proposal") return <TurnRow marker={<JarokuMark />}><DiffCard turn={turn} /></TurnRow>;
  if (turn.kind === "reply") return <TurnRow marker={<JarokuMark />}><ReplyTurnView turn={turn} /></TurnRow>;
  // Info notes are the app narrating itself ("connectors changed"), not Jaroku answering — no
  // mark, so the gutter stays a record of who spoke.
  return (
    <TurnRow>
      <div className={`text-[12px] ${turn.tone === "error" ? "text-err" : "text-faint"}`}>
        {turn.text}
      </div>
    </TurnRow>
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
        {/* "Dry run (free)" is prose; a model id is an identifier. Only the latter gets mono. */}
        <span className={provider === "fake" ? undefined : "font-mono"}>{label}</span>
        <ChevronDownIcon size={13} />
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 left-0 z-30 min-w-[190px] rounded-card bg-panel border border-edge shadow-floating py-1">
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
                    className={`w-full text-left px-3 py-1 font-mono text-[12px] transition-colors ${
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
  // MCP tools are selected per TOOL, not per server. Connecting a server makes its tools
  // available to choose from; it grants an agent nothing on its own.
  const [selectedMcp, setSelectedMcp] = useState<string[]>([]);
  const [mcpOpen, setMcpOpen] = useState(false);
  const mcpServers = useMcpStore((s) => s.servers);
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
  // A plan on screen awaiting a decision. It routes a typed message to a revision and, when
  // the connector selection changes, is what gets invalidated.
  const planId = pendingPlanId({ pending: pendingThread });
  const busy = genStatus === "generating" || streamingAgentId !== null || isPlanning({ pending: pendingThread });
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
  const intent = classifyIntent(text, {
    agentId: activeAgentId, pendingPlanId: planId, step: selectedStep, nodeId: selectedNodeId,
  });
  const contextLabel = selectedNodeId
    ? `node: ${selectedNodeId}`
    : selectedStep
      ? `step #${selectedStep.seq} · ${selectedStep.type}${selectedStep.error ? " · error" : ""}`
      : null;

  // How many files generation has started writing. Subscribed to purely so the scroll effect
  // below has something that changes while they stream — see there for why.
  const genFileCount = useBuildStore((s) => s.fileOrder.length);

  // Keep the newest turn in view — the conversation scrolls up like a terminal.
  //
  // `genFileCount` is in the deps because generation is the one thing that grows the thread
  // without changing a turn. Files stream into buildStore, GenTurnView re-renders on its own, and
  // BuildPane — which owns the scroll container — never hears about it. So the list grew downward
  // past the fold: you watched the first file land and then nothing, until generation finished and
  // the turn changed, at which point the view jumped to a finished list you never saw appear.
  // Everything streams (doc §4.3) is only true if you can see it stream.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, genStatus, genFileCount]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const mcpTools = useMemo(() => allMcpTools(mcpServers), [mcpServers]);
  const toggleMcp = (ref: string) =>
    setSelectedMcp((s) => (s.includes(ref) ? s.filter((x) => x !== ref) : [...s, ref]));

  // A plan describes the connectors that were ticked when it was written. Change them and it
  // no longer describes what would be built, so it loses its Generate button.
  //
  // Deliberately NOT sent to the server as a discard, which is what a stale cost estimate
  // gets. The record holds the original brief, and a revision re-plans that brief against the
  // CURRENT selection — so keeping it means ticking Postgres and saying "use it for the
  // lookup" continues the conversation instead of making the user retype what they wanted.
  //
  // Staleness is a comparison against the selection the plan was written with, not a latch on
  // "something changed". Latching meant putting a mis-clicked connector back left the plan stale
  // anyway, with no way out but paying for another plan — the fix for a mis-click cost the same as
  // the mistake. `plannedConnectors` is set when a plan is requested, so the answer is always
  // whether the two selections match right now.
  // The MCP selection belongs in this key for exactly the reason the connectors do: a plan
  // written against three external tools does not describe a build with a fourth in it.
  const connectorKey = `${selected.join(",")}|${[...selectedMcp].sort().join(",")}`;
  const plannedConnectors = useRef<string | null>(null);
  const planStale = useChatStore((s) => s.planStale);
  useEffect(() => {
    if (plannedConnectors.current === null) return;
    planStale(connectorKey !== plannedConnectors.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectorKey]);

  // --- Test mode (runs) + voice, folded in from the old run-bar ------------------
  const canRun = connected && Boolean(activeAgentId) && (agent?.runnable ?? false);

  // Promote the current test input into the eval dataset (doc §4.7.6, "one click"). The
  // draft is the subject when there is one, otherwise the remembered last input — so this
  // works both before running and right after, which is when a case proves worth keeping.
  // The server picks/creates the dataset, so this stays a single round trip.
  const promoted = useEvalStore((s) => s.promoted);
  const clearPromoted = useEvalStore((s) => s.clearPromoted);
  const promotable = (testDraft.trim() || (localStorage.getItem(inputKey(activeAgentId)) ?? "").trim());
  const promote = () => {
    if (!activeAgentId || !promotable) return;
    sendPromoteTestInput(activeAgentId, promotable, agent?.name);
  };
  // The confirmation is a transient acknowledgement, not state — clear it after a beat.
  useEffect(() => {
    if (!promoted) return;
    const t = setTimeout(clearPromoted, 2600);
    return () => clearTimeout(t);
  }, [promoted, clearPromoted]);

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
        // Never straight to generation: the plan gate is the only way in, so nothing gets
        // built that the user hasn't seen described first.
        plannedConnectors.current = connectorKey;
        sendPlanAgent(trimmed, selected, name.trim() || undefined, undefined, selectedMcp);
        break;
      case "replan":
        // A revision is planned against the CURRENT selection, so that becomes the new baseline.
        plannedConnectors.current = connectorKey;
        sendPlanAgent(trimmed, selected, name.trim() || undefined, intent.planId, selectedMcp);
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
    // font-sans is scoped here rather than on body: this pane is the only one migrated onto the
    // prose/code split, and the trace, graph and sidebar stay monospace until they follow.
    //
    // Line-height is set once here and inherits. Prose was a scatter of `leading-relaxed` (1.625)
    // on some blocks and the 1.5 body default on others, so two paragraphs of the same size could
    // sit at different rhythms depending on which component rendered them. 1.55 for everything the
    // panel reads as prose; code overrides back down where it needs to (diff hunks).
    <div className="flex h-full flex-col bg-bg font-sans leading-[1.55]">
      <div className="flex shrink-0 items-baseline gap-2 border-b border-hair px-6 pb-2 pt-4">
        <span className="text-[11px] uppercase tracking-widest text-faint">
          {mode === "generate" ? "New agent" : "Fix"}
        </span>
        {agent && (
          // Two truncations, two fixes. The server's 60-char cut already happened and landed
          // mid-word, so displayTitle() ends it on a whole word; `truncate` handles the narrow-pane
          // case, and `min-w-0` is what lets it shrink at all inside this flex row. The tooltip
          // carries the untruncated original, which the client has always had and never shown.
          <span
            className="min-w-0 font-mono text-[12px] text-muted truncate"
            title={fullTitle(agent.name, agent.description)}
          >
            {displayTitle(agent.name, agent.description)}
          </span>
        )}
      </div>

      {/* conversation */}
      {/* Turns are distinct moments — a prompt, a plan, a generation. 24px between them, the
          widest step in the scale, so the thread reads as separate exchanges rather than one
          continuous document. */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-6 py-2 space-y-6">
        {turns.length === 0 &&
          (mode === "generate" ? (
            <EmptyState
              icon={SparklesIcon}
              title="Describe the agent you want"
              hint="You’ll get a short plan first — its tools, state and graph — to approve or correct. Nothing is generated until you do."
            />
          ) : (
            <EmptyState
              icon={WrenchIcon}
              title={`Describe a change to ${agent?.name ?? "this agent"}`}
              hint="You’ll get a reviewable diff to apply or discard. Nothing is changed until you apply it."
            />
          ))}
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
                // Ticked means "this agent gets the audited template", so the check is the
                // reviewed accent — the same colour it will wear in the plan a moment later.
                //
                // `reserveIcon` keeps the slot there when unticked. Rendering the check only when
                // on made each chip ~14px wider the moment you clicked it, and with three
                // connectors that was enough to wrap the row onto two lines and shove the whole
                // composer down mid-click. A control must not resize because you used it.
                <Chip
                  key={c.id}
                  size="lg"
                  onClick={() => toggle(c.id)}
                  selected={on}
                  disabled={busy}
                  title={c.hint}
                  reserveIcon
                  icon={on ? <StatusDot state="ok" size={11} color={ACCENT.reviewed} /> : undefined}
                >
                  {c.label}
                </Chip>
              );
            })}
            {/* Locked once a plan exists, because by then it does nothing. Generation takes the
                name from the approved plan record, not from this field (server/src/index.ts —
                "building what was approved is the whole point of the gate"), and a revision keeps
                the name the first plan was given. So typing here after planning changed nothing
                and said nothing — the agent quietly kept its old name.

                Leaving it editable-but-ignored is the worst of the options. Locking it says the
                name is settled, and the placeholder says how to change your mind. */}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy || Boolean(planId)}
              placeholder={planId ? "name (set by the plan)" : "name (optional)"}
              title={
                planId
                  ? "The name is fixed once a plan is on the table — discard the plan to change it"
                  : "Optional. Otherwise the name is taken from your description."
              }
              className="ml-auto w-40 bg-panel font-mono text-ink placeholder:text-faint rounded-control px-2.5 py-1 text-[12px] outline-none focus:shadow-focusring disabled:opacity-50"
            />
          </div>
        )}

        {/* MCP tools — new-agent generation only, and only when a server is connected.
            Deliberately a separate row from the connectors above rather than more chips in
            the same one. They are not the same kind of thing: ticking Postgres asks for an
            audited template, ticking an MCP tool asks for a call into code nobody here has
            read, and a row that mixed them would quietly say those decisions are equivalent.

            Per-tool rather than per-server, which is the least-privilege rule made
            clickable: a connected server's whole catalogue is never handed over because the
            server happens to be connected. */}
        {composerMode === "chat" && mode === "generate" && mcpTools.length > 0 && (
          <div className="mb-2">
            <button
              onClick={() => setMcpOpen((v) => !v)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 text-[11px] text-faint hover:text-muted transition-colors disabled:opacity-50"
            >
              <span style={{ color: ACCENT.mcp }}>
                <PlugIcon size={ICON.xs} />
              </span>
              MCP tools
              {selectedMcp.length > 0 && (
                <span className="tabular-nums" style={{ color: ACCENT.mcp }}>
                  {selectedMcp.length} selected
                </span>
              )}
              <span className="text-faint">{mcpOpen ? "hide" : "choose"}</span>
            </button>

            {mcpOpen && (
              <div className="mt-1.5 max-h-40 overflow-y-auto rounded-card bg-panel p-1.5">
                {mcpTools.map((t) => {
                  const on = selectedMcp.includes(t.ref);
                  const high = t.impact === "high";
                  return (
                    <button
                      key={t.ref}
                      onClick={() => toggleMcp(t.ref)}
                      disabled={busy}
                      title={`${t.serverLabel} — ${t.impact_reason}`}
                      className={`flex w-full items-center gap-1.5 rounded-control px-1.5 py-1 text-left text-[12px] transition-colors disabled:opacity-50 ${
                        on ? "bg-active text-ink" : "text-muted hover:text-ink"
                      }`}
                    >
                      {/* Fixed-width slot so a control never resizes because you used it —
                          the same reason the connector chips reserve theirs. */}
                      <span className="inline-flex w-[11px] shrink-0 items-center justify-center" aria-hidden>
                        {on && <StatusDot state="ok" size={11} color={ACCENT.mcp} />}
                      </span>
                      <span className="font-mono truncate">{t.name}</span>
                      {/* Which server it came from is not decoration: two servers can
                          advertise the same tool name and mean different things. */}
                      <span className="text-faint truncate">{t.serverLabel}</span>
                      {high && (
                        // The same word, the same colour and now the same chip the plan card and
                        // the MCP panel use for this fact one screen away.
                        <Chip
                          caps
                          size="sm"
                          variant="bare"
                          color={STATUS.pending}
                          className="ml-auto shrink-0"
                          title="Asks before it runs the first time"
                        >
                          confirms
                        </Chip>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* context chip + live routing hint (Chat mode) — so the one composer stays transparent */}
        {composerMode === "chat" && (contextLabel || text.trim()) && (
          <div className="mb-2 flex items-center gap-2 text-[11px]">
            {contextLabel && (
              <Chip mono icon={<span className="text-faint"><ChevronRightIcon size={ICON.xs} /></span>}>
                {contextLabel}
                <button
                  onClick={clearContext}
                  className="text-faint transition-colors duration-fast hover:text-ink"
                  title="Clear context"
                >
                  <XIcon size={ICON.xs} />
                </button>
              </Chip>
            )}
            {text.trim() && <span className="text-faint ml-auto">⌘↵ will {routeLabel(intent)}</span>}
          </div>
        )}

        {/* the card — textarea sits directly in it; only the toggle + send read as solid elements */}
        <div
          className="rounded-modal border border-edge bg-panel shadow-raised transition-shadow duration-fast focus-within:shadow-focusring"
          style={{ padding: "14px 16px 12px" }}
        >
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
              {/* Test mode only: the input IS an eval example, so promotion belongs here
                  rather than in the Evals tab — that's where a case earns its place. */}
              {composerMode === "test" && activeAgentId && (
                <button
                  type="button"
                  onClick={promote}
                  disabled={!connected || !promotable}
                  title={
                    promotable
                      ? "Save this test input to the eval dataset"
                      : "Type or run a test input first"
                  }
                  className="text-muted hover:text-ink transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <SaveToDatasetIcon size={16} />
                </button>
              )}
              {promoted && (
                <span className={`text-[11px] ${promoted.duplicate ? "text-muted" : "text-ok"}`}>
                  {promoted.duplicate
                    ? `already in ${promoted.datasetName}`
                    : `saved to ${promoted.datasetName}`}
                </span>
              )}
            </div>

            {/* right — the only two solid elements: mode toggle + send circle */}
            <div className="flex items-center gap-2.5">
              <div className="flex items-center rounded-full bg-active p-0.5">
                {(["chat", "test"] as const).map((m) => {
                  const active = composerMode === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setComposerMode(m)}
                      className={`rounded-full text-[12px] transition-colors ${active ? "" : "text-muted hover:text-ink"}`}
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
