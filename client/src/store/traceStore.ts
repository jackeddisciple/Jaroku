// The trace store — the correctness core of the timeline (the 🟡 review point).
//
// Invariants that keep the trace honest (README §10.3 "a corrupted trace is a lying product"):
//   1. Steps are keyed by step.id, so at-least-once re-delivery is idempotent (no duplicates).
//   2. Render order is ALWAYS derived by sorting on `seq`, never arrival order — steps are
//      emitted at end time and therefore arrive out of causal order (README §4.3).
// All updates are immutable so React/zustand see changed references exactly when data changes.

import { create } from "zustand";
import type { Run, RunStatus, RunSummary, Step, TraceEvent } from "../types.ts";

export type ConnectionState = "connecting" | "open" | "closed";
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
   * Whether the trace's Final answer section is open. One choice for every run, kept for the session
   * and never written to storage: somebody who folded it away to read steps wants the next run's
   * answer folded too, and a reload is a fair moment to show it again.
   */
  answerOpen: boolean;

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
  applyRunSteps: (runId: string, steps: Step[]) => void;
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
  setAnswerOpen: (open: boolean) => void;
}

const LOG_CAP = 200;
/** How many runs' next nodes are kept — see `setNext`. */
const NEXT_KEPT = 50;

/**
 * The reason the server writes on a run somebody stopped — its `TraceStore.CANCELLED_BY_USER`, held to
 * it by `test:trace`. A stopped run and a failed one are both `error`; this is what tells them apart.
 */
export const CANCELLED_BY_USER = "cancelled by user";

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
  activeRunId: null,
  selectedStepId: null,
  expandedStepId: null,
  connection: "connecting",
  logs: [],
  nextByRun: {},
  answerOpen: true,

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
          activeRunId: run.id, // auto-focus the run that just started
          selectedStepId: null, // a new run's steps don't exist yet — drop stale selection
          expandedStepId: null,
        };
      }
      if (event.kind === "run_end") {
        const run: Run = event.run;
        return {
          runs: { ...state.runs, [run.id]: { ...state.runs[run.id], ...run } },
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
      return { stepsByRun: { ...state.stepsByRun, [step.run_id]: nextBucket }, runs };
    }),

  applyRunSteps: (runId, steps) =>
    set((state) => ({
      stepsByRun: { ...state.stepsByRun, [runId]: bucketFrom(steps) },
      loaded: { ...state.loaded, [runId]: true },
    })),

  selectRun: (id) => set({ activeRunId: id, selectedStepId: null, expandedStepId: null }),

  clearRunSelection: () => set({ activeRunId: null, selectedStepId: null, expandedStepId: null }),

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
  selectStep: (id) =>
    set((state) =>
      id && state.expandedStepId && state.expandedStepId !== id
        ? { selectedStepId: id, expandedStepId: id }
        : { selectedStepId: id },
    ),

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

  setAnswerOpen: (answerOpen) => set({ answerOpen }),
}));

// --- selectors (pure; sort-by-seq lives here so no component can render arrival order) ---

/** Steps of a run in true causal order. Returns [] if none loaded yet. */
export function orderedSteps(bucket: Record<string, Step> | undefined): Step[] {
  if (!bucket) return [];
  return Object.values(bucket).sort((a, b) => a.seq - b.seq);
}

/** Runs for the sidebar, newest first. */
export function orderedRuns(runs: Record<string, RunSummary>): RunSummary[] {
  return Object.values(runs).sort((a, b) =>
    a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0,
  );
}
