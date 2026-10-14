// The trace's header: which run this is, how it is going, and what can be done to it.
//
// IT WAS ONE LINE OF IDENTIFIERS — `Trace anthropic/claude-sonnet-5 · 99d9face` — beside the figures.
// Nothing on it said which agent ran, and a stopped run and a failed one read the same, because the
// only status it had was the absence of the word "Working". Now the first line names the panel and
// the outcome, as a coloured pill, and the second says whose run it is and when.
//
// A STOPPED RUN SAYS "stopped", NOT "failed": the server stores both as `error`, and the reason is
// what tells them apart. A paused one says "paused", because it can be resumed.
//
// THE ACTIONS ARE MARKS BESIDE THE OUTCOME, and only what already works: copy the id, show this run on
// the graph, find it in the Runs list, run it again — the same `runAgain` the Runs tab's row calls.

import { absTime, fmtDuration, relTime } from "../lib/format.ts";
import { runElapsed } from "../lib/traceView.ts";
import { useRunClock } from "../lib/useRunClock.ts";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";
import { openRun, runAgain, runAgainBlocked } from "../lib/runActions.ts";
import { runOutcome, type RunOutcome } from "../lib/runOutcome.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { RunSummary } from "../types.ts";
import { PauseResumeControls } from "./PauseResumeControls.tsx";
import { IconButton } from "./IconButton.tsx";
import { Tip } from "./ui/tooltip.tsx";

/** The first segment of a uuid — enough to tell two runs apart. */
const shortId = (id: string): string => id.slice(0, 8);

type Outcome = RunOutcome;

/**
 * THE OUTCOME AS A PILL — the product owner's call on 2026-10-12: a finished run is a green pill,
 * its word and its mark green together. Each outcome keeps the colour it means everywhere else in
 * the app: amber only for a run still moving, red for a failure. A run somebody STOPPED is info blue
 * (2026-10-14) — not a success, not a fault, and no longer the grey of a paused one beside it.
 */
const OUTCOME: Record<Outcome, { tone: string; Mark: IconComponent }> = {
  finished: { tone: "bg-ok/10 text-ok", Mark: Icon.trace.finished },
  failed: { tone: "bg-err/10 text-err", Mark: Icon.trace.failed },
  running: { tone: "bg-run/10 text-run", Mark: Icon.trace.running },
  paused: { tone: "bg-active text-muted", Mark: Icon.trace.paused },
  stopped: { tone: "bg-warn/10 text-warn", Mark: Icon.trace.stopped },
};

/**
 * WHILE IT RUNS, THE PILL IS ALIVE: a pulsing amber dot where the mark was, and the time it has run
 * so far beside the word, on the run's own clock (`useRunClock`) — the same figure as Elapsed.
 */
function OutcomePill({ run }: { run: RunSummary }) {
  const outcome = runOutcome(run);
  const { tone, Mark } = OUTCOME[outcome];
  const live = outcome === "running";
  const now = useRunClock(run.id, live, 200);
  const elapsed = live ? runElapsed(run, [], now) : null;
  return (
    <span className={`flex h-6 items-center gap-1.5 rounded-pill px-2 text-tiny font-medium ${tone}`}>
      {live ? (
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-stream-pulse rounded-full bg-run motion-reduce:animate-none" />
      ) : (
        <Mark size={ICON.xs} />
      )}
      {outcome}
      {elapsed != null && <span className="tabular-nums font-normal">· {fmtDuration(elapsed)}</span>}
    </span>
  );
}

/** A pressable fact on the metadata line: the app's neutral chip, darker on hover. */
const CHIP = "rounded-xs bg-active/60 px-1.5 py-px text-tiny text-muted transition-colors hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring";

async function copyRunId(id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(id);
    useUiStore.getState().showToast("Run ID copied");
  } catch {
    useUiStore.getState().showToast("Couldn't reach the clipboard", "err");
  }
}

/**
 * WHAT CAN BE DONE TO THE RUN, AS MARKS BESIDE ITS OUTCOME — the product owner's call on 2026-10-14:
 * the four were behind a ⋯ that hid them a click away. Copy its id, show it on the graph, find it in
 * Runs, run it again; each mark says what it does on hover, and Run again says why when it can't.
 */
