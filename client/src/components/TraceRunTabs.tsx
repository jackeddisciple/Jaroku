// The trace's run-level views beside its steps (the product owner's list, 2026-10-14): Changes — a
// branch against the run it branched from — State, Artifacts and Raw.
//
// THE STEPS ARE STILL WHAT A TRACE IS FOR, so they are the first tab and the one a run opens on; the
// others are each one question about the run as a whole: what did this branch change, where did the
// state end up, what did the run produce, and what exactly was recorded.

import { useEffect, useMemo, useState } from "react";

import { extractAgentOutput } from "../lib/agentOutput.ts";
import { fmtCost, fmtDuration, tokenCount } from "../lib/format.ts";
import { Icon } from "../lib/icons/registry.ts";
import { sendLoadRun } from "../lib/socket.ts";
import { compareRuns, finalState, runArtifacts, type StepPair } from "../lib/traceCompare.ts";
import { ownSteps, runElapsed, traceTotals } from "../lib/traceView.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { orderedSteps, useTraceStore, type RunTab } from "../store/traceStore.ts";
import type { RunSummary, Step } from "../types.ts";
import { tabBtn } from "./buttons.ts";
import { CopyTurn } from "./composer/CopyTurn.tsx";
import { JsonTree, PayloadText } from "./JsonTree.tsx";

const TABS: { id: RunTab; label: string }[] = [
  { id: "steps", label: "Steps" },
  { id: "changes", label: "Changes" },
  { id: "state", label: "State" },
  { id: "artifacts", label: "Artifacts" },
  { id: "raw", label: "Raw" },
];

/** The tab strip. Changes is offered only for a branch: there is nothing to compare a first run with. */
export function RunTabs({ run }: { run: RunSummary }) {
  const tab = useTraceStore((s) => s.runTab);
  const setTab = useTraceStore((s) => s.setRunTab);
  const shown = TABS.filter((t) => t.id !== "changes" || run.parent_run_id);
  return (
    <div role="tablist" aria-label="Run views" className="flex shrink-0 items-center gap-0.5 border-b border-hair px-5">
      {shown.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => setTab(t.id)}
          className={tabBtn(tab === t.id, "sm")}
          title={t.id === "changes" ? "This branch against the run it branched from" : undefined}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Changes ──────────────────────────────────────────────────────────────────

/** A difference said with its direction and its colour: lower is better here, green; higher is red. */
export function Delta({ value, format, pct }: { value: number | null; format: (n: number) => string; pct?: number | null }) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value === 0) return <span className="text-faint">no change</span>;
  const better = value < 0;
  return (
    <span className={better ? "text-ok" : "text-err"}>
      {better ? "↓" : "↑"} {pct != null && Number.isFinite(pct) ? `${Math.abs(Math.round(pct))}%` : format(Math.abs(value))}
    </span>
  );
}

function Figure({ label, before, after, delta }: { label: string; before: string; after: string; delta: React.ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-2">
      <div className="text-tiny text-faint">{label}</div>
      <div className="flex min-w-0 items-baseline gap-1.5 tabular-nums">
        <span className="truncate text-caption text-muted">{before}</span>
        <span aria-hidden className="text-faint">→</span>
        <span className="truncate text-label text-ink">{after}</span>
      </div>
      <div className="text-tiny tabular-nums">{delta}</div>
    </div>
  );
}

function Value({ value }: { value: unknown }) {
  if (value == null) return <p className="text-tiny text-faint">Nothing recorded.</p>;
  if (typeof value === "string") return <PayloadText text={value} />;
  return <JsonTree value={value} openDepth={1} />;
}

