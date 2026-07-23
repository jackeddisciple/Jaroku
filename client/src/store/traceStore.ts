// The trace store — the correctness core of the timeline (the 🟡 review point).
//
// Invariants that keep the trace honest (README §10.3 "a corrupted trace is a lying product"):
//   1. Steps are keyed by step.id, so at-least-once re-delivery is idempotent (no duplicates).
//   2. Render order is ALWAYS derived by sorting on `seq`, never arrival order — steps are
//      emitted at end time and therefore arrive out of causal order (README §4.3).
// All updates are immutable so React/zustand see changed references exactly when data changes.

import { create } from "zustand";
import type { Run, RunSummary, Step, TraceEvent } from "../types.ts";

export type ConnectionState = "connecting" | "open" | "closed";
export type LogLine = { level: "stderr" | "parseError"; text: string };

interface TraceState {
  runs: Record<string, RunSummary>;
  stepsByRun: Record<string, Record<string, Step>>; // runId -> (stepId -> Step)
  loaded: Record<string, true>; // runIds whose steps are fully in memory
  activeRunId: string | null;
  // The step the user is focused on — drives trace↔graph sync (a clicked step lights its
  // graph node, and clicking a node selects a step here). Cleared when the active run changes.
  selectedStepId: string | null;
  connection: ConnectionState;
  logs: LogLine[];

  applyHistory: (runs: RunSummary[]) => void;
  applyEvent: (event: TraceEvent) => void;
  applyRunSteps: (runId: string, steps: Step[]) => void;
  selectRun: (id: string) => void;
  selectStep: (id: string | null) => void;
  needsLoad: (id: string) => boolean;
  addLog: (line: LogLine) => void;
  setConnection: (c: ConnectionState) => void;
}

const LOG_CAP = 200;

function bucketFrom(steps: Step[]): Record<string, Step> {
  const out: Record<string, Step> = {};
  for (const s of steps) out[s.id] = s; // keyed by id → dedupe
  return out;
}

export const useTraceStore = create<TraceState>((set, get) => ({
  runs: {},
  stepsByRun: {},
  loaded: {},
  activeRunId: null,
  selectedStepId: null,
  connection: "connecting",
  logs: [],

  applyHistory: (runs) =>
    set((state) => {
      const merged = { ...state.runs };
      for (const r of runs) merged[r.id] = { ...merged[r.id], ...r };
      return { runs: merged };
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

  selectRun: (id) => set({ activeRunId: id, selectedStepId: null }),

  selectStep: (id) => set({ selectedStepId: id }),

  needsLoad: (id) => !get().loaded[id],

  addLog: (line) =>
    set((state) => ({ logs: [line, ...state.logs].slice(0, LOG_CAP) })),

  setConnection: (connection) => set({ connection }),
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
