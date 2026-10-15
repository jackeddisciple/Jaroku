// One step of a trace: what ran, what kind of thing it was, and what it cost.
//
// IT WAS A SENTENCE ON ONE LINE — `#3 ⚒ Called get_time   1,204 tok  $0.0031  820 ms` — drawn through
// the shared ActionRow. That read well for eight steps and badly for eighty: every row was the same
// weight, the verb repeated what the icon already said, and a 60-character tool name pushed the
// figures onto a second line wherever it happened to land.
//
// NOW THE NAME LEADS AND THE KIND SITS UNDER IT. The step's own name is what somebody scans a trace
// for, so it is first and in ink; the kind ("LLM call", "Tool call") is the quiet line beneath, and a
// failure says "failed" there beside a warning mark — never the colour alone. The
// figures keep their own right-hand column, so they line up down the trace however long a name gets.
//
// THE MARKS ARE HUGEICONS, ONE PER KIND OF STEP, in the kind's own STEP_TYPE colour on a tile of the
// same colour (the product owner's call, 2026-10-12). The tile is the row's node on the timeline's line.
//
// A CLICK SELECTS, AND ONLY SELECTS. The step lights its node on the graph and becomes what the
// composer is talking about, exactly as before — but the details drawer no longer slides over the
// timeline on every click. It opens from the row's Details button, or Enter, on purpose. Once it is
// open it follows the selection (see `selectStep`), so it never shows one step beside another's row.

import { useEffect, useRef } from "react";

import { fmtCost, fmtDuration, fmtOffset, tokenCount } from "../lib/format.ts";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";
import { matchPlaces, rerunBlocked, stepCategory, stepProvider, type StepCategory, type VisibleRow } from "../lib/traceView.ts";
import { BRAND_COLOR, ProviderMark, hasProviderMark } from "../lib/icons.tsx";
import { kindWord, type StepMark } from "./traceMarks.ts";
import { ICON, METRIC, PINNED, STATUS, STEP_TYPE, SURFACE, TEXT, VIEWED } from "../lib/tokens.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { agentMcpToolNames } from "../store/mcpStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { markTraceStep, sendBranchRun } from "../lib/socket.ts";
import { stepNodeId } from "../lib/traceGraphMap.ts";
import type { Step } from "../types.ts";
import { McpBadge } from "./McpBadge.tsx";

/** The one colour a step is drawn in — its tile, its bar: red if it failed, else its own. */
export function stepColour(step: Pick<Step, "type" | "error" | "name">, provider?: string | null, mark?: StepMark): string {
  if (step.error) return STATUS.error;
  if (mark) return mark.colour;
  const brand = stepProvider(step, provider);
  if (brand && BRAND_COLOR[brand]) return BRAND_COLOR[brand]!;
  const known = STEP_TYPE[step.type as keyof typeof STEP_TYPE] as { fg: string } | undefined;
  return known ? known.fg : TEXT.muted;
}

/** Each kind of step's mark, from the app's Hugeicons set — the product owner's call on 2026-10-12. */
const STEP_MARK: Record<StepCategory, IconComponent> = {
  llm: Icon.trace.modelStep,
  tool: Icon.trace.toolStep,
  state: Icon.trace.stateStep,
  route: Icon.trace.routeStep,
  other: Icon.trace.otherStep,
};

/**
 * A tile's ground: the step's own colour, mixed strong enough to read AS that colour. It was the
 * STEP_TYPE wash — about six percent — which the product owner found too light to see; a fifth of
 * the colour keeps the mark legible on it and the kinds tellable apart at a glance.
 */
export const tileTint = (colour: string): string => `color-mix(in srgb, ${colour} 20%, white)`;

/**
 * The tile behind a step's mark: its kind's colour, red for a failure, grey for a kind we don't know.
 *
 * A MODEL CALL WEARS ITS PROVIDER'S LOGO — Claude's for Anthropic, OpenAI's for OpenAI — on a tile of
 * that brand's colour (the product owner's call, 2026-10-12). A provider without a logo here keeps
 * the Hugeicons model mark.
 */