/** One pair, folded to a line: what changed, and — open — the two values, the parent's and this run's. */
function PairRow({ pair }: { pair: StepPair }) {
  const [open, setOpen] = useState(false);
  const only = !pair.parent ? "only in this run" : !pair.own ? "only in the parent" : null;
  const changed = pair.inputChanged || pair.outputChanged;
  const what = only ?? (changed ? [pair.inputChanged && "input", pair.outputChanged && "output"].filter(Boolean).join(" and ") + " changed" : "same");
  return (
    <div className="rounded-control border border-hair bg-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <span aria-hidden className={`shrink-0 text-faint transition-transform duration-fast ${open ? "" : "-rotate-90"}`}>
          <Icon.trace.fold size={ICON.xs} />
        </span>
        <span className="min-w-0 flex-1 truncate text-caption text-ink">
          {pair.own ? `#${pair.own.seq} ` : ""}{pair.name}
        </span>
        <span className={`shrink-0 text-tiny ${changed || only ? "text-ink" : "text-faint"}`}>{what}</span>
        <span className="w-16 shrink-0 text-right text-tiny tabular-nums">
          <Delta value={pair.latencyDelta} format={fmtDuration} />
        </span>
        <span className="w-16 shrink-0 text-right text-tiny tabular-nums">
          <Delta value={pair.costDelta} format={(n) => fmtCost(n)} />
        </span>
      </button>
      {open && (
        <div className="grid grid-cols-1 gap-2 border-t border-hair p-2 sm:grid-cols-2">
          {/* BEFORE ON RED, AFTER ON GREEN — the product owner's call on 2026-10-14, as a diff reads. */}
          <div className="min-w-0 rounded-control bg-err/[0.06] p-2">
            <div className="mb-1 text-tiny text-muted">Parent</div>
            <Value value={pair.parent?.output} />
          </div>
          <div className="min-w-0 rounded-control bg-ok/[0.06] p-2">
            <div className="mb-1 text-tiny text-muted">This run</div>
            <Value value={pair.own?.output} />
          </div>
        </div>
      )}
    </div>
  );
}

export function ChangesView({ run, steps }: { run: RunSummary; steps: readonly Step[] }) {
  const parentId = run.parent_run_id ?? null;
  const parentRun = useTraceStore((s) => (parentId ? s.runs[parentId] : undefined));
  const parentBucket = useTraceStore((s) => (parentId ? s.stepsByRun[parentId] : undefined));
  const needsLoad = useTraceStore((s) => (parentId ? !s.loaded[parentId] : false));
  useEffect(() => {
    if (parentId && needsLoad) sendLoadRun(parentId);
  }, [parentId, needsLoad]);
  const parentSteps = useMemo(() => orderedSteps(parentBucket), [parentBucket]);
  const pairs = useMemo(() => compareRuns(parentSteps, steps), [parentSteps, steps]);
  const [showSame, setShowSame] = useState(false);

  if (!parentId) return <p className="px-6 py-6 text-caption text-muted">This run is not a branch, so there is nothing to compare it with.</p>;
  if (!parentRun || parentSteps.length === 0) return <p className="px-6 py-6 text-caption text-muted">Loading the run this one branched from…</p>;

  // THE RUNS AS A WHOLE FIRST: what this branch took and spent against its parent, then what each
  // run came to, side by side.
  const mine = traceTotals(ownSteps(run, steps));
  const theirs = traceTotals(parentSteps);
  const myTime = runElapsed(run, steps, Date.now());
  const theirTime = runElapsed(parentRun, parentSteps, Date.now());
  const pct = (a: number | null, b: number | null): number | null => (a != null && b != null && b > 0 ? ((a - b) / b) * 100 : null);
  const changed = pairs.filter((p) => p.inputChanged || p.outputChanged || !p.parent || !p.own);
  const shown = showSame ? pairs : changed;
  const myAnswer = run.status === "completed" ? extractAgentOutput(steps) : "";
  const theirAnswer = parentRun.status === "completed" ? extractAgentOutput(parentSteps) : "";

  return (
    <div className="flex flex-col gap-3 px-6 py-3">
      <div className="grid grid-cols-3 divide-x divide-hair rounded-card border border-hair bg-panel">
        <Figure
          label="Duration"
          before={theirTime == null ? "—" : fmtDuration(theirTime)}
          after={myTime == null ? "—" : fmtDuration(myTime)}
          delta={<Delta value={myTime != null && theirTime != null ? myTime - theirTime : null} format={fmtDuration} />}
        />
        <Figure
          label="Tokens"
          before={theirs.tokens == null ? "—" : tokenCount(theirs.tokens)}
          after={mine.tokens == null ? "—" : tokenCount(mine.tokens)}
          delta={<Delta value={mine.tokens != null && theirs.tokens != null ? mine.tokens - theirs.tokens : null} format={tokenCount} />}
        />
        <Figure
          label="Cost"
          before={fmtCost(theirs.cost)}
          after={fmtCost(mine.cost)}
          delta={<Delta value={mine.cost != null && theirs.cost != null ? mine.cost - theirs.cost : null} format={(n) => fmtCost(n)} pct={pct(mine.cost, theirs.cost)} />}
        />
      </div>

      {(myAnswer || theirAnswer) && (
        <section aria-label="Answers side by side">
          <div className={`mb-1.5 ${TYPE.sectionLabel}`}>Answers</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="min-w-0 rounded-control bg-err/[0.06] p-2">
              <div className="mb-1 text-tiny text-muted">Parent</div>
              <p className="line-clamp-6 whitespace-pre-wrap break-words text-caption text-ink">{theirAnswer || "No text answer."}</p>
            </div>
            <div className="min-w-0 rounded-control bg-ok/[0.06] p-2">
              <div className="mb-1 text-tiny text-muted">This run</div>
              <p className="line-clamp-6 whitespace-pre-wrap break-words text-caption text-ink">{myAnswer || "No text answer."}</p>
            </div>
          </div>
        </section>
      )}

      <section aria-label="Steps compared">
        <div className="mb-1.5 flex items-center gap-2">
          <span className={TYPE.sectionLabel}>Steps</span>
          <span className="text-tiny text-faint">{changed.length} of {pairs.length} differ</span>
          <button
            type="button"
            onClick={() => setShowSame((v) => !v)}
            className="ml-auto rounded-xs text-tiny text-muted underline decoration-hair underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            {showSame ? "Only what differs" : "Show every step"}
          </button>
        </div>
        <div className="flex flex-col gap-1">
          {shown.length === 0 ? (
            <p className="text-caption text-muted">Every step matches the parent's.</p>
          ) : (
            shown.map((p) => <PairRow key={p.key} pair={p} />)
          )}
        </div>
      </section>
    </div>
  );
}

