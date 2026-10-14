// The trace store — the correctness core of the timeline (the 🟡 review point).
//
// Invariants that keep the trace honest (README §10.3 "a corrupted trace is a lying product"):
//   1. Steps are keyed by step.id, so at-least-once re-delivery is idempotent (no duplicates).
//   2. Render order is ALWAYS derived by sorting on `seq`, never arrival order — steps are
//      emitted at end time and therefore arrive out of causal order (README §4.3).
// All updates are immutable so React/zustand see changed references exactly when data changes.

import { create } from "zustand";
import type { Run, RunEvalScore, RunStatus, RunSummary, Step, TraceEvent } from "../types.ts";
import { ancestorIds, awaitingNode, buildTraceTree, traceSections, visibleRows, type StepFilter, type VisibleRow } from "../lib/traceView.ts";
import { nodeKind } from "../components/graphNodeIcons.ts";

export type ConnectionState = "connecting" | "open" | "closed";
export type StepView = "list" | "waterfall" | "graph";
export type RunTab = "steps" | "changes" | "state" | "artifacts" | "raw";
/** The step drawer's tabs. */
export type DrawerTab = "overview" | "input" | "output" | "prompt" | "state" | "raw";
/** Where the drawer docked under the steps rests: a peek at its header, half the tab, or all of it. */
export type DrawerSnap = "peek" | "half" | "full";
/** The share of the tab the drawer takes at each rest. */
export const DRAWER_SNAP: Record<DrawerSnap, number> = { peek: 0.3, half: 0.6, full: 1 };
export type LogLine = { level: "stderr" | "parseError"; text: string };

interface TraceState {
  runs: Record<string, RunSummary>;
  /**
   * How many rows the last window asked for, and whether it reached the end.
   *
   * WHAT THEY ARE FOR. The list read is `ORDER BY started_at DESC LIMIT n` and there was no way to
   * ask for more than the default fifty — so the 51st-newest run could not be opened at all, because
   * `loadRun` needs an id and the only source of ids was that list. These two fields are what a "load
   * more" control needs: the size to ask for next, and whether to offer itself at all.
   *
   * `historyComplete` starts TRUE, which is the honest default before anything has arrived: an app
   * with no history yet must not offer to load more of it. Every history message carries both fields
   * — the connect snapshot included — so the control is right from frame one rather than only after
   * somebody has already pressed it once.
   */
  historyWindow: number;
  historyComplete: boolean;
  stepsByRun: Record<string, Record<string, Step>>; // runId -> (stepId -> Step)
  loaded: Record<string, true>; // runIds whose steps are fully in memory
  /** The judge's verdict on a run an eval ran and scored, as it came with the run's steps. */
  evalByRun: Record<string, RunEvalScore>;
  activeRunId: string | null;
  // The step the user is focused on — drives trace↔graph sync (a clicked step lights its
  // graph node, and clicking a node selects a step here). Cleared when the active run changes.
  selectedStepId: string | null;
  // The expanded (detail-open) step. Shared so keyboard nav (Enter) can expand the selection,
  // not just a mouse click. Cleared when the active run changes.
  expandedStepId: string | null;
  connection: ConnectionState;
  logs: LogLine[];
  /**
   * Per live run, the nodes it will run next — what each node boundary says on the debug channel.
   * The trace says what a run has FINISHED (a step is emitted when it ends); this is the only word on
   * what it is doing now, where a paused run will continue, and where a stopped one stood.
   */
  nextByRun: Record<string, string[]>;
  /**
   * Per live run, the smallest delay any of its events has arrived with: when it reached this app,
   * less when the runner stamped it. What `useRunClock` takes off `now` so a live run's figures count
   * on its own clock. Live events only — a run loaded from history has nothing to measure.
   */
  lagByRun: Record<string, number>;
  /**
   * Per run, the highest seq a node boundary has covered while this app was listening — the steps
   * at or below it have a checkpoint to re-run from even when the copy of them here, loaded before
   * the boundary, says otherwise (`rerunBlocked`). Bounded like `nextByRun`.
   */
  boundaryByRun: Record<string, number>;
  /**
   * Whether the trace's Final answer section is open. One choice for every run, kept for the session
   * and never written to storage: somebody who folded it away to read steps wants the next run's
   * answer folded too, and a reload is a fair moment to show it again.
   */
  answerOpen: boolean;
  /**
   * Node steps folded away in the timeline, by step id. Ids are unique across runs, so one map serves
   * every trace; kept for the session and never written to storage.
   */
  collapsedStepIds: Record<string, true>;
  /**
   * Which kind of step the timeline shows, and the words it is searched for — both session-only, and
   * both about THE RUN ON SCREEN: opening another run sets them back (see `aboutAnotherRun`).
   */
  stepFilter: StepFilter;
  stepQuery: string;
  /**
   * A step somebody asked to see ON THE GRAPH ("Show this step on the graph"), for the Graph tab to
   * take once: it moves the run's replay to the frame where that step's node finished, rather than
   * leaving it at the run's end with the step's own node the faded one. Cleared when taken.
   */
  graphStepRequest: string | null;
  /**
   * How the Steps tab draws the run: the list, the list with each step's time drawn behind its row
   * (waterfall), or the agent's graph. One choice for the session, kept across runs.
   */
  stepView: StepView;
  /** Which of the run's views is open: its steps, or Changes, State, Artifacts or Raw. Session-only. */
  runTab: RunTab;
  /** The step drawer's open tab, kept as the drawer moves from step to step. Session-only. */
  drawerTab: DrawerTab;
  /** Where the drawer docked under the steps rests, and — while its handle is dragged — where it is. */
  drawerSnap: DrawerSnap;
  drawerDrag: number | null;
  /** Sections of a long run folded away, by their first node's step id (`traceSections`). Session-only. */
  collapsedSections: Record<string, true>;
  /**
   * The latest refusal from the run controls — a pause, a resume or a re-run the server turned down —
   * and the run it was about, when it named one. Read by the controls that asked, so a refusal is said
   * where the button is rather than only in a two-second toast. `at` tells two equal refusals apart.
   */
  controlError: { runId: string | null; message: string; at: number } | null;

