// How a run went, in one word — the same word on every surface that names it.
//
// THE RUNS LIST AND THE TRACE HEADER SAID DIFFERENT THINGS ABOUT THE SAME RUN. The list read the
// status through its phase (`RUN_PHASE`), so a paused run was "stopped" (paused → halted → "stopped")
// and a run somebody stopped was "failed" (its status is `error`); the header said "paused" and
// "stopped". "Stopped" meant one thing on one surface and another on the next. Both read this now.
//
// A STOPPED RUN AND A FAILED ONE ARE BOTH `error` ON THE SERVER, and the reason on the row is what
// tells them apart (`CANCELLED_BY_USER`).

import { CANCELLED_BY_USER } from "../store/traceStore.ts";
import type { RunSummary } from "../types.ts";
import { RUN_PHASE } from "./domainPhase.ts";
import type { Phase } from "./statusPhase.ts";

export type RunOutcome = "running" | "paused" | "finished" | "failed" | "stopped";

/** The run's outcome, as the word every surface says for it. */
export function runOutcome(run: Pick<RunSummary, "status" | "error">): RunOutcome {
  if (run.status === "error") return run.error === CANCELLED_BY_USER ? "stopped" : "failed";
  if (run.status === "completed") return "finished";
  return run.status;
}

/**
 * The outcome's phase, for the shared status glyph: the status's own, except that a run somebody
 * stopped is `halted` — nobody's fault, nothing to fix — rather than the `failed` its status implies.
 */
export function outcomePhase(run: Pick<RunSummary, "status" | "error">): Phase {
  return runOutcome(run) === "stopped" ? "halted" : RUN_PHASE[run.status];
}