export function StepTile({
  step,
  provider,
  mark,
  size = "md",
}: {
  step: Pick<Step, "type" | "error" | "name">;
  provider?: string | null;
  /** This step's own mark and colour in its run (traceMarks). */
  mark?: StepMark;
  /** `lg` for the details drawer's header, where the tile introduces the step. */
  size?: "md" | "lg";
}) {
  const box = size === "lg" ? "h-8 w-8 rounded-control" : "h-[22px] w-[22px] rounded-sm";
  const glyph = size === "lg" ? ICON.md : ICON.sm;
  const brand = stepProvider(step, provider);
  if (brand && hasProviderMark(brand)) {
    const colour = step.error ? STATUS.error : BRAND_COLOR[brand] ?? TEXT.muted;
    return (
      <span
        aria-hidden
        className={`flex shrink-0 items-center justify-center ${box}`}
        style={{ background: tileTint(colour) }}
      >
        <ProviderMark provider={brand} size={glyph} />
      </span>
    );
  }
  if (mark) {
    const colour = step.error ? STATUS.error : mark.colour;
    return (
      <span
        aria-hidden
        className={`flex shrink-0 items-center justify-center ${box}`}
        // A connector's logo keeps its own colours; a glyph takes the step's.
        style={{ background: tileTint(colour), color: mark.brand ? undefined : colour }}
      >
        <mark.Icon size={glyph} />
      </span>
    );
  }
  const Mark = STEP_MARK[stepCategory(step)];
  const known = STEP_TYPE[step.type as keyof typeof STEP_TYPE] as { fg: string } | undefined;
  const colour = step.error ? STATUS.error : known ? known.fg : TEXT.muted;
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center ${box}`}
      style={{ background: tileTint(colour), color: colour }}
    >
      <Mark size={glyph} />
    </span>
  );
}

/**
 * How much of a row's right-hand side the list's width can afford. THE NAME ALWAYS WINS: a row that
 * kept its figures and lost its name would be a row of numbers about nothing. Cost goes first (it is
 * in the details), then tokens; the duration stays, and Details floats instead of holding a slot.
 */
export type RowTier = "full" | "wide" | "medium" | "narrow";

/** The heaviest step's figures in the run — what each row's mini bars are a share of. */
export interface MetricScale {
  tokens: number;
  cost: number;
  time: number;
}

/**
 * A FIGURE'S SHARE, DRAWN (2026-10-14): a hairline bar under the number, as long as this step's share of
 * the run's heaviest, in the figure's own colour (METRIC) — so the heavy steps stand out down the column
 * before a digit is read. Right-aligned under the right-aligned number; nothing for an unknown figure.
 */
function MiniBar({ value, max, colour }: { value: number | null; max: number; colour: string }) {
  // Nothing for an unknown figure or a zero: a stub under "0ms" would say there was something.
  if (value == null || !(value > 0) || !(max > 0)) return null;
  const share = Math.min(1, Math.max(0, value / max));
  // Under a hundredth of the heaviest is nothing worth drawing — a 0.05ms router would be a stub.
  if (share < 0.01) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute -bottom-1 right-0 h-0.5 rounded-full"
      style={{ width: `max(2px, ${share * 100}%)`, background: colour, opacity: 0.75 }}
    />
  );
}

/** Where a step's bar sits in the waterfall, as fractions of the run's span. */
export interface BarPlace {
  left: number;
  width: number;
  /** When it began, relative to the run's start, for the tooltip — signed: a clock can be a little off. */
  offsetMs: number;
}

/**
 * WHEN THE STEP RAN, against the whole run. The bar starts where the step really began and ends where
 * it finished — `started_at` is stamped as a step ends, so its start is that minus its duration — and
 * so a node's bar spans its model call's, steps that overlapped are drawn overlapping, and the gaps
 * between nodes are visible as gaps rather than invented away.
 */
function Waterfall({ step, bar, colour, inherited }: { step: Step; bar: BarPlace | null; colour: string; inherited: boolean }) {
  return (
    <span
      className={`relative h-1.5 shrink-0 rounded-full bg-void ${COL.timeline}`}
      title={
        bar ? `Started ${fmtOffset(bar.offsetMs)} · took ${fmtDuration(step.latency_ms)}`
          // AN INHERITED STEP HAS NO BAR: it ran in the parent, before this run began.
          : inherited ? "Ran in the run this one branched from, before this run began"
            : "No timing recorded"
      }
    >
      {bar && (
        <span
          aria-hidden
          // The step's own colour — the same one as its tile — so a bar is findable from its row.
          className="absolute bottom-0 top-0 rounded-full"
          style={{
            left: `${bar.left * 100}%`,
            // Never thinner than a hair, so a 0ms routing decision still marks its moment.
            width: `max(2px, ${bar.width * 100}%)`,
            backgroundColor: colour,
            opacity: step.error ? 0.8 : 0.6,
          }}
        />
      )}
    </span>
  );
}

/** What a folded node stands for: its steps, what they cost, and whether any of them failed. */
export interface FoldSummary {
  steps: number;
  tokens: number | null;
  cost: number | null;
  failed: number;
}

/**
 * THE FIGURE COLUMNS, AT FIXED WIDTHS — so every row's numbers line up in a column, a node's empty
 * cells included. There are no headings over them (the product owner's call, 2026-10-12): the figures
 * say what they are. Narrow enough that a nested step's name keeps a hundred-odd pixels.
 */
export const COL = {
  // Tokens and time carry their marks (the product owner's call, 2026-10-12), 16px of each column.
  tokens: "w-14",
  cost: "w-14",
  time: "w-14",
  timeline: "w-16",
  /** The Viewed box (2026-10-14), held on every row so the figures stay one column. */
  viewed: "w-6",
  /** Re-run and Details, two marks side by side on every row. */
  actions: "w-[3.75rem]",
} as const;

/** Which columns a width tier can afford — every row, and the live row, read the same answer. */
export const columnsFor = (tier: RowTier) => ({
  tokens: tier !== "narrow",
  cost: tier === "wide" || tier === "full",
  timeline: tier === "full",
  // ALWAYS: re-run and details are on every row at every width (the product owner's call, 2026-10-14).
  actions: true,
});

/** A name with the searched-for words marked — every place they occur, ignoring case. */
function Marked({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (let i = text.toLowerCase().indexOf(q); q && i !== -1; i = text.toLowerCase().indexOf(q, at)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<mark key={i} className="rounded-xs bg-ink/10 text-inherit">{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * "VIEWED", AS A CODE REVIEW TICKS OFF A FILE (2026-10-14): a box at the end of every row, filled green
 * with a white tick once somebody has read the step — theirs alone, kept on the server. Empty, it shows
 * only under the pointer or on the selected row, so a run nobody has reviewed is not a column of boxes.
 * V marks the selected step from the keyboard.
 */
/** The box itself: green with a white tick when viewed, an empty grey square when not. */
function ViewedMark({ viewed }: { viewed: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-xs border ${viewed ? "" : "border-grip"}`}
      style={viewed ? { backgroundColor: VIEWED, borderColor: VIEWED, color: SURFACE.elevated } : undefined}
    >
      {viewed && <Icon.trace.viewedTick size={ICON.badge} />}
    </span>
  );
}

