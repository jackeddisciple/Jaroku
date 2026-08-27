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
import { inputKey, useUiStore } from "../store/uiStore.ts";
import { runProviders, useProviderStore } from "../store/providerStore.ts";
import {
  sendApplyEdit, sendBranchRun, sendDiscardEdit, sendDiscardPlan, sendEdit, sendExplain,
  sendGenerate, sendPlanAgent, sendPromoteTestInput, sendRun,
} from "../lib/socket.ts";
import { useEvalStore } from "../store/evalStore.ts";
import { UpsellCard } from "./UpsellCard.tsx";
import { composerMoment } from "../lib/composerMoment.ts";
import { classifyIntent, fixPrompt, routeLabel } from "../lib/intent.ts";
import { fmtCost, fmtTokens } from "../lib/format.ts";
import { Chip, chipClass } from "./Chip.tsx";
import { ChoiceRow, type Choice } from "./ChoiceRow.tsx";
import { DiffCard } from "./DiffCard.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Prose } from "./InlineCode.tsx";
import { StreamingFileRow } from "./FileList.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { ChevronDownIcon } from "./composerIcons.tsx";
import {
  GitHubAttachChips, GitHubTriggerPicker, useGithubAttachments,
} from "./GitHubAttach.tsx";
import { ComposerBar, showsLabel } from "./composer/ComposerBar.tsx";
import { ComposerShell } from "./composer/FullscreenComposer.tsx";
import { ControlButton } from "./composer/ControlButton.tsx";
import { PopoverRow } from "./composer/Popover.tsx";
import { AddMenu } from "./composer/AddMenu.tsx";
import { AttachmentRail, type DraftAttachment } from "./composer/AttachmentRail.tsx";
import { refKey, type AttachKind, type AttachableRow } from "./composer/AttachPicker.tsx";
import { MAX_ATTACHMENTS, WARN_AT, budgetPercent } from "../lib/attachBudget.ts";
import { EffortControl, effortLabel } from "./composer/EffortControl.tsx";
import { ShieldControl, modeLabel } from "./composer/ShieldControl.tsx";
import { ConnectorDeck } from "./composer/ConnectorDeck.tsx";
import { TurnActions } from "./composer/TurnActions.tsx";
import { PinRail, pinLabel, type PinnedTurn } from "./composer/PinRail.tsx";
import { useTurnInteractionStore } from "../store/turnInteractionStore.ts";
import { TurnMetadata } from "./composer/TurnMetadata.tsx";
import { turnSource, metaForTurn, promptForRegenerate } from "../lib/turnSource.ts";
import { canRerunTurn } from "../lib/rerun.ts";
import {
  FALLBACK_SETTINGS, useComposerSettingsStore, type Effort, type PermissionMode,
} from "../store/composerSettingsStore.ts";
import { GLYPH, Glyph, HIT_TARGET, Icon } from "./icons.ts";
import type { Density } from "../lib/composerBar.ts";
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
import { ACCENT, ICON, INTERACTION, STATUS, SURFACE, TEXT, TYPE } from "../lib/tokens.ts";
import { JarokuGlyph, ProviderMark } from "../lib/icons.tsx";
import { displayTitle, fullTitle } from "../lib/title.ts";
import { useStreamedText } from "../lib/useStreamedText.ts";
import { useVoiceInput } from "../lib/useVoiceInput.ts";
import { VoiceWaveform } from "./VoiceWaveform.tsx";

/**
 * Band 2's geometry, in the two numbers §3.1 gives it.
 *
 * The textarea is 14px at line-height 1.5, so one line is 21px. Twelve of those is the cap the
 * spec sets before the box stops growing and starts scrolling inside itself — which is the clause
 * that matters, because the alternative is a composer that eats the thread as somebody types.
 *
 * Named rather than written into the style object because the auto-grow effect and the style have
 * to agree about them, and two copies of 252 is how a box grows one line past where it scrolls.
 */
const LINE_PX = 21;
const MAX_LINES = 12;

// Mirrors runtime/tool_templates/catalog.json. The server validates the ids it receives
// against the catalog, so a stale entry here can never inject an unreviewed connector.
// SIX NOW, NOT THREE, AND THE ROW HAS TO SURVIVE THAT. The chips already reserve their tick's
// width so choosing one cannot resize it (see the picker below), but six chips plus the name field
// wrap on a narrow window — which `flex-wrap` handles, and which is why the hints are short. A
// hint is a tooltip, not a description: what a connector does at length belongs in the catalog
// entry the model reads, and the one here only has to separate it from its neighbours.
//
// THE WRITE ONES SAY SO. "create events" and "read-only" are the two words somebody scanning this
// row is actually deciding between, because ticking a connector here is what puts its tools in an
// agent's hands. Gmail's hint has said "draft replies" rather than "send mail" since it was
// written, for the same reason.
const CONNECTORS = [
  { id: "gmail", label: "Gmail", hint: "search mail, draft replies" },
  { id: "google_calendar", label: "Google Calendar", hint: "read, create and update events" },
  { id: "slack", label: "Slack", hint: "read channels, post messages" },
  { id: "stripe", label: "Stripe", hint: "read-only: customers, payments, invoices" },
  { id: "postgres", label: "Postgres", hint: "read-only SQL" },
  { id: "http", label: "HTTP/Webhook", hint: "https requests to allowlisted domains" },
];

function GenTurnView({ turn, isLive }: { turn: GenTurn; isLive: boolean }) {
  const files = useBuildStore((s) => s.files);
  const fileOrder = useBuildStore((s) => s.fileOrder);
  const streamingFile = useBuildStore((s) => s.streamingFile);

  if (turn.status === "error") {
    return (
      <div className="text-caption">
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
      <div className="text-caption">
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
      keepLabel: true,
    },
  ];
  if (turn.usage) {
    stats.push({
      icon: <HashIcon size={STAT_ICON} />,
      value: fmtTokens(turn.usage.output_tokens, "short"),
      label: "output tokens",
    });
    // The cost shown is the total the user actually paid — planning included. Leading with the
    // generation's own figure and appending the plan as a correction made the honest number the
    // hardest one to read.
    stats.push({
      icon: <DollarSignIcon size={STAT_ICON} />,
      // Through `fmtCost`, like everywhere else. Written by hand it was always four decimals,
      // so a sub-cent generation read as $0.0000 here and as $0.00000 through the helper two
      // cards away — the same cost, shown two ways, one of them rounded to nothing.
      value: fmtCost(turn.usage.cost_usd + planCost),
      title:
        planCost > 0
          ? `${fmtCost(turn.usage.cost_usd)} to generate + ${fmtCost(planCost)} to plan`
          : undefined,
    });
    if (turn.usage.cache_read_input_tokens > 0) {
      stats.push({
        icon: <ZapIcon size={STAT_ICON} />,
        value: fmtTokens(turn.usage.cache_read_input_tokens, "short"),
        label: "cached",
        title: "Prompt prefix was reused — these input tokens were not charged at full rate",
        dim: true,
      });
    }
  }
  return (
    // A DOT, THEN THE WORD. The line led with `Generated` in green and no mark at all, while
    // every other "this finished" in the app is a coloured glyph. The dot is the status; the word
    // is what happened.
    <StatRow
      leading={
        <span className="inline-flex items-center gap-1.5 text-caption text-ok">
          <StatusDot state="ok" size={ICON.badge} />
          Generated
        </span>
      }
      stats={stats}
    />
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
    <div className={`text-label whitespace-pre-wrap break-words ${turn.status === "error" ? "text-err" : "text-ink"}`}>
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
      <JarokuGlyph size={ICON.md} />
    </span>
  );
}