  /**
   * The run history, merged by id.
   *
   * `complete` and `window` arrive only on the answer to `loadHistory`, which is a growing WINDOW
   * rather than a page: the channel is a full-snapshot channel and this merges, so a larger window
   * adds rows and never assembles a list out of two moments. A broadcast that carries neither — the
   * one every new run sends — leaves both alone, so pressing "load more" is not undone by somebody
   * else starting a run.
   */
  applyHistory: (runs: RunSummary[], meta?: { complete?: boolean; window?: number }) => void;
  applyEvent: (event: TraceEvent) => void;
  applyRunSteps: (runId: string, steps: Step[], evalScore?: RunEvalScore) => void;
  selectRun: (id: string) => void;
  /** Drop the run and step selection entirely — used when the run on screen no longer
   *  belongs to the selected agent. See lib/selection.ts for the invariant. */
  clearRunSelection: () => void;
  /** A status flip from the debug channel — with the reason, for a cancel, as the server records it. */
  setRunStatus: (runId: string, status: RunStatus, error?: string) => void;
  selectStep: (id: string | null) => void;
  setExpandedStep: (id: string | null) => void;
  needsLoad: (id: string) => boolean;
  addLog: (line: LogLine) => void;
  setConnection: (c: ConnectionState) => void;
  setNext: (runId: string, next: string[]) => void;
  noteBoundary: (runId: string, seq: number) => void;
  setAnswerOpen: (open: boolean) => void;
  setCollapsed: (stepId: string, collapsed: boolean) => void;
  /** Fold or unfold every node of the run on screen at once — Collapse all / Expand all. */
  setAllCollapsed: (collapsed: boolean) => void;
  setStepFilter: (filter: StepFilter) => void;
  setStepQuery: (query: string) => void;
  requestGraphStep: (stepId: string | null) => void;
  setStepView: (view: StepView) => void;
  toggleSection: (key: string) => void;
  setRunTab: (tab: RunTab) => void;
  setDrawerTab: (tab: DrawerTab) => void;
  setDrawerSnap: (snap: DrawerSnap) => void;
  setDrawerDrag: (share: number | null) => void;
  setControlError: (error: { runId: string | null; message: string } | null) => void;
}

