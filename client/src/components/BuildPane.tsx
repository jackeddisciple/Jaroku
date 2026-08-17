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
  type ChatTurn, type GenTurn, type PlanTurn, type ProposalTurn, type ReplyTurn,
} from "../store/chatStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { inputKey, RUN_PROVIDERS, useUiStore } from "../store/uiStore.ts";
import { useProviderStore } from "../store/providerStore.ts";
import {
  sendApplyEdit, sendBranchRun, sendDiscardEdit, sendDiscardPlan, sendEdit, sendExplain,
  sendGenerate, sendPlanAgent, sendPromoteTestInput, sendRun,
} from "../lib/socket.ts";
import { useEvalStore } from "../store/evalStore.ts";
import { composerMoment } from "../lib/composerMoment.ts";
import { classifyIntent, fixPrompt, routeLabel } from "../lib/intent.ts";
import { Chip } from "./Chip.tsx";
import { ChoiceRow, type Choice } from "./ChoiceRow.tsx";
import { DiffCard } from "./DiffCard.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Prose } from "./InlineCode.tsx";
import { StreamingFileRow } from "./FileList.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { ArrowUpIcon, ChevronDownIcon, MicIcon, SaveToDatasetIcon } from "./composerIcons.tsx";
import {
  GitHubAttachChips, GitHubAttachMenu, GitHubTriggerPicker, useGithubAttachments,
} from "./GitHubAttach.tsx";
import { activeTrigger, removeTrigger, type ActiveTrigger } from "../lib/composerTriggers.ts";
import { Truncate } from "./Truncate.tsx";
import { StatusDot } from "./StatusBadge.tsx";
import { StatRow, STAT_ICON, type Stat } from "./StatRow.tsx";
import {
  AlertTriangleIcon, CheckIcon, ChevronRightIcon, DollarSignIcon, FileIcon, HashIcon,
  LightbulbIcon, LoaderIcon, PencilIcon, PlugIcon, RefreshIcon, SparklesIcon, UserCircleIcon,
  WrenchIcon, XIcon, ZapIcon,
} from "./panelIcons.tsx";
import { useMcpStore, allMcpTools } from "../store/mcpStore.ts";
import { useThreadStore } from "../store/threadStore.ts";
import { firstUnresolvedTurnId } from "../lib/threadResume.ts";
import { ACCENT, ICON, STATUS, SURFACE, TEXT, TYPE } from "../lib/tokens.ts";
import { JarokuGlyph, ProviderMark } from "../lib/icons.tsx";
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
      {turn.status === "streaming" && (
        <span className="animate-stream-pulse text-faint motion-reduce:animate-none">▋</span>
      )}
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
 * Jaroku's mark — who is speaking, in the gutter of every turn it takes.
 *
 * This was a sparkle in a filled ring, a stand-in from when the app had no glyph of its own: the
 * ring existed to give a 10px speck enough mass to answer a 14px face across the gutter. There is
 * a real mark now, and a mark that is a solid shape does not need a disc drawn behind it — so the
 * ring goes and the logo takes the whole slot.
 *
 * Muted rather than ink. This says who spoke; it is not the thing you came to read, and at
 * full ink on every second row a solid glyph pulls harder than the sentence beside it. It still
 * sits a step above the `faint` face opposite, which is the right order — one of these two
 * produced what follows it.
 */
