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
import type { Dataset, DatasetExample } from "../types.ts";

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
}));

/** Examples of a dataset in position order. `[]` when not loaded yet. */
export function examplesOf(
  byDataset: Record<string, DatasetExample[]>,
  datasetId: string | null,
): DatasetExample[] {
  if (!datasetId) return [];
  return byDataset[datasetId] ?? [];
}
