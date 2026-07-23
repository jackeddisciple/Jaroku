import { useState } from "react";
import type { Step } from "../types.ts";
import { jsonPretty } from "../lib/format.ts";
import { StateDiff, canDiff } from "./StateDiff.tsx";
import { useTraceStore } from "../store/traceStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { useUiStore } from "../store/uiStore.ts";

/** Build the fix prompt for One-Click Fix (doc §4.7.1): the failing step + its error, plus a
 *  little input context, framed as an edit instruction. The editor already sees every file, so
 *  we give it the failure, not the whole codebase. */
function fixPrompt(step: Step): string {
  const lines = [
    `The trace step "${step.name}" (${step.type}) failed with this error:`,
    "",
    (step.error ?? "").trim(),
  ];
  const input = jsonPretty(step.input);
  if (input && input.length <= 600) {
    lines.push("", "It was called with:", input);
  }
  lines.push("", "Please fix the agent's code so this step succeeds.");
  return lines.join("\n");
}

/** "Ask Jaroku to fix this step" — routes an error into the existing edit/fix loop by selecting
 *  the run's agent and pre-filling the composer. Reuses the edit pipeline; builds no parallel one. */
function FixButton({ step }: { step: Step }) {
  const run = useTraceStore((s) => s.runs[step.run_id]);
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === run?.agent_id));
  const selectAgent = useBuildStore((s) => s.selectAgent);
  const prefillChat = useUiStore((s) => s.prefillChat);

  // Only offer it when the failing run belongs to an editable (generated) agent.
  if (!agent || agent.hand_written) return null;

  return (
    <button
      type="button"
      onClick={() => {
        selectAgent(agent.agent_id);
        prefillChat(fixPrompt(step));
      }}
      className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-run hover:text-ink transition-colors"
    >
      <span aria-hidden>✧</span> Ask Jaroku to fix this step
    </button>
  );
}

function Section({ label, value }: { label: string; value: unknown }) {
  const text = jsonPretty(value);
  if (!text) return null;
  return (
    <div className="mt-3 first:mt-0">
      <div className="text-faint uppercase tracking-wide text-[11px] mb-1">{label}</div>
      <pre className="whitespace-pre-wrap break-words text-[12px] text-[#a1a1aa] leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

/**
 * State panel. Defaults to the diff — "what did this step change?" should read in ~2s —
 * with the raw before/after blobs one click away, so nothing is hidden.
 */
function StateView({ step }: { step: Step }) {
  const [raw, setRaw] = useState(false);

  return (
    <div className="mt-3">
      <div className="flex items-baseline gap-3 mb-1">
        <span className="text-faint uppercase tracking-wide text-[11px]">state</span>
        <button
          type="button"
          onClick={() => setRaw((v) => !v)}
          className="ml-auto text-[11px] text-faint hover:text-muted underline underline-offset-2"
        >
          {raw ? "show diff" : "show raw"}
        </button>
      </div>
      {raw ? (
        <>
          <Section label="state before" value={step.state_before} />
          <Section label="state after" value={step.state_after} />
        </>
      ) : (
        <StateDiff before={step.state_before} after={step.state_after} />
      )}
    </div>
  );
}

export function StepDetail({ step }: { step: Step }) {
  const diffable = canDiff(step.state_before, step.state_after);
  const hasState = step.state_before != null || step.state_after != null;

  return (
    <div className="mt-2 ml-9 pr-4 pb-1">
      {step.error && (
        <div className="mt-3 first:mt-0">
          <div className="text-err uppercase tracking-wide text-[11px] mb-1">error</div>
          <pre className="whitespace-pre-wrap break-words text-[12px] text-err leading-relaxed">
            {step.error}
          </pre>
          <FixButton step={step} />
        </div>
      )}
      <Section label="input" value={step.input} />
      <Section label="output" value={step.output} />
      {diffable ? (
        <StateView step={step} />
      ) : (
        hasState && (
          <>
            <Section label="state before" value={step.state_before} />
            <Section label="state after" value={step.state_after} />
          </>
        )
      )}
    </div>
  );
}