const LOG_CAP = 200;
/** How many runs' next nodes are kept — see `setNext`. The same bound holds `lagByRun`. */
const NEXT_KEPT = 50;

/**
 * `lagByRun` with an event's delay folded in: the smaller of what it was and this one's. Bounded like
 * `nextByRun` — the latest run is kept at the end, and the oldest go.
 */
function withLag(lagByRun: Record<string, number>, runId: string, stampedAt: string): Record<string, number> {
  const at = Date.parse(stampedAt);
  if (!Number.isFinite(at)) return lagByRun;
  const lag = Date.now() - at;
  const known = lagByRun[runId];
  if (known !== undefined && known <= lag) return lagByRun;
  const others = Object.entries(lagByRun).filter(([id]) => id !== runId).slice(-(NEXT_KEPT - 1));
  return { ...Object.fromEntries(others), [runId]: lag };
}

/**
 * The reason the server writes on a run somebody stopped — its `TraceStore.CANCELLED_BY_USER`, held to
 * it by `test:trace`. A stopped run and a failed one are both `error`; this is what tells them apart.
 */
export const CANCELLED_BY_USER = "cancelled by user";

/**
 * What changes when the trace turns to a different run.
 *
 * THE FILTER AND THE SEARCH GO WITH THE SELECTION. They were kept, so a run opened after "LLM" and
 * "Chat" on another one arrived already narrowed, and a stale query made a healthy run read "No steps
 * match". Folds stay: they are keyed by step id, so they never touch another run's rows, and going back
 * to a run finds it folded the way it was left.
 */
function aboutAnotherRun(state: Pick<TraceState, "activeRunId">, id: string | null): Partial<TraceState> {
  const reset: Partial<TraceState> = { selectedStepId: null, expandedStepId: null };
  if (id !== state.activeRunId) {
    reset.stepFilter = "all";
    reset.stepQuery = "";
  }
  return reset;
}

function bucketFrom(steps: Step[]): Record<string, Step> {
  const out: Record<string, Step> = {};
  for (const s of steps) out[s.id] = s; // keyed by id → dedupe
  return out;
}

