// Provider picker + run control for an eval.
//
// Real providers are deliberately NOT selectable yet: an eval multiplies cost by
// examples × providers, and firing one with no idea of the bill is exactly the mistake this
// feature must not make easy. The dry run is free and proves the whole loop, so it ships
// first; real providers unlock together with the pre-run cost estimate.

import { useEvalStore } from "../store/evalStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { RUN_PROVIDERS } from "../store/uiStore.ts";
import { sendCancelEval, sendStartEval } from "../lib/socket.ts";
import { examplesOf } from "../store/evalStore.ts";

export function EvalRunBar() {
  const activeAgentId = useBuildStore((s) => s.activeAgentId);
  const connected = useTraceStore((s) => s.connection === "open");
  const selectedDatasetId = useEvalStore((s) => s.selectedDatasetId);
  const examplesByDataset = useEvalStore((s) => s.examplesByDataset);
  const progress = useEvalStore((s) => s.progress);

  const examples = examplesOf(examplesByDataset, selectedDatasetId);
  const running = progress !== null && progress.status === undefined;
  const free = RUN_PROVIDERS.find((p) => p.id === "fake")!;

  if (!selectedDatasetId) return null;

  const run = () => {
    if (!activeAgentId || !examples.length) return;
    // Free by construction: the dry-run model is priced at zero, so there is no ceiling to
    // set and nothing to confirm.
    sendStartEval(selectedDatasetId, activeAgentId, [{ provider: "fake", model: free.models[0] }], null);
  };

  return (
    <div className="px-4 py-3 shrink-0 flex items-center gap-2.5 text-[12px]">
      <span className="rounded px-2 py-1 bg-active text-ink whitespace-nowrap shrink-0">
        Dry run (free)
      </span>
      <span
        className="text-faint whitespace-nowrap shrink-0"
        title="Real providers unlock with the pre-run cost estimate — an eval multiplies cost by examples × providers"
      >
        + real providers soon
      </span>

      <span className="ml-auto text-faint tabular-nums whitespace-nowrap">
        {examples.length} run{examples.length === 1 ? "" : "s"}
      </span>

      {running ? (
        <button
          onClick={() => progress && sendCancelEval(progress.evalId)}
          className="rounded px-3 py-1.5 text-[12px] text-err hover:bg-active transition-colors"
        >
          Cancel
        </button>
      ) : (
        <button
          onClick={run}
          disabled={!connected || !examples.length}
          className="rounded px-3 py-1.5 text-[12px] whitespace-nowrap shrink-0 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ background: "#e4e4e7", color: "#0d0d0f" }}
        >
          Run eval
        </button>
      )}
    </div>
  );
}