function RunActions({ run }: { run: RunSummary }) {
  return (
    <span className="flex items-center" role="group" aria-label="Run actions">
      <IconButton icon={Icon.turn.copy} label="Copy run ID" onClick={() => { void copyRunId(run.id); }} />
      <IconButton icon={Icon.panel.graph} label="Show on graph" onClick={() => useUiStore.getState().setRightTab("graph")} />
      <IconButton icon={Icon.panel.runs} label="Open in Runs" onClick={() => useUiStore.getState().setRightTab("runs")} />
      <IconButton
        icon={Icon.cockpit.refresh}
        label="Run again on this run's input and model"
        disabledReason={runAgainBlocked(run)}
        onClick={() => runAgain(run)}
      />
    </span>
  );
}

export function TraceHeader({ run }: { run: RunSummary | undefined }) {
  const agentName = useBuildStore((s) =>
    run ? (s.agents.find((a) => a.agent_id === run.agent_id)?.name ?? run.agent_id) : null,
  );

  // The body says why there is nothing here, once; the header only names the panel.
  if (!run) {
    return (
      <div className="flex shrink-0 items-center gap-3 border-b border-hair px-6 py-3">
        <span className={TYPE.panelLabel}>Execution trace</span>
      </div>
    );
  }


  return (
    <div className="shrink-0 border-b border-hair px-6 pb-2.5 pt-3">
      <div className="flex min-h-6 items-center gap-3">
        <span className={`min-w-0 truncate ${TYPE.panelLabel}`}>Execution trace</span>
        <span className="ml-auto flex shrink-0 items-center gap-3">
          <PauseResumeControls />
          <OutcomePill run={run} />
          <RunActions run={run} />
        </span>
      </div>
      {/* WHOSE RUN AND WHEN — one line that gives up its tail before it wraps. The model is not
          here (the product owner's call): it is in a step's details, beside the figures it explains. */}
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-tiny text-muted">
        {/* THE NAME GIVES WAY LAST. Both it and the branch note could shrink, equally, so at 330px
            the name read "Liv…" while "branch of bec57d6c fro…" kept its room. The note now shrinks
            a thousand times faster — down to its mark — before the name loses a letter. */}
        <span className="min-w-0 shrink truncate text-label text-ink" title={agentName ?? run.agent_id}>{agentName}</span>
        {/* THE LINE'S PARTS DO SOMETHING (2026-10-14): the id copies itself, the time says exactly when
            on hover, and a branch's parent opens on a click. Chips, so each reads as pressable. */}
        <Tip label="Copy run ID">
          <button type="button" onClick={() => { void copyRunId(run.id); }} className={`${CHIP} shrink-0 tabular-nums`} aria-label={`Copy run ID ${run.id}`}>
            {shortId(run.id)}
          </button>
        </Tip>
        <Tip label={absTime(run.started_at)}>
          <span className={`${CHIP} shrink-0 cursor-default`} tabIndex={0}>{relTime(run.started_at)}</span>
        </Tip>
        {run.parent_run_id && (
          <Tip label={`Open run ${run.parent_run_id}, which this branched from`}>
            <button
              type="button"
              onClick={() => openRun(run.parent_run_id!)}
              className={`${CHIP} flex min-w-[1.75rem] shrink-[1000] items-center gap-1 truncate`}
            >
              {/* The branch mark in green, the product owner's call on 2026-10-12; its words stay muted. */}
              <span aria-hidden className="shrink-0 text-ok"><Icon.agents.fork size={ICON.xs} /></span>
              <span className="truncate">
                branch of {shortId(run.parent_run_id)}
                {run.branch_from_seq != null && ` from #${run.branch_from_seq}`}
              </span>
            </button>
          </Tip>
        )}
        {/* WHAT A BRANCH WAS RE-RUN WITH (2026-10-14), when it was given a temperature or a seed —
            the model is the run's own and already in its details. */}
        {(run.temperature != null || run.seed != null) && (
          <Tip label="The sampling this run was re-run with — the model's own default otherwise">
            <span className={`${CHIP} shrink-0 cursor-default tabular-nums`} tabIndex={0}>
              {[run.temperature != null ? `temperature ${run.temperature}` : null, run.seed != null ? `seed ${run.seed}` : null].filter(Boolean).join(" · ")}
            </span>
          </Tip>
        )}
      </div>
    </div>
  );
}
