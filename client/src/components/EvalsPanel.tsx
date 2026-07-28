// The Evals tab: build a dataset, run it across providers, read the comparison.
//
// One tab with two modes rather than two tabs, because they're the same task at different
// stages — you build a dataset in order to run it, and you come back to the dataset when
// the results tell you what's missing. The mode auto-follows the work: starting an eval
// switches to Results, and an agent with no dataset yet lands on Dataset.

import { useEffect, useState } from "react";
import { useBuildStore } from "../store/buildStore.ts";
import { useEvalStore } from "../store/evalStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { sendListEvals, sendLoadEvalResults } from "../lib/socket.ts";
import { DatasetBuilder } from "./DatasetBuilder.tsx";
import { ComparisonTable } from "./EvalDashboard.tsx";
import { ExampleDrillDown } from "./EvalDrillDown.tsx";
import { EvalRunBar } from "./EvalRunBar.tsx";
import { relTime } from "../lib/format.ts";

type Mode = "dataset" | "results";

export function EvalsPanel() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const connected = useTraceStore((s) => s.connection === "open");
  const selectedDatasetId = useEvalStore((s) => s.selectedDatasetId);
  const evals = useEvalStore((s) => s.evals);
  const selectedEvalId = useEvalStore((s) => s.selectedEvalId);
  const selectEval = useEvalStore((s) => s.selectEval);
  const resultsByEval = useEvalStore((s) => s.resultsByEval);
  const progress = useEvalStore((s) => s.progress);

  const [mode, setMode] = useState<Mode>("dataset");
  const results = selectedEvalId ? resultsByEval[selectedEvalId] : undefined;
  const running = progress !== null && (progress.status === undefined || progress.scoring === true);

  // Past evals for this dataset, so a finished comparison stays reachable.
  useEffect(() => {
    if (connected && selectedDatasetId) sendListEvals(selectedDatasetId);
  }, [connected, selectedDatasetId]);

  // An eval starting is the moment the results view becomes the thing to look at.
  useEffect(() => {
    if (progress) setMode("results");
  }, [progress?.evalId]);

  useEffect(() => {
    if (connected && selectedEvalId && !resultsByEval[selectedEvalId]) sendLoadEvalResults(selectedEvalId);
  }, [connected, selectedEvalId]);

  if (!activeAgentId) {
    return (
      <div className="flex h-full items-center justify-center text-center px-6">
        <div className="text-muted">
          <div className="text-ink mb-1">Evals</div>
          <div className="text-[12px]">Select an agent to build a dataset for it.</div>
        </div>
      </div>
    );
  }

  const tab = (m: Mode, label: string) => (
    <button
      onClick={() => setMode(m)}
      className={`px-2.5 py-1 text-[12px] rounded transition-colors ${
        mode === m ? "bg-active text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-4 pb-2 shrink-0">
        {tab("dataset", "Dataset")}
        {tab("results", "Results")}
        {running && (
          <span className="ml-2 text-[11px] text-run animate-pulse">
            {progress.scoring && progress.status ? "scoring…" : `running ${progress.done}/${progress.total}`}
          </span>
        )}
      </div>

      {mode === "dataset" ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0"><DatasetBuilder /></div>
          <EvalRunBar />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
          {/* Past evals — a comparison keeps its value after the run that produced it. */}
          {evals.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5 pb-3">
              {evals.slice(0, 6).map((e) => (
                <button
                  key={e.id}
                  onClick={() => selectEval(e.id)}
                  title={`${e.status} · ${e.targets.map((t) => t.model).join(", ")}`}
                  className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                    e.id === selectedEvalId ? "bg-active text-ink" : "text-faint hover:text-ink"
                  }`}
                >
                  {relTime(e.started_at)}
                  {e.status !== "completed" && (
                    <span className={e.status === "aborted_over_budget" ? "text-err ml-1" : "text-muted ml-1"}>
                      · {e.status === "aborted_over_budget" ? "over budget" : e.status}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {progress && !progress.status && (
            <div className="text-[11px] text-muted pb-3">
              {progress.done}/{progress.total} runs done · {progress.running} in flight
              {progress.queued > 0 && ` · ${progress.queued} queued`}
              {progress.failed > 0 && <span className="text-err"> · {progress.failed} failed</span>}
            </div>
          )}

          {results ? (
            <>
              <ComparisonTable results={results} />
              <ExampleDrillDown results={results} />
            </>
          ) : (
            <div className="text-[12px] text-muted pt-6">
              No results yet. Pick providers below the dataset and run it.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
