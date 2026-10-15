import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CANCELLED_BY_USER, DRAWER_SNAP, orderedSteps, treeSteps, useTraceStore } from "../store/traceStore.ts";
import type { RunSummary, Step } from "../types.ts";
import { useUiStore } from "../store/uiStore.ts";
import { COL, NAME_X, StepRow, TILE_X, columnsFor, type FoldSummary, type MetricScale, type RowTier } from "./StepRow.tsx";
import { buildTraceTree, descendantSteps, isInherited, ownSteps, runWindow, stepWindow, traceSections, traceTotals, visibleRows, type TimeWindow, type TraceSection, type VisibleRow } from "../lib/traceView.ts";
import { nodeKind } from "./graphNodeIcons.ts";
import { EmptyState } from "./EmptyState.tsx";
import { TraceHeader } from "./TraceHeader.tsx";
import { TraceMetrics } from "./TraceMetrics.tsx";
import { TraceFilters, ViewSwitcher } from "./TraceFilters.tsx";
import { GraphView } from "./GraphView.tsx";
import { ArtifactsTab, ChangesView, RawTab, RunTabs, StateTab } from "./TraceRunTabs.tsx";
import { TraceResult } from "./TraceResult.tsx";
import { StepDetailPanel } from "./StepDetailPanel.tsx";
import { graphLook, traceMarks, type StepMark } from "./traceMarks.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { useGraphStore } from "../store/graphStore.ts";
import { START_ID } from "../lib/graphLayout.ts";
import { sendLoadAgentGraph } from "../lib/socket.ts";
import { Icon } from "../lib/icons/registry.ts";
import { fmtDuration } from "../lib/format.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { useRunClock } from "../lib/useRunClock.ts";


/** The list's own width, as the tier its rows can afford. Measured, because the panel is resizable. */
function useRowTier(ref: React.RefObject<HTMLDivElement | null>): RowTier {
  const [tier, setTier] = useState<RowTier>("wide");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const w = el.clientWidth;
      // 24px above where they were before tokens and time took their marks, so each tier still leaves
      // a step's name the room it was sized for.
      // 42px above where they were before the rows grew a size (2026-10-15), so each tier still leaves
      // its names the room it did.
      setTier(w >= 606 ? "full" : w >= 546 ? "wide" : w >= 446 ? "medium" : "narrow");
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return tier;
}

/**
 * The steps, as a tree a keyboard can walk.
 *
 * NESTED THE WAY THEY RAN. A model call, tool call or routing decision sits under the node it ran
 * inside (`parent_step_id`), and a node folds away to one row that still says how many steps it
 * holds, what they cost, and whether any of them failed.
 *
 * ONE ROW IS IN THE TAB ORDER — the selected one, or the first — and ↑/↓ move the selection and the
 * focus together, ← folds a node (or climbs to it), → unfolds it (or steps into it), Home and End go
 * to the first and last. J/K walk the same visible rows from anywhere (CommandPalette), and Enter on a
 * row opens its details.
 */