export const useTraceStore = create<TraceState>((set, get) => ({
  runs: {},
  // The default window the connect snapshot serves, and the honest starting answer about what is
  // behind it: nothing has asked yet, so nothing offers to load more yet.
  historyWindow: 50,
  historyComplete: true,
  stepsByRun: {},
  loaded: {},
  evalByRun: {},
  activeRunId: null,
  selectedStepId: null,
  expandedStepId: null,
  connection: "connecting",
  logs: [],
  nextByRun: {},
  lagByRun: {},
  boundaryByRun: {},
  answerOpen: true,
  collapsedStepIds: {},
  stepFilter: "all",
  stepQuery: "",
  graphStepRequest: null,
  stepView: "list",
  collapsedSections: {},
  runTab: "steps",
  drawerTab: "overview",
  drawerSnap: "half",
  drawerDrag: null,
  controlError: null,

  applyHistory: (runs, meta) =>
    set((state) => {
      const merged = { ...state.runs };
      for (const r of runs) merged[r.id] = { ...merged[r.id], ...r };
      return {
        runs: merged,
        ...(meta?.complete === undefined ? {} : { historyComplete: meta.complete }),
        ...(meta?.window === undefined ? {} : { historyWindow: meta.window }),
      };
    }),

  applyEvent: (event) =>
    set((state) => {
      if (event.kind === "run_start") {
        const run: Run = event.run;
        return {
          runs: { ...state.runs, [run.id]: { ...state.runs[run.id], ...run } },
          // Open a fresh bucket; a live run streams from seq 0, so it is "loaded".
          stepsByRun: { ...state.stepsByRun, [run.id]: state.stepsByRun[run.id] ?? {} },
          loaded: { ...state.loaded, [run.id]: true },
          // A new run's steps don't exist yet — drop the stale selection, filter and search.
          ...aboutAnotherRun(state, run.id),
          activeRunId: run.id, // auto-focus the run that just started
          lagByRun: withLag(state.lagByRun, run.id, run.started_at),
        };
      }
      if (event.kind === "run_end") {
        const run: Run = event.run;
        const known = state.runs[run.id];
        return {
          // A RUN STARTS ONCE. The runner that sends `run_end` after a Resume (or for a branch) is a
          // new process with a new `Run`, stamped when IT started — merged over the row, it moved the
          // run's start to the resume, so Duration shrank below its own steps and every step before
          // the pause drew before the run began. The server keeps the first start; so does this.
          runs: { ...state.runs, [run.id]: { ...known, ...run, started_at: known?.started_at ?? run.started_at } },
        };
      }
      // kind === "step"
      const step = event.step;
      const prev = state.stepsByRun[step.run_id] ?? {};
      const nextBucket = { ...prev, [step.id]: step }; // new ref → re-render this run's timeline
      const summary = state.runs[step.run_id];
      const runs = summary
        ? { ...state.runs, [step.run_id]: { ...summary, step_count: Object.keys(nextBucket).length } }
        : state.runs;
      // A step is stamped as it ends (`started_at` is its end — see traceView), so that is the
      // moment its delay is measured from.
      return { stepsByRun: { ...state.stepsByRun, [step.run_id]: nextBucket }, runs, lagByRun: withLag(state.lagByRun, step.run_id, step.started_at) };
    }),

  applyRunSteps: (runId, steps, evalScore) =>
    set((state) => ({
      stepsByRun: { ...state.stepsByRun, [runId]: bucketFrom(steps) },
      loaded: { ...state.loaded, [runId]: true },
      ...(evalScore ? { evalByRun: { ...state.evalByRun, [runId]: evalScore } } : {}),
    })),

  selectRun: (id) => set((state) => ({ ...aboutAnotherRun(state, id), activeRunId: id })),

  clearRunSelection: () => set((state) => ({ ...aboutAnotherRun(state, null), activeRunId: null })),

  // Debug depth: reflect a control-plane status flip (paused / resumed) on the run row. Only the
  // status changes — steps and seq ordering are untouched; a resumed run's new steps still arrive
  // as normal trace events. No-op if the run isn't known yet.
  setRunStatus: (runId, status, error) =>
    set((state) =>
      state.runs[runId]
        ? { runs: { ...state.runs, [runId]: { ...state.runs[runId], status, ...(error === undefined ? {} : { error }) } } }
        : {},
    ),

  // AN OPEN DRAWER FOLLOWS THE SELECTION. Details open on one step while another row is selected
  // would be two answers to "which step am I looking at"; so picking a different step — a click, J/K,
  // a graph node — moves the drawer with it. Clearing the selection leaves the drawer alone.
  //
  // AND A SELECTED STEP IS ALWAYS ON SCREEN. A graph node or the sparkline can pick a step whose
  // node is folded away, or that the filter or search is hiding; its ancestors unfold and the filter
  // steps aside, rather than the selection landing on a row nobody can see.
  selectStep: (id) =>
    set((state) => {
      const next: Partial<TraceState> = { selectedStepId: id };
      if (id && state.expandedStepId && state.expandedStepId !== id) next.expandedStepId = id;
      const bucket = id && state.activeRunId ? state.stepsByRun[state.activeRunId] : undefined;
      if (!id || !bucket?.[id]) return next;
      const folded = ancestorIds(bucket, id).filter((a) => state.collapsedStepIds[a]);
      if (folded.length > 0) {
        const collapsedStepIds = { ...state.collapsedStepIds };
        for (const a of folded) delete collapsedStepIds[a];
        next.collapsedStepIds = collapsedStepIds;
      }
      if (state.stepFilter !== "all" || state.stepQuery.trim() !== "") {
        const shown = visibleRows(buildTraceTree(Object.values(bucket)), { filter: state.stepFilter, query: state.stepQuery });
        if (!shown.some((r) => r.step.id === id)) {
          next.stepFilter = "all";
          next.stepQuery = "";
        }
      }
      return next;
    }),

  setExpandedStep: (id) => set({ expandedStepId: id }),

  needsLoad: (id) => !get().loaded[id],

  addLog: (line) =>
    set((state) => ({ logs: [line, ...state.logs].slice(0, LOG_CAP) })),

  setConnection: (connection) => set({ connection }),

  // BOUNDED. Boundaries arrive for every run, an eval's hundreds included, and only the runs somebody
  // could still be looking at need theirs: the latest is kept at the end, and the oldest go.
  setNext: (runId, next) =>
    set((state) => {
      const others = Object.entries(state.nextByRun).filter(([id]) => id !== runId).slice(-(NEXT_KEPT - 1));
      return { nextByRun: { ...Object.fromEntries(others), [runId]: next } };
    }),

  noteBoundary: (runId, seq) =>
    set((state) => {
      if ((state.boundaryByRun[runId] ?? -1) >= seq) return {};
      const others = Object.entries(state.boundaryByRun).filter(([id]) => id !== runId).slice(-(NEXT_KEPT - 1));
      return { boundaryByRun: { ...Object.fromEntries(others), [runId]: seq } };
    }),

  setAnswerOpen: (answerOpen) => set({ answerOpen }),

  setStepFilter: (stepFilter) => set({ stepFilter }),

  setStepQuery: (stepQuery) => set({ stepQuery }),

  requestGraphStep: (graphStepRequest) => set({ graphStepRequest }),

  setStepView: (stepView) => set({ stepView }),

  setRunTab: (runTab) => set({ runTab }),
  setDrawerTab: (drawerTab) => set({ drawerTab }),
  setDrawerSnap: (drawerSnap) => set({ drawerSnap, drawerDrag: null }),
  setDrawerDrag: (drawerDrag) => set({ drawerDrag }),

  toggleSection: (key) =>
    set((state) => {
      const collapsedSections = { ...state.collapsedSections };
      if (collapsedSections[key]) delete collapsedSections[key];
      else collapsedSections[key] = true;
      return { collapsedSections };
    }),

  setControlError: (error) => set({ controlError: error ? { ...error, at: Date.now() } : null }),

  setAllCollapsed: (collapsed) =>
    set((state) => {
      const bucket = state.activeRunId ? state.stepsByRun[state.activeRunId] : undefined;
      if (!bucket) return {};
      const nodes = buildTraceTree(Object.values(bucket)).filter((r) => r.childIds.length > 0).map((r) => r.step.id);
      const collapsedStepIds = { ...state.collapsedStepIds };
      for (const id of nodes) {
        if (collapsed) collapsedStepIds[id] = true;
        else delete collapsedStepIds[id];
      }
      // A selection folded out of sight moves up to its top-level node, as a single fold moves it.
      const sel = state.selectedStepId;
      const top = collapsed && sel && bucket[sel] ? [sel, ...ancestorIds(bucket, sel)].pop() : undefined;
      return top && top !== sel ? { collapsedStepIds, selectedStepId: top } : { collapsedStepIds };
    }),

  setCollapsed: (stepId, collapsed) =>
    set((state) => {
      if (Boolean(state.collapsedStepIds[stepId]) === collapsed) return {};
      const collapsedStepIds = { ...state.collapsedStepIds };
      if (collapsed) collapsedStepIds[stepId] = true;
      else delete collapsedStepIds[stepId];
      // Folding away the selected step's node moves the selection up to the node, so it stays visible.
      const bucket = state.activeRunId ? state.stepsByRun[state.activeRunId] : undefined;
      const hidden = collapsed && state.selectedStepId && bucket && ancestorIds(bucket, state.selectedStepId).includes(stepId);
      return hidden ? { collapsedStepIds, selectedStepId: stepId } : { collapsedStepIds };
    }),
}));

