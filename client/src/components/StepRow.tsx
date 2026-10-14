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

import { fmtCost, fmtDuration, fmtOffset, fmtTokens, shortCount } from "../lib/format.ts";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";
import { CATEGORY_LABEL, stepCategory, stepOutputText, stepProvider, type StepCategory, type VisibleRow } from "../lib/traceView.ts";
import { BRAND_COLOR, ProviderMark, hasProviderMark } from "../lib/icons.tsx";
import type { StepMark } from "./traceMarks.ts";
import { ICON, STATUS, STEP_TYPE, TEXT } from "../lib/tokens.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { agentMcpToolNames } from "../store/mcpStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { Step } from "../types.ts";
import { CopyTurn } from "./composer/CopyTurn.tsx";
import { IconButton } from "./IconButton.tsx";
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

/**
 * Where a row's tile sits, so the lines that join a node to its steps meet it exactly. A row is the
 * seq gutter (44px with its padding), then INDENT per level, a fold chevron's slot, then the tile.
 */
const GUTTER = 44;
const INDENT = 20;
const CHEVRON = 20; // the chevron's 16px slot and the 4px before the tile
const TILE = 22;
/** The x of the centre of a tile at `depth` — where that level's connector line runs. */
export const tileCentre = (depth: number): number => GUTTER + depth * INDENT + CHEVRON + TILE / 2;

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
  /** The Details slot, held empty when the row is not hovered or selected. */
  actions: "w-16",
} as const;

/** Which columns a width tier can afford — every row, and the live row, read the same answer. */
export const columnsFor = (tier: RowTier) => ({
  tokens: tier !== "narrow",
  cost: tier === "wide" || tier === "full",
  timeline: tier === "full",
  actions: tier !== "narrow",
});

/** Connector lines' weight: 2px, the strongest neutral border — the product owner's call, 2026-10-12. */
const LINE = 2;

/**
 * The lines joining this row to the tree around it, 2px and in `grip`, with a ROUNDED ELBOW where a
 * step meets the node it ran inside (the product owner's call on 2026-10-12, "more bolder").
 *
 *   a node with steps showing  — a line from the bottom of its tile down to the row's bottom edge;
 *   a step inside a node       — an elbow: down from the row's top at the node's line, curving into
 *                                its own tile, and straight on down when another step follows it;
 *   every outer level          — a straight line wherever that level's node has a step still to come.
 *
 * EVERY PIECE STOPS AT A TILE'S EDGE. The lines are positioned and the tile is not, so a line drawn
 * across a tile would paint over it.
 */