function StepList({ run, steps }: { run: RunSummary | undefined; steps: readonly Step[] }) {
  const selectedStepId = useTraceStore((s) => s.selectedStepId);
  const filter = useTraceStore((s) => s.stepFilter);
  const query = useTraceStore((s) => s.stepQuery);
  // A live run's span grows, so its bars are re-placed once a second; a finished one never moves.
  // On the run's own clock (useRunClock), so the span ends where the run has got to.
  const now = useRunClock(run?.id, run?.status === "running", 1000);
  // THE RUN'S OWN SPAN: a branch's inherited steps ran in its parent, before it began, and have no
  // place on its track (see `ownSteps`).
  const own = useMemo(() => ownSteps(run, steps), [run, steps]);
  const span = useMemo(() => (run ? runWindow(run, own, now) : null), [run, own, now]);
  const collapsed = useTraceStore((s) => s.collapsedStepIds);
  // MEASURED ON A BOX THAT IS ALWAYS THERE. The tree unmounts while "No steps match" shows, and an
  // observer left on it would keep reading the detached element after the filter is cleared.
  const frame = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const tier = useRowTier(frame);

  // WHILE IT RUNS, a step whose node has not landed is held by the live tail, under the node it ran
  // in, rather than drawn as a root that jumps in under its node a moment later (`treeSteps`).
  const placed = useMemo(() => treeSteps(steps, run), [steps, run]);
  const waiting = useMemo(() => {
    if (placed.length === steps.length) return [];
    const ids = new Set(placed.map((s) => s.id));
    return steps.filter((s) => !ids.has(s.id));
  }, [placed, steps]);
  const tree = useMemo(() => buildTraceTree(placed), [placed]);
  const connectors = useBuildStore((s) => s.agents.find((a) => a.agent_id === run?.agent_id)?.connectors);
  const graph = useGraphStore((s) => (run ? s.graphs[run.agent_id] : undefined));
  const look = useMemo(() => graphLook(graph, connectors ?? []), [graph, connectors]);
  const marks = useMemo(() => traceMarks(steps, connectors ?? [], look), [steps, connectors, look]);
  const rows = useMemo(() => visibleRows(tree, { collapsed, filter, query }), [tree, collapsed, filter, query]);
  const folds = useMemo(() => {
    const out: Record<string, FoldSummary> = {};
    for (const row of rows) {
      if (!row.collapsed) continue;
      const inside = descendantSteps(tree, row.step.id);
      const totals = traceTotals(inside);
      out[row.step.id] = {
        steps: inside.length,
        tokens: totals.tokens,
        failed: inside.filter((s) => s.error != null).length,
      };
    }
    return out;
  }, [rows, tree]);
  // THE RUN'S HEAVIEST FIGURES, which every row's mini bars are a share of (a run's own steps only: a
  // branch's inherited ones were its parent's work).
  const scale = useMemo<MetricScale>(() => {
    const own = ownSteps(run, steps);
    return {
      tokens: Math.max(0, ...own.map((st) => st.tokens ?? 0)),
      time: Math.max(0, ...own.map((st) => (Number.isFinite(st.latency_ms) ? st.latency_ms : 0))),
    };
  }, [run, steps]);
  const tabbableId = rows.some((r) => r.step.id === selectedStepId) ? selectedStepId : (rows[0]?.step.id ?? null);
  // A top-level row starts a card and takes every row after it until the next top-level one.
  // A LONG RUN IN SECTIONS (2026-10-14): runs of consecutive nodes of one kind under a header that
  // folds — "Extraction", "Scoring", "Writing" — from SECTIONS_FROM steps up.
  const sections = useMemo(() => traceSections(rows, steps.length, nodeKind), [rows, steps.length]);
  const foldedSections = useTraceStore((s) => s.collapsedSections);

  const focusRow = (id: string): void => {
    useTraceStore.getState().selectStep(id);
    useUiStore.getState().setSelectedNodeId(null);
    // After the store has re-rendered the rows — a fold changes which ones exist.
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-step-id="${id}"]`)?.focus());
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.target instanceof HTMLElement && e.target.getAttribute("role") !== "treeitem") return;
    // ESCAPE LETS GO OF THE STEP — the keyboard's way to clear what the composer is asking about,
    // which was the pill's × alone. Open details close first (StepDetailPanel's own Escape), so it
    // is the second press that clears; focus stays on the row.
    if (e.key === "Escape") {
      const st = useTraceStore.getState();
      if (st.expandedStepId || !st.selectedStepId) return;
      e.preventDefault();
      st.selectStep(null);
      useUiStore.getState().setSelectedNodeId(null);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    // FIRST AND LAST, as the ARIA tree pattern has them — of the rows on screen, folds and filters
    // respected, like every other key here.
    if (e.key === "Home" || e.key === "End") {
      const edge = e.key === "Home" ? rows[0] : rows[rows.length - 1];
      if (edge) focusRow(edge.step.id);
      return;
    }
    const at = rows.findIndex((r) => r.step.id === useTraceStore.getState().selectedStepId);
    const row = rows[at];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = rows[at === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) focusRow(next.step.id);
      return;
    }
    if (!row) return;
    const group = row.childIds.length > 0;
    if (e.key === "ArrowLeft") {
      if (group && !row.collapsed) useTraceStore.getState().setCollapsed(row.step.id, true);
      else if (row.parentId) focusRow(row.parentId);
    } else if (group && row.collapsed) {
      useTraceStore.getState().setCollapsed(row.step.id, false);
    } else if (group) {
      focusRow(row.childIds[0]!);
    }
  };

  // ONE CARD PER NODE — the product owner's call on 2026-10-12: a node and the steps that ran inside it
  // read as one block, and the run as a stack of them. Presentation only (`role="none"`): the rows are
  // still the tree's items. THE NODE IS THE CARD'S HEADER (2026-10-14): its row on top, a hairline, and
  // the steps inside it below, level with one another — no indent, no connector lines.
  const card = (group: VisibleRow[]) => (
    <div key={group[0]!.step.id} role="none" className="rounded-card border border-hair bg-panel p-1">
      {group.map((r, i) => (
        <Fragment key={r.step.id}>
        {i === 1 && (
          // The hairline under the header, from where the names start — so the card's line runs on beside
          // it rather than crossing it (the product owner's call, 2026-10-15).
          <div role="none" aria-hidden className="relative h-[5px]">
            <span className="absolute right-2 top-0.5 h-px bg-hair" style={{ left: NAME_X }} />
            <span className="absolute inset-y-0 w-0.5 bg-grip" style={{ left: TILE_X - 1 }} />
          </div>
        )}
        <StepRow
          key={r.step.id}
          row={r}
          tabbable={r.step.id === tabbableId}
          tier={tier}
          fold={folds[r.step.id]}
          inherited={isInherited(r.step, run)}
          provider={run?.provider}
          mark={marks.get(r.step.name)}
          scale={scale}
          link={{ up: i > 0, down: i < group.length - 1 }}
        />
        </Fragment>
      ))}
    </div>
  );

  // THE FILTERS STICK, so they stay in reach however far down somebody has scrolled. No failure banner
  // under them (the product owner's call, 2026-10-14: it looked cheap): the Errors tab counts the
  // failures, and E / Shift+E still go to the next and previous one.
  const header = (
    <div className="sticky top-0 z-10 -mx-1 mb-1 bg-bg px-1">
      <TraceFilters steps={steps} />
    </div>
  );

  // Nothing to draw because nothing matches — not because every step so far is waiting for its node.
  if (rows.length === 0 && (filter !== "all" || query.trim() !== "" || waiting.length === 0)) {
    return (
      <div ref={frame}>
      {header}
      <div className="flex flex-col items-start gap-1.5 px-2 py-6">
        <p className="text-caption text-ink">No steps match</p>
        <p className="text-tiny text-muted">
          {query.trim() ? `Nothing in this run matches “${query.trim()}”` : "This run has no steps of that kind"}
          {filter !== "all" && query.trim() ? " with that filter on." : "."}
        </p>
        <button
          type="button"
          onClick={() => {
            useTraceStore.getState().setStepFilter("all");
            useTraceStore.getState().setStepQuery("");
          }}
          className="mt-1 rounded-control border border-hair px-2.5 py-1 text-tiny text-ink transition-colors hover:bg-active focus-visible:outline-none focus-visible:shadow-focusring"
        >
          Clear filters
        </button>
      </div>
      </div>
    );
  }

  return (
    <div ref={frame}>
    {header}
    <div ref={ref} role="tree" aria-label="Steps" className="flex flex-col gap-1.5" onKeyDown={onKeyDown}>
      {sections
        ? sections.map((sec) => (
            <div key={sec.key} role="none" className="flex flex-col gap-1.5">
              <KindSectionHeader section={sec} folded={Boolean(foldedSections[sec.key])} />
              {!foldedSections[sec.key] && cardsOf(sec.rows).map(card)}
            </div>
          ))
        : cardsOf(rows).map(card)}
    </div>
    {run && (
      <div className="mt-1.5">
        <LiveTail run={run} steps={steps} span={span} tier={tier} waiting={waiting} marks={marks} />
      </div>
    )}
    </div>
  );
}

/** Rows as node cards: a top-level row starts a card and takes every row after it until the next. */
function cardsOf(rows: readonly VisibleRow[]): VisibleRow[][] {
  const out: VisibleRow[][] = [];
  for (const r of rows) {
    if (r.depth === 0 || out.length === 0) out.push([r]);
    else out[out.length - 1]!.push(r);
  }
  return out;
}

/**
 * A section's header: its word in the section-label grey, a dot in its kind's graph colour, how many
 * steps it holds — and a press folds it (the product owner's colours, 2026-10-14).
 */
function KindSectionHeader({ section, folded }: { section: TraceSection; folded: boolean }) {
  return (
    <button
      type="button"
      onClick={() => useTraceStore.getState().toggleSection(section.key)}
      aria-expanded={!folded}
      className="-mx-1 mt-1 flex items-center gap-2 rounded-control px-1 py-0.5 text-left focus-visible:outline-none focus-visible:shadow-focusring"
    >
      <span aria-hidden className={`text-faint transition-transform duration-fast ${folded ? "-rotate-90" : ""}`}>
        <Icon.trace.fold size={ICON.xs} />
      </span>
      {section.hue && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: section.hue }} />}
      <span className={TYPE.sectionLabel}>{section.label}</span>
      <span className="text-tiny tabular-nums text-faint">{section.steps === 1 ? "1 step" : `${section.steps} steps`}</span>
    </button>
  );
}

/**
 * WHAT THE RUN IS DOING NOW, below what it has done.
 *
 * A step is emitted when it FINISHES, so the timeline is always a list of things that are over — and
 * for the seconds a model call takes, a live run looked stalled after its last row. Each node boundary
 * says which nodes run next (`nextByRun`, the same word the graph's live mark uses); this row says it
 * here too. Paused, it is where the run will continue; stopped, where it stood.
 */
function LiveTail({ run, steps, span, tier, waiting = [], marks }: {
  run: RunSummary;
  steps: readonly Step[];
  span: TimeWindow | null;
  tier: RowTier;
  /** Steps that finished inside the node running now, before it did — drawn under it, here. */
  waiting?: readonly Step[];
  marks?: Map<string, StepMark>;
}) {
  const next = useTraceStore((s) => s.nextByRun[run.id]);
  // ITS OWN CLOCK, FIVE TIMES A SECOND. The time it shows is in tenths, and it was read off the
  // list's once-a-second span — so it changed once a second and always ended in the same tenth.
  const now = useRunClock(run.id, run.status === "running", 200);
  const stopped = run.status === "error" && run.error === CANCELLED_BY_USER;
  // BEFORE THE FIRST BOUNDARY, THE GRAPH SAYS WHERE A RUN STARTS: the node after Start, when there is
  // one. "The next step" stood there while extract_jd was the step running.
  const edges = useGraphStore((s) => s.graphs[run.agent_id]?.edges);
  const firstNodes = useMemo(() => edges?.filter((e) => e.source === START_ID).map((e) => e.target), [edges]);
  // The waiting steps as the rows they will be once their node lands: one level in, under the tile
  // below, each line meeting it as a nested row's line meets its node's.
  const inside = useMemo(() => {
    let rootLast = true;
    return visibleRows(buildTraceTree(waiting)).map((r) => {
      if (r.depth === 0) rootLast = r.lastChild;
      return { ...r, depth: r.depth + 1, lastPath: [rootLast, ...r.lastPath] };
    });
  }, [waiting]);
  const state = run.status === "running" ? "running" : run.status === "paused" ? "paused" : stopped && next?.length ? "stopped" : null;
  if (!state) return null;

  const names = next?.length ? next.join(", ") : null;
  const name = names
    ?? (steps.length === 0 && firstNodes?.length === 1 ? firstNodes[0]! : steps.length === 0 ? "The first step" : "The next step");
  // SHORT ENOUGH TO READ WHOLE at the panel's default width — "Paused here — Resume co…" was the
  // sentence's useful half cut off. The longer form is the line's tooltip.
  const [word, more] =
    state === "running"
      ? steps.length === 0
        ? ["Running — steps appear as they finish", "Each step appears here as it finishes"]
        : ["Running now", "Running now — this step appears above when it finishes"]
      : state === "paused"
        ? ["Paused here", "Paused here — Resume continues the run from this step"]
        : ["Stopped here", "Stopped here, before this step ran"];
  // The time the run has spent on it so far: from the last thing that finished to now.
  let soFar: number | null = null;
  if (state === "running" && span) {
    const lastEnd = Math.max(span.start, ...steps.map((st) => stepWindow(st)?.end ?? span.start));
    soFar = Math.max(0, now - lastEnd);
  }
  const show = columnsFor(tier);

  return (
    // Its own card, DASHED: it stands where the next node's card will be, and is not one yet.
    <div
      className={`rounded-card border border-dashed p-1 ${state === "running" ? "border-run/50 bg-run/[0.04]" : "border-edge bg-panel"}`}
      aria-live="polite"
    >
    <div className="relative flex items-center gap-2 rounded-control py-2 pl-2 pr-1">
      <span className="w-8 shrink-0" />
      <span className="flex shrink-0 items-center" style={{ paddingLeft: 20 }}>
        <span
          aria-hidden
          className={`flex h-7 w-7 items-center justify-center rounded-control border border-dashed ${
            state === "running" ? "border-run/60 bg-run/10" : "border-grip bg-void"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${state === "running" ? "animate-stream-pulse bg-run motion-reduce:animate-none" : "bg-grip"}`}
          />
        </span>
      </span>
      <span className="min-w-[4.5rem] flex-1">
        <span className="block truncate text-body font-medium text-ink" title={name}>{name}</span>
        <span className={`mt-0.5 block truncate text-caption ${state === "running" ? "text-run" : "text-faint"}`} title={more}>{word}</span>
      </span>
      {/* THE STEPS' OWN COLUMNS, so its time sits under theirs: the time it has run so far, in amber. */}
      <span className="flex shrink-0 items-center gap-2 text-caption tabular-nums">
        {show.tokens && <span className={COL.tokens} />}
        <span className={`${COL.time} flex items-center justify-end gap-1 ${state === "running" ? "text-run" : "text-faint"}`}>
          {soFar != null && (
            <>
              <span aria-hidden className="shrink-0"><Icon.trace.time size={ICON.sm} /></span>
              <span className="truncate">{fmtDuration(soFar)}</span>
            </>
          )}
        </span>
      </span>
      <span className={`${COL.viewed} shrink-0`} />
      {show.actions && <span className={`${COL.actions} shrink-0`} />}
    </div>
    {inside.length > 0 && (
      <div role="tree" aria-label="Finished inside the running step">
        {inside.map((r) => (
          <StepRow
            key={r.step.id}
            row={r}
            tabbable={false}
            tier={tier}
            provider={run.provider}
            mark={marks?.get(r.step.name)}
          />
        ))}
      </div>
    )}
    </div>
  );
}

/**
 * NOTHING TO SHOW YET, said the way the Runs tab says it — centred, and naming the agent — and
 * pointing the right way: "Run the agent below" pointed at nothing, since the composer is to the left.
 */
function NoRun() {
  const agentId = useBuildStore((s) => s.activeAgentId);
  const name = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId)?.name ?? null);
  const hasRuns = useTraceStore((s) => agentId != null && Object.values(s.runs).some((r) => r.agent_id === agentId));
  const what = "Each model call, tool call, state update and routing decision appears here, in order, as it finishes.";
  return (
    <EmptyState
        icon={Icon.trace.empty}
        title={!agentId ? "Choose an agent to see its runs" : hasRuns ? "No run open" : `${name ?? "This agent"} has not run yet`}
        hint={!agentId ? what : hasRuns ? "Open one from the Runs tab, or run the agent from the composer on the left." : `Run it from the composer on the left. ${what}`}
      />
  );
}

/**
 * Room for the step list and Step details side by side: the panel's 380px and a list that keeps its
 * "medium" tier (404px) — below it, the details dock under the list instead.
 */
const SIDE_BY_SIDE_FROM = 380 + 404;

/**
 * Whether the tab's body is wide enough for the details beside the list. Measured: the panel resizes.
 * `mounted` is whether the body is on screen at all — it is not while there is no run — so the
 * measure starts again when it appears.
 */
function useSideBySide(ref: React.RefObject<HTMLDivElement | null>, mounted: boolean): boolean {
  const [side, setSide] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setSide(el.clientWidth >= SIDE_BY_SIDE_FROM);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, mounted]);
  return side;
}

export function TraceTimeline() {
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const run = useTraceStore((s) => (activeRunId ? s.runs[activeRunId] : undefined));
  const bucket = useTraceStore((s) => (activeRunId ? s.stepsByRun[activeRunId] : undefined));
  const detailsOpen = useTraceStore((s) => Boolean(s.expandedStepId && bucket?.[s.expandedStepId]));
  const stepView = useTraceStore((s) => s.stepView);
  // Changes is a branch's alone; on a run that is not one, the steps are what is open.
  const chosenTab = useTraceStore((s) => s.runTab);
  const tab = chosenTab === "changes" && !run?.parent_run_id ? "steps" : chosenTab;
  const body = useRef<HTMLDivElement>(null);
  const side = useSideBySide(body, run != null);

  const steps = useMemo(() => orderedSteps(bucket), [bucket]);
  // THE DRAWER UNDER THE STEPS RESTS AT A PEEK, HALF OR ALL OF THE TAB (`DRAWER_SNAP`), or wherever its
  // handle is being dragged; the steps keep the rest. At "full" they give it all.
  const snapShare = useTraceStore((s) => DRAWER_SNAP[s.drawerSnap]);
  const dragShare = useTraceStore((s) => s.drawerDrag);
  const listShare = Math.max(0, 1 - (dragShare ?? snapShare));

  // THE AGENT'S GRAPH, SO A NODE LOOKS THE SAME ON BOTH TABS (traceMarks). Asked for here as GraphView
  // asks for it — once, not for a draft, not while it is on its way — and the server keeps it cached.
  const agentId = run?.agent_id;
  const agentKnown = useBuildStore((s) => (agentId ? s.agents.some((a) => a.agent_id === agentId && a.draft !== true) : false));
  const graphHere = useGraphStore((s) => (agentId ? Boolean(s.graphs[agentId] || s.loading[agentId]) : true));
  useEffect(() => {
    if (agentId && agentKnown && !graphHere) sendLoadAgentGraph(agentId);
  }, [agentId, agentKnown, graphHere]);

  return (
    <div className="flex h-full flex-col bg-bg">
      <TraceHeader run={run} />
      {run && <TraceMetrics run={run} steps={steps} />}
      {run && <div className="mt-2"><RunTabs run={run} /></div>}

      {/* THE STEPS, AND THEIR DETAILS DOCKED BESIDE OR UNDER THEM (see StepDetailPanel): beside on a
          panel wide enough for both, and otherwise below, with the list keeping its top two-fifths so
          the selected row stays on screen while somebody reads about it. */}
      {!run ? <div className="min-h-0 flex-1"><NoRun /></div> : tab !== "steps" ? (
        <div className="min-h-0 flex-1 overflow-auto pb-4">
          {tab === "changes" ? <ChangesView run={run} steps={steps} />
            : tab === "state" ? <StateTab steps={steps} />
              : tab === "artifacts" ? <ArtifactsTab steps={steps} />
                : <RawTab run={run} steps={steps} />}
        </div>
      ) : stepView === "graph" ? (
        // THE GRAPH VIEW: the agent's graph with this run on it, in place of the list — the switcher
        // stays above it, so the list is one press away.
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 justify-end px-6 py-2"><ViewSwitcher /></div>
          <div className="min-h-0 flex-1 border-t border-hair"><GraphView /></div>
        </div>
      ) : (
      <div ref={body} className={`flex min-h-0 flex-1 ${detailsOpen && side ? "flex-row" : "flex-col"}`}>
      {/* timeline body */}
      {/* NO `scroll-fade` HERE: the filter row sticks to the top of this region, and a mask over the
          first 16px would dim the controls it is meant to keep in reach. */}
      {/* The padding is on the INNER box: a sticky child sticks to the scroller's padding edge, so
          top padding here would leave a strip above the filter row for steps to scroll through. */}
      <div
        className={`overflow-auto px-6 ${!detailsOpen ? "flex-1 pb-4" : side ? "min-w-0 flex-1 pb-4" : `shrink-0 ${listShare > 0 ? "pb-4" : "hidden"}`}`}
        style={detailsOpen && !side ? { height: `${listShare * 100}%` } : undefined}
      >
        <div className="pt-3">
          {steps.length === 0 ? (
            run?.status === "running" || run?.status === "paused" ? (
              // A RUN WITH NOTHING FINISHED YET is not an empty trace: it is a trace whose first row has
              // not landed. Say what is happening, and that rows arrive as their steps finish.
              <>
                <TraceResult run={run} steps={steps} />
                <LiveTail run={run} steps={steps} span={null} tier="narrow" />
              </>
            ) : (
              <EmptyState
                size="line"
                icon={Icon.trace.empty}
                title="This run recorded no steps"
                hint="It ended before any step finished, so there is nothing to inspect. Its outcome is in the header."
              />
            )
          ) : (
            <>
              {run && <TraceResult run={run} steps={steps} />}
              <StepList run={run} steps={steps} />
            </>
          )}
        </div>
      </div>
      {detailsOpen && <StepDetailPanel dock={side ? "side" : "bottom"} />}
      </div>
      )}
    </div>
  );
}
