// Eval state — datasets and their examples (doc §6.4 dataset builder).
//
// Deliberately separate from traceStore. The trace store owns run data and has one
// invariant that matters here: `applyEvent` focuses `activeRunId` on every run_start. An
// eval fans out into many parallel runs, so if eval data flowed through there the Trace
// timeline would jump between them and the user would lose their place. Eval facts arrive
// on their own channel and land here; the runs an eval produces are still ordinary runs,
// read back on demand through the existing loadRun path.
//
// The server answers every mutation with a full snapshot, so every reducer below is a
// replace, never a merge — there is no partial state to reconcile.

import { create } from "zustand";
import type { Dataset, DatasetExample, EvalResults, EvalRunSummary, Rubric } from "../types.ts";

/** Live counters while an eval drains. Counts only — no step traffic on this channel. */
export interface EvalProgress {
  evalId: string;
  total: number;
  done: number;
  running: number;
  queued: number;
  failed: number;
  /** Set once the runs finish; scoring may still be in flight. */
  status?: string;
  scoring?: boolean;
}

interface EvalState {
  /** Datasets for the agent last listed, newest first. */
  datasets: Dataset[];
  /** datasetId -> its examples, in position order. Populated on demand. */
  examplesByDataset: Record<string, DatasetExample[]>;
  /** Which dataset the builder is showing. */
  selectedDatasetId: string | null;
  /** Last control-plane error, surfaced inline rather than swallowed. */
  error: string | null;
  /** Transient confirmation for a one-click promotion — the composer shows it briefly so
   *  the user knows WHERE the input landed (and whether it was already there). */
  promoted: { datasetName: string; duplicate: boolean; at: number } | null;

  setDatasets: (datasets: Dataset[]) => void;
  setExamples: (datasetId: string, examples: DatasetExample[]) => void;
  removeDataset: (datasetId: string) => void;
  selectDataset: (id: string | null) => void;
  setError: (message: string | null) => void;
  setPromoted: (datasetName: string, duplicate: boolean) => void;
  clearPromoted: () => void;

  // --- eval runs ---
  /** Past evals for the selected dataset, newest first. */
  evals: EvalRunSummary[];
  /** The eval whose results the dashboard is showing. */
  selectedEvalId: string | null;
  /** evalId -> full results (provider rollups + per-example rows). */
  resultsByEval: Record<string, EvalResults>;
  /** Live counters for the eval currently draining, if any. */
  progress: EvalProgress | null;
  /** The dataset's rubric, once loaded. */
  rubric: Rubric | null;
  rubricIsDefault: boolean;

  setEvals: (evals: EvalRunSummary[]) => void;
  selectEval: (evalId: string | null) => void;
  setResults: (evalId: string, results: EvalResults) => void;
  setProgress: (p: EvalProgress | null) => void;
  patchProgress: (patch: Partial<EvalProgress>) => void;
  setRubric: (rubric: Rubric, isDefault: boolean) => void;
}

export const useEvalStore = create<EvalState>((set) => ({
  datasets: [],
  examplesByDataset: {},
  selectedDatasetId: null,
  error: null,
  promoted: null,

  setDatasets: (datasets) =>
    set((s) => ({
      datasets,
      // Keep a selection only while it still exists; otherwise fall back to the newest so
      // the builder is never pointed at a dataset that has been deleted elsewhere.
      selectedDatasetId:
        s.selectedDatasetId && datasets.some((d) => d.id === s.selectedDatasetId)
          ? s.selectedDatasetId
          : (datasets[0]?.id ?? null),
    })),

  setExamples: (datasetId, examples) =>
    set((s) => ({ examplesByDataset: { ...s.examplesByDataset, [datasetId]: examples } })),

  removeDataset: (datasetId) =>
    set((s) => {
      const examplesByDataset = { ...s.examplesByDataset };
      delete examplesByDataset[datasetId];
      return {
        examplesByDataset,
        datasets: s.datasets.filter((d) => d.id !== datasetId),
        selectedDatasetId: s.selectedDatasetId === datasetId ? null : s.selectedDatasetId,
      };
    }),

  selectDataset: (selectedDatasetId) => set({ selectedDatasetId, error: null }),

  setError: (error) => set({ error }),

  setPromoted: (datasetName, duplicate) => set({ promoted: { datasetName, duplicate, at: Date.now() } }),
  clearPromoted: () => set({ promoted: null }),

  evals: [],
  selectedEvalId: null,
  resultsByEval: {},
  progress: null,
  rubric: null,
  rubricIsDefault: true,

  setEvals: (evals) =>
    set((s) => ({
      evals,
      // Default to the newest eval so finishing one lands you on its results.
      selectedEvalId:
        s.selectedEvalId && evals.some((e) => e.id === s.selectedEvalId)
          ? s.selectedEvalId
          : (evals[0]?.id ?? null),
    })),

  selectEval: (selectedEvalId) => set({ selectedEvalId }),

  setResults: (evalId, results) =>
    set((s) => ({ resultsByEval: { ...s.resultsByEval, [evalId]: results } })),

  setProgress: (progress) => set({ progress }),

  patchProgress: (patch) =>
    set((s) => (s.progress ? { progress: { ...s.progress, ...patch } } : {})),

  setRubric: (rubric, rubricIsDefault) => set({ rubric, rubricIsDefault }),
}));

/** Examples of a dataset in position order. `[]` when not loaded yet. */
export function examplesOf(
  byDataset: Record<string, DatasetExample[]>,
  datasetId: string | null,
): DatasetExample[] {
  if (!datasetId) return [];
  return byDataset[datasetId] ?? [];
}