function ViewedBox({ runId, step, viewed }: { runId: string; step: Step; viewed: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={viewed}
      // Out of the Tab order, like Details beside it: the keyboard has V.
      tabIndex={-1}
      aria-label={`Viewed: #${step.seq} ${step.name}`}
      title={viewed ? "Viewed — press to unmark (V)" : "Mark as viewed (V)"}
      onClick={(e) => {
        e.stopPropagation();
        markTraceStep(runId, step.id, "viewed", !viewed);
      }}
      // ON EVERY ROW, ALWAYS (the product owner's call, 2026-10-14): a review is read down the column
      // of boxes, and a box that appears only under the pointer cannot be read that way.
      className={`flex h-7 ${COL.viewed} shrink-0 items-center justify-center rounded-control focus-visible:outline-none focus-visible:shadow-focusring`}
    >
      <ViewedMark viewed={viewed} />
    </button>
  );
}


/** Re-run from this step as it was — the drawer's first button, from the row. Why not, when it can't. */
function rerunFromRow(step: Step): void {
  const st = useTraceStore.getState();
  const runId = st.activeRunId;
  const bucket = runId ? st.stepsByRun[runId] : undefined;
  if (!runId || !bucket) return;
  const blocked = rerunBlocked(step as Step & { checkpoint_id?: string | null }, Object.values(st.runs), st.boundaryByRun[runId]);
  if (blocked) {
    useUiStore.getState().showToast(`Can't re-run from #${step.seq}: ${blocked.charAt(0).toLowerCase()}${blocked.slice(1)}`);
    return;
  }
  sendBranchRun(runId, step.seq, stepNodeId(step, bucket) ?? undefined);
}