// ── State, Artifacts, Raw ────────────────────────────────────────────────────

export function StateTab({ steps }: { steps: readonly Step[] }) {
  const state = useMemo(() => finalState(steps), [steps]);
  if (state == null) return <p className="px-6 py-6 text-caption text-muted">No node recorded a state for this run.</p>;
  return (
    <div className="px-6 py-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className={TYPE.sectionLabel}>Final state</span>
        <span className="text-tiny text-faint">after the last node</span>
        <CopyTurn source={JSON.stringify(state, null, 2)} label="Copy state" title="Copy the final state as JSON" className="ml-auto" />
      </div>
      <JsonTree value={state} openDepth={2} />
    </div>
  );
}

export function ArtifactsTab({ steps }: { steps: readonly Step[] }) {
  const artifacts = useMemo(() => runArtifacts(steps), [steps]);
  if (artifacts.length === 0) {
    return <p className="px-6 py-6 text-caption text-muted">This run produced no structured output — no JSON reply and no structured field in its state.</p>;
  }
  return (
    <div className="flex flex-col gap-3 px-6 py-3">
      {artifacts.map((a) => (
        <section key={a.key} aria-label={a.title}>
          <div className="mb-1 flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-caption font-medium text-ink">{a.title}</span>
            <button
              type="button"
              onClick={() => {
                const st = useTraceStore.getState();
                st.setRunTab("steps");
                if (a.stepId) st.selectStep(a.stepId);
              }}
              className="min-w-0 truncate rounded-xs text-tiny text-faint underline decoration-hair underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
              title="Show the step it came from"
            >
              {a.source}
            </button>
            <CopyTurn source={JSON.stringify(a.value, null, 2)} label={`Copy ${a.title}`} title="Copy it as JSON" className="ml-auto" />
          </div>
          <JsonTree value={a.value} openDepth={2} />
        </section>
      ))}
    </div>
  );
}

export function RawTab({ run, steps }: { run: RunSummary; steps: readonly Step[] }) {
  const raw = useMemo(() => ({ run, steps }), [run, steps]);
  return (
    <div className="px-6 py-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className={TYPE.sectionLabel}>The run as recorded</span>
        <span className="text-tiny text-faint">{steps.length} steps</span>
        <CopyTurn source={JSON.stringify(raw, null, 2)} label="Copy run JSON" title="Copy the run and its steps as JSON" className="ml-auto" />
      </div>
      <JsonTree value={raw} openDepth={1} />
    </div>
  );
}