/**
 * §5 and §6, under every one of Jaroku's turns.
 *
 * WRAPPED AROUND THE CARD RATHER THAN BUILT INTO EACH ONE. There are four kinds of assistant turn
 * — a plan, a generation, a diff proposal, a reply — and every one of them is copyable,
 * regenerable and has metadata to report. Four copies of that row would be four places for the
 * keyboard rule to be forgotten, and §5 is explicit that it "must be reachable in tab order" on
 * every turn rather than only the ones somebody remembered.
 *
 * An INFO turn gets neither: it is the app narrating itself ("connectors changed"), not a response
 * anybody asked for, and offering to regenerate one would be offering to re-run nothing.
 */
function AssistantTurn({
  turn,
  isLast,
  children,
}: {
  turn: ChatTurn;
  isLast: boolean;
  children: React.ReactNode;
}) {
  const streaming = useChatStore((s) => s.streamingThreadId !== null);
  const models = useProviderStore((s) => s.models);
  const threadId = useThreadStore((s) => s.activeThreadId);
  const turns = useChatStore((s) => threadFor({ threads: s.threads, pending: s.pending }, threadId));
  const meta = metaForTurn(turn);
  const source = turnSource(turn);
  const loadTurn = useTurnInteractionStore((s) => s.loadTurn);

  // The DURABLE id, or nothing. A turn the server has not filed yet has no row to annotate, and
  // the action row renders its note, pin and feedback controls only once one exists.
  const itemId = turn.itemId ?? null;
  useEffect(() => { if (itemId) void loadTurn(itemId); }, [itemId, loadTurn]);

  // ASKED BEFORE THE CONTROL IS RENDERED, not after it is pressed. `rerunTurn` dispatches for one
  // turn kind and this row is mounted on four, so passing the handlers unconditionally put a ⟳ on
  // a plan, a generation and a proposal that promised a re-run in its tooltip and did nothing.
  // See lib/rerun.ts — a control that does nothing is worse than no control.
  const rerunnable = canRerunTurn(turn);

  return (
    // `group/turn` is what lets the action row appear on hover of the WHOLE turn rather than of the
    // row itself — a strip of glyphs you have to find before it appears is one nobody finds.
    <div className="group/turn">
      {children}
      {source !== null && (
        <div className="mt-1.5 pl-[26px]">
          <TurnActions
            source={source}
            isLast={isLast}
            streaming={isLast && streaming}
            onRegenerate={rerunnable ? () => rerunTurn(turns, turn) : undefined}
            onRegenerateWith={rerunnable ? (opts) => rerunTurn(turns, turn, opts) : undefined}
            // The three most recent models from the catalogue. The whole list would be a menu
            // longer than the response it is offering to replace.
            models={models.slice(0, 3).map((m) => ({ id: m.id, label: m.label }))}
            turnId={itemId}
            conversationId={threadId}
            // §5.5's promotion offer is only shown on a turn that PRODUCED a version, because that
            // is the only kind whose input can become a regression test.
            producedVersion={Boolean(meta?.versionLabel)}
            onPromoteToDataset={() => useUiStore.getState().setRightTab("evals")}
          />
          {meta && (
            <TurnMetadata
              meta={meta}
              streaming={isLast && streaming}
              // §5.4's SWITCHER, WITH A CALLER AT LAST. It was an optional prop no component ever
              // passed, so both arrows carried `disabled={… || !onSwitchVariant}` and the slot it
              // sits in could never be present anyway — `total` was 1 on every turn in the product
              // because nothing wrote a second variant.
              //
              // Offered only where there are bodies to switch BETWEEN, which is a reply this
              // session has regenerated: `turn_variants` records what each answer cost forever, and
              // the prose lives as long as the tab does. See `ReplyTurn.priorVariants`.
              onSwitchVariant={
                itemId && turn.role === "jaroku" && turn.kind === "reply" && (turn.priorVariants?.length ?? 0) > 0
                  ? (ordinal) => useChatStore.getState().switchVariant({ threadId: threadId ?? undefined, turnId: itemId, ordinal })
                  : undefined
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Re-run the message that produced this turn — §5.4.
 *
 * IT DISPATCHES NOW RATHER THAN PREFILLING, which is what §5.4 asks for: "re-runs the same user
 * input with the current toolbar settings". It used to put the sentence back in the composer and
 * stop, so the user had to find and press Send themselves, and what arrived was an ordinary new
 * turn appended to the thread rather than a variant of the old one — two questions instead of two
 * answers to one. The `‹ n/m ›` switcher therefore never appeared and `onSwitchVariant` had nobody
 * to pass it.
 *
 * THE PREVIOUS RESPONSE IS NEVER DESTROYED, and this is now true rather than asserted. The server
 * opens a second `turn_variants` row beside the first, each carrying the model and the effort that
 * produced THAT one, so "which model wrote this?" stays answerable for both — the invariant
 * `turnVariants.ts`'s own header was written for and which nothing was upholding.
 *
 * ONLY A REPLY IS RE-RUNNABLE AS A VARIANT. A generation and an edit publish a version and change
 * an agent's files; running one again is a second build rather than a second answer, and giving it
 * a switcher would offer to "switch back" to code that has already been superseded on disk.
 *
 * SO THE OTHER THREE KINDS NO LONGER REACH THIS FUNCTION AT ALL. They used to, and fell through to
 * a `prefillChat` that put the sentence back in the composer and stopped — under a tooltip
 * promising a re-run, with no frame sent and nothing on screen to say which of the two had
 * happened. `AssistantTurn` now asks `canRerunTurn` before it passes the handlers, so no control
 * renders where none can dispatch, and the guard below is the same predicate rather than a second
 * opinion about it.
 */
function rerunTurn(
  turns: readonly ChatTurn[],
  turn: ChatTurn,
  opts?: { modelId?: string; effort?: string },
): void {
  // Nothing renders a regenerate control for a turn this refuses, so reaching here is a wiring
  // mistake rather than a user action — and refusing is the honest answer to it either way.
  if (!canRerunTurn(turn) || turn.role !== "jaroku" || turn.kind !== "reply" || !turn.itemId) return;
  // The message, not the turn. A generation three cards down re-runs the sentence that started it
  // — §5.4's "the same user input" — rather than whatever is in the box now.
  const prompt = promptForRegenerate(turns, turn);
  if (!prompt) return;
  if (opts?.modelId) useUiStore.getState().setModel(opts.modelId);

  // THE SAME COMMAND THE ORIGINAL DISPATCHED, with the turn it is a second answer to. The subject
  // is the agent generally: the step or node the first answer was grounded in may not be selected
  // any more, and re-running against whatever happens to be selected NOW would answer a different
  // question under the first one's heading.
  sendExplain(turn.agentId, prompt, { kind: "agent" }, undefined, undefined, turn.itemId);
}

function Turn({ turn, isLastGen }: { turn: ChatTurn; isLastGen: boolean }) {
  if (turn.role === "user") {
    return (
      // The `›` it replaces was a prompt character — it said "input", not "you". At the top of a
      // scrolled-back thread, the question is whose turn this was, and a face answers that faster
      // than punctuation does.
      <TurnRow marker={<UserCircleIcon size={ICON.sm} className="text-faint" />}>
        <span className="text-ink text-label whitespace-pre-wrap break-words">{turn.text}</span>
      </TurnRow>
    );
  }
  if (turn.kind === "plan") {
    return (
      <AssistantTurn turn={turn} isLast={isLastGen}>
        <TurnRow marker={<JarokuMark />}><PlanCard turn={turn} /></TurnRow>
      </AssistantTurn>
    );
  }
  if (turn.kind === "gen") {
    return (
      <AssistantTurn turn={turn} isLast={isLastGen}>
        <TurnRow marker={<JarokuMark />}><GenTurnView turn={turn} isLive={isLastGen} /></TurnRow>
      </AssistantTurn>
    );
  }
  if (turn.kind === "proposal") {
    return (
      <AssistantTurn turn={turn} isLast={isLastGen}>
        <TurnRow marker={<JarokuMark />}><DiffCard turn={turn} /></TurnRow>
      </AssistantTurn>
    );
  }
  if (turn.kind === "reply") {
    return (
      <AssistantTurn turn={turn} isLast={isLastGen}>
        <TurnRow marker={<JarokuMark />}><ReplyTurnView turn={turn} /></TurnRow>
      </AssistantTurn>
    );
  }
  // Info notes are the app narrating itself ("connectors changed"), not Jaroku answering — no
  // mark, so the gutter stays a record of who spoke.
  return (
    <TurnRow>
      <div className={`text-caption ${turn.tone === "error" ? "text-err" : "text-faint"}`}>
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
  setModel,
}: {
  provider: string;
  model: string;
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
  // THE CATALOGUE COMES FROM THE SERVER'S PRICE SHEET, not from a constant in this client — see
  // providerStore. Memoised against the snapshot's own array, so the grouping runs when the
  // catalogue changes rather than on every keystroke in the composer beside it.
  const models = useProviderStore((s) => s.models);
  const catalogue = useMemo(() => runProviders(models), [models]);
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
        <span className={provider === "fake" ? undefined : ""}>{label}</span>
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
        <div className="absolute bottom-full left-0 z-30 mb-1 min-w-[190px] animate-slide-in rounded-card border border-edge bg-elevated p-1 shadow-floating motion-reduce:animate-none">
          {catalogue.map((p) => (
            <div key={p.id} className="mt-1 first:mt-0">
              {/* The provider's own mark on its group, so the menu is scanned by logo the way
                  the chip that opened it is read by logo. */}
              <div className={`flex items-center gap-1.5 px-2 pb-1 pt-0.5 ${TYPE.sectionLabel}`}>
                <ProviderMark provider={p.id} size={ICON.badge} />
                {p.label}
                {/* THE WAY OUT, ATTACHED TO THE PROVIDER IT IS ABOUT. The models below are disabled
                    with a reason, which is right — a model that vanishes reads as unsupported — but
                    a disabled control cannot also be the fix. §5.2 asks that the way out open the
                    add dialog FOR THAT PROVIDER, and it can only carry which provider if it lives
                    beside one. */}
                {!usableProviders.has(p.id) ? (
                  <button
                    type="button"
                    className="ml-auto text-tiny text-muted underline-offset-2 hover:text-ink hover:underline"
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
                      // ONE CALL, because `setModel` now resolves the provider that owns the model
                      // rather than leaving whatever was selected. The two-step dance was this
                      // menu maintaining an invariant the store did not have — correct here, and
                      // absent everywhere else `setModel` is reached from.
                      setModel(m);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-1.5 rounded-control px-2 py-1 text-left text-caption transition-colors duration-fast ${
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
                    {!usable ? <span className="shrink-0 text-tiny">no API key</span> : null}
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
            className="mt-1 flex w-full items-center gap-1.5 rounded-control border-t border-hair px-2 pt-2 pb-1 text-left text-caption text-muted transition-colors duration-fast hover:text-ink"
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
    // NO BOX. This is already the app's best empty-state pattern — a mark, a muted sentence, and
    // an action at the end of it — and it was wrapped in a bordered container, which turns prose
    // in the flow into a banner you have to dismiss in your head before reading what is under it.
    // Dropping the border is the entire difference between the two.
    <div className="mb-2 flex items-center gap-2 px-0.5 text-tiny text-muted">
      <span className="shrink-0 text-faint" aria-hidden><PlugIcon size={ICON.xs} /></span>
      <span className="min-w-0 flex-1">
        No provider key in this workspace yet — runs use the free dry-run model until you add one.
      </span>
      <button
        type="button"
        className="shrink-0 font-medium text-ink underline-offset-2 hover:underline"
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
  // Where the upsell card's "See Pro" goes. Named by the PLACEMENT rather than inside the card, so
  // the card stays a rendering of one refusal and each surface decides where its own upgrade path
  // leads — the same reason `NoProviderKeyBanner` above reaches for the tab itself.
  const openUsageTab = useUiStore((s) => s.setRightTab);
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
  // WHICH SESSION THIS COMPOSER IS IN (§3.1). The conversation is keyed by it, and so is everything
  // derived from the conversation below — a plan awaiting a decision in another thread is not this
  // composer's business, and a message typed here is filed here.
  const activeThreadId = useThreadStore((s) => s.activeThreadId);

  // §3.2's expanded editor. PER CONVERSATION AND LOCAL ONLY, which the spec is explicit about:
  // "Persist 'was fullscreen' per conversation in local state only. Not a server setting."
  // Keyed by thread rather than held as one boolean, so opening a second thread does not inherit
  // the first one's editor — writing a long brief in one conversation says nothing about the next.
  const [fullscreenBy, setFullscreenBy] = useState<Record<string, boolean>>({});
  // `__none` covers the composer before a thread exists — a brand-new agent's first message,
  // which is exactly the case the expanded editor was asked for.
  const fullscreenKey = activeThreadId ?? "__none";
  const fullscreen = fullscreenBy[fullscreenKey] ?? false;
  const setFullscreen = useCallback(
    (on: boolean) => setFullscreenBy((m) => ({ ...m, [fullscreenKey]: on })),
    [fullscreenKey],
  );
  // §3.3's ⌘/ — a counter rather than a boolean, because the same chord pressed twice has to open
  // the menu twice, and a boolean that is already true is a keystroke that does nothing.
  const [attachChordNonce, setAttachChordNonce] = useState(0);

  // §5.3's rail. The pins are this user's — the server scoped the read — and the collapsed state
  // is remembered per conversation in LOCAL state only: collapsing a rail in one thread says
  // nothing about the next, because the reason to collapse it is that THIS thread's anchors are
  // not what somebody is looking at right now.
  const pins = useTurnInteractionStore((s) => s.pins);
  const loadPins = useTurnInteractionStore((s) => s.loadPins);
  const togglePin = useTurnInteractionStore((s) => s.togglePin);
  const [railCollapsedBy, setRailCollapsedBy] = useState<Record<string, boolean>>({});
  const railCollapsed = railCollapsedBy[activeThreadId ?? "__none"] ?? false;
  const setRailCollapsed = useCallback(
    (next: boolean | ((v: boolean) => boolean)) =>
      setRailCollapsedBy((m) => {
        const key = activeThreadId ?? "__none";
        const now = typeof next === "function" ? next(m[key] ?? false) : next;
        return { ...m, [key]: now };
      }),
    [activeThreadId],
  );
  useEffect(() => { if (activeThreadId) void loadPins(activeThreadId); }, [activeThreadId, loadPins]);

  // §3.2's settings, mirrored from the server. The store never decides — a workspace can pin the
  // permission mode and disallow Fast, so what somebody picked and what is in effect are different
  // values, and only the server knows the second one.
  const settings = useComposerSettingsStore((s) => s.byConversation[activeThreadId ?? "__none"]) ?? FALLBACK_SETTINGS;
  const patchSettings = useComposerSettingsStore((s) => s.patch);
  const loadSettings = useComposerSettingsStore((s) => s.load);
  const settingsError = useComposerSettingsStore((s) => s.error);
  const clearSettingsError = useComposerSettingsStore((s) => s.clearError);
  useEffect(() => { void loadSettings(activeThreadId); }, [activeThreadId, loadSettings]);

  // §3.2's deck — the workspace's connectors joined with this conversation's decisions, from the
  // server. Not assembled here: the join is what decides whether a connector renders grayscale,
  // and a client that computed it would need its own copy of the absent-row rule.
  const conversationConnectors = useComposerSettingsStore(
    (s) => s.connectorsByConversation[activeThreadId ?? "__none"],
  );
  const loadConnectors = useComposerSettingsStore((s) => s.loadConnectors);
  const toggleConnector = useComposerSettingsStore((s) => s.toggleConnector);
  useEffect(() => { void loadConnectors(activeThreadId); }, [activeThreadId, loadConnectors]);

  /**
   * What the deck draws.
   *
   * FROM THE SERVER'S JOIN WHEN THERE IS A CONVERSATION, and from the workspace's own MCP snapshot
   * before there is one. The second case is a composer that has not started a thread yet: there is
   * nothing to scope, so every connector is on and the deck is a readout rather than a control.
   */
  const deckConnectors = useMemo(() => {
    if (conversationConnectors) {
      return conversationConnectors.map((c) => ({
        id: c.id, label: c.label, logoUrl: c.logo_url, enabled: c.enabled, warning: c.warning,
      }));
    }
    return mcpServers.map((sv) => ({
      id: sv.id, label: sv.label || sv.id, logoUrl: null, enabled: true,
      warning: sv.status === "error" ? "could not be reached" : null,
    }));
  }, [conversationConnectors, mcpServers]);

  /**
   * The effort THIS message will be sent with.
   *
   * Held beside the draft rather than in the store, because §3.2 is explicit that a per-turn
   * override is not sticky unless "Remember" is checked. An override that lived in the settings
   * store would be one that persisted by construction, and the checkbox would have nothing left to
   * mean. Cleared when the conversation changes, for the same reason the draft is per-thread: an
   * override is about a message, and that message is gone.
   */
  const [effortOverride, setEffortOverride] = useState<Effort | null>(null);
  useEffect(() => { setEffortOverride(null); }, [activeThreadId]);
  const effort: Effort = effortOverride ?? settings.reasoning_effort;

  // The selected model's own capability record, from the server's catalogue snapshot. Looked up
  // rather than guessed: whether a reasoning control exists at all is the server's answer, and a
  // second table in this client is what put the catalogue four models behind the price sheet once.
  const selectedModel = useProviderStore((s) => s.models.find((m) => m.id === model));

  const agent = agents.find((a) => a.agent_id === activeAgentId);
  const mode: "generate" | "edit" = activeAgentId ? "edit" : "generate";
  const turns = threadFor({ threads, pending: pendingThread }, activeThreadId);
  // A plan on screen awaiting a decision. It routes a typed message to a revision and, when
  // the connector selection changes, is what gets invalidated.
  const planId = pendingPlanId(turns);
  const busy = genStatus === "generating" || streamingAgentId !== null || isPlanning(turns);

  /**
   * The rail's rows — a pinned turn id resolved against the thread it belongs to.
   *
   * §5.3: "Pin label = first ~60 chars of the turn, or its plan title if the turn produced a plan."
   * Resolved here rather than stored on the pin, because a plan's title can change when the plan is
   * revised and a stored label would go stale against the turn it names.
   *
   * A PIN WHOSE TURN IS GONE IS DROPPED — §9's "Pinned turn deleted: pin removed from the rail
   * automatically". Silently, because there is nothing for the user to do about it.
   */
  const pinnedTurns = useMemo((): PinnedTurn[] => {
    const byItem = new Map(turns.filter((t) => t.itemId).map((t) => [t.itemId!, t]));
    return pins.flatMap((itemId) => {
      const t = byItem.get(itemId);
      if (!t || t.role === "user") return [];
      if (t.kind === "info") return [];
      const label = t.kind === "plan"
        // A plan has no name of its own — the brief it was written for is what identifies it,
        // and it is also what somebody would recognise in a rail.
        ? (t.prompt || "Plan")
        : t.kind === "reply"
          ? t.text
          : t.kind === "proposal"
            ? (t.summary ?? "Proposed an edit")
            : "Generated an agent";
      return [{ turnId: itemId, label: pinLabel(label), kind: t.kind }];
    });
  }, [pins, turns]);

  /**
   * §5.3: "Click scrolls to the turn and flashes a highlight (200ms)."
   *
   * THE FLASH IS SKIPPED UNDER `prefers-reduced-motion` (§10). Scrolling to a turn in a long thread
   * lands the reader somewhere with no indication of which row was meant, so the flash is doing
   * real work — but it is a flash, and the static alternative is simply arriving there.
   */
  const scrollToTurn = useCallback((itemId: string) => {
    const local = turns.find((t) => t.itemId === itemId);
    if (!local) return;
    const el = scrollRef.current?.querySelector(`[data-turn-id="${local.id}"]`);
    if (!(el instanceof HTMLElement)) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    el.classList.add("animate-flash-highlight");
    window.setTimeout(() => el.classList.remove("animate-flash-highlight"), 400);
  }, [turns]);

  // §3.3's two window-level chords.
  //
  // WINDOW-LEVEL RATHER THAN ON THE TEXTAREA, because both are meant to work when the caret is
  // not in it — ⌘⇧F is how you get to the editor from anywhere in the pane, and ⌘/ is how you
  // attach something without first clicking into a box you are about to leave again.
  //
  // ⌘/ MOVED. It focused the composer until now (CommandPalette.tsx), and §3.3 assigns it to the
  // ⊕ menu. The old behaviour is not lost: the palette still carries "Focus chat" as an item, and
  // ⌘/ lands in the composer's own ⊕ anyway — so the chord still puts you in the composer, just
  // with the menu it was asked to open already open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setFullscreen(!fullscreen);
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        setAttachChordNonce((n) => n + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, setFullscreen]);

  /**
   * §3.3: ↑ on an EMPTY composer edits the last user message.
   *
   * "Empty" is doing real work here. On a composer with text in it, ↑ is how you move the caret up
   * a line, and stealing that would make the expanded editor unusable for the long instructions it
   * exists to hold. So the binding lives on the textarea, fires only when the box is empty, and
   * puts the previous message back rather than opening an editor — the message is a draft again,
   * which is the same shape everything else in this composer has.
   */
  const editLastUserMessage = useCallback((): boolean => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t && t.role === "user" && t.text.trim()) {
        setText(t.text);
        return true;
      }
    }
    return false;
  }, [turns, setText]);

  // Band 2 auto-grows with what is typed into it. MEASURED rather than counted: a wrapped line is
  // still a line, and counting newlines says a 300-character paragraph is one.
  useEffect(() => {
    const el = composerRef.current;
    if (!el || fullscreen) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, LINE_PX * MAX_LINES)}px`;
  }, [text, composerMode, fullscreen]);


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
  // And why it is empty, when the reason is a read that failed. `attachSources` cannot carry that:
  // it is a set, and an absent kind means the same thing whichever way the list got empty.
  const agentFilesError = useBuildStore((s) => s.error);

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
  // SERVICED ONCE PER REQUEST, and the ref is what makes that true. `resumeNonce` only ever grows,
  // so the guard on zero suppresses this effect exactly once — before the first thread of the
  // session is opened — and `turns` in the deps re-ran it on every subsequent change to the
  // conversation. Typing a follow-up into a thread with a pending diff therefore yanked the view
  // back to the OLD diff on every streamed frame, for the rest of the session, in every thread.
  //
  // `turns` stays in the deps deliberately: the conversation for the thread being opened may not
  // have arrived in the same frame the request did, so the effect has to be allowed to re-run —
  // it just must not act twice for one request.
  const servedResume = useRef(0);
  useEffect(() => {
    if (resumeNonce === 0 || servedResume.current === resumeNonce) return;
    const el = scrollRef.current;
    if (!el) return;
    const target = firstUnresolvedTurnId(turns);
    if (!target) {
      // Nothing outstanding is a complete answer to "where should this open", so the request is
      // spent. An empty conversation is not: the turns are still on their way, and a request marked
      // served on the frame before they land is a resume that silently did nothing.
      if (turns.length > 0) servedResume.current = resumeNonce;
      el.scrollTop = el.scrollHeight;
      return;
    }
    servedResume.current = resumeNonce;
    // Queried rather than kept in a ref map: the turn cards are rendered by four different components
    // and a ref per card would be four places to forget one. The attribute is on the wrapper this file
    // renders, so there is exactly one thing to keep in step.
    const node = el.querySelector(`[data-turn-id="${target}"]`);
    // `block: "start"` rather than `center`: the unresolved card's own top edge is where its heading
    // and its buttons are, and centring a tall diff would open on the middle of a file.
    if (node) node.scrollIntoView({ block: "start", behavior: "auto" });
    else el.scrollTop = el.scrollHeight;
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
    planStale(activeThreadId, connectorKey !== plannedConnectors.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectorKey, activeThreadId]);

  // --- Test mode (runs) + voice, folded in from the old run-bar ------------------
  const canRun = connected && Boolean(activeAgentId) && (agent?.runnable ?? false);

  // Promote the current test input into the eval dataset (doc §4.7.6, "one click"). The
  // draft is the subject when there is one, otherwise the remembered last input — so this
  // works both before running and right after, which is when a case proves worth keeping.
  // The server picks/creates the dataset, so this stays a single round trip.
  const promoted = useEvalStore((s) => s.promoted);
  const runCount = useTraceStore((st) => Object.keys(st.runs).length);
  const datasetCount = useEvalStore((st) => st.datasets.length);

  /**
   * §4's attachments, held beside the draft.
   *
   * NOT IN A STORE, and for the same reason the GitHub attachments above are not: they belong to
   * the message being written, they are cleared when it is sent, and nothing outside this composer
   * has a reason to read them. §4.4's "snapshot at send, not at attach" is what makes that safe —
   * the ref is already pinned when it lands here, so a file that changes between attaching and
   * sending does not change what was attached.
   */
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  // Cleared with the thread, like the draft. Attachments are about a message, and that message is
  // gone when the conversation changes.
  useEffect(() => { setAttachments([]); }, [activeThreadId]);

  const addAttachments = useCallback((kind: AttachKind, rows: AttachableRow[]) => {
    setAttachments((current) => {
      const byKey = new Map(current.map((a) => [a.key, a]));
      for (const row of rows) {
        const key = refKey(row.ref);
        // ATTACHING THE SAME THING TWICE IS ONE ATTACHMENT. A picker left open across two searches
        // makes this easy to do by accident, and two identical chips is both noise and double the
        // context budget for one file.
        if (byKey.has(key)) continue;
        // §4.4's cap, enforced here as well as at the route: the eleventh is refused with a
        // sentence rather than silently dropped.
        if (byKey.size >= MAX_ATTACHMENTS) break;
        byKey.set(key, {
          key,
          kind,
          ref: row.ref,
          label: row.label,
          tokenEstimate: row.token_estimate,
          protected: row.protected,
        });
      }
      return [...byKey.values()];
    });
  }, []);

  const removeAttachment = useCallback((key: string) => {
    setAttachments((current) => current.filter((a) => a.key !== key));
  }, []);

  /**
   * Which of the five sources have anything behind them.
   *
   * A SOURCE WITH NOTHING BEHIND IT IS HIDDEN — §4.2's rule about the GitHub entry, generalised:
   * "an empty menu item that always fails is worse than no item". An agent that has never been
   * generated has no file tree, a workspace with no MCP server has no tool schemas, and an unlinked
   * agent has no commits.
   */
  const attachSources = useMemo(() => {
    const kinds = new Set<AttachKind>();
    if (activeAgentId && agentFileOrder.length > 0) kinds.add("file");
    if (runCount > 0) kinds.add("run");
    if (datasetCount > 0) kinds.add("dataset_case");
    if (mcpTools.length > 0) kinds.add("tool_schema");
    // §12.12: hidden when the agent has no `github_links` row. `github.view` is null exactly then.
    if (github.view) kinds.add("github");
    return kinds;
  }, [activeAgentId, agentFileOrder.length, runCount, datasetCount, mcpTools.length, github.view]);

  /**
   * §4.4's budget, computed in the browser for the WARNING and re-computed on the server for the
   * REFUSAL.
   *
   * Two implementations, said out loud rather than pretended away. This one exists because the
   * warning has to move as somebody attaches, and a round trip per chip would make the rail feel
   * broken. The server's is the one that decides: it re-measures every ref at attach time and
   * answers 413 if the turn does not fit, so a client that under-counted cannot talk its way past
   * the limit. What this can do is be WRONG IN THE HARMLESS DIRECTION — warn slightly early — and
   * the estimates it sums came from the server in the first place.
   */
  const attachmentTokens = useMemo(
    () => attachments.reduce((n, a) => n + a.tokenEstimate, 0),
    [attachments],
  );
  const contextWindow = selectedModel?.context_window ?? null;
  const budgetFraction = contextWindow ? attachmentTokens / contextWindow : null;
  const overBudget = budgetFraction !== null && budgetFraction >= 1;
  // Largest first, because the remedy is "remove one" and the largest is the one worth removing.
  const offending = overBudget
    ? [...attachments].sort((a, b) => b.tokenEstimate - a.tokenEstimate).slice(0, 2).map((a) => a.label)
    : [];
  // `unresolved` IS GONE WITH THE FIELD IT READ. It blocked Send on a per-chip error state nothing
  // could set — see `DraftAttachment` — and a send-block that can never fire is a promise in the
  // type system the product does not keep. What CAN block a send is the budget, which is measured
  // from figures the server priced and is now a warning about a payload that genuinely leaves.

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

    /**
     * §4's attachments, on the command that creates the turn.
     *
     * THE LINE THAT DID NOT EXIST. The picker, the rail, the budget meter, the cap, the route and
     * the table were all finished; nothing sent the refs, so a message went out and the chips
     * vanished with the draft having never left the browser. It rides the command rather than a
     * second round trip because at this moment the turn has no id — the server writes the
     * `thread_items` row — which is exactly why `github.attachments` already work this way.
     *
     * REFS ONLY. `tokenEstimate` stays here for the meter and is not sent: the server re-measures
     * every one at attach time, because a client-supplied estimate would let any request through by
     * claiming to be small.
     */
    const attachRefs = attachments.map((a) => ({
      kind: a.kind,
      ref: a.ref,
      agent_id: activeAgentId ?? "",
    }));

    switch (intent.kind) {
      case "generate":
        // Never straight to generation: the plan gate is the only way in, so nothing gets
        // built that the user hasn't seen described first.
        plannedConnectors.current = connectorKey;
        sendPlanAgent(trimmed, selected, name.trim() || undefined, undefined, selectedMcp, attachRefs);
        break;
      case "replan":
        // A revision is planned against the CURRENT selection, so that becomes the new baseline.
        plannedConnectors.current = connectorKey;
        sendPlanAgent(trimmed, selected, name.trim() || undefined, intent.planId, selectedMcp, attachRefs);
        break;
      case "edit":
        if (activeAgentId) sendEdit(activeAgentId, trimmed, attachRefs);
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
          // AND §4's, on the same rule. Two sources, one turn: the GitHub rail and the ⊕ picker
          // both put references on the question, and the server resolves both at send time.
          attachRefs,
        );
        github.clear();
        setGithubTrigger(null);
        break;
      }
    }
    setChatDraft("");
    // WITH THE DRAFT, because they belong to the message that has just gone. The chips used to
    // vanish here having never been sent at all, which is what made the rail a display of
    // something the model never saw; they leave for the same reason now, and they leave having
    // been sent. An attachment outliving its message would silently ground the NEXT one.
    setAttachments([]);
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
    planning: isPlanning(turns),
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
            className="text-caption text-muted"
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
        {/* §5.3's pinned rail. Sticky at the top of the thread, and PERSONAL — the ids in it came
            from a read scoped to this user, and nothing here could ask for anybody else's. */}
        {!anchored && (
          <PinRail
            pins={pinnedTurns}
            collapsed={railCollapsed}
            onToggleCollapsed={() => setRailCollapsed((v) => !v)}
            onOpen={scrollToTurn}
            onUnpin={(itemId) => void togglePin(activeThreadId ?? "", itemId)}
          />
        )}
        {turns.length === 0 && emptySlot}
        {turns.length === 0 && !emptySlot &&
          (mode === "generate" ? (
            <EmptyState
              icon={SparklesIcon}
              title="Describe the agent you want"
              // The worked example lives here now, where it can be read. It used to be inside the
              // placeholder — twenty-two words wrapping to two lines in an empty input, which is
              // what makes an empty field look pre-filled.
              hint={
                <>
                  e.g. “a support agent that reads Gmail, looks up orders in Postgres, and drafts
                  replies”. You’ll get a short plan first — its tools, state and graph — to approve
                  or correct. Nothing is generated until you do.
                </>
              }
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
            <span className={standalone ? `${TYPE.sectionLabel} mr-1` : "text-tiny text-faint mr-1"}>
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
                  icon={on ? <StatusDot state="ok" size={ICON.badge} color={ACCENT.reviewed} /> : undefined}
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
              className="ml-auto w-40 bg-panel text-ink placeholder:text-faint rounded-control px-2.5 py-1 text-caption outline-none focus:shadow-focusring disabled:opacity-50"
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
              className="inline-flex items-center gap-1.5 text-tiny text-faint hover:text-muted transition-colors disabled:opacity-50"
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
              {/* A CHEVRON, NOT A WORD. Disclosure had five vocabularies in this client and two
                  of them were English — which is the icon-first rule inverted, on the one control
                  whose whole meaning is a direction. Down when open, ninety degrees when closed,
                  the same as every tree and section disclosure here. */}
              <span
                className={`text-faint transition-transform duration-fast ${mcpOpen ? "" : "-rotate-90"}`}
                aria-hidden
              >
                <ChevronDownIcon size={ICON.xs} />
              </span>
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
                      className={`flex w-full items-center gap-1.5 rounded-control px-1.5 py-1 text-left text-caption transition-colors disabled:opacity-50 ${
                        on ? "bg-active text-ink" : "text-muted hover:text-ink"
                      }`}
                    >
                      {/* Fixed-width slot so a control never resizes because you used it —
                          the same reason the connector chips reserve theirs. */}
                      <span className="inline-flex w-[11px] shrink-0 items-center justify-center" aria-hidden>
                        {on && <StatusDot state="ok" size={ICON.badge} color={ACCENT.mcp} />}
                      </span>
                      <Truncate className="">{t.name}</Truncate>
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
          <div className="mb-2 flex items-center gap-2 text-tiny">
            {/* What the app is doing. The routing hint on the right says where a message would go;
                this says what is going on regardless of whether anything has been typed. */}
            {moment.status && (
              <span className="inline-flex items-center gap-1.5 text-muted">
                {busy && <StatusDot state="pending" icon={LoaderIcon} spin size={ICON.xs} />}
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
                in it — a hint claiming otherwise would be the composer misdescribing itself.

                A KEYCAP AND THE VERB. It was the sentence `⌘↵ will plan a new agent`, right-aligned
                directly above an input — which is a line of chrome in the one place a placeholder
                should be doing the talking. And the chord was two font characters set inline, while
                the command palette three keystrokes away draws its own keys as bordered caps: the
                app has a primitive for exactly this shape of thing and two call sites went around
                it. */}
            {composerMode === "chat" && text.trim() && (
              <span className="ml-auto flex items-center gap-1.5 text-faint">
                <kbd className={`${chipClass({ size: "sm", mono: true, tone: "faint" })} shadow-[inset_0_0_0_1px_theme(colors.hair)]`}>
                  ⌘↵
                </kbd>
                {routeLabel(intent)}
              </span>
            )}
          </div>
        )}

        {/* the card — textarea sits directly in it; only the toggle + send read as solid elements */}
        {/* On first run it carries a resting glow. The screen has one thing to do and this is
            it, and a box that only lights up once you have already found it is not an anchor —
            it is a form field that happens to be focusable. In the three-column app the composer
            is one of several places to look and it goes back to a hairline and a shadow. */}
        {/* §3.2's re-parenting. The composer below is written ONCE; the shell decides whether it
            renders here at the bottom of the thread or inside the expanded dialog. Every piece of
            its state — draft, attachments, mode, model — is held above this line, which is what
            makes "the same composer state, re-parented" true rather than aspirational. */}
        <ComposerShell fullscreen={fullscreen} onClose={() => setFullscreen(false)} onSend={submit}>
        <div
          // ON THE GRID, AND IN CLASSES. It was `padding: "14px 16px 12px"` as an inline style —
          // the only inline padding in the app, on the app's most important control, off the 4px
          // grid on two of its three axes.
          //
          // In the dialog it drops its own border, radius and shadow and fills instead: the dialog
          // already IS the raised box, and a card inside a card is two edges saying one thing.
          className={
            fullscreen
              ? "flex min-h-0 flex-1 flex-col bg-panel p-4 pb-3"
              : `rounded-modal border border-edge bg-panel p-4 pb-3 transition-shadow duration-fast
                 focus-within:shadow-focusring ${standalone ? "shadow-glow" : "shadow-raised"}`
          }
        >
          {/* WHAT THE TIER JUST REFUSED, above the input and inside the composer card.
              Inline rather than as a modal, per the specification: a fourth agent on Free is
              refused at the moment somebody presses Generate, and taking the screen away to say so
              would cost them the prompt they had just written. Here it sits directly over the
              control that did not work, with the sentence still in the box. */}
          <div className="empty:hidden [&>*]:mb-3">
            <UpsellCard channel="gen" onUpgrade={() => openUsageTab("usage")} />
          </div>

          {/* WHAT A WORKSPACE POLICY JUST REFUSED, in the same place and for the same reason as the
              tier upsell above it: the control that did not work is a few pixels below, and the
              sentence the server sent names the policy rather than saying "couldn't save".

              Rendered rather than prevented. This control can be looking at a stale row when an
              admin pins the mode, and a control that silently snapped back would read as the app
              being broken instead of as a rule being applied. */}
          {settingsError && (
            <div className="mb-3 flex items-start gap-2 rounded-card border border-edge bg-bg px-2.5 py-2 text-tiny text-muted">
              <span className="shrink-0" style={{ color: STATUS.warn }} aria-hidden>
                <AlertTriangleIcon size={ICON.xs} />
              </span>
              <span className="min-w-0 flex-1" role="status">{settingsError}</span>
              <button
                type="button"
                onClick={clearSettingsError}
                aria-label="Dismiss"
                className="shrink-0 text-faint transition-colors duration-fast hover:text-ink"
              >
                <XIcon size={ICON.xs} />
              </button>
            </div>
          )}

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

          {/* Band 1 — §3.1's attachment rail. CONTENT rather than controls, which is why it sits
              with the text it belongs to rather than in the bottom bar: chips are variable-length,
              and in the control bar they would push every button around as they wrapped. */}
          <AttachmentRail attachments={attachments} onRemove={removeAttachment} />

          {/* §4.4 and §9's budget. A warning at 70%, a BLOCK at 100% naming what to remove.
              Blocking is the half that matters: the alternative is a request that fits by having
              been quietly cut, and §4.4 is blunt about it — "Silent truncation is the worst
              possible behavior here — it produces a confident answer grounded in half a file." */}
          {attachments.length > 0 && budgetFraction !== null && budgetFraction >= WARN_AT && (
            <div
              className="mb-2 flex items-start gap-2 rounded-card border border-edge bg-bg px-2.5 py-2 text-tiny"
              role="status"
            >
              <span className="shrink-0" style={{ color: overBudget ? STATUS.error : STATUS.warn }} aria-hidden>
                <AlertTriangleIcon size={ICON.xs} />
              </span>
              <span className="min-w-0 flex-1 text-muted">
                {overBudget ? (
                  <>
                    This turn&apos;s context is about {budgetPercent(attachmentTokens, contextWindow)}% of what{" "}
                    {selectedModel?.id ?? "this model"} can hold. Remove {offending.join(" or ")} to send it.
                  </>
                ) : (
                  <>
                    Using about {budgetPercent(attachmentTokens, contextWindow)}% of the model&apos;s context.
                  </>
                )}
              </span>
            </div>
          )}

          {/* input slot: the textarea and the live waveform crossfade in place (~200ms) so the
              transition from typing to recording is smooth and the card doesn't jump. */}
          <div
            className={fullscreen ? "relative min-h-0 flex-1" : "relative"}
            style={{ height: showWave ? recordHeight : undefined }}
          >
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
                  // §3.2: ⌘↵ in the expanded editor sends AND collapses. The dialog binds this
                  // too, for when focus is on a control rather than in the text; both paths end
                  // in the same two calls rather than in two ideas of what the chord does.
                  if (fullscreen) setFullscreen(false);
                  return;
                }
                // §3.3: ↑ on an EMPTY composer brings the last message back as a draft. Guarded on
                // emptiness because on a composer with text in it ↑ is how you move the caret up a
                // line, and taking that would make the twelve-line editor unusable.
                if (e.key === "ArrowUp" && text === "" && editLastUserMessage()) e.preventDefault();
                // §4.3: "Backspace in an empty textarea removes the last chip." Guarded on empty
                // for the same reason ↑ is — in a box with text in it, Backspace deletes a
                // character, and taking that would be unusable.
                if (e.key === "Backspace" && text === "" && attachments.length > 0) {
                  e.preventDefault();
                  removeAttachment(attachments[attachments.length - 1]!.key);
                }
              }}
              rows={1}
              placeholder={moment.placeholder}
              // 14px, in a class. It is still deliberately off the 11/12/13 chrome ladder — this
              // is the sentence the user writes and it should be the largest text on the screen —
              // but a half-pixel size that exists once, as an inline style, is a value nobody can
              // maintain or match.
              className="w-full resize-none bg-transparent text-body leading-[1.5] text-ink outline-none transition-opacity duration-base placeholder:text-muted focus-visible:shadow-focusring"
              style={{
                minHeight: LINE_PX,
                // In the dialog there is no 12-line cap — the box IS the editor, and it fills
                // whatever the 70vh dialog gives it.
                maxHeight: fullscreen ? undefined : LINE_PX * MAX_LINES,
                height: fullscreen ? "100%" : undefined,
                overflowY: "auto",
                opacity: showWave ? 0 : 1,
                pointerEvents: showWave ? "none" : "auto",
                position: showWave ? "absolute" : "relative",
                inset: showWave ? 0 : undefined,
              }}
            />
            <div
              className="absolute inset-0 transition-opacity duration-base"
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

          {/* Band 3 — the control bar. §3.1: every composer control lives in this one row at the
              bottom of the card. Nothing renders above the textarea except attachment chips, and
              nothing floats inside it.

              THE CONTROLS ARE A MAP, NOT A LAYOUT. Which side of the spacer each one sits on, what
              collapses below which width, and where the `⋯` goes are decided in
              lib/composerBar.ts, where they are rules a suite can check rather than a class string
              somebody reads. A control that is absent — the deck with no connectors, promote
              outside Test mode — is simply not a key here, and §12.1c is the promise that its
              absence moves nothing else. */}
          <ComposerBar
            className="mt-3"
            controls={{
              add: {
                bar: () => (
                  <AddMenu
                    agentId={activeAgentId}
                    available={attachSources}
                    unavailable={agentFileOrder.length === 0 ? agentFilesError : null}
                    onPick={addAttachments}
                    disabled={busy}
                    openSignal={attachChordNonce}
                  />
                ),
              },
              fullscreen: {
                bar: () => (
                  <ControlButton
                    icon={Icon.Fullscreen}
                    name={fullscreen ? "Collapse the composer" : "Expand the composer"}
                    title={
                      fullscreen
                        ? "Collapse (Esc)"
                        : "Write in a larger editor (⌘⇧F) — keeps your text, attachments and settings"
                    }
                    pressed={fullscreen}
                    active={fullscreen}
                    onClick={() => setFullscreen(!fullscreen)}
                  />
                ),
              },
              effort: {
                bar: (density: Density) => (
                  <EffortControl
                    value={effort}
                    model={selectedModel}
                    dense={!showsLabel(density)}
                    disabled={busy}
                    remembered={settings.explicit.effort}
                    onPick={(level, remember) => {
                      // UNCHECKED IS THE DEFAULT AND IT WRITES NOTHING. The level applies to the
                      // next turn and is forgotten after it; only "Remember" reaches the server.
                      setEffortOverride(level);
                      if (remember) void patchSettings(activeThreadId, { reasoning_effort: level });
                    }}
                  />
                ),
                menu: () => (
                  <PopoverRow
                    label="Reasoning effort"
                    detail={
                      selectedModel?.reasoning
                        ? effortLabel(effort)
                        : `${selectedModel?.id ?? "This model"} doesn't expose a reasoning control.`
                    }
                    disabled={!selectedModel?.reasoning || busy}
                    onSelect={() => {
                      // Cycles rather than opening a second popover inside the overflow one. A
                      // nested menu at this width is a menu that does not fit on the screen it is
                      // collapsing for, and the four levels are a ring somebody can step round.
                      const order: Effort[] = ["low", "medium", "high", "xhigh"];
                      setEffortOverride(order[(order.indexOf(effort) + 1) % order.length]!);
                    }}
                  />
                ),
              },
              shield: {
                bar: (density: Density) => (
                  <ShieldControl
                    value={settings.permission_mode}
                    dense={!showsLabel(density)}
                    pinned={settings.permission_mode_pinned}
                    fastDisallowed={settings.fast_disallowed}
                    disabled={busy}
                    // ALWAYS PERSISTED, unlike effort. The two look like the same kind of control
                    // and are not: effort is a property of the question being asked, while the
                    // shield is a policy about what an agent may do — and a policy that reverted
                    // after one turn would be a policy nobody could rely on. There is deliberately
                    // no "just for this turn" here.
                    onPick={(mode: PermissionMode) => void patchSettings(activeThreadId, { permission_mode: mode })}
                  />
                ),
                menu: () => (
                  <PopoverRow
                    label="Permission mode"
                    detail={
                      settings.permission_mode_pinned
                        ? `pinned to ${modeLabel(settings.permission_mode)} by a workspace policy`
                        : modeLabel(settings.permission_mode)
                    }
                    disabled={settings.permission_mode_pinned || busy}
                    onSelect={() => {
                      // Cycles the three, skipping Fast where an admin has disallowed it — the same
                      // reason the bar's own popover renders that row disabled rather than hidden.
                      const order: PermissionMode[] = settings.fast_disallowed
                        ? ["strict", "smart"]
                        : ["strict", "smart", "fast"];
                      const at = order.indexOf(settings.permission_mode);
                      void patchSettings(activeThreadId, { permission_mode: order[(at + 1) % order.length]! });
                    }}
                  />
                ),
              },
              // §3.2's deck. Absent with zero connectors, which is §12.1c's own worked example:
              // its absence must move nothing else, and it does not, because both groups are
              // packed against their own edge rather than spread.
              ...(deckConnectors.length > 0
                ? {
                    connectors: {
                      bar: () => (
                        <ConnectorDeck
                          connectors={deckConnectors}
                          disabled={busy}
                          onToggle={(id, on) => void toggleConnector(activeThreadId, id, on)}
                          onAddConnector={() => openUsageTab("connections")}
                        />
                      ),
                      menu: () => (
                        <PopoverRow
                          label="Connectors"
                          detail={`${deckConnectors.filter((c) => c.enabled).length} of ${deckConnectors.length} available here`}
                          onSelect={() => openUsageTab("connections")}
                        />
                      ),
                    },
                  }
                : {}),
              // Test mode only: the input IS an eval example, so promotion belongs on the bar
              // beside the thing being promoted rather than in the Evals tab — that is where a
              // case earns its place.
              ...(composerMode === "test" && activeAgentId
                ? {
                    promote: {
                      bar: (density: Density) => (
                        <ControlButton
                          icon={Icon.AttachDataset}
                          name="Save this test input to the eval dataset"
                          label={
                            showsLabel(density) && promoted
                              ? promoted.duplicate ? "already saved" : "saved"
                              : undefined
                          }
                          title={
                            promoted
                              ? promoted.duplicate
                                ? `already in ${promoted.datasetName}`
                                : `saved to ${promoted.datasetName}`
                              : promotable
                                ? "Save this test input to the eval dataset"
                                : "Type or run a test input first"
                          }
                          active={Boolean(promoted)}
                          disabled={!connected || !promotable}
                          onClick={promote}
                        />
                      ),
                      menu: () => (
                        <PopoverRow
                          label="Save to eval dataset"
                          detail={promoted ? `saved to ${promoted.datasetName}` : "turn this test input into a case"}
                          disabled={!connected || !promotable}
                          onSelect={promote}
                        />
                      ),
                    },
                  }
                : {}),
              model: {
                bar: () => (
                  <ModelSelector provider={provider} model={model} setModel={setModel} />
                ),
              },
              mode: {
                bar: () => (
                  // Two chips in a track — unchanged from v0.2.2 except for where it sits. The
                  // active segment is panel surface with an accent label rather than an ink fill:
                  // a mode is a state, not an act, and the app's one ink-filled control on this
                  // screen is the thing you press.
                  <div className="flex shrink-0 items-center rounded-full bg-active p-0.5">
                    {(["chat", "test"] as const).map((m) => {
                      const active = composerMode === m;
                      return (
                        <Chip
                          key={m}
                          size="lg"
                          onClick={() => setComposerMode(m)}
                          variant={active ? "fill" : "bare"}
                          color={active ? INTERACTION.accent : undefined}
                          background={active ? SURFACE.panel : undefined}
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
                ),
              },
              mic: {
                bar: () => (
                  <ControlButton
                    icon={Icon.Mic}
                    name={voice.listening ? "Stop voice input" : "Voice input"}
                    title={
                      voice.supported
                        ? voice.listening
                          ? "Stop voice input"
                          : "Voice input"
                        : "Voice input isn't supported in this browser"
                    }
                    pressed={voice.listening}
                    disabled={!voice.supported || busy}
                    onClick={voice.toggle}
                    className={voice.listening ? "text-run animate-stream-pulse motion-reduce:animate-none" : ""}
                  />
                ),
              },
              send: {
                bar: () => (
                  <button
                    type="button"
                    onClick={submit}
                    // §9: over the context budget, or holding an attachment that would not
                    // resolve, send is BLOCKED rather than allowed to truncate. The notice above
                    // the input says which, so a disabled button is never unexplained.
                    disabled={
                      !connected || !text.trim() || overBudget
                      || (composerMode === "test" ? !canRun : busy)
                    }
                    aria-label={composerMode === "test" ? "Run the agent on this input" : "Send"}
                    title={composerMode === "test" ? "Run the agent on this input" : "Send (⌘↵)"}
                    // The one ink-filled control on the screen, and the only one in this bar that
                    // is not a glyph on open background. §3.2: the only change here is the
                    // registry icon and the 32px hit target the rest of the bar now shares.
                    className="flex shrink-0 items-center justify-center rounded-full transition-opacity
                      focus-visible:outline-none focus-visible:shadow-focusring
                      disabled:cursor-not-allowed disabled:opacity-30"
                    style={{ width: HIT_TARGET, height: HIT_TARGET, background: TEXT.ink, color: SURFACE.bg }}
                  >
                    <Glyph icon={Icon.Send} size={GLYPH.toolbar} />
                  </button>
                ),
              },
            }}
          />
        </div>
        </ComposerShell>
      </div>
    </div>
  );
}
