// Step details — the slide-in drawer from the right (doc §4.1, not a permanent column). Opens from a
// row's Details button or Enter, then follows the selection while it stays open.
//
// ORGANISED AS THE QUESTIONS SOMEBODY BRINGS TO A STEP, in the order they bring them:
//
//   what is it      — the header: its tile, its name, its kind and how it went, with a way to the
//                     step before and after it;
//   how long, how much — the figures: its duration, and the tokens and cost it (or the model calls
//                     inside it) spent;
//   why it failed   — the error, first, when there is one;
//   where and when  — Overview: its place in the run, the node it ran inside, when it started and
//                     finished, the run's model;
//   what went in and came out — Input and Output (StepDetail), and the state it changed;
//   what to do next — re-run or branch from here, as the drawer's two black buttons.
//
// EVERY FIELD IS ONE THE SCHEMA CARRIES, AND NOTHING IS ESTIMATED. A step records its total tokens and
// not the input/output split, so the split is named as not recorded rather than guessed. Its start is
// `started_at − latency_ms`, because `started_at` is stamped when the step finishes (see traceView).

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useTraceStore, visibleTraceRows } from "../store/traceStore.ts";
import { absTime, fmtCost, fmtDuration, fmtOffset } from "../lib/format.ts";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";
import { CATEGORY_LABEL, buildTraceTree, descendantSteps, isInherited, stepCategory, stepWindow, traceTotals } from "../lib/traceView.ts";
import { ICON, STEP_TYPE, TYPE } from "../lib/tokens.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { RunSummary, Step } from "../types.ts";
import { Chip } from "./Chip.tsx";
import { CopyTurn } from "./composer/CopyTurn.tsx";
import { IconButton } from "./IconButton.tsx";
import { ErrorView, StepDetail } from "./StepDetail.tsx";
import { StateBranchEditor } from "./StateBranchEditor.tsx";
import { McpBadge } from "./McpBadge.tsx";
import { StepTile } from "./StepRow.tsx";
import { Metric } from "./TraceMetrics.tsx";
import { traceMarks } from "./traceMarks.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { agentMcpToolNames } from "../store/mcpStore.ts";

/** A clock time to the millisecond — steps are often milliseconds apart. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions);
}

/** One line of the Overview card. */
function Kv({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 py-1.5 text-caption" title={title}>
      <span className="shrink-0 text-muted">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-1.5 text-right tabular-nums text-ink">{children}</span>
    </div>
  );
}

/**
 * How the step went, as the same kind of pill the run's own outcome wears — and in the same word: a
 * run that went through is "finished" in the header, so a step that did is too, not "completed".
 */
function StepStatus({ failed }: { failed: boolean }) {
  return (
    <span
      className={`flex h-6 shrink-0 items-center gap-1 rounded-pill px-2 text-tiny font-medium ${
        failed ? "bg-err/10 text-err" : "bg-ok/10 text-ok"
      }`}
    >
      {failed ? <Icon.trace.failed size={ICON.xs} /> : <Icon.trace.finished size={ICON.xs} />}
      {failed ? "failed" : "finished"}
    </span>
  );
}

/**
 * The step's figures, in the same strip the run's own are in. A model call's are its own; a node's
 * are summed from the model calls inside it, and the labels say so. A step that spent nothing a model
 * would bill shows its duration alone rather than two columns of dashes.
 */
function Figures({ step, inside }: { step: Step; inside: readonly Step[] }) {
  const llm = step.type === "llm_call";
  const totals = traceTotals(inside);
  // Duration and tokens beside the trace's own two marks, the same ones the rows and the strip wear.
  const cells: { label: string; value: string; title: string; Mark?: IconComponent }[] = [
    { label: "Duration", value: Number.isFinite(step.latency_ms) ? fmtDuration(step.latency_ms) : "—", title: "How long this step took, start to finish", Mark: Icon.trace.time },
  ];
  if (llm) {
    cells.push(
      { label: "Tokens", value: step.tokens == null ? "—" : step.tokens.toLocaleString(), title: "Every token the call consumed; the input/output split isn't recorded", Mark: Icon.trace.tokens },
      { label: "Cost", value: step.cost == null ? "—" : fmtCost(step.cost), title: step.cost == null ? "Not priced" : "What this call cost" },
    );
  } else if (totals.llmCalls > 0) {
    const calls = `${totals.llmCalls} model call${totals.llmCalls === 1 ? "" : "s"} inside this step`;
    cells.push(
      { label: "Tokens inside", value: totals.tokens == null ? "—" : totals.tokens.toLocaleString(), title: `Summed from the ${calls}`, Mark: Icon.trace.tokens },
      { label: "Cost inside", value: fmtCost(totals.cost), title: `Summed from the ${calls}` },
    );
  }
  return (
    <div
      className="grid divide-x divide-hair rounded-card border border-hair bg-panel"
      style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
    >
      {cells.map((c) => <Metric key={c.label} label={c.label} value={c.value} title={c.title} Mark={c.Mark} />)}
    </div>
  );
}

