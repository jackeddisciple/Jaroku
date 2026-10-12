// The trace's header: which run this is, how it is going, and what can be done to it.
//
// IT WAS ONE LINE OF IDENTIFIERS — `Trace anthropic/claude-sonnet-5 · 99d9face` — beside the figures.
// Nothing on it said which agent ran, and a stopped run and a failed one read the same, because the
// only status it had was the absence of the word "Working". Now the first line names the panel and
// the outcome, and the second says whose run it is, on what model, and when.
//
// THE OUTCOME IS THE APP'S SHARED STATUS MARK, through `RUN_PHASE` exactly as the Runs tab draws it,
// so a run reads the same in the list and in its own header. Two words are this header's own: a
// paused run says "paused" rather than the phase's "stopped" (it can be resumed), and a run the user
// stopped says "stopped" rather than "failed" — the server stores both as `error`, and the reason is
// what tells them apart.
//
// THE MENU HOLDS ONLY WHAT ALREADY WORKS. Copy the id, show this run on the graph, find it in the
// Runs list, run the agent again — the same `runAgain` the Runs tab's row calls.

import { useState } from "react";

import { RUN_PHASE } from "../lib/domainPhase.ts";
import { absTime, relTime } from "../lib/format.ts";
import { Icon } from "../lib/icons/registry.ts";
import { runAgain } from "../lib/runActions.ts";
import type { Phase } from "../lib/statusPhase.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { CANCELLED_BY_USER } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { RunSummary } from "../types.ts";
import { PauseResumeControls } from "./PauseResumeControls.tsx";
import { StatusGlyph } from "./StatusGlyph.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx";

/** The first segment of a uuid — enough to tell two runs apart. */
const shortId = (id: string): string => id.slice(0, 8);

/** The run's outcome as a phase and the word this header says for it. */
export function runOutcome(run: Pick<RunSummary, "status" | "error">): { phase: Phase; word: string } {
  if (run.status === "error" && run.error === CANCELLED_BY_USER) return { phase: "halted", word: "stopped" };
  if (run.status === "paused") return { phase: "halted", word: "paused" };
  const phase = RUN_PHASE[run.status];
  return { phase, word: run.status === "running" ? "running" : run.status === "completed" ? "finished" : "failed" };
}

const WORD_TONE: Partial<Record<string, string>> = {
  running: "text-run",
  failed: "text-err",
};

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

  if (!run) {
    return (
      <div className="flex shrink-0 items-center gap-3 border-b border-hair px-6 py-3">
        <span className={TYPE.panelLabel}>Execution trace</span>
        <span className="text-caption text-muted">no run selected</span>
      </div>
    );
  }

  const { phase, word } = runOutcome(run);

  return (
    <div className="shrink-0 border-b border-hair px-6 pb-2.5 pt-3">
      <div className="flex min-h-6 items-center gap-3">
        <span className={`min-w-0 truncate ${TYPE.panelLabel}`}>Execution trace</span>
        <span className="ml-auto flex shrink-0 items-center gap-3">
          <PauseResumeControls />
          <span className={`flex items-center gap-1.5 text-tiny ${WORD_TONE[word] ?? "text-muted"}`}>
            <StatusGlyph phase={phase} size={ICON.xs} title={word} />
            {word}
          </span>
          <RunMenu run={run} />
        </span>
      </div>
      {/* WHOSE RUN, ON WHAT, WHEN — one line that gives up its tail before it wraps. */}
      <div className="mt-1 flex min-w-0 items-baseline gap-1.5 text-tiny text-muted">
        <span className="shrink-0 text-label text-ink" title={run.agent_id}>{agentName}</span>
        <span className="shrink-0" title={run.id}>· {shortId(run.id)}</span>
        {/* A provider and a model id are identifiers, and still Sans. */}
        <span className="min-w-0 truncate" title={`${run.provider}/${run.model}`}>
          · {run.provider}/{run.model}
        </span>
        <span className="shrink-0" title={absTime(run.started_at)}>· {relTime(run.started_at)}</span>
        {run.parent_run_id && (
          <span className="flex min-w-0 shrink items-center gap-1 truncate" title={`Branched from run ${run.parent_run_id}`}>
            · <Icon.agents.fork size={ICON.xs} />
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
