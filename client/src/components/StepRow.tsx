// One step of a trace: what ran, what kind of thing it was, and what it cost.
//
// IT WAS A SENTENCE ON ONE LINE — `#3 ⚒ Called get_time   1,204 tok  $0.0031  820 ms` — drawn through
// the shared ActionRow. That read well for eight steps and badly for eighty: every row was the same
// weight, the verb repeated what the icon already said, and a 60-character tool name pushed the
// figures onto a second line wherever it happened to land.
//
// NOW THE NAME LEADS AND THE KIND SITS UNDER IT. The step's own name is what somebody scans a trace
// for, so it is first and in ink; the kind ("LLM call", "Tool call") is the quiet line beneath, and a
// failure says "failed" there beside the warning mark it always had — never the colour alone. The
// figures keep their own right-hand column, so they line up down the trace however long a name gets.
//
// THE MARKS ARE THE TRACE'S OWN, UNCHANGED — `actionForStep`'s glyph at its size and accent — on a
// soft tile in the step type's own STEP_TYPE tint. The tile is the row's node on the timeline's line.
//
// A CLICK SELECTS, AND ONLY SELECTS. The step lights its node on the graph and becomes what the
// composer is talking about, exactly as before — but the details drawer no longer slides over the
// timeline on every click. It opens from the row's Details button, or Enter, on purpose. Once it is
// open it follows the selection (see `selectStep`), so it never shows one step beside another's row.

import { useEffect, useRef } from "react";

import { actionForStep } from "../lib/actionIcons.tsx";
import { fmtCost, fmtDuration, fmtTokens, jsonPretty } from "../lib/format.ts";
import { Icon } from "../lib/icons/registry.ts";
import { CATEGORY_LABEL, stepCategory } from "../lib/traceView.ts";
import { ICON, STATUS, STEP_TYPE } from "../lib/tokens.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { agentMcpToolNames } from "../store/mcpStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { Step } from "../types.ts";
import { CopyTurn } from "./composer/CopyTurn.tsx";
import { IconButton } from "./IconButton.tsx";
import { McpBadge } from "./McpBadge.tsx";
import { ChevronRightIcon } from "./panelIcons.tsx";
import { StatusDot } from "./StatusBadge.tsx";

