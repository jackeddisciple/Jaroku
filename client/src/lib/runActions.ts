// What can be done to a run from more than one place: open its trace, run its agent again.
//
// THESE LIVED IN THE RUNS TAB, which was their only caller until the trace's own header grew the
// same menu. Two copies of "run again" would be two places to forget the missing-key check, so the
// row's menu and the trace's menu now call the same two functions.

import { sendLoadRun, sendRunAgain } from "./socket.ts";
import { selectRun } from "./selection.ts";
import { isRunnable, useProviderStore } from "../store/providerStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { RunSummary } from "../types.ts";

/**
 * "Run again": THIS RUN, again — its own input on its own provider and model, which the server reads
 * (`sendRunAgain`). It sent no input and the composer's model, so the agent ran on the runner's
 * default greeting instead. With no key for the run's provider it opens Secrets there instead.
 */
export function runAgain(run: Pick<RunSummary, "id" | "agent_id" | "provider">): void {
  const { providers, loaded } = useProviderStore.getState();
  if (loaded && !isRunnable(providers, run.provider)) {
    useUiStore.getState().openSecretsForProvider(run.provider || "anthropic");
    return;
  }
  sendRunAgain(run.id, run.agent_id);
}

/** Why "Run again" cannot work for a run, or null when it can (the server says if it cannot). */
export function runAgainBlocked(run: Pick<RunSummary, "has_input">): string | null {
  return run.has_input === false ? "This run's input wasn't kept — it ran before inputs were — so it can't be run again" : null;
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