// --- selectors (pure; sort-by-seq lives here so no component can render arrival order) ---

/** Steps of a run in true causal order. Returns [] if none loaded yet. */
export function orderedSteps(bucket: Record<string, Step> | undefined): Step[] {
  if (!bucket) return [];
  return Object.values(bucket).sort((a, b) => a.seq - b.seq);
}

/**
 * The rows the active run's timeline draws, in order — what J/K and the arrow keys walk, so the
 * keyboard can never land on a step the screen is not showing.
 */
export function visibleTraceRows(
  state: Pick<TraceState, "activeRunId" | "stepsByRun" | "collapsedStepIds" | "stepFilter" | "stepQuery"> & Partial<Pick<TraceState, "runs" | "collapsedSections">>,
): VisibleRow[] {
  if (!state.activeRunId) return [];
  const bucket = state.stepsByRun[state.activeRunId];
  if (!bucket) return [];
  const rows = visibleRows(buildTraceTree(treeSteps(Object.values(bucket), state.runs?.[state.activeRunId])), {
    collapsed: state.collapsedStepIds,
    filter: state.stepFilter,
    query: state.stepQuery,
  });
  // A FOLDED SECTION'S ROWS ARE NOT ON SCREEN, so the keyboard does not walk them either.
  const folded = state.collapsedSections ?? {};
  if (Object.keys(folded).length === 0) return rows;
  const sections = traceSections(rows, Object.keys(bucket).length, nodeKind);
  return sections ? sections.flatMap((sec) => (folded[sec.key] ? [] : sec.rows)) : rows;
}

