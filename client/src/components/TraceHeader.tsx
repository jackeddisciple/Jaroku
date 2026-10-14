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
// THE MENU HOLDS ONLY WHAT ALREADY WORKS. Copy the id, show this run on the graph, find it in the
// Runs list, run the agent again — the same `runAgain` the Runs tab's row calls.

import { useState } from "react";

import { absTime, relTime } from "../lib/format.ts";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";
import { runAgain } from "../lib/runActions.ts";
import { runOutcome, type RunOutcome } from "../lib/runOutcome.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { RunSummary } from "../types.ts";
import { PauseResumeControls } from "./PauseResumeControls.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx";

/** The first segment of a uuid — enough to tell two runs apart. */
const shortId = (id: string): string => id.slice(0, 8);

type Outcome = RunOutcome;

/**
 * THE OUTCOME AS A PILL — the product owner's call on 2026-10-12: a finished run is a green pill,
 * its word and its mark green together. Each outcome keeps the colour it means everywhere else in
 * the app: amber only for a run still moving, red for a failure, and no colour for a run that was
 * stopped or paused, which is neither a success nor a fault.
 */
const OUTCOME: Record<Outcome, { tone: string; Mark: IconComponent }> = {
  finished: { tone: "bg-ok/10 text-ok", Mark: Icon.trace.finished },
  failed: { tone: "bg-err/10 text-err", Mark: Icon.trace.failed },
  running: { tone: "bg-run/10 text-run", Mark: Icon.trace.running },
  paused: { tone: "bg-active text-muted", Mark: Icon.trace.paused },
  stopped: { tone: "bg-active text-muted", Mark: Icon.trace.stopped },
};

function OutcomePill({ outcome }: { outcome: Outcome }) {
  const { tone, Mark } = OUTCOME[outcome];
  return (
    <span className={`flex h-6 items-center gap-1 rounded-pill px-2 text-tiny font-medium ${tone}`}>
      <Mark size={ICON.xs} />
      {outcome}
    </span>
  );
}

function RunMenu({ run }: { run: RunSummary }) {
  const [open, setOpen] = useState(false);

  const copyId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(run.id);
      useUiStore.getState().showToast("Run ID copied");
    } catch {
      useUiStore.getState().showToast("Couldn't reach the clipboard", "err");
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="More"
          aria-label={`More actions for run ${shortId(run.id)}`}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-control transition-colors hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring ${
            open ? "bg-active text-ink" : "text-faint"
          }`}
        >
          <Icon.agents.more size={ICON.sm} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Run actions">
        <DropdownMenuItem size="compact" onSelect={() => { void copyId(); }}>
          <Icon.turn.copy size={ICON.sm} />
          <span className="min-w-0 flex-1 truncate">Copy run ID</span>
        </DropdownMenuItem>
        <DropdownMenuItem size="compact" onSelect={() => useUiStore.getState().setRightTab("graph")}>
          <Icon.panel.graph size={ICON.sm} />
          <span className="min-w-0 flex-1 truncate">Show on graph</span>
        </DropdownMenuItem>
        <DropdownMenuItem size="compact" onSelect={() => useUiStore.getState().setRightTab("runs")}>
          <Icon.panel.runs size={ICON.sm} />
          <span className="min-w-0 flex-1 truncate">Open in Runs</span>
        </DropdownMenuItem>
        <DropdownMenuItem size="compact" onSelect={() => runAgain(run.agent_id)}>
          <Icon.cockpit.refresh size={ICON.sm} />
          <span className="min-w-0 flex-1 truncate">Run again</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
          <OutcomePill outcome={runOutcome(run)} />
          <RunMenu run={run} />
        </span>
      </div>
      {/* WHOSE RUN AND WHEN — one line that gives up its tail before it wraps. The model is not
          here (the product owner's call): it is in a step's details, beside the figures it explains. */}
      <div className="mt-1 flex min-w-0 items-baseline gap-1.5 text-tiny text-muted">
        {/* THE NAME GIVES WAY LAST. Both it and the branch note could shrink, equally, so at 330px
            the name read "Liv…" while "branch of bec57d6c fro…" kept its room. The note now shrinks
            a thousand times faster — down to its mark — before the name loses a letter. */}
        <span className="min-w-0 shrink truncate text-label text-ink" title={agentName ?? run.agent_id}>{agentName}</span>
        <span className="shrink-0" title={run.id}>· {shortId(run.id)}</span>
        <span className="shrink-0" title={absTime(run.started_at)}>· {relTime(run.started_at)}</span>
        {run.parent_run_id && (
          <span className="flex min-w-[1.75rem] shrink-[1000] items-center gap-1 truncate" title={`Branched from run ${run.parent_run_id}`}>
            {/* The branch mark in green, the product owner's call on 2026-10-12; its words stay muted. */}
            · <span aria-hidden className="shrink-0 text-ok"><Icon.agents.fork size={ICON.xs} /></span>
            <span className="truncate">
              branch of {shortId(run.parent_run_id)}
              {run.branch_from_seq != null && ` from #${run.branch_from_seq}`}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
