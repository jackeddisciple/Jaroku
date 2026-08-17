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
import { Chip } from "./Chip.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { DatabaseIcon } from "./panelIcons.tsx";

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
  const evalsWindow = useEvalStore((s) => s.evalsWindow);
  const evalsComplete = useEvalStore((s) => s.evalsComplete);

  const [mode, setMode] = useState<Mode>("dataset");
  /**
   * How many past evals the strip is showing.
   *
   * TWO CEILINGS USED TO SIT ON TOP OF EACH OTHER HERE, and both were unreachable: the server read
   * the newest fifty with no way to ask past it, and this strip then rendered the first SIX of those
   * — so the seventh-newest comparison could not be selected at all, in the panel whose entire job is
   * comparing. This is the local half; the window below is the server's.
   */
  const [shown, setShown] = useState(6);
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
      <EmptyState
        icon={DatabaseIcon}
        title="No agent selected"
        hint="Pick one in the sidebar to build it a dataset and compare providers on it."
      />
    );
  }

  const tab = (m: Mode, label: string) => (
    <button
      onClick={() => setMode(m)}
      className={`px-2.5 py-1 text-[12px] rounded-control transition-colors ${
        mode === m ? "bg-active text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-hair px-4 pb-2 pt-1">
        {tab("dataset", "Dataset")}
        {tab("results", "Results")}
        {running && (
          <span className="ml-2 text-[11px] text-run animate-stream-pulse motion-reduce:animate-none">
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
              {evals.slice(0, shown).map((e) => (
                <Chip
                  key={e.id}
                  onClick={() => selectEval(e.id)}
                  selected={e.id === selectedEvalId}
                  tone="faint"
                  title={`${e.status} · ${e.targets.map((t) => t.model).join(", ")}`}
                >
                  {relTime(e.started_at)}
                  {e.status !== "completed" && (
                    <span className={e.status === "aborted_over_budget" ? "text-err" : "text-muted"}>
                      {e.status === "aborted_over_budget" ? "over budget" : e.status}
                    </span>
                  )}
                </Chip>
              ))}
              {/* OLDER COMPARISONS. It widens the strip first and then asks the server for a bigger
                  window when the loaded ones run out, so one control answers "show me more" whichever
                  of the two ceilings is the one in the way. It disappears when both are exhausted. */}
              {(shown < evals.length || !evalsComplete) && (
                <button
                  onClick={() => {
                    if (shown < evals.length) setShown(shown + 12);
                    else sendListEvals(selectedDatasetId ?? undefined, Math.min(evalsWindow * 2, 500));
                  }}
                  className="rounded-control px-2 py-1 text-[11px] text-muted transition-colors hover:bg-active hover:text-ink"
                >
                  older…
                </button>
              )}
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
            <EmptyState
              icon={DatabaseIcon}
              title="No results yet"
              hint="Pick providers under the dataset and run it — quality, cost and latency land here side by side."
            />
          )}
        </div>
      )}
    </div>
  );
}
