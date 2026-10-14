// What can be done to a run from more than one place: open its trace, run its agent again.
//
// THESE LIVED IN THE RUNS TAB, which was their only caller until the trace's own header grew the
// same menu. Two copies of "run again" would be two places to forget the missing-key check, so the
// row's menu and the trace's menu now call the same two functions.

import { sendLoadRun, sendRun } from "./socket.ts";
import { selectRun } from "./selection.ts";
import { isRunnable, useProviderStore } from "../store/providerStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";

/**
 * "Run again", for THIS agent on the model the composer has chosen. With no key for that model it
 * opens Secrets at that provider instead.
 */
export function runAgain(agentId: string): void {
  const { provider, model } = useUiStore.getState();
  const { providers, loaded } = useProviderStore.getState();
  if (loaded && !isRunnable(providers, provider)) {
    useUiStore.getState().openSecretsForProvider(provider || "anthropic");
    return;
  }
  sendRun(undefined, provider, model, agentId);
}

/** Open a run's trace, fetching its steps first when they are not here yet. */
export function openRun(runId: string): void {
  if (useTraceStore.getState().needsLoad(runId)) sendLoadRun(runId);
  selectRun(runId);
  useUiStore.getState().setRightTab("trace");
}

/**
 * "Show this step on the graph", from a trace row or from its details: the step becomes the selection
 * (and what the composer is about), and the Graph tab opens on the run as it stood when that step's
 * node finished — see `traceStore.graphStepRequest`.
 */
export function showStepOnGraph(stepId: string): void {
  const trace = useTraceStore.getState();
  trace.selectStep(stepId);
  trace.requestGraphStep(stepId);
  useUiStore.getState().setSelectedNodeId(null);
  useUiStore.getState().setRightTab("graph");
}