/** The tile behind a step's mark: its type's own tint, red for a failure, grey for a type we don't know. */
export function StepTile({ step }: { step: Pick<Step, "type" | "error"> }) {
  const { Icon: Mark, accent } = actionForStep(step);
  const known = STEP_TYPE[step.type as keyof typeof STEP_TYPE] as { fg: string; bg: string } | undefined;
  return (
    <span
      aria-hidden
      className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm ${
        step.error ? "bg-err/10" : known ? "" : "bg-active text-muted"
      }`}
      style={{
        background: step.error ? undefined : known?.bg,
        color: step.error ? STATUS.error : known ? accent : undefined,
      }}
    >
      <Mark size={ICON.sm} />
    </span>
  );
}

/** What "Copy output" puts on the clipboard: text as text, anything else as the JSON it is. */
function outputText(step: Step): string {
  return jsonPretty(step.output);
}

/**
 * How much of a row's right-hand side the list's width can afford. THE NAME ALWAYS WINS: a row that
 * kept its figures and lost its name would be a row of numbers about nothing. Cost goes first (it is
 * in the details), then tokens; the duration stays, and Details floats instead of holding a slot.
 */
export type RowTier = "wide" | "medium" | "narrow";

export function StepRow({ step, tabbable, tier }: { step: Step; tabbable: boolean; tier: RowTier }) {
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId));
  const mcpNames = agentMcpToolNames(agent?.mcp_tools);
  const expanded = useTraceStore((s) => s.expandedStepId === step.id);
  const selected = useTraceStore((s) => s.selectedStepId === step.id);
  const rowRef = useRef<HTMLDivElement>(null);

  // When selected from elsewhere (a graph-node click, J/K), bring the row into view.
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const select = (): void => {
    useTraceStore.getState().selectStep(step.id);
    useUiStore.getState().setSelectedNodeId(null); // composer context is now this step
  };
  const toggleDetails = (): void => {
    select();
    useTraceStore.getState().setExpandedStep(expanded ? null : step.id);
  };

  const category = stepCategory(step);
  const output = outputText(step);
  const failed = step.error != null;

  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-level={1}
      aria-selected={selected}
      aria-label={`#${step.seq} ${step.name}, ${CATEGORY_LABEL[category]}${failed ? ", failed" : ""}`}
      data-step-id={step.id}
      tabIndex={tabbable ? 0 : -1}
      onClick={select}
      onKeyDown={(e) => {
        // ENTER IS THIS ROW'S, AND ONLY THIS ROW'S. The window-wide Enter (CommandPalette) toggles the
        // selected step too; letting it through would toggle twice — from the row, and from a button in
        // it — and leave the drawer where it was.
        if (e.key !== "Enter" && e.key !== " ") return;
        e.stopPropagation();
        if (e.target !== e.currentTarget) return; // a button in the row is handling its own press
        e.preventDefault();
        toggleDetails();
      }}
      className={`group/step relative flex animate-slide-in cursor-pointer select-none items-center gap-2 rounded-control py-1.5 pl-2 pr-1 outline-none transition-colors duration-fast focus-visible:shadow-focusring motion-reduce:animate-none ${
        selected ? "bg-active" : "hover:bg-active/40"
      }`}
    >
      {/* The same selection mark the other lists use — inset, square, ink. */}
      {selected && <span aria-hidden className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent" />}

      <span className="w-7 shrink-0 text-right text-tiny tabular-nums text-faint">#{step.seq}</span>
      <StepTile step={step} />

      <span className="min-w-[4.5rem] flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-caption font-medium text-ink" title={step.name}>{step.name}</span>
          {/* Derived from the AGENT's manifest, not from the step: the frozen Step schema has no
              provenance field and must not grow one. */}
          {step.type === "tool_call" && mcpNames.has(step.name) && <McpBadge variant="compact" />}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-tiny text-faint">
          <span className="truncate">{CATEGORY_LABEL[category]}</span>
          {failed && (
            <span className="flex shrink-0 items-center gap-1 text-err">
              <StatusDot state="error" size={ICON.xs} title="This step failed" />
              failed
            </span>
          )}
        </span>
      </span>

      {/* Figures, tabular, and only the ones this step has: a node has no tokens of its own. */}
      <span className="flex shrink-0 items-center gap-3 text-tiny tabular-nums text-muted">
        {step.tokens != null && tier !== "narrow" && (
          <span title={fmtTokens(step.tokens)}>{fmtTokens(step.tokens, tier === "wide" ? "exact" : "short")}</span>
        )}
        {step.cost != null && tier === "wide" && <span>{fmtCost(step.cost)}</span>}
        <span className="min-w-[3rem] text-right">{fmtDuration(step.latency_ms)}</span>
      </span>

      {/* THE ROW'S ACTIONS. Details holds its own place, so the figures never move when it appears;
          the other two float over the figures while the row is hovered or focused. Too narrow for a
          slot, Details floats over the duration instead and the other two stay in the drawer. */}
      <span className={tier === "narrow" ? "absolute right-1 top-1/2 flex -translate-y-1/2 items-center" : "relative flex shrink-0 items-center"}>
        {tier !== "narrow" && (
        <span
          className="absolute right-full top-1/2 flex -translate-y-1/2 items-center rounded-control bg-bg opacity-0 transition-opacity duration-fast group-hover/step:opacity-100 group-focus-within/step:opacity-100"
        >
          <span className={`flex items-center rounded-control ${selected ? "bg-active" : "bg-active/40"}`}>
            <IconButton
              icon={Icon.panel.graph}
              label="Show this step on the graph"
              stopPropagation
              onClick={() => {
                select();
                useUiStore.getState().setRightTab("graph");
              }}
            />
            {output && <CopyTurn source={output} label="Copy output" title="Copy this step's output" />}
          </span>
        </span>
        )}
        <button
          type="button"
          aria-pressed={expanded}
          onClick={(e) => {
            e.stopPropagation();
            toggleDetails();
          }}
          title={expanded ? "Close step details" : "Open step details"}
          className={`flex h-7 items-center gap-0.5 rounded-control px-2 text-tiny transition-[opacity,color,background-color] duration-fast focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-focusring ${
            expanded
              ? "bg-chrome text-ink opacity-100"
              : `${tier === "narrow" ? "bg-active" : ""} text-muted hover:bg-active hover:text-ink ${selected ? "opacity-100" : "opacity-0 group-hover/step:opacity-100 group-focus-within/step:opacity-100"}`
          }`}
        >
          Details
          <ChevronRightIcon size={ICON.xs} />
        </button>
      </span>
    </div>
  );
}