function Connectors({ row }: { row: VisibleRow }) {
  const lines: React.ReactNode[] = [];
  const v = (key: string, x: number, cls: string, style: React.CSSProperties = {}) =>
    lines.push(<span key={key} aria-hidden className={`absolute w-0.5 bg-grip ${cls}`} style={{ left: x - LINE / 2, ...style }} />);

  // Down out of a node whose steps are on screen.
  if (row.shownChildren) {
    v("down", tileCentre(row.depth), "bottom-0", { top: `calc(50% + ${TILE / 2}px)` });
  }
  if (row.depth === 0) return <>{lines}</>;

  // Outer levels: a full-height line wherever that level's node has a step still to come.
  for (let level = 1; level < row.depth; level++) {
    if (row.lastPath[level - 1] === false) v(`v${level}`, tileCentre(level - 1), "bottom-0 top-0");
  }
  const parentX = tileCentre(row.depth - 1);
  const tileLeft = tileCentre(row.depth) - TILE / 2;
  // The elbow: down from the top at the node's line, curving into this step's tile.
  lines.push(
    <span
      key="elbow"
      aria-hidden
      className="absolute top-0 rounded-bl-control border-b-2 border-l-2 border-grip"
      style={{ left: parentX - LINE / 2, width: tileLeft - (parentX - LINE / 2), height: `calc(50% + ${LINE / 2}px)` }}
    />,
  );
  // ...and straight on down past it when another step of the same node follows.
  if (!row.lastChild) v("on", parentX, "bottom-0 top-1/2");
  // A FRAGMENT, NOT A WRAPPER. The lines are absolute, so on their own they take no part in the row's
  // flex layout; wrapped in a span they made a zero-width flex item that still took a gap, which
  // pushed every nested row's number, tile and name 8px right of the rows above it.
  return <>{lines}</>;
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
}) {
  const { step } = row;
  const group = row.childIds.length > 0;
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId));
  const mcpNames = agentMcpToolNames(agent?.mcp_tools);
  const expanded = useTraceStore((s) => s.expandedStepId === step.id);
  const selected = useTraceStore((s) => s.selectedStepId === step.id);
  const rowRef = useRef<HTMLDivElement>(null);

  // When selected from elsewhere (a graph-node click, J/K), bring the row into view.
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const select = (): void => {
    useTraceStore.getState().selectStep(step.id);
    useUiStore.getState().setSelectedNodeId(null); // composer context is now this step
  };
  const toggleDetails = (): void => {
    select();
    useTraceStore.getState().setExpandedStep(expanded ? null : step.id);
  };

  const category = stepCategory(step);
  const show = columnsFor(tier);
  const tokens = step.tokens ?? fold?.tokens ?? null;
  const cost = step.cost ?? fold?.cost ?? null;
  const output = stepOutputText(step);
  const failed = step.error != null;

  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={group ? !row.collapsed : undefined}
      aria-selected={selected}
      aria-label={`#${step.seq} ${step.name}, ${CATEGORY_LABEL[category]}${failed ? ", failed" : ""}`}
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
      className={`group/step relative flex animate-slide-in cursor-pointer select-none items-center gap-2 rounded-control py-1.5 pl-2 pr-1 outline-none transition-colors duration-fast focus-visible:shadow-focusring motion-reduce:animate-none ${
        selected ? "bg-active" : "hover:bg-active/40"
      } ${row.context ? "text-muted [&_.text-ink]:text-muted" : ""}`}
      // A row kept only so a match keeps its place in the tree reads quieter than the matches.
      title={row.context ? "Shown because a step inside it matches" : undefined}
    >
      {/* The same selection mark the other lists use — inset, square, ink. */}
      {selected && <span aria-hidden className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent" />}

      <Connectors row={row} />
      {/* LEFT-ALIGNED, so every row's # stands in one column whatever its number's digits. */}
      <span className="w-7 shrink-0 text-left text-tiny tabular-nums text-faint">#{step.seq}</span>
      <span className="flex shrink-0 items-center" style={{ paddingLeft: row.depth * INDENT }}>
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

      <span className="min-w-[4.5rem] flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-caption font-medium text-ink" title={step.name}>{step.name}</span>
          {/* Derived from the AGENT's manifest, not from the step: the frozen Step schema has no
              provenance field and must not grow one. */}
          {step.type === "tool_call" && mcpNames.has(step.name) && <McpBadge variant="compact" />}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-tiny text-faint">
          <span className="truncate">{CATEGORY_LABEL[category]}</span>
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

      {/* Figures, tabular, and only the ones this step has: a node has no tokens of its own. */}
      <span className="flex shrink-0 items-center gap-2 text-tiny tabular-nums text-muted">
        {/* A folded node shows what its steps add up to, said as such — the node itself has none. An
            empty cell keeps its width, so the columns stay columns. The token mark says what it is. */}
        {show.tokens && (
          <span className={`${COL.tokens} flex items-center justify-end gap-1`} title={tokens == null ? undefined : fold ? `${fmtTokens(tokens)} across the ${fold.steps} steps inside` : fmtTokens(tokens)}>
            {tokens != null && (
              <>
                <span aria-hidden className="shrink-0 text-faint"><Icon.trace.tokens size={ICON.xs} /></span>
                <span className="truncate">{tier === "medium" ? shortCount(tokens) : tokens.toLocaleString()}</span>
              </>
            )}
          </span>
        )}
        {show.cost && (
          <span className={`${COL.cost} truncate text-right`} title={cost != null && fold ? `Across the ${fold.steps} steps inside` : undefined}>
            {cost == null ? "" : fmtCost(cost)}
          </span>
        )}
        <span className={`${COL.time} flex items-center justify-end gap-1`}>
          <span aria-hidden className="shrink-0 text-faint"><Icon.trace.time size={ICON.xs} /></span>
          <span className="truncate">{fmtDuration(step.latency_ms)}</span>
        </span>
        {show.timeline && <Waterfall step={step} bar={bar} colour={stepColour(step, provider, mark)} inherited={inherited} />}
      </span>

      {/* THE ROW'S ACTIONS. Details holds its own place, so the figures never move when it appears;
          the other two float over the figures while the row is hovered or focused. Too narrow for a
          slot, Details floats over the duration instead and the other two stay in the drawer. */}
      <span className={tier === "narrow" ? "absolute right-1 top-1/2 flex -translate-y-1/2 items-center" : `relative flex shrink-0 items-center justify-end ${COL.actions}`}>
        {tier !== "narrow" && (
        <span
          className="absolute right-full top-1/2 flex -translate-y-1/2 items-center rounded-control bg-bg opacity-0 transition-opacity duration-fast group-hover/step:opacity-100 group-focus-within/step:opacity-100"
        >
          <span className={`flex items-center rounded-control ${selected ? "bg-active" : "bg-active/40"}`}>
            <IconButton
              icon={Icon.panel.graph}
              label="Show this step on the graph"
              stopPropagation
              onClick={() => {
                select();
                useUiStore.getState().setRightTab("graph");
              }}
            />
            {output && <CopyTurn source={output} label="Copy output" title="Copy this step's output" />}
          </span>
        </span>
        )}
        <button
          type="button"
          aria-pressed={expanded}
          onClick={(e) => {
            e.stopPropagation();
            toggleDetails();
          }}
          title={expanded ? "Close step details" : "Open step details"}
          className={`flex h-7 items-center gap-0.5 rounded-control px-2 text-tiny transition-[opacity,color,background-color] duration-fast focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-focusring ${
            expanded
              ? "bg-chrome text-ink opacity-100"
              : `${tier === "narrow" ? "bg-active" : ""} text-muted hover:bg-active hover:text-ink ${selected ? "opacity-100" : "opacity-0 group-hover/step:opacity-100 group-focus-within/step:opacity-100"}`
          }`}
        >
          Details
          <Icon.trace.details size={ICON.xs} />
        </button>
      </span>
    </div>
  );
}