function Overview({ step, run, bucket, inside }: { step: Step; run: RunSummary | undefined; bucket: Record<string, Step>; inside: readonly Step[] }) {
  const window = stepWindow(step);
  const runStart = run ? Date.parse(run.started_at) : NaN;
  const parent = step.parent_step_id ? bucket[step.parent_step_id] : undefined;
  const known = STEP_TYPE[step.type as keyof typeof STEP_TYPE] as { fg: string; bg: string } | undefined;
  const inherited = isInherited(step, run);

  return (
    <section aria-label="Overview" className="mt-4">
      <div className={`mb-1.5 ${TYPE.sectionLabel}`}>Overview</div>
      <div className="divide-y divide-hair rounded-card border border-hair bg-panel px-3">
        <Kv label="Kind">
          {CATEGORY_LABEL[stepCategory(step)]}
          {/* The schema's own word for it — the one place it is worth spelling out. */}
          <Chip mono size="sm" color={known?.fg} background={known?.bg}>{step.type}</Chip>
        </Kv>
        <Kv label="Step ID" title={step.id}>
          <span className="text-muted">{step.id.slice(0, 8)}</span>
          <CopyTurn source={step.id} label="Copy step ID" title="Copy this step's full ID" />
        </Kv>
        {step.parent_step_id && (
          <Kv label="Ran inside">
            {parent ? (
              <button
                type="button"
                onClick={() => useTraceStore.getState().selectStep(parent.id)}
                className="min-w-0 truncate rounded-xs text-ink underline decoration-hair underline-offset-2 transition-colors hover:decoration-ink focus-visible:outline-none focus-visible:shadow-focusring"
                title={`Select #${parent.seq} ${parent.name}`}
              >
                #{parent.seq} {parent.name}
              </button>
            ) : (
              <span className="text-faint" title={step.parent_step_id}>a step not in this trace</span>
            )}
          </Kv>
        )}
        {inside.length > 0 && <Kv label="Steps inside">{inside.length}</Kv>}
        {window ? (
          <>
            <Kv label="Started" title={`${absTime(new Date(window.start).toISOString())} — when it finished, less how long it took`}>
              {clock(window.start)}
              {/* AN INHERITED STEP RAN IN THE PARENT, before this run began: its offset from this run's
                  start is a negative nobody asked for, so it says where it ran instead. Every other
                  offset is signed rather than clamped — a "+0ms" hid a step forty seconds early. */}
              {inherited && run?.parent_run_id ? (
                <span className="text-faint" title={`Copied from run ${run.parent_run_id}`}>in run {run.parent_run_id.slice(0, 8)}</span>
              ) : Number.isFinite(runStart) && (
                <span className="text-faint">{fmtOffset(window.start - runStart)}</span>
              )}
            </Kv>
            <Kv label="Finished" title={absTime(step.started_at)}>{clock(window.end)}</Kv>
          </>
        ) : (
          <Kv label="Timing"><span className="text-faint">not recorded</span></Kv>
        )}
        {run && (step.type === "llm_call" || inside.some((s) => s.type === "llm_call")) && (
          <Kv label="Run model" title="The model this run was started on; a step records no model of its own">
            <span className="min-w-0 truncate">{run.provider}/{run.model}</span>
          </Kv>
        )}
      </div>
    </section>
  );
}

