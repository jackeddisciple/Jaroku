// The Runs tab: the selected agent's runs, newest first, where there is room to read them.
//
// THESE ROWS USED TO BE IN THE SIDEBAR, nested under each agent behind a twisty. The column is for
// finding an agent and its conversations; what an agent has run belongs beside its trace, one tab away
// from it — so opening a run here turns the panel to the Trace tab, next to the list it came from.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAnchoredMenu } from "../lib/anchoredMenu.ts";
import { RUN_PHASE } from "../lib/domainPhase.ts";
import { absTime, relTime } from "../lib/format.ts";
import { Icon } from "../lib/icons/registry.ts";
import { useMenuFocus } from "../lib/menuFocus.ts";
import { selectAgent, selectRun } from "../lib/selection.ts";
import { sendLoadHistory, sendLoadRun, sendRun } from "../lib/socket.ts";
import { PHASE_WORD, type Phase } from "../lib/statusPhase.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { isRunnable, useProviderStore } from "../store/providerStore.ts";
import { orderedRuns, useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { RunStatus, RunSummary } from "../types.ts";
import { EmptyState } from "./EmptyState.tsx";
import { StatusGlyph } from "./StatusGlyph.tsx";

/**
 * How long a run took, from the two timestamps it already carries.
 *
 * SHOWN ONLY WHEN IT FINISHED. A duration computed against `Date.now()` for a run still in flight is a
 * number that changes every render and means "so far" while reading as "took".
 */
function runDuration(run: RunSummary): string | null {
  if (!run.ended_at) return null;
  const ms = new Date(run.ended_at).getTime() - new Date(run.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** The first line of an error, short enough to sit at the end of a row. The full text is in the trace. */
function errorSnippet(error: string): string {
  const first = error.split("\n")[0] ?? error;
  return first.length > 34 ? `${first.slice(0, 33)}…` : first;
}

/**
 * A run's outcome as a capsule: a soft ground, the SHARED glyph, and the phase's own word.
 *
 * THE MARK IS `StatusGlyph` AND THE WORD IS `PHASE_WORD` — the one status vocabulary `test:status-glyph`
 * holds every surface to. `RUN_PHASE` maps the four run statuses onto the phases, so `paused` gets
 * amber and its own word rather than falling into a green-or-red that would call it a failure.
 */
const PHASE_TONE: Record<Phase, string> = {
  pending: "bg-active text-muted",
  ready: "bg-active text-muted",
  // The only phase permitted amber, here as everywhere else.
  active: "bg-run/10 text-run",
  waiting: "bg-active text-muted",
  // On a row inside a list of runs the outcome IS the content, so the ground carries it.
  done: "bg-ok/10 text-ok",
  failed: "bg-err/10 text-err",
  halted: "bg-active text-muted",
};

function RunStatusCapsule({ status }: { status: RunStatus }) {
  const phase = RUN_PHASE[status];
  return (
    <span className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-tiny font-medium ${PHASE_TONE[phase]}`}>
      <StatusGlyph phase={phase} size={ICON.xs} />
      {PHASE_WORD[phase]}
    </span>
  );
}

/**
 * "Run again", for THIS agent on the model the composer has chosen. With no key for that model it
 * opens Secrets at that provider instead.
 */
function runAgain(agentId: string): void {
  const { provider, model } = useUiStore.getState();
  const { providers, loaded } = useProviderStore.getState();
  if (loaded && !isRunnable(providers, provider)) {
    useUiStore.getState().openSecretsForProvider(provider || "anthropic");
    return;
  }
  sendRun(undefined, provider, model, agentId);
}

/** Open a run's trace, fetching its steps first when they are not here yet. */
function openRun(runId: string): void {
  if (useTraceStore.getState().needsLoad(runId)) sendLoadRun(runId);
  selectRun(runId);
  useUiStore.getState().setRightTab("trace");
}

const MENU_ROW =
  "flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-caption text-muted transition-colors hover:bg-active/40 hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring";

/**
 * The run's overflow, revealed on hover and on focus.
 *
 * PORTALLED, because it opens from inside this tab's scrolling list and an `overflow` ancestor clips an
 * absolutely-positioned panel whatever its `z-index` — see lib/anchoredMenu.ts and `test:menu-clip`.
 */
function RunOverflow({ run, agentId }: { run: RunSummary; agentId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  useMenuFocus(open, panelRef, ref);
  useAnchoredMenu(open, ref, panelRef);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
        aria-label={`More actions for run ${shortRunId(run.id)}`}
        className={`flex h-6 w-6 items-center justify-center rounded-control text-faint transition-opacity hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring ${
          open ? "opacity-100" : "opacity-0 group-hover/run:opacity-100 group-focus-within/run:opacity-100"
        }`}
      >
        <Icon.agents.more size={ICON.sm} />
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="menu"
          aria-label="Run actions"
          className="fixed left-0 top-0 z-50 w-40 origin-top animate-menu-in overflow-hidden rounded-control border border-edge bg-elevated py-1 shadow-floating motion-reduce:animate-none"
        >
          <button
            type="button"
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setOpen(false); openRun(run.id); }}
            className={MENU_ROW}
          >
            <Icon.panel.trace size={ICON.sm} />
            <span className="min-w-0 flex-1 truncate">View trace</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setOpen(false); selectAgent(agentId); runAgain(agentId); }}
            className={MENU_ROW}
          >
            <Icon.cockpit.refresh size={ICON.sm} />
            <span className="min-w-0 flex-1 truncate">Run again</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * Which run this is, for a person rather than for a database.
 *
 * A POSITION, NOT AN IDENTIFIER. There is no per-agent counter on the server, so this counts backwards
 * from the newest run LOADED — a run's number moves when older runs arrive behind it, which is why the
 * tooltip carries the id and nothing quotes the number.
 */
function runNumber(runs: RunSummary[], run: RunSummary): number {
  return runs.length - runs.indexOf(run);
}

/** The first segment of a uuid — enough to tell two runs apart in a tooltip. */
const shortRunId = (id: string): string => id.slice(0, 8);

function RunRow({ run, runs, agentId }: { run: RunSummary; runs: RunSummary[]; agentId: string }) {
  const active = useTraceStore((s) => s.activeRunId === run.id);
  const duration = runDuration(run);
  const failed = run.status === "error";

  return (
    <div
      className={`group/run relative flex h-8 w-full items-center gap-2 rounded-control pl-2 pr-1 transition-colors ${
        active ? "bg-active" : "hover:bg-active/40"
      }`}
    >
      {active && <span className="pointer-events-none absolute left-0 top-1 bottom-1 w-0.5 bg-accent" aria-hidden />}
      <button
        type="button"
        onClick={() => openRun(run.id)}
        title={`${shortRunId(run.id)} · ${run.provider} · ${absTime(run.started_at)}`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <RunStatusCapsule status={run.status} />
        {/* Branches keep their fork mark: a branched run is a different thing from a re-run. */}
        {run.parent_run_id && (
          <span className="shrink-0 text-faint" title="branch"><Icon.agents.fork size={ICON.xs} /></span>
        )}
        <span className="shrink-0 text-label font-normal tabular-nums text-ink">Run #{runNumber(runs, run)}</span>
        {/* THE TIME, THEN WHAT IT COST YOU — a duration when it worked, the reason when it did not. */}
        <span className="ml-auto flex min-w-0 shrink items-center gap-1.5 overflow-hidden text-caption tabular-nums text-faint">
          <span className="shrink-0" title={absTime(run.started_at)}>{relTime(run.started_at)}</span>
          {failed && run.error
            ? <span className="min-w-0 truncate text-err" title={run.error}>{errorSnippet(run.error)}</span>
            : duration && <span className="shrink-0">{duration}</span>}
        </span>
      </button>
      <RunOverflow run={run} agentId={agentId} />
    </div>
  );
}

export function RunsPanel() {
  const agentId = useBuildStore((s) => s.activeAgentId);
  const agentName = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId)?.name ?? null);
  const runs = useTraceStore((s) => s.runs);
  const historyWindow = useTraceStore((s) => s.historyWindow);
  const historyComplete = useTraceStore((s) => s.historyComplete);

  const loaded = orderedRuns(runs);
  const mine = agentId ? loaded.filter((r) => r.agent_id === agentId) : [];
  // THE HISTORY IS A WINDOW. The read stops at a cap, so these are the runs that have been FETCHED,
  // and this is how an older one becomes reachable at all.
  const more = loaded.length >= historyWindow && !historyComplete;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hair px-4">
        <span className={TYPE.panelLabel}>Runs</span>
        {agentName && <span className="min-w-0 truncate text-tiny text-muted" title={agentName}>{agentName}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">
        {!agentId ? (
          <EmptyState icon={Icon.panel.runs} title="Choose an agent to see its runs" />
        ) : mine.length === 0 ? (
          <EmptyState icon={Icon.panel.runs} title={`${agentName ?? "This agent"} has not run yet`} />
        ) : (
          <div className="flex flex-col gap-0.5">
            {mine.map((r) => (
              <RunRow key={r.id} run={r} runs={mine} agentId={agentId} />
            ))}
          </div>
        )}
        {agentId && more && (
          <button
            type="button"
            onClick={() => sendLoadHistory(Math.min(historyWindow * 2, 500))}
            className="mt-1 w-full rounded-control px-2 py-1.5 text-left text-caption text-muted transition-colors hover:bg-active/40 hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            Load older runs…
          </button>
        )}
      </div>
    </div>
  );
}