/**
 * The steps the timeline's tree is built from: all of them, except — while the run is live — those
 * still waiting for their node, which the live tail holds where that node will land (`awaitingNode`).
 */
export function treeSteps(steps: readonly Step[], run: Pick<RunSummary, "status"> | undefined): Step[] {
  if (run?.status !== "running") return [...steps];
  const waiting = awaitingNode(steps);
  return waiting.size === 0 ? [...steps] : steps.filter((s) => !waiting.has(s.id));
}

/**
 * The run's failed steps in the order the timeline draws them (tree order) — what E and Shift+E walk,
 * and what the error banner counts. Folds and filters do not hide a failure from these: selecting one
 * unfolds its node and sets a filter aside (`selectStep`).
 */
export function failedStepIds(state: Pick<TraceState, "activeRunId" | "stepsByRun">): string[] {
  const bucket = state.activeRunId ? state.stepsByRun[state.activeRunId] : undefined;
  if (!bucket) return [];
  return buildTraceTree(Object.values(bucket)).filter((r) => r.step.error != null).map((r) => r.step.id);
}

/** Select the next (or previous) failed step after the selection, wrapping round. False when none failed. */
export function jumpToError(delta: 1 | -1): boolean {
  const st = useTraceStore.getState();
  const failed = failedStepIds(st);
  if (failed.length === 0) return false;
  const bucket = st.activeRunId ? st.stepsByRun[st.activeRunId] : undefined;
  const order = bucket ? buildTraceTree(Object.values(bucket)).map((r) => r.step.id) : [];
  const at = st.selectedStepId ? order.indexOf(st.selectedStepId) : -1;
  const pos = (id: string): number => order.indexOf(id);
  const next = delta === 1
    ? failed.find((id) => pos(id) > at) ?? failed[0]!
    : [...failed].reverse().find((id) => pos(id) < (at === -1 ? order.length : at)) ?? failed[failed.length - 1]!;
  st.selectStep(next);
  return true;
}

/** Runs for the sidebar, newest first. *//** Runs for the sidebar, newest first. */
export function orderedRuns(runs: Record<string, RunSummary>): RunSummary[] {
  return Object.values(runs).sort((a, b) =>
    a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0,
  );
}