export function StepDetailPanel() {
  // Same join as the timeline row: a step carries a tool NAME, and whether that name came
  // from MCP is a fact about the AGENT, recorded in its manifest.
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId));
  const mcpNames = agentMcpToolNames(agent?.mcp_tools);
  const expandedStepId = useTraceStore((s) => s.expandedStepId);
  const step = useTraceStore((s) => {
    const id = s.expandedStepId;
    const run = s.activeRunId;
    return id && run ? s.stepsByRun[run]?.[id] : undefined;
  });
  const bucket = useTraceStore((s) => (s.activeRunId ? s.stepsByRun[s.activeRunId] : undefined));
  const run = useTraceStore((s) => (s.activeRunId ? s.runs[s.activeRunId] : undefined));
  const setExpandedStep = useTraceStore((s) => s.setExpandedStep);
  const open = Boolean(expandedStepId && step);
  const connectors = useBuildStore((s) => s.agents.find((a) => a.agent_id === run?.agent_id)?.connectors);
  const marks = useMemo(() => traceMarks(Object.values(bucket ?? {}), connectors ?? []), [bucket, connectors]);
  const inside = useMemo(
    () => (step && bucket ? descendantSteps(buildTraceTree(Object.values(bucket)), step.id) : []),
    [step, bucket],
  );

  // EVERY STEP OPENS AT ITS TOP. Prev/next swapped the content under a scroller that kept its
  // place, so stepping from #1 (scrolled down to Raw event) to #8 opened #8 mid-way, its figures and
  // Overview above the fold. Before paint, so the old offset is never drawn on the new step.
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [expandedStepId]);

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedStep(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setExpandedStep]);

  /** The step before or after this one, through the rows the timeline shows — J/K's order. */
  const neighbour = (delta: 1 | -1): Step | undefined => {
    if (!step) return undefined;
    const rows = visibleTraceRows(useTraceStore.getState());
    const at = rows.findIndex((r) => r.step.id === step.id);
    return at === -1 ? undefined : rows[at + delta]?.step;
  };
  // The drawer follows the selection (traceStore.selectStep), so moving the selection moves it.
  const go = (delta: 1 | -1): void => {
    const next = neighbour(delta);
    if (next) useTraceStore.getState().selectStep(next.id);
  };

  // Keep the element mounted for the slide-out transition; just translate it off-screen.
  return (
    <div
      className={`absolute top-0 right-0 bottom-0 w-[380px] max-w-[85%] bg-elevated z-20 flex flex-col
        border-l border-edge shadow-floating transition-transform duration-base ease-state
        ${open ? "translate-x-0" : "translate-x-full pointer-events-none"}`}
      aria-hidden={!open}
    >
      {step && bucket && (
        <>
          <div className="shrink-0 border-b border-hair px-4 pb-4 pt-2">
            <div className="flex h-9 items-center">
              <span className={TYPE.panelLabel}>Step details</span>
              <span className="ml-auto flex items-center">
                <IconButton
                  icon={Icon.trace.prevStep}
                  label="Previous step"
                  disabledReason={neighbour(-1) ? null : "This is the first step shown"}
                  onClick={() => go(-1)}
                />
                <IconButton
                  icon={Icon.trace.nextStep}
                  label="Next step"
                  disabledReason={neighbour(1) ? null : "This is the last step shown"}
                  onClick={() => go(1)}
                />
                <IconButton
                  icon={Icon.panel.graph}
                  label="Show this step on the graph"
                  onClick={() => useUiStore.getState().setRightTab("graph")}
                />
                <IconButton icon={Icon.trace.closeDetails} label="Close step details" onClick={() => setExpandedStep(null)} />
              </span>
            </div>
            {/* THE ROW YOU CLICKED, AGAIN, AND LARGER: its tile, its name, its kind and how it went —
                so the drawer opens on the step the reader chose. */}
            <div className="mt-2 flex min-w-0 items-center gap-3">
              <StepTile step={step} provider={run?.provider} mark={marks.get(step.name)} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-section text-ink" title={step.name}>{step.name}</span>
                  {step.type === "tool_call" && mcpNames.has(step.name) && <McpBadge />}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-caption text-muted">
                  <span>{CATEGORY_LABEL[stepCategory(step)]}</span>
                  <span className="text-faint">·</span>
                  <span className="tabular-nums">#{step.seq}</span>
                </div>
              </div>
              <StepStatus failed={step.error != null} />
            </div>
          </div>

          <div ref={body} className="flex-1 overflow-auto px-4 pb-6 pt-4">
            <Figures step={step} inside={inside} />
            {/* A failure next: it is what somebody opening a red step came for. */}
            {step.error && (
              <div className="mt-4">
                <ErrorView error={step.error} runStatus={run?.status} />
              </div>
            )}
            <Overview step={step} run={run} bucket={bucket} inside={inside} />
            <div className="mt-4">
              <StepDetail step={step} />
            </div>
            <StateBranchEditor step={step} />
          </div>
        </>
      )}
    </div>
  );
}
