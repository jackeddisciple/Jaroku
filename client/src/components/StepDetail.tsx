import { useState } from "react";
import type { Step } from "../types.ts";
import { jsonPretty } from "../lib/format.ts";
import { StateDiff, canDiff } from "./StateDiff.tsx";

function Section({ label, value }: { label: string; value: unknown }) {
  const text = jsonPretty(value);
  if (!text) return null;
  return (
    <div className="mt-3 first:mt-0">
      <div className="text-faint uppercase tracking-wide text-[11px] mb-1">{label}</div>
      {/* The payload is what this panel exists to show, and it was flowing text against the
          panel's own surface — three sections in a row read as one long blob. A well bounds
          each one. */}
      <pre className="whitespace-pre-wrap break-words rounded-control border border-hair bg-bg/60 p-2 text-[12px] leading-relaxed text-[#a1a1aa]">
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
    <div className="pb-1">
      {step.error && (
        <div className="mt-3 first:mt-0">
          <div className="text-err uppercase tracking-wide text-[11px] mb-1">error</div>
          <pre className="whitespace-pre-wrap break-words rounded-control border border-err/25 bg-err/[0.04] p-2 text-[12px] leading-relaxed text-err">
            {step.error}
          </pre>
          {/* One-Click Fix is now the unified composer: select this step and type "fix this"
              (or "why did this fail?") — one place to type, no per-step button. */}
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
