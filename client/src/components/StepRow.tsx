// One step of a trace, as a sentence about something that happened.
//
// The row used to read `#3  [tool_call]  get_time    1,204 tok · $0.0031 · 820 ms`. Everything in
// it is true and none of it says what the agent DID: `tool_call` is the name of a field in the
// frozen event schema, and the reader has to translate it every time. Scanning eight of those to
// find where a run went wrong means reading eight type names and eight node names and assembling
// the story yourself.
//
// Now it reads `#3  Called get_time   1,204 tok  $0.0031  820 ms`, drawn through the shared
// ActionRow so the trace narrates itself in the same words and the same four slots the plan card
// and the generation list use.
//
// The type badge is gone from the row rather than moved. Verb and type are the same fact — every
// `tool_call` is a "Called" and nothing else — so the chip was the schema's name for what the verb
// already says, in a slot that could hold the tool name instead. The exact field value is still
// one click away in the step-detail panel, which is where somebody who wants the schema's word
// for it is looking.
//
// The spine is untouched: the rail, the connector node, and the amber accent bar on the selected
// row all still say "these are one sequence, and you are here". Those answer a different question
// from the action icon a few pixels to their right, which says what kind of thing this step was.

import { useEffect, useRef } from "react";
import type { Step } from "../types.ts";
import { actionForStep } from "../lib/actionIcons.tsx";
import { fmtCost, fmtDuration, fmtTokens } from "../lib/format.ts";
import { ICON } from "../lib/tokens.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { agentMcpToolNames } from "../store/mcpStore.ts";
import { ActionRow } from "./ActionRow.tsx";
import { McpBadge } from "./McpBadge.tsx";
import { StatusDot } from "./StatusBadge.tsx";

export function StepRow({ step }: { step: Step }) {
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === s.activeAgentId));
  const mcpNames = agentMcpToolNames(agent?.mcp_tools);
  const open = useTraceStore((s) => s.expandedStepId === step.id);
  const selected = useTraceStore((s) => s.selectedStepId === step.id);
  const selectStep = useTraceStore((s) => s.selectStep);
  const setExpandedStep = useTraceStore((s) => s.setExpandedStep);
  const rowRef = useRef<HTMLDivElement>(null);

  // When selected from elsewhere (a graph-node click), bring the row into view.
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  return (
    <div ref={rowRef} className="relative animate-slide-in py-1.5 pl-7 motion-reduce:animate-none">
      {/* connector node on the timeline's vertical line */}
      <span
        className={`absolute left-[6px] top-[13px] w-[7px] h-[7px] rounded-full ring-2 ring-bg ${
          step.error ? "bg-err" : selected ? "bg-run" : "bg-grip"
        }`}
      />
      {/* The same selection mark the other six lists use — inset 4px top and bottom, square, ink.
          It was full height, rounded, and AMBER, which is the running colour: the one list in the
          app that diverged was also the one using "this is executing" to mean "this is the row you
          picked", inside the panel where the distinction matters most. */}
      {selected && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent" />}
      <ActionRow
        action={actionForStep(step)}
        state={step.error ? "error" : "done"}
        selected={selected}
        className="-mx-2 px-2"
        lead={<span className="w-8 text-right">#{step.seq}</span>}
        object={<span className="font-medium text-ink [overflow-wrap:anywhere]">{step.name}</span>}
        // Derived from the AGENT's manifest, not from the step: the frozen Step schema has
        // no provenance field and must not grow one.
        badges={
          step.type === "tool_call" && mcpNames.has(step.name) ? <McpBadge variant="compact" /> : undefined
        }
        trailing={
          <>
            {/* Figures, so mono and tabular: eight rows of these are a column to compare. */}
            {step.tokens != null && <span className="text-muted">{fmtTokens(step.tokens)}</span>}
            {step.cost != null && <span className="text-muted">{fmtCost(step.cost)}</span>}
            <span className="text-muted">{fmtDuration(step.latency_ms)}</span>
            {/* Only failures get a mark. A green check on every row is a column of green checks,
                and the figures beside it are already the evidence that a step completed. */}
            {step.error && <StatusDot state="error" size={ICON.xs} title="This step failed" />}
          </>
        }
        onClick={() => {
          selectStep(step.id);
          setExpandedStep(open ? null : step.id);
          useUiStore.getState().setSelectedNodeId(null); // composer context is now this step
        }}
      />
    </div>
  );
}
