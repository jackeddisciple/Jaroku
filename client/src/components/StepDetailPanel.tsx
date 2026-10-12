// Step details — the slide-in drawer from the right (doc §4.1, not a permanent column). Opens from a
// row's Details button or Enter, then follows the selection while it stays open.
//
// ORGANISED AS THE QUESTIONS SOMEBODY BRINGS TO A STEP, in the order they bring them:
//
//   what is it      — the header: its tile, its name, its kind, how it went;
//   where and when  — Overview: its place in the run, the node it ran inside, when it started
//                     and finished, how long it took;
//   what it cost    — Performance, for a step that spent anything: tokens, cost, the run's model;
//   what went in and came out — Input and Output (StepDetail), and the state it changed.
//
// EVERY FIELD IS ONE THE SCHEMA CARRIES, AND NOTHING IS ESTIMATED. A step records its total tokens and
// not the input/output split, so the split is named as not recorded rather than guessed. Its start is
// `started_at − latency_ms`, because `started_at` is stamped when the step finishes (see traceView).

import { useEffect, useState } from "react";
import { useTraceStore } from "../store/traceStore.ts";
import { absTime, fmtCost, fmtDuration, fmtTokens } from "../lib/format.ts";
import { Icon } from "../lib/icons/registry.ts";
import { CATEGORY_LABEL, buildTraceTree, descendantSteps, stepCategory, stepWindow, traceTotals } from "../lib/traceView.ts";
import { ICON, STEP_TYPE, TYPE } from "../lib/tokens.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { RunSummary, Step } from "../types.ts";
import { Chip } from "./Chip.tsx";
import { CollapsibleRegion } from "./CollapsibleRegion.tsx";
import { CopyTurn } from "./composer/CopyTurn.tsx";
import { IconButton } from "./IconButton.tsx";
import { ErrorView, StepDetail } from "./StepDetail.tsx";
import { StateBranchEditor } from "./StateBranchEditor.tsx";
import { McpBadge } from "./McpBadge.tsx";
import { StepTile } from "./StepRow.tsx";
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

function Kv({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex min-h-7 items-baseline justify-between gap-3 py-0.5 text-caption" title={title}>
      <span className="shrink-0 text-muted">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-1.5 text-right tabular-nums text-ink">{children}</span>
    </div>
  );
}

/** A section of the drawer that folds, open by default. */
function Region({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-3 first:mt-0">
      <CollapsibleRegion label={label} open={open} onToggle={() => setOpen((v) => !v)} chevron={Icon.trace.fold}>
        <div className="border-t border-hair pt-1">{children}</div>
      </CollapsibleRegion>
    </div>
  );
}

function Overview({ step, run, bucket }: { step: Step; run: RunSummary | undefined; bucket: Record<string, Step> }) {
  const window = stepWindow(step);
  const runStart = run ? Date.parse(run.started_at) : NaN;
  const parent = step.parent_step_id ? bucket[step.parent_step_id] : undefined;
  const inside = descendantSteps(buildTraceTree(Object.values(bucket)), step.id);
  const known = STEP_TYPE[step.type as keyof typeof STEP_TYPE] as { fg: string; bg: string } | undefined;

  return (
    <Region label="Overview">
      <Kv label="Kind">
        {CATEGORY_LABEL[stepCategory(step)]}
        {/* The schema's own word for it — the one place it is worth spelling out. */}
        <Chip mono size="sm" color={known?.fg} background={known?.bg}>{step.type}</Chip>
      </Kv>
      <Kv label="Step" title={step.id}>
        #{step.seq} · <span className="text-muted">{step.id.slice(0, 8)}</span>
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
            {Number.isFinite(runStart) && (
              <span className="text-faint">+{fmtDuration(Math.max(0, window.start - runStart))}</span>
            )}
          </Kv>
          <Kv label="Finished" title={absTime(step.started_at)}>{clock(window.end)}</Kv>
        </>
      ) : (
        <Kv label="Timing"><span className="text-faint">not recorded</span></Kv>
      )}
      <Kv label="Duration">{Number.isFinite(step.latency_ms) ? fmtDuration(step.latency_ms) : "—"}</Kv>
    </Region>
  );
}

