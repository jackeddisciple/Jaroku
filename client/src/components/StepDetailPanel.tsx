// Step details — the slide-in overlay from the right (doc §4.1, not a permanent column). Opens
// when a step is "expanded" (row click or Enter); shows the overview key-values, then the
// step's input / output / state diff and the One-Click Fix button. Reuses StepDetail for the
// body so there's a single source of truth for how a step renders.

import { useEffect } from "react";
import { useTraceStore } from "../store/traceStore.ts";
import { fmtCost, fmtDuration, fmtTokens } from "../lib/format.ts";
import { actionForStep } from "../lib/actionIcons.tsx";
import { ICON, STEP_TYPE, TYPE } from "../lib/tokens.ts";
import { ActionRow } from "./ActionRow.tsx";
import { Chip } from "./Chip.tsx";
import { StatusDot } from "./StatusBadge.tsx";
import { XIcon } from "./panelIcons.tsx";
import { StepDetail } from "./StepDetail.tsx";
import { StateBranchEditor } from "./StateBranchEditor.tsx";
import { McpBadge } from "./McpBadge.tsx";
import { useBuildStore } from "../store/buildStore.ts";
import { agentMcpToolNames } from "../store/mcpStore.ts";

function Kv({ label, value, tag }: { label: string; value: string; tag?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-1 text-caption">
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-2">
        <span className="text-ink tabular-nums">{value}</span>
        {tag && <Chip caps size="sm" tone="faint">this step</Chip>}
      </span>
    </div>
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
      className={`absolute top-0 right-0 bottom-0 w-[340px] max-w-[85%] bg-panel z-20 flex flex-col
        border-l border-edge shadow-floating transition-transform duration-base ease-state
        ${open ? "translate-x-0" : "translate-x-full pointer-events-none"}`}
      aria-hidden={!open}
    >
      {step && (
        <>
          <div className="flex items-center gap-2 px-4 py-3 shrink-0">
            <span className={TYPE.panelLabel}>Step details</span>
            <button
              onClick={() => setExpandedStep(null)}
              className="ml-auto text-muted hover:text-ink transition-colors duration-fast"
              title="Close (Esc)"
            >
              <XIcon size={ICON.sm} />
            </button>
          </div>

          <div className="px-4 pb-3 shrink-0">
            {/* The same sentence the timeline row states, in the same four slots — a reader who
                clicked a row should land on the row they clicked, not on a differently-shaped
                description of it. What this panel adds is room: the MCP badge says the word here
                rather than showing the plug alone, and the schema's own name for the step type
                appears, which is the one place it is worth spelling out. */}
            <ActionRow
              action={actionForStep(step)}
              state={step.error ? "error" : "done"}
              object={<span className="font-medium text-ink [overflow-wrap:anywhere]">{step.name}</span>}
              badges={step.type === "tool_call" && mcpNames.has(step.name) ? <McpBadge /> : undefined}
              trailing={
                <Chip mono size="sm" color={STEP_TYPE[step.type].fg} background={STEP_TYPE[step.type].bg}>
                  {step.type}
                </Chip>
              }
            />
            {/* Outcome, in the app's own status mark rather than a coloured bullet character. */}
            <div className="mt-1.5 flex items-center gap-1.5 pl-[22px] text-tiny">
              <StatusDot state={step.error ? "error" : "ok"} />
              <span className={step.error ? "text-err" : "text-ok"}>{step.error ? "failed" : "ok"}</span>
            </div>
          </div>

          <div className="flex-1 overflow-auto px-4 pb-6">
            <div className="border-t border-hair pt-2">
              <Kv label="Step ID" value={step.id.slice(0, 8)} />
              <Kv label="Type" value={step.type} />
              <Kv label="Seq" value={`#${step.seq}`} />
              {step.tokens != null && <Kv label="Tokens" value={fmtTokens(step.tokens)} tag />}
              {step.cost != null && <Kv label="Cost" value={fmtCost(step.cost)} tag />}
              <Kv label="Duration" value={fmtDuration(step.latency_ms)} tag />
            </div>
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