function JarokuMark() {
  return (
    <span className="flex h-[18px] w-[18px] items-center justify-center text-muted">
      <JarokuGlyph size={15} />
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

// The model selector: which model a Test-mode run goes to.
//
// It was a bare label and a chevron with no surface of its own, sitting between the mic and the
// send button — so the one control in the composer footer that changes what a run COSTS looked
// like a caption. It is a chip now, with the provider's own mark, which is the same shape the top
// bar already uses to say the same thing.
//
// The open state is the chip's selected state rather than a bespoke one: an open menu is a
// pressed control, and the app has one way of drawing that.
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
  const openSecretsForProvider = useUiStore((s) => s.openSecretsForProvider);
  // WHICH PROVIDERS CAN ACTUALLY RUN. `fake` always can — it is the free dry-run path and needs no
  // key, which is the thing this product is rightly proud of. The rest need one in THIS workspace,
  // which `providerStore` already knows from the providers channel.
  const providers = useProviderStore((s) => s.providers);
  const usableProviders = new Set<string>([
    "fake",
    ...providers.filter((p) => p.configured).map((p) => p.id),
  ]);
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
      <Chip
        size="lg"
        selected={open}
        onClick={() => setOpen((o) => !o)}
        title="Run model"
        icon={<ProviderMark provider={provider} size={12} />}
      >
        {/* "Dry run (free)" is prose; a model id is an identifier. Only the latter gets mono. */}
        <span className={provider === "fake" ? undefined : "font-mono"}>{label}</span>
        {/* Points down at a closed menu and up at an open one — this popover opens upward, and a
            chevron that keeps pointing down while the list is above it is pointing at nothing. */}
        <span
          className={`shrink-0 transition-transform duration-fast ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          <ChevronDownIcon size={ICON.xs} />
        </span>
      </Chip>
      {open && (
        <div className="absolute bottom-full mb-2 left-0 z-30 min-w-[190px] rounded-card bg-panel border border-edge shadow-floating p-1">
          {RUN_PROVIDERS.map((p) => (
            <div key={p.id} className="mt-1 first:mt-0">
              {/* The provider's own mark on its group, so the menu is scanned by logo the way
                  the chip that opened it is read by logo. */}
              <div className={`flex items-center gap-1.5 px-2 pb-1 pt-0.5 ${TYPE.sectionLabel}`}>
                <ProviderMark provider={p.id} size={10} />
                {p.label}
                {/* THE WAY OUT, ATTACHED TO THE PROVIDER IT IS ABOUT. The models below are disabled
                    with a reason, which is right — a model that vanishes reads as unsupported — but
                    a disabled control cannot also be the fix. §5.2 asks that the way out open the
                    add dialog FOR THAT PROVIDER, and it can only carry which provider if it lives
                    beside one. */}
                {!usableProviders.has(p.id) ? (
                  <button
                    type="button"
                    className="ml-auto text-[10px] text-muted underline-offset-2 hover:text-ink hover:underline"
                    onClick={() => {
                      openSecretsForProvider(p.id);
                      setOpen(false);
                    }}
                  >
                    Add key
                  </button>
                ) : null}
              </div>
              {p.models.map((m) => {
                const active = provider === p.id && model === m;
                // DISABLED WITH A STATED REASON, NEVER HIDDEN. A model that vanishes because a key
                // is missing reads as "Jaroku does not support this", which is both false and
                // unfixable from the user's side. Shown, greyed, and told why.
                const usable = usableProviders.has(p.id);
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={!usable}
                    title={usable ? undefined : `No ${p.label} API key in this workspace`}
                    onClick={() => {
                      setProvider(p.id); // resets model to the provider's default…
                      setModel(m); // …then pin the chosen one
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-1.5 rounded-control px-2 py-1 text-left font-mono text-[12px] transition-colors duration-fast ${
                      !usable
                        ? "cursor-not-allowed text-faint opacity-60"
                        : active
                          ? "bg-active text-ink"
                          : "text-muted hover:bg-active/40 hover:text-ink"
                    }`}
                  >
                    {/* A fixed slot, so choosing a model does not shift the list. */}
                    <span className="inline-flex w-[11px] shrink-0 items-center justify-center" aria-hidden>
                      {active && <CheckIcon size={ICON.xs} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{m}</span>
                    {!usable ? <span className="shrink-0 text-[10px]">no API key</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
          {/* THE WAY OUT OF THE DEAD END. Opens the Secrets tab at the provider group with the add
              form already showing — and does NOT unmount the composer, so the draft, the selected
              connectors and the attachments are all still there when they come back. That is the
              whole reason this is a tab rather than a full-screen step. */}
          <button
            type="button"
            onClick={() => {
              // No provider named: this one sits under every group, so it opens the tab and the
              // add form without claiming to know which key somebody came for.
              openSecretsForProvider(null);
              setOpen(false);
            }}
            className="mt-1 flex w-full items-center gap-1.5 rounded-control border-t border-hair px-2 pt-2 pb-1 text-left text-[12px] text-muted transition-colors duration-fast hover:text-ink"
          >
            <span className="inline-flex w-[11px] shrink-0 items-center justify-center" aria-hidden>
              +
            </span>
            Add a provider key…
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The one banner a workspace with no provider keys sees.
 *
 * A BANNER, NOT A MODAL, and the brief is specific about why: a modal on first run gets dismissed
 * reflexively, before it has been read, by somebody trying to get to the thing they came for. This
 * sits above the composer, says what is missing, and offers the one click that fixes it.
 *
 * Only when `loaded`. Before the first providers snapshot arrives, "no keys" and "we have not been
 * told yet" are indistinguishable, and rendering the first would flash a warning at somebody who
 * has three.
 */
function NoProviderKeyBanner() {
  const providers = useProviderStore((s) => s.providers);
  const loaded = useProviderStore((s) => s.loaded);
  const setRightTab = useUiStore((s) => s.setRightTab);
  if (!loaded || providers.some((p) => p.configured)) return null;
  return (
    <div className="mb-2 flex items-center gap-2 rounded-control border border-hair px-2.5 py-1.5 text-[11px] text-muted">
      <PlugIcon size={ICON.xs} />
      <span className="min-w-0 flex-1">
        No provider key in this workspace yet — runs use the free dry-run model until you add one.
      </span>
      <button
        type="button"
        className="shrink-0 text-ink underline-offset-2 hover:underline"
        onClick={() => setRightTab("secrets")}
      >
        Add a key
      </button>
    </div>
  );
}

export function BuildPane({
  /**
   * What to show in an empty conversation instead of the default prompt.
   *
   * The one seam onboarding needs. Its first-prompt step wants a few real examples where this
   * pane's "Describe the agent you want" normally sits — the same words, so rendering both
   * printed the heading twice with a gap between them. A slot rather than a fork: everything
   * about the composer, the routing and the cards stays the one implementation.
   */
  emptySlot,
  /**
   * This pane IS the screen, rather than the middle column of three.
   *
   * True for exactly one moment: onboarding step 3, where nothing else is mounted. Three things
   * follow, and all three are the same observation — chrome that orients you between panels is
   * noise when there are no other panels:
   *
   *   * the header goes. "NEW AGENT" labels a column against its neighbours; with none, it is a
   *     caption on a blank screen sitting directly above a heading that says the same thing in
   *     a sentence
   *   * the optional name field goes. The name is taken from the description when it is left
   *     empty, which is what everybody does with their first agent, and it is the only control
   *     here that can be ignored entirely with no consequence
   *   * an empty conversation stops being a tall scroll area with the composer pinned beneath
   *     it. The examples and the composer become one centred group, so the box you type into is
   *     the middle of the screen rather than the thing at the bottom of it
   *
   * Everything else — the routing, the connectors, the modes, the cards — is untouched. This is
   * about what surrounds the composer, never about what it does.
   */
  standalone = false,
}: { emptySlot?: React.ReactNode; standalone?: boolean } = {}) {
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
  // Which fork the user has waved away, by key. Local and unpersisted on purpose: skipping is a
  // decision about this moment, and the next fork — or the same one on a new plan — should ask.
  const [skippedFork, setSkippedFork] = useState<string | null>(null);
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
  // §7's GitHub attach. Held beside the draft rather than in a store: it belongs to the message
  // being written, is cleared when that message is sent, and nothing outside this composer has a
  // reason to read it.
  const github = useGithubAttachments(activeAgentId);
  // §A.6. The trigger the caret is currently inside, recomputed from the draft and the caret on
  // every keystroke — a pure function of both, so there is no popover state to fall out of step
  // with what is actually typed. Null is the ordinary case and renders nothing.
  const [githubTrigger, setGithubTrigger] = useState<ActiveTrigger | null>(null);
  // §B.5.1's Fix in Jaroku, arriving from the GitHub panel. A ONE-SHOT INTENT consumed here and
  // cleared immediately: it describes a click that happened, and leaving it set would re-attach the
  // same two chips every time this component re-rendered, over whatever somebody had since removed.
  const attachRequest = useUiStore((s) => s.githubAttachRequest);
  const clearAttachRequest = useUiStore((s) => s.clearGithubAttachRequest);
  useEffect(() => {
    if (!attachRequest) return;
    for (const a of attachRequest) github.attach(a);
    clearAttachRequest();
  }, [attachRequest, clearAttachRequest]);
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
  const activeRun = useTraceStore((s) => (s.activeRunId ? s.runs[s.activeRunId] : undefined));
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
    // §B.5.2's one new signal. It changes no destination — a review-grounded message already routed
    // to the edit loop — and changes what the route label SAYS, which is the visible half.
    hasReviewComment: github.attachments.some((a) => a.kind === "reviewComment"),
  });
  const contextLabel = selectedNodeId
    ? `node: ${selectedNodeId}`
    : selectedStep
      ? `step #${selectedStep.seq} · ${selectedStep.type}${selectedStep.error ? " · error" : ""}`
      : null;

  // How many files generation has started writing. Subscribed to purely so the scroll effect
  // below has something that changes while they stream — see there for why.
  const genFileCount = useBuildStore((s) => s.fileOrder.length);
  // §4.5's request, bumped by `openThread`. Zero means nobody has opened a thread on this tab yet, so
  // the conversation keeps its ordinary terminal behaviour.
  const resumeNonce = useThreadStore((s) => s.resumeNonce);
  // The agent's own file list, for §A.6's `@` picker. The same array `genFileCount` measures —
  // subscribed to directly rather than derived, so the picker offers a file the moment generation
  // writes it.
  const agentFileOrder = useBuildStore((s) => s.fileOrder);

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

  // §4.5: OPENING A THREAD RESUMES AT ITS FIRST UNRESOLVED TURN, not at the bottom.
  //
  // A separate effect from the one above, and deliberately after it: the terminal scroll runs on every
  // change to the conversation and this runs only when somebody has just opened a thread, so ordering
  // them this way means the resume wins the frame it is asked for and the bottom-scroll owns every
  // other one. Merging the two would put "did the user just navigate" inside the effect that fires
  // while files stream.
  //
  // FALLS BACK TO THE BOTTOM when nothing is outstanding, which is the ordinary case and the ordinary
  // behaviour — a thread with nothing waiting in it has no better place to be than where it left off.
  useEffect(() => {
    if (resumeNonce === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const target = firstUnresolvedTurnId(turns);
    if (!target) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    // Queried rather than kept in a ref map: the turn cards are rendered by four different components
    // and a ref per card would be four places to forget one. The attribute is on the wrapper this file
    // renders, so there is exactly one thing to keep in step.
    const node = el.querySelector(`[data-turn-id="${target}"]`);
    // `block: "start"` rather than `center`: the unresolved card's own top edge is where its heading
    // and its buttons are, and centring a tall diff would open on the middle of a file.
    if (node) node.scrollIntoView({ block: "start", behavior: "auto" });
    else el.scrollTop = el.scrollHeight;
    // `turns` is in the deps as well as the nonce, because the conversation for the thread being
    // opened may not have arrived in the same frame the request did.
  }, [resumeNonce, turns]);

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
          // §7's attachments ride the question they were attached to, and are cleared with the
          // draft below — an attachment outliving the message it was made for would silently
          // ground the NEXT question in a diff nobody meant to send.
          github.attachments,
        );
        github.clear();
        setGithubTrigger(null);
        break;
      }
    }
    setChatDraft("");
  };

  const lastGenId = [...turns].reverse().find((t) => t.role === "jaroku" && t.kind === "gen")?.id;

  // ── The fork the session is at, if it is at one ──────────────────────────────
  //
  // Derived entirely from state that already exists. Precedence is by what BLOCKS: a plan or a
  // proposal is a decision the app is waiting on and nothing else can happen until it is
  // answered, so it outranks a failed step, which is an invitation rather than a gate.
  const openPlan = [...turns]
    .reverse()
    .find(
      (t): t is PlanTurn =>
        t.role === "jaroku" && t.kind === "plan" && (t.status === "pending" || t.status === "stale"),
    );
  const openProposal = [...turns]
    .reverse()
    .find(
      (t): t is ProposalTurn => t.role === "jaroku" && t.kind === "proposal" && t.status === "pending",
    );

  let fork: { key: string; question: string; choices: Choice[] } | null = null;
  if (openPlan?.planId && openPlan.status === "pending") {
    fork = {
      key: `plan:${openPlan.planId}`,
      question: "This plan is waiting on you",
      choices: [
        {
          id: "generate",
          label: "Generate",
          hint: "write the project",
          icon: SparklesIcon,
          accent: ACCENT.bespoke,
          primary: true,
          title: "Generate the agent this plan describes",
          onPick: () => sendGenerate(openPlan.prompt, [], undefined, openPlan.planId ?? undefined),
        },
        {
          id: "revise",
          label: "Revise",
          hint: "say what to change",
          icon: PencilIcon,
          title: "Type feedback — the plan is re-written against it",
          onPick: () => {
            setComposerMode("chat");
            composerRef.current?.focus();
          },
        },
        {
          id: "discard",
          label: "Discard",
          hint: "hand the brief back",
          icon: XIcon,
          title: "Drop this plan and return your description to the composer",
          onPick: () => {
            if (openPlan.planId) sendDiscardPlan(openPlan.planId);
            useUiStore.getState().prefillChat(openPlan.prompt);
          },
        },
      ],
    };
  } else if (openPlan?.planId && openPlan.status === "stale") {
    fork = {
      key: `stale:${openPlan.planId}`,
      question: "The connectors changed after this plan was written",
      choices: [
        {
          id: "replan",
          label: "Re-plan",
          hint: "against the new selection",
          icon: AlertTriangleIcon,
          accent: STATUS.pending,
          primary: true,
          onPick: () => {
            useUiStore.getState().prefillChat(openPlan.prompt);
          },
        },
        {
          id: "discard",
          label: "Discard",
          hint: "start from something else",
          icon: XIcon,
          onPick: () => {
            if (openPlan.planId) sendDiscardPlan(openPlan.planId);
            useUiStore.getState().prefillChat(openPlan.prompt);
          },
        },
      ],
    };
  } else if (openProposal?.proposalId) {
    fork = {
      key: `edit:${openProposal.proposalId}`,
      question: "This change is waiting on you",
      choices: [
        {
          id: "apply",
          label: "Apply",
          hint: "write it to disk",
          icon: CheckIcon,
          accent: STATUS.ok,
          primary: true,
          title: "Snapshot the project, then swap these files in",
          onPick: () => openProposal.proposalId && sendApplyEdit(openProposal.proposalId),
        },
        {
          id: "discard",
          label: "Discard",
          hint: "change nothing",
          icon: XIcon,
          onPick: () => openProposal.proposalId && sendDiscardEdit(openProposal.proposalId),
        },
      ],
    };
  } else if (selectedStep?.error && activeAgentId) {
    // Three things you can do with a failure, each already reachable by typing a phrase the
    // intent router recognises. The cards name them, which is the part that was undiscoverable.
    const failed = selectedStep;
    fork = {
      key: `step:${failed.id}`,
      question: `Step #${failed.seq} failed`,
      choices: [
        {
          id: "explain",
          label: "Explain",
          hint: "why did this fail?",
          icon: LightbulbIcon,
          primary: true,
          onPick: () =>
            sendExplain(activeAgentId, "Why did this step fail?", {
              kind: "step",
              step: {
                name: failed.name,
                type: failed.type,
                seq: failed.seq,
                error: failed.error,
                input: failed.input,
                output: failed.output,
              },
            }),
        },
        {
          id: "fix",
          label: "Fix it",
          hint: "propose a code change",
          icon: WrenchIcon,
          accent: ACCENT.bespoke,
          onPick: () => sendEdit(activeAgentId, fixPrompt(failed)),
        },
        {
          id: "rerun",
          label: "Re-run",
          hint: "branch from this step",
          icon: RefreshIcon,
          onPick: () => sendBranchRun(failed.run_id, failed.seq),
        },
      ],
    };
  }
  const showFork = fork !== null && fork.key !== skippedFork && composerMode === "chat" && !busy;

  // What the composer should say right now. Same inputs the fork above is derived from, plus the
  // in-flight flags — see lib/composerMoment.ts for the order of precedence.
  const moment = composerMoment({
    mode: composerMode,
    canRun,
    agentName: agent?.name ?? null,
    planning: isPlanning({ pending: pendingThread }),
    generating: genStatus === "generating",
    answering: streamingAgentId !== null,
    planPending: openPlan?.status === "pending",
    planStale: openPlan?.status === "stale",
    proposalPending: Boolean(openProposal),
    running: activeRun?.status === "running",
    failedStepSeq: selectedStep?.error ? selectedStep.seq : null,
    contextLabel,
  });

  // An empty thread on a screen this pane owns. The one case where the composer is not the
  // bottom of a conversation but the middle of a page — see `standalone`.
  const anchored = standalone && turns.length === 0;

  return (
    // The family comes from the body now — every panel is on the prose/code split, and this
    // pane no longer has to declare what it always was.
    //
    // Line-height is set once here and inherits. Prose was a scatter of `leading-relaxed` (1.625)
    // on some blocks and the 1.5 body default on others, so two paragraphs of the same size could
    // sit at different rhythms depending on which component rendered them. 1.55 for everything the
    // panel reads as prose; code overrides back down where it needs to (diff hunks).
    <div className={`flex h-full flex-col bg-bg leading-[1.55] ${anchored ? "justify-center" : ""}`}>
      <div
        className={`shrink-0 items-baseline gap-2 border-b border-hair px-6 pb-2 pt-4 ${
          standalone ? "hidden" : "flex"
        }`}
      >
        <span className={TYPE.panelLabel}>{mode === "generate" ? "New agent" : "Fix"}</span>
        {agent && (
          // Two truncations, two fixes. The server's 60-char cut already happened and landed
          // mid-word, so displayTitle() ends it on a whole word; `truncate` handles the narrow-pane
          // case, and `min-w-0` is what lets it shrink at all inside this flex row. The tooltip
          // carries the untruncated original, which the client has always had and never shown.
          <Truncate
            className="font-mono text-[12px] text-muted"
            title={fullTitle(agent.name, agent.description)}
          >
            {displayTitle(agent.name, agent.description)}
          </Truncate>
        )}
      </div>

      {/* conversation */}
      {/* Turns are distinct moments — a prompt, a plan, a generation. 24px between them, the
          widest step in the scale, so the thread reads as separate exchanges rather than one
          continuous document. */}
      <div
        ref={scrollRef}
        className={`px-6 ${
          anchored ? "shrink-0" : "flex-1 min-h-0 overflow-y-auto py-2 space-y-6"
        }`}
      >
        {turns.length === 0 && emptySlot}
        {turns.length === 0 && !emptySlot &&
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
          // The id on the wrapper is what §4.5's resume scrolls to. One place, rather than a ref
          // inside each of the four card components.
          <div key={t.id} data-turn-id={t.id}>
            <Turn turn={t} isLastGen={t.id === lastGenId} />
          </div>
        ))}
      </div>

      {/* composer — ONE input; the Chat/Test toggle folds in what used to be the run-bar */}
      <div className="px-6 pb-4 pt-2 shrink-0">
        <NoProviderKeyBanner />
        {/* connectors + name — new-agent generation only (Chat mode, no agent selected) */}
        {composerMode === "chat" && mode === "generate" && (
          // On first run this row is one of three stacked groups — examples, connectors,
          // composer — and a lowercase caption between two proper section headings reads as a
          // stray word rather than as the head of its own group. It gets the panel's section
          // label there, and stays a caption in the three-column app, where it is the only
          // label above the composer and an uppercase one would shout.
          <div className={`mb-2 flex flex-wrap items-center gap-2 ${standalone ? "mt-1" : ""}`}>
            <span className={standalone ? `${TYPE.sectionLabel} mr-1` : "text-[11px] text-faint mr-1"}>
              Connectors
            </span>
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
                  // Outlined when off, rather than bare. This is a picker, not a strip of
                  // entities where one is current: every option has to look clickable before it
                  // has been clicked, and a bare label reads as a caption.
                  variant={on ? undefined : "outline"}
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
              // Hidden, not removed, on first run: `name` is still the state the submit path
              // reads, and it is still empty, which is what makes generation take the name from
              // the description. See `standalone` for why it is not on screen there.
              hidden={standalone}
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
                      <Truncate className="font-mono">{t.name}</Truncate>
                      {/* Which server it came from is not decoration: two servers can
                          advertise the same tool name and mean different things. */}
                      <Truncate className="text-faint">{t.serverLabel}</Truncate>
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

        {/* The fork, when there is one. Above the input rather than replacing it: these are the
            reasonable answers, and anything else is still a sentence you type underneath. */}
        {showFork && fork && (
          <ChoiceRow
            question={fork.question}
            choices={fork.choices}
            onSkip={() => setSkippedFork(fork.key)}
          />
        )}

        {/* context chip + live routing hint (Chat mode) — so the one composer stays transparent */}
        {(contextLabel || text.trim() || moment.status) && (
          <div className="mb-2 flex items-center gap-2 text-[11px]">
            {/* What the app is doing. The routing hint on the right says where a message would go;
                this says what is going on regardless of whether anything has been typed. */}
            {moment.status && (
              <span className="inline-flex items-center gap-1.5 text-muted">
                {busy && <StatusDot state="pending" icon={LoaderIcon} pulse size={ICON.xs} />}
                {moment.status}
              </span>
            )}
            {/* Same rule the placeholder follows: a selection is only context when there is an
                agent to ask about. A step stays selected across an agent change, and with none
                selected a typed message plans a new agent — so the chip would be naming a
                context the composer is about to ignore. */}
            {composerMode === "chat" && contextLabel && activeAgentId && (
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
            {/* Chat mode only: in Test mode ⌘↵ runs the agent, and the intent router has no say
                in it — a hint claiming otherwise would be the composer misdescribing itself. */}
            {composerMode === "chat" && text.trim() && (
              <span className="ml-auto text-faint">⌘↵ will {routeLabel(intent)}</span>
            )}
          </div>
        )}

        {/* the card — textarea sits directly in it; only the toggle + send read as solid elements */}
        {/* On first run it carries a resting glow. The screen has one thing to do and this is
            it, and a box that only lights up once you have already found it is not an anchor —
            it is a form field that happens to be focusable. In the three-column app the composer
            is one of several places to look and it goes back to a hairline and a shadow. */}
        <div
          className={`rounded-modal border border-edge bg-panel transition-shadow duration-fast
            focus-within:shadow-focusring ${standalone ? "shadow-glow" : "shadow-raised"}`}
          style={{ padding: "14px 16px 12px" }}
        >
          {/* Attached GitHub context, above the input. Above rather than below because it is
              part of the message being composed, and a chip under the send button would read as
              something that happened rather than something about to be sent. */}
          {/* §A.6's picker, above the chips and above the input: it is about the token being
              typed, so it sits between the sentence and the things already attached to it. */}
          {githubTrigger && github.view && (
            <GitHubTriggerPicker
              view={github.view}
              trigger={githubTrigger}
              // The loaded project's own files, so `@agent.py` works for a file that has never
              // changed — which is the one somebody most often asks about.
              paths={agentFileOrder}
              onDismiss={() => setGithubTrigger(null)}
              onPick={(attachment) => {
                github.attach(attachment);
                // The token comes OUT of the sentence — the attachment is a chip now, and leaving
                // `#a1b2c3d` in the prose would send the same reference twice.
                const { text: next } = removeTrigger(text, githubTrigger);
                setText(next);
                setGithubTrigger(null);
              }}
            />
          )}

          <GitHubAttachChips attachments={github.attachments} onRemove={github.remove} />

          {/* input slot: the textarea and the live waveform crossfade in place (~200ms) so the
              transition from typing to recording is smooth and the card doesn't jump. */}
          <div className="relative" style={{ height: showWave ? recordHeight : undefined }}>
            <textarea
              ref={composerRef}
              // First run only. The caret belongs in the one control the screen exists for, and
              // §4.5's keyboard-first rule is not satisfied by a screen you have to click into
              // before you can type. In the three-column app the pane does not get to steal focus
              // from wherever the user actually is.
              autoFocus={standalone}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                // Recomputed here rather than in an effect, so the picker opens on the keystroke
                // that typed the trigger rather than a frame later.
                setGithubTrigger(
                  activeTrigger(e.target.value, e.target.selectionStart ?? e.target.value.length, github.triggers),
                );
              }}
              // A caret moved by click or arrow key closes a picker whose trigger it has left, and
              // opens one it has entered. Without this, clicking away from `#a1b2` leaves a picker
              // floating over a word nobody is editing.
              onSelect={(e) => {
                const el = e.currentTarget;
                setGithubTrigger(activeTrigger(el.value, el.selectionStart ?? el.value.length, github.triggers));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={2}
              placeholder={moment.placeholder}
              className="w-full resize-none bg-transparent text-ink placeholder:text-muted outline-none leading-[1.5] transition-opacity duration-200"
              style={{
                // Off the 11/12/13 ladder on purpose, and the only thing in the app that is. This
                // is the sentence the user writes; it should be the largest text on the screen.
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
                  voice.listening ? "text-run animate-stream-pulse motion-reduce:animate-none" : "text-muted hover:text-ink"
                }`}
              >
                <MicIcon size={17} />
              </button>
              {/* Beside the mic and before the model chip: it is an input to the message, like
                  the mic, rather than a setting for how the message is handled. */}
              <GitHubAttachMenu view={github.view} onAttach={github.attach} />
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
              {/* Two chips in a track. Same geometry as every other chip in the app, overridden
                  only where a segmented control genuinely differs from a chip strip: the radius
                  is a pill because the segments sit inside one, and the selected segment is
                  ink-on-inverted rather than the usual tinted fill — this control chooses where
                  ⌘↵ goes, which is the same weight of decision as the send button beside it. */}
              <div className="flex items-center rounded-full bg-active p-0.5">
                {(["chat", "test"] as const).map((m) => {
                  const active = composerMode === m;
                  return (
                    <Chip
                      key={m}
                      size="lg"
                      onClick={() => setComposerMode(m)}
                      variant={active ? "fill" : "bare"}
                      color={active ? SURFACE.bg : undefined}
                      background={active ? TEXT.ink : undefined}
                      className="!rounded-full"
                      title={
                        m === "chat"
                          ? "Talk to Jaroku — plan, edit, explain"
                          : "Send this as the agent's own input and run it"
                      }
                    >
                      {m === "chat" ? "Chat" : "Test"}
                    </Chip>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={submit}
                disabled={!connected || !text.trim() || (composerMode === "test" ? !canRun : busy)}
                title={composerMode === "test" ? "Run the agent on this input" : "Send"}
                className="flex items-center justify-center rounded-full transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ width: 30, height: 30, background: TEXT.ink, color: SURFACE.bg }}
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