export function StepRow({
  row,
  tabbable,
  tier,
  fold,
  bar,
  provider,
  mark,
  inherited = false,
  scale,
}: {
  row: VisibleRow;
  tabbable: boolean;
  tier: RowTier;
  /** Set while this node is folded: what its hidden steps add up to. */
  fold?: FoldSummary;
  /** Its place in the run's waterfall, or null when its times can't say. */
  bar: BarPlace | null;
  /** The run's provider, for a model call whose class does not name one. */
  provider?: string | null;
  /** This step's own mark and colour (traceMarks). */
  mark?: StepMark;
  /** Copied into this branch from the run it branched from, not run by it (`isInherited`). */
  inherited?: boolean;
  /** The run's heaviest figures, for the mini bars under this row's own. */
  scale?: MetricScale;
}) {
  const { step } = row;
  const group = row.childIds.length > 0;
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId));
  const mcpNames = agentMcpToolNames(agent?.mcp_tools);
  const expanded = useTraceStore((s) => s.expandedStepId === step.id);
  const query = useTraceStore((s) => s.stepQuery);
  const selected = useTraceStore((s) => s.selectedStepId === step.id);
  const runId = useTraceStore((s) => s.activeRunId);
  const viewed = useTraceStore((s) => (s.activeRunId ? s.marksByRun[s.activeRunId]?.[step.id]?.viewed === true : false));
  const pinned = useTraceStore((s) => (s.activeRunId ? s.marksByRun[s.activeRunId]?.[step.id]?.pinned === true : false));
  const rowRef = useRef<HTMLDivElement>(null);

  // When selected from elsewhere (a graph-node click, J/K), bring the row into view — and again when
  // its details open, which docks them under a narrow list and can push the row out of it.
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected, expanded]);

  const select = (): void => {
    useTraceStore.getState().selectStep(step.id);
    useUiStore.getState().setSelectedNodeId(null); // composer context is now this step
  };
  const toggleDetails = (): void => {
    select();
    useTraceStore.getState().setExpandedStep(expanded ? null : step.id);
  };

  // What the Graph calls this node, when it is one the graph has — the two tabs say the same word.
  const kind = kindWord(step, mark);
  // WHERE A SEARCH FOUND IT, for a row that matched (not one kept as context): its name is marked
  // where the words are, and anywhere else is said under it.
  const places = !row.context && query.trim() ? matchPlaces(step, query) : [];
  const elsewhere = places.filter((p) => p !== "name");
  const show = columnsFor(tier);
  const tokens = step.tokens ?? fold?.tokens ?? null;
  const cost = step.cost ?? fold?.cost ?? null;
  const failed = step.error != null;

  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={group ? !row.collapsed : undefined}
      aria-selected={selected}
      aria-label={`#${step.seq} ${step.name}, ${kind}${inherited ? ", inherited" : ""}${failed ? ", failed" : ""}`}
      data-step-id={step.id}
      tabIndex={tabbable ? 0 : -1}
      onClick={select}
      onKeyDown={(e) => {
        // ENTER IS THIS ROW'S, AND ONLY THIS ROW'S. The window-wide Enter (CommandPalette) toggles the
        // selected step too; letting it through would toggle twice — from the row, and from a button in
        // it — and leave the drawer where it was.
        if (e.key !== "Enter" && e.key !== " ") return;
        e.stopPropagation();
        if (e.target !== e.currentTarget) return; // a button in the row is handling its own press
        e.preventDefault();
        toggleDetails();
      }}
      className={`group/step relative isolate flex animate-slide-in cursor-pointer select-none items-center gap-2 rounded-control py-1.5 pl-2 pr-1 outline-none transition-colors duration-fast focus-visible:shadow-focusring motion-reduce:animate-none ${
        selected ? "bg-active" : "hover:bg-active/40"
      } ${row.context || inherited ? "text-muted [&_.text-ink]:text-muted" : ""}`}
      // NO BACKGROUND OF ITS OWN (the product owner's call, 2026-10-14): a red wash on the heavy steps
      // read as a failure, and a grey hatch on an inherited one read as nothing anyone could name. An
      // inherited step is dimmed and says "inherited"; the heavy ones show in their mini bars.
      // A row kept only so a match keeps its place in the tree reads quieter than the matches.
      title={row.context ? "Shown because a step inside it matches" : undefined}
    >
      {/* The same selection mark the other lists use — inset, square, ink. */}
      {selected && <span aria-hidden className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent" />}

      {/* LEFT-ALIGNED, so every row's # stands in one column whatever its number's digits. */}
      <span className="w-7 shrink-0 text-left text-tiny tabular-nums text-faint">#{step.seq}</span>
      {/* NO INDENT AND NO TREE LINES (the product owner's call, 2026-10-14): a node is its card's header
          row, and every step inside it sits level with the others below it — the staircase of
          elbows read as nesting to be decoded rather than a list to be read. */}
      <span className="flex shrink-0 items-center">
        {/* THE FOLD, FOR A POINTER. A span rather than a button: the row is the tree item and owns the
            keys (← folds, → unfolds), and a button here would be one more tab stop per node. */}
        <span
          aria-hidden
          onClick={
            group
              ? (e) => {
                  e.stopPropagation();
                  useTraceStore.getState().setCollapsed(step.id, !row.collapsed);
                }
              : undefined
          }
          className={`mr-1 flex h-4 w-4 items-center justify-center rounded-xs ${
            group ? "text-faint transition-colors hover:bg-active hover:text-ink" : ""
          }`}
        >
          {group && (
            <span className={`transition-transform duration-fast ${row.collapsed ? "-rotate-90" : ""}`}>
              <Icon.trace.fold size={ICON.xs} />
            </span>
          )}
        </span>
        <StepTile step={step} provider={provider} mark={mark} />
      </span>

      <span className="relative min-w-[4.5rem] flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-caption font-medium text-ink" title={step.name}>
            {places.includes("name") ? <Marked text={step.name} query={query} /> : step.name}
          </span>
          {/* Derived from the AGENT's manifest, not from the step: the frozen Step schema has no
              provenance field and must not grow one. */}
          {step.type === "tool_call" && mcpNames.has(step.name) && <McpBadge variant="compact" />}
          {/* PINNED, IN VIOLET (2026-10-14): one of the steps somebody keeps coming back to. P walks them. */}
          {pinned && (
            <span className="shrink-0" style={{ color: PINNED }} title="Pinned — P and Shift+P go from pin to pin">
              <Icon.trace.pinStep size={ICON.xs} />
              <span className="sr-only">pinned</span>
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-tiny text-faint">
          {/* The kind keeps its word; where a search matched gives way first. */}
          <span className={elsewhere.length > 0 ? "shrink-0" : "truncate"}>{kind}</span>
          {elsewhere.length > 0 && (
            <span className="min-w-0 truncate text-muted" title={`The search matched this step's ${elsewhere.join(", ")}`}>
              · matched in {elsewhere.join(", ")}
            </span>
          )}
          {/* SAID, NOT ONLY SHOWN. A branch's copied prefix looked exactly like the steps it ran: now the
              row is dimmed, and the word comes with a link mark (copied, not re-run). */}
          {inherited && (
            <span className="flex shrink-0 items-center gap-1" title="Copied from the run this one branched from — it ran there, before this run began, and was not re-run">
              · <span aria-hidden className="shrink-0"><Icon.trace.inherited size={ICON.xs} /></span>inherited
            </span>
          )}
          {fold && <span className="shrink-0">· {fold.steps} {fold.steps === 1 ? "step" : "steps"}</span>}
          {/* A FAILURE INSIDE A FOLD IS STILL SAID. Folding a node must never be how an error disappears. */}
          {fold && fold.failed > 0 && !failed && (
            <span className="flex shrink-0 items-center gap-1 text-err" title="A step inside this one failed">
              <Icon.trace.failed size={ICON.xs} />
              {fold.failed} failed inside
            </span>
          )}
          {failed && (
            <span className="flex shrink-0 items-center gap-1 text-err" title="This step failed">
              <Icon.trace.failed size={ICON.xs} />
              failed
            </span>
          )}
        </span>
      </span>

      {/* Figures, tabular, and only the ones this step has: a node has no tokens of its own. An
          inherited step's are quieter: its parent spent them, and the run's totals leave them out. */}
      <span className={`flex shrink-0 items-center gap-2 text-tiny tabular-nums ${inherited ? "text-faint" : "text-muted"}`}>
        {/* A folded node shows what its steps add up to, said as such — the node itself has none. An
            empty cell keeps its width, so the columns stay columns. The token mark says what it is. */}
        {show.tokens && (
          <span
            className={`${COL.tokens} relative flex items-center justify-end gap-1`}
            // THE UNIT, IN WORDS, wherever the mark beside the figure is not read: "1,572 tokens" on
            // hover and to a screen reader, never a bare number beside a duration.
            title={tokens == null ? undefined : `${tokens.toLocaleString()} tokens${fold ? ` across the ${fold.steps} steps inside` : ""}`}
          >
            {tokens != null && (
              <>
                <span aria-hidden className="shrink-0 text-faint"><Icon.trace.tokens size={ICON.xs} /></span>
                <span className="truncate">{tokenCount(tokens)}</span>
                <span className="sr-only"> tokens</span>
              </>
            )}
            {scale && <MiniBar value={tokens} max={scale.tokens} colour={METRIC.tokens} />}
          </span>
        )}
        {show.cost && (
          <span className={`${COL.cost} relative text-right`} title={cost != null && fold ? `Across the ${fold.steps} steps inside` : undefined}>
            <span className="block truncate">{cost == null ? "" : fmtCost(cost)}</span>
            {scale && <MiniBar value={cost} max={scale.cost} colour={METRIC.cost} />}
          </span>
        )}
        <span className={`${COL.time} relative flex items-center justify-end gap-1`} title={`Took ${fmtDuration(step.latency_ms)}`}>
          <span aria-hidden className="shrink-0 text-faint"><Icon.trace.time size={ICON.xs} /></span>
          <span className="truncate">{fmtDuration(step.latency_ms)}</span>
          {scale && <MiniBar value={Number.isFinite(step.latency_ms) ? step.latency_ms : null} max={scale.time} colour={METRIC.time} />}
        </span>
        {show.timeline && <Waterfall step={step} bar={bar} colour={stepColour(step, provider, mark)} inherited={inherited} />}
      </span>

      {runId && <ViewedBox runId={runId} step={step} viewed={viewed} />}

      {/* RE-RUN AND DETAILS, ON EVERY ROW AND ALWAYS (the product owner's call, 2026-10-14): two marks at
          the row's end, re-run on the left of details. They were a "Details ›" that showed under the
          pointer and a re-run that floated over the name; both are read at a glance now. */}
      <span className={`relative flex shrink-0 items-center justify-end gap-0.5 ${COL.actions}`}>
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            rerunFromRow(step);
          }}
          aria-label={`Re-run from #${step.seq} ${step.name}`}
          title="Re-run from here — a new run from this step, as it was"
          className="flex h-7 w-7 items-center justify-center rounded-control text-muted transition-colors duration-fast hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
        >
          <Icon.trace.rerunStep size={ICON.sm} />
        </button>
        <button
          type="button"
          aria-pressed={expanded}
          // ONE TAB STOP PER TREE, NOT THREE PER ROW. The rows rove (one is tabbable, the arrows move
          // between them), and every row's Details was a stop of its own — 27 presses of Tab to leave
          // a nine-step trace, most of them on buttons invisible until focused. Enter on the row
          // opens the same details.
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            toggleDetails();
          }}
          // WHICH STEP, SAID. Nine buttons all read "Details — Open step details" to VoiceOver.
          aria-label={`${expanded ? "Close" : "Open"} details for #${step.seq} ${step.name}`}
          title={expanded ? "Close step details" : "Open step details"}
          className={`flex h-7 w-7 items-center justify-center rounded-control transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
            expanded ? "bg-chrome text-ink" : "text-muted hover:bg-active hover:text-ink"
          }`}
        >
          <Icon.trace.details size={ICON.sm} />
        </button>
      </span>
    </div>
  );
}
