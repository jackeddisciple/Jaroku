import { useState } from "react";
import type { RunStatus, Step } from "../types.ts";
import { textFromLlmOutput } from "../lib/agentOutput.ts";
import { jsonPretty } from "../lib/format.ts";
import { errorParts } from "../lib/traceView.ts";
import { Icon } from "../lib/icons/registry.ts";
import { StateDiff, canDiff } from "./StateDiff.tsx";
import { TYPE } from "../lib/tokens.ts";
import { CollapsibleRegion } from "./CollapsibleRegion.tsx";
import { CopyTurn } from "./composer/CopyTurn.tsx";
import { JsonTree, MessageList, PayloadText, asMessages } from "./JsonTree.tsx";

function Section({ label, value }: { label: string; value: unknown }) {
  const text = jsonPretty(value);
  if (!text) return null;
  return (
    <div className="mt-3 first:mt-0">
      <div className={`mb-1 ${TYPE.sectionLabel}`}>{label}</div>
      {/* The payload is what this panel exists to show, and it was flowing text against the
          panel's own surface — three sections in a row read as one long blob. A well bounds
          each one. */}
      <pre className="whitespace-pre-wrap break-words rounded-control border border-hair bg-void p-2 text-caption leading-relaxed text-muted">
        {text}
      </pre>
    </div>
  );
}

/**
 * A payload section: its name, a copy of exactly what was captured, and the payload drawn for what it
 * is. Folds, so somebody after the output is not made to scroll a forty-message input to reach it.
 */
function PayloadSection({ label, value, children }: { label: "Input" | "Output"; value: unknown; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="mt-3 first:mt-0">
      <CollapsibleRegion
        label={label}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        chevron={Icon.trace.fold}
        trailing={empty ? undefined : <CopyTurn source={jsonPretty(value)} label={`Copy ${label.toLowerCase()}`} title={`Copy this step's ${label.toLowerCase()} as captured`} />}
      >
        {empty ? (
          <p className="text-tiny text-faint">
            {value === "" ? `The ${label.toLowerCase()} was an empty string.` : `No ${label.toLowerCase()} was recorded for this step.`}
          </p>
        ) : (
          children
        )}
      </CollapsibleRegion>
    </div>
  );
}

/** What went in: a model's messages as a conversation, text as text, anything else as a tree. */
function InputView({ step }: { step: Step }) {
  const messages = step.type === "llm_call" ? asMessages(step.input) : null;
  if (messages) return <MessageList messages={messages} />;
  if (typeof step.input === "string") return <PayloadText text={step.input} />;
  // A node's input is the whole agent state; its first level is the useful map, the rest folds.
  return <JsonTree value={step.input} openDepth={step.type === "state_update" ? 1 : 2} />;
}

/** What came out: a model's reply as its text and any tool calls, a router's choice, text, or a tree. */
function OutputView({ step }: { step: Step }) {
  if (step.type === "llm_call") {
    const text = textFromLlmOutput(step.output);
    const calls = Array.isArray(step.output)
      ? step.output.flatMap((g) => (typeof g === "object" && g !== null && Array.isArray((g as { tool_calls?: unknown }).tool_calls)
        ? ((g as { tool_calls: unknown[] }).tool_calls)
        : []))
      : [];
    if (text || calls.length > 0) {
      return (
        <div className="flex flex-col gap-1.5">
          {text && <PayloadText text={text} prose />}
          {calls.length > 0 && <JsonTree value={{ tool_calls: calls }} openDepth={3} />}
        </div>
      );
    }
  }
  if (step.type === "router" && typeof step.output === "string") {
    return (
      <p className="text-caption text-ink">
        <span className="text-muted">Chose </span>
        <span className="font-medium">{step.output}</span>
      </p>
    );
  }
  if (typeof step.output === "string") return <PayloadText text={step.output} />;
  return <JsonTree value={step.output} openDepth={2} />;
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
        <span className={TYPE.sectionLabel}>state</span>
        <button
          type="button"
          onClick={() => setRaw((v) => !v)}
          className="ml-auto text-tiny text-faint hover:text-muted underline underline-offset-2"
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

/**
 * Why the step failed, first and findable.
 *
 * THE EXCEPTION'S CLASS, ITS MESSAGE, THEN ITS STACK — split the way the interceptor writes them
 * (`errorParts`), so "RuntimeError" is a word to scan for rather than the start of a sentence. Red is
 * the edge and the class name, not a red box: the failure has to be easy to find without the drawer
 * shouting over the input and output that explain it.
 *
 * NO RETRY BUTTON. The trace has no notion of a retry, and a button that looked like one would be a
 * promise the schema cannot keep; "Re-run from here" below is the real thing, and the composer
 * answers "why did this fail?" about the selected step.
 */
export function ErrorView({ error, runStatus }: { error: string; runStatus: RunStatus | undefined }) {
  const { type, message, detail } = errorParts(error);
  const [stackOpen, setStackOpen] = useState(false);
  return (
    <section className="mb-4 mt-3 first:mt-0" aria-label="Error">
      <div className="flex min-h-8 items-center">
        <span className={`${TYPE.sectionLabel} !text-err`}>Error</span>
        <CopyTurn source={error} label="Copy error" title="Copy the full error" className="ml-auto" />
      </div>
      <div className="border-l-2 border-err pl-3">
        {type && <div className="text-caption font-medium text-err">{type}</div>}
        <p className="whitespace-pre-wrap break-words text-caption leading-relaxed text-ink [overflow-wrap:anywhere]">{message}</p>
        {detail && (
          <div className="mt-1.5">
            <button
              type="button"
              onClick={() => setStackOpen((v) => !v)}
              aria-expanded={stackOpen}
              className="rounded-xs text-tiny text-muted underline decoration-hair underline-offset-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
            >
              {stackOpen ? "Hide the stack" : `Show the stack (${detail.trim().split("\n").length} lines)`}
            </button>
            {stackOpen && <div className="mt-1.5"><PayloadText text={detail} /></div>}
          </div>
        )}
        {/* What happened next, when the run says: a failure the agent recovered from reads differently
            from the one that ended it. */}
        {runStatus === "completed" && (
          <p className="mt-1.5 text-tiny text-muted">The run still finished — the agent carried on past this failure.</p>
        )}
      </div>
    </section>
  );
}

/**
 * The step exactly as it arrived, for anybody who needs a field this drawer does not lay out. Folded
 * by default, and nothing new: every value in it is one the sections above already show.
 */
function RawEvent({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <CollapsibleRegion
        label="Raw event"
        open={open}
        onToggle={() => setOpen((v) => !v)}
        chevron={Icon.trace.fold}
        trailing={<CopyTurn source={JSON.stringify(step, null, 2)} label="Copy raw event" title="Copy the step as JSON" />}
      >
        <JsonTree value={step} openDepth={1} />
      </CollapsibleRegion>
    </div>
  );
}

export function StepDetail({ step }: { step: Step }) {
  const diffable = canDiff(step.state_before, step.state_after);
  const hasState = step.state_before != null || step.state_after != null;

  return (
    <div className="pb-1">
      <PayloadSection label="Input" value={step.input}>
        <InputView step={step} />
      </PayloadSection>
      <PayloadSection label="Output" value={step.output}>
        <OutputView step={step} />
      </PayloadSection>
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
      <RawEvent step={step} />
    </div>
  );
}
