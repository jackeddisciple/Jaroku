// Step details — docked in the Trace tab beside its steps, or under them (doc §4.1, not a permanent
// column). Opens from a row's Details button or Enter, then follows the selection while it stays open.
//
// DOCKED, NOT DRAWN OVER. It was a 380px drawer over the whole right panel: at the panel's default
// width it covered all but a "#N" sliver of the trace it described, it stayed over the Runs, Evals and
// Secrets tabs, and "Show this step on the graph" put the graph behind it. Now it is part of the Trace
// tab's own layout (the product owner's call, 2026-10-14): beside the list when the tab is wide enough
// for both, below it when not — the list keeps its top part with the selected row in view — and on no
// other tab. The graph has its own node inspector.
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
import { DRAWER_SNAP, useTraceStore, visibleTraceRows, type DrawerSnap, type DrawerTab } from "../store/traceStore.ts";
import { absTime, fmtCost, fmtDuration, fmtOffset, tokenCount } from "../lib/format.ts";
import { Icon, type IconComponent } from "../lib/icons/registry.ts";
import { buildTraceTree, descendantSteps, isInherited, stepWindow, traceTotals } from "../lib/traceView.ts";
import { ICON, STEP_TYPE, TYPE } from "../lib/tokens.ts";
import { showStepOnGraph } from "../lib/runActions.ts";
import { markTraceStep, sendEdit, sendExplain } from "../lib/socket.ts";
import { fixPrompt } from "../lib/intent.ts";
import type { RunSummary, Step } from "../types.ts";
import { Chip } from "./Chip.tsx";
import { CopyTurn } from "./composer/CopyTurn.tsx";
import { IconButton } from "./IconButton.tsx";
import { ErrorView, InputTab, OutputTab, PromptTab, RawTab, StateTabBody, hasState, promptCalls } from "./StepDetail.tsx";
import { tabBtn } from "./buttons.ts";
import { RerunFields, RerunFooter, useRerun } from "./StateBranchEditor.tsx";
import { McpBadge } from "./McpBadge.tsx";
import { StepTile, ViewedToggle } from "./StepRow.tsx";
import { Metric } from "./TraceMetrics.tsx";
import { graphLook, kindWord, traceMarks } from "./traceMarks.ts";
import { useGraphStore } from "../store/graphStore.ts";
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
      { label: "Tokens", value: step.tokens == null ? "—" : tokenCount(step.tokens), title: step.tokens == null ? "Every token the call consumed" : `${step.tokens.toLocaleString()} tokens — every one the call consumed`, Mark: Icon.trace.tokens },
      { label: "Cost", value: step.cost == null ? "—" : fmtCost(step.cost), title: step.cost == null ? "Not priced" : "What this call cost" },
    );
  } else if (totals.llmCalls > 0) {
    const calls = `${totals.llmCalls} model call${totals.llmCalls === 1 ? "" : "s"} inside this step`;
    cells.push(
      { label: "Tokens inside", value: totals.tokens == null ? "—" : tokenCount(totals.tokens), title: totals.tokens == null ? `Summed from the ${calls}` : `${totals.tokens.toLocaleString()} tokens, summed from the ${calls}`, Mark: Icon.trace.tokens },
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

function Overview({ step, run, bucket, inside, kind, onNavigate }: {
  step: Step;
  /** The words for its kind — the Graph's, for a node it has (`kindWord`). */
  kind: string;
  run: RunSummary | undefined;
  bucket: Record<string, Step>;
  inside: readonly Step[];
  /** After a link here has moved the panel to another step — the link may be gone on that one. */
  onNavigate: () => void;
}) {
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
          {kind}
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
                onClick={() => {
                  useTraceStore.getState().selectStep(parent.id);
                  onNavigate();
                }}
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

/** Where the panel sits in the Trace tab: beside the steps, or below them on a narrow panel. */
export type StepDetailDock = "side" | "bottom";

const TABS: { id: DrawerTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "input", label: "Input" },
  { id: "output", label: "Output" },
  { id: "prompt", label: "Prompt" },
  { id: "state", label: "State diff" },
  { id: "raw", label: "Raw" },
];

const SNAPS: DrawerSnap[] = ["peek", "half", "full"];

/**
 * THE DRAWER UNDER THE STEPS HAS A HANDLE (2026-10-14): drag it, and it comes to rest at the nearest
 * of three heights — a peek at its header, half the tab, the whole tab — or press it, or use ↑/↓ on
 * it. Neutral greys: a handle is furniture, not a signal.
 */
function DrawerHandle({ panel }: { panel: React.RefObject<HTMLDivElement | null> }) {
  const snap = useTraceStore((s) => s.drawerSnap);
  const setSnap = useTraceStore((s) => s.setDrawerSnap);
  const setDrag = useTraceStore((s) => s.setDrawerDrag);
  const moved = useRef(false);
  const shareAt = (clientY: number): number | null => {
    const box = panel.current?.parentElement?.getBoundingClientRect();
    if (!box || box.height <= 0) return null;
    return Math.min(1, Math.max(0.15, (box.bottom - clientY) / box.height));
  };
  const nearest = (share: number): DrawerSnap =>
    SNAPS.reduce((best, s) => (Math.abs(DRAWER_SNAP[s] - share) < Math.abs(DRAWER_SNAP[best] - share) ? s : best), "half" as DrawerSnap);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    moved.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const share = shareAt(e.clientY);
    if (share == null) return;
    moved.current = true;
    setDrag(share);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const share = shareAt(e.clientY);
    if (moved.current && share != null) setSnap(nearest(share));
    // A press without a drag steps through the rests: peek → half → full → peek.
    else setSnap(SNAPS[(SNAPS.indexOf(snap) + 1) % SNAPS.length]!);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const at = SNAPS.indexOf(snap);
    if (e.key === "ArrowUp" && at < SNAPS.length - 1) setSnap(SNAPS[at + 1]!);
    else if (e.key === "ArrowDown" && at > 0) setSnap(SNAPS[at - 1]!);
    else if (e.key === "Enter" || e.key === " ") setSnap(SNAPS[(at + 1) % SNAPS.length]!);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const word = snap === "peek" ? "a peek" : snap === "half" ? "half the tab" : "the whole tab";
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize step details"
      aria-valuetext={word}
      tabIndex={0}
      title={`Drag to resize — it rests at a peek, half or the whole tab (now ${word}). ↑/↓ or press to step.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={onKeyDown}
      className="group flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center outline-none focus-visible:shadow-focusring"
    >
      <span aria-hidden className="h-1 w-8 rounded-full bg-edge transition-colors group-hover:bg-grip" />
    </div>
  );
}

export function StepDetailPanel({ dock }: { dock: StepDetailDock }) {
  // Same join as the timeline row: a step carries a tool NAME, and whether that name came
  // from MCP is a fact about the AGENT, recorded in its manifest.
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId));
  const selectedAgentId = useBuildStore((s) => s.activeAgentId);
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
  const graph = useGraphStore((s) => (run ? s.graphs[run.agent_id] : undefined));
  const look = useMemo(() => graphLook(graph, connectors ?? []), [graph, connectors]);
  const marks = useMemo(() => traceMarks(Object.values(bucket ?? {}), connectors ?? [], look), [bucket, connectors, look]);
  const inside = useMemo(
    () => (step && bucket ? descendantSteps(buildTraceTree(Object.values(bucket)), step.id) : []),
    [step, bucket],
  );

  // EVERY STEP OPENS AT ITS TOP. Prev/next swapped the content under a scroller that kept its
  // place, so stepping from #1 (scrolled down to Raw event) to #8 opened #8 mid-way, its figures and
  // Overview above the fold. Before paint, so the old offset is never drawn on the new step.
  const body = useRef<HTMLDivElement>(null);
  const drawerTab = useTraceStore((s) => s.drawerTab);
  useLayoutEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [expandedStepId, drawerTab]);

  // THE KEYBOARD IS NEVER DROPPED. Closing the panel from inside it unmounted whatever had focus, and
  // focus fell to <body>, where the arrows do nothing — so it goes back to the step's row, where ↑/↓
  // carry on. A step change that takes away the focused control (the "Ran inside" link on a step
  // with no parent, Next on the last step) leaves focus on the panel itself rather than on nothing.
  const panel = useRef<HTMLDivElement>(null);
  const lostFocus = (): boolean => {
    const at = document.activeElement;
    return !at || at === document.body || Boolean(panel.current?.contains(at));
  };
  const close = (): void => {
    const st = useTraceStore.getState();
    const id = st.selectedStepId ?? st.expandedStepId;
    const refocus = lostFocus();
    setExpandedStep(null);
    if (refocus && id) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[role="treeitem"][data-step-id="${id}"]`)?.focus());
    }
  };
  const keepFocus = (): void => {
    requestAnimationFrame(() => {
      const at = document.activeElement as HTMLButtonElement | null;
      if (!at || at === document.body || at.disabled) panel.current?.focus();
    });
  };

  // Escape closes the panel — through the latest `close`, from a listener registered once per opening.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

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
    keepFocus();
  };

  // THE RE-RUN, for the editor in Overview and the buttons pinned under every tab: one set of drafts,
  // this step's (`useRerun` starts them again when the drawer moves to another step).
  const rerun = useRerun(step);
  // The reader's own marks on this step (migration 085): pinned, viewed.
  const mark = useTraceStore((s) => (s.activeRunId && step ? s.marksByRun[s.activeRunId]?.[step.id] : undefined));
  // The tabs this step has something for: Prompt only where a model was asked, State diff only where
  // state was recorded. A tab chosen on another step that this one lacks shows Overview, and the
  // choice is kept for the next step that has it.
  const chosenTab = useTraceStore((s) => s.drawerTab);
  const setTab = useTraceStore((s) => s.setDrawerTab);
  const tabs = step ? TABS.filter((t) => (t.id === "prompt" ? promptCalls(step, inside).length > 0 : t.id === "state" ? hasState(step) : true)) : TABS;
  const tab = tabs.some((t) => t.id === chosenTab) ? chosenTab : "overview";
  // "3 of 9": where this step is among the rows the timeline shows, J/K's order.
  const rows = step ? visibleTraceRows(useTraceStore.getState()) : [];
  const position = step ? rows.findIndex((r) => r.step.id === step.id) : -1;

  if (!open) return null;
  return (
    <div
      ref={panel}
      role="region"
      aria-label="Step details"
      // A place for focus to rest when the control that had it goes (see `keepFocus`), never a stop.
      tabIndex={-1}
      className={`flex min-h-0 flex-col bg-elevated outline-none ${
        dock === "side" ? "w-[380px] shrink-0 border-l border-edge" : "min-w-0 flex-1 border-t border-edge"
      }`}
    >
      {dock === "bottom" && <DrawerHandle panel={panel} />}
      {step && bucket && (
        <>
          {/* THE HEADER STAYS PUT (it sits outside the scroller): the step's name, where it is among
              the steps — "3 of 9" between the arrows — and the tabs, while its payload scrolls. */}
          <div className={`shrink-0 border-b border-hair px-4 ${dock === "bottom" ? "pt-0" : "pt-2"}`}>
            <div className="flex h-9 min-w-0 items-center gap-2">
              {/* BESIDE THE STEPS THERE IS NO ROOM FOR THE WORDS as well as the step's controls, and the
                  step's own name heads the panel a line below; under them, there is. */}
              {dock === "bottom" && <span className={`${TYPE.panelLabel} min-w-0 truncate`}>Step details</span>}
              <span className="ml-auto flex shrink-0 items-center">
                <IconButton
                  icon={Icon.trace.prevStep}
                  label="Previous step"
                  disabledReason={neighbour(-1) ? null : "This is the first step shown"}
                  onClick={() => go(-1)}
                />
                {position >= 0 && (
                  <span className="whitespace-nowrap px-0.5 text-tiny tabular-nums text-faint" title="This step's place among the steps shown">
                    {position + 1} of {rows.length}
                  </span>
                )}
                <IconButton
                  icon={Icon.trace.nextStep}
                  label="Next step"
                  disabledReason={neighbour(1) ? null : "This is the last step shown"}
                  onClick={() => go(1)}
                />
                <IconButton
                  icon={Icon.panel.graph}
                  label="Show this step on the graph"
                  onClick={() => showStepOnGraph(step.id)}
                />
                {run && (
                  <IconButton
                    icon={Icon.trace.pinStep}
                    label={mark?.pinned ? "Unpin this step" : "Pin this step"}
                    active={mark?.pinned === true}
                    onClick={() => markTraceStep(run.id, step.id, "pinned", !mark?.pinned)}
                  />
                )}
                {run && <ViewedToggle runId={run.id} step={step} viewed={mark?.viewed === true} />}
                <IconButton icon={Icon.trace.closeDetails} label="Close step details" onClick={close} />
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
                  <span>{kindWord(step, marks.get(step.name))}</span>
                  <span className="text-faint">·</span>
                  <span className="tabular-nums">#{step.seq}</span>
                  {isInherited(step, run) && (
                    <>
                      <span className="text-faint">·</span>
                      <span className="flex items-center gap-1" title="Copied from the run this one branched from — it ran there, before this run began, and was not re-run">
                        <span aria-hidden><Icon.trace.inherited size={ICON.xs} /></span>inherited
                      </span>
                    </>
                  )}
                </div>
              </div>
              <StepStatus failed={step.error != null} />
            </div>
            <div role="tablist" aria-label="Step views" className="-mx-1 mt-3 flex items-center gap-0.5 overflow-x-auto">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`${tabBtn(tab === t.id, "sm")} shrink-0`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div ref={body} className="flex-1 overflow-auto px-4 pb-6 pt-4">
            {tab === "input" ? <InputTab step={step} />
              : tab === "output" ? <OutputTab step={step} />
                : tab === "prompt" ? <PromptTab step={step} inside={inside} />
                  : tab === "state" ? <StateTabBody step={step} />
                    : tab === "raw" ? <RawTab step={step} />
                      : (
            <>
            <Figures step={step} inside={inside} />
            {/* A failure next: it is what somebody opening a red step came for. */}
            {step.error && (
              <div className="mt-4">
                <ErrorView
                  error={step.error}
                  runStatus={run?.status}
                  // Only about the agent on screen: an explanation or a fix is filed against it.
                  actions={selectedAgentId && run?.agent_id === selectedAgentId ? {
                    explain: () => sendExplain(selectedAgentId, "Why did this step fail?", {
                      kind: "step",
                      step: { name: step.name, type: step.type, seq: step.seq, error: step.error, input: step.input, output: step.output },
                    }),
                    fix: () => sendEdit(selectedAgentId, fixPrompt(step)),
                  } : undefined}
                />
              </div>
            )}
            <Overview step={step} run={run} bucket={bucket} inside={inside} kind={kindWord(step, marks.get(step.name))} onNavigate={keepFocus} />
            <RerunFields rerun={rerun} />
            </>
                      )}
          </div>
          <RerunFooter rerun={rerun} />
        </>
      )}
    </div>
  );
}