/**
 * What the step spent. A model call's own figures; a node's, summed from the model calls inside it —
 * said as such, since a node itself carries none. Nothing for a step that spent nothing measurable.
 */
function Performance({ step, run, bucket }: { step: Step; run: RunSummary | undefined; bucket: Record<string, Step> }) {
  const llm = step.type === "llm_call";
  const inside = llm ? [] : descendantSteps(buildTraceTree(Object.values(bucket)), step.id);
  const totals = traceTotals(inside);
  if (!llm && totals.llmCalls === 0) return null;

  const tokens = llm ? step.tokens : totals.tokens;
  const cost = llm ? step.cost : totals.cost;
  return (
    <Region label="Performance">
      {!llm && <p className="pb-1 pt-1.5 text-tiny text-faint">Summed from the {totals.llmCalls === 1 ? "model call" : `${totals.llmCalls} model calls`} inside this step.</p>}
      <Kv label="Tokens" title="Every token the call consumed, cached or not">
        {tokens == null ? <span className="text-faint">not reported</span> : fmtTokens(tokens)}
      </Kv>
      <Kv label="Input / output">
        <span className="text-faint">not recorded per step</span>
      </Kv>
      <Kv label="Cost">
        {cost == null ? <span className="text-faint">not priced</span> : fmtCost(cost)}
      </Kv>
      {llm && <Kv label="Request took">{fmtDuration(step.latency_ms)}</Kv>}
      {run && (
        <Kv label="Run model" title="The model this run was started on; a step records no model of its own">
          <span className="min-w-0 truncate">{run.provider}/{run.model}</span>
        </Kv>
      )}
    </Region>
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

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedStep(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setExpandedStep]);

  // Keep the element mounted for the slide-out transition; just translate it off-screen.
  return (
    <div
      className={`absolute top-0 right-0 bottom-0 w-[340px] max-w-[85%] bg-elevated z-20 flex flex-col
        border-l border-edge shadow-floating transition-transform duration-base ease-state
        ${open ? "translate-x-0" : "translate-x-full pointer-events-none"}`}
      aria-hidden={!open}
    >
      {step && bucket && (
        <>
          <div className="shrink-0 px-4 pb-3 pt-2">
            <div className="flex h-8 items-center gap-1">
              <span className={TYPE.panelLabel}>Step details</span>
              <span className="ml-auto flex items-center">
                <IconButton
                  icon={Icon.panel.graph}
                  label="Show this step on the graph"
                  onClick={() => useUiStore.getState().setRightTab("graph")}
                />
                <button
                  type="button"
                  onClick={() => setExpandedStep(null)}
                  className="flex h-8 w-8 items-center justify-center rounded-control text-muted transition-colors duration-fast hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
                  title="Close (Esc)"
                  aria-label="Close step details"
                >
                  <Icon.trace.closeDetails size={ICON.sm} />
                </button>
              </span>
            </div>
            {/* THE ROW YOU CLICKED, AGAIN: its tile, its name, its kind — so the drawer opens on the
                step the reader chose rather than on a differently-shaped description of it. */}
            <div className="mt-1 flex min-w-0 items-start gap-2.5">
              <StepTile step={step} provider={run?.provider} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-label text-ink" title={step.name}>{step.name}</span>
                  {step.type === "tool_call" && mcpNames.has(step.name) && <McpBadge />}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-tiny text-muted">
                  <span>{CATEGORY_LABEL[stepCategory(step)]}</span>
                  <span className="text-faint">·</span>
                  <span className="tabular-nums">#{step.seq}</span>
                  <span className="text-faint">·</span>
                  <span className={`flex items-center gap-1 ${step.error ? "text-err" : "text-ok"}`}>
                    {step.error ? <Icon.trace.failed size={ICON.xs} /> : <Icon.trace.finished size={ICON.xs} />}
                    {step.error ? "failed" : "completed"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-auto border-t border-hair px-4 pb-6 pt-3">
            {/* A failure first: it is what somebody opening a red step came for. */}
            {step.error && <ErrorView error={step.error} runStatus={run?.status} />}
            <Overview step={step} run={run} bucket={bucket} />
            <Performance step={step} run={run} bucket={bucket} />
            <div className="mt-3">
              <StepDetail step={step} />
            </div>
            <StateBranchEditor step={step} />
          </div>
        </>
      )}
    </div>
  );
}
