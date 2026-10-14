import { useState } from "react";
import type { RunStatus, Step } from "../types.ts";
import { textFromLlmOutput } from "../lib/agentOutput.ts";
import { jsonPretty } from "../lib/format.ts";
import { errorParts, jsonReply, llmToolCalls, stepOutputText } from "../lib/traceView.ts";
import { StateDiff, canDiff } from "./StateDiff.tsx";
import { TYPE } from "../lib/tokens.ts";
import { CopyTurn } from "./composer/CopyTurn.tsx";
import { JsonTree, MessageList, PayloadText, asMessages, contentText, type Message } from "./JsonTree.tsx";

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

/** What went in: a model's messages as a conversation, text as text, anything else as a tree. */
function InputView({ step }: { step: Step }) {
  const messages = step.type === "llm_call" ? asMessages(step.input) : null;
  if (messages) return <MessageList messages={messages} />;
  if (typeof step.input === "string") return <PayloadText text={step.input} />;
  // A node's input is the whole agent state; its first level is the useful map, the rest folds.
  return <JsonTree value={step.input} openDepth={step.type === "state_update" ? 1 : 2} />;
}

/**
 * A model's reply that is JSON, drawn as the tree state is drawn — `{"must_haves": …}` was one long
 * string — with the text it arrived as one press away, since that is what the model actually said.
 */
function JsonReply({ text, value }: { text: string; value: object }) {
  const [asText, setAsText] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      {asText ? <PayloadText text={text} /> : <JsonTree value={value} openDepth={2} />}
      <button
        type="button"
        onClick={() => setAsText((v) => !v)}
        className="self-start rounded-xs text-tiny text-faint underline decoration-hair underline-offset-2 transition-colors hover:text-muted focus-visible:outline-none focus-visible:shadow-focusring"
      >
        {asText ? "Show as JSON" : "Show the reply as text"}
      </button>
    </div>
  );
}

/** What came out: a model's reply as its text and any tool calls, a router's choice, text, or a tree. */
function OutputView({ step }: { step: Step }) {
  if (step.type === "llm_call") {
    const text = textFromLlmOutput(step.output);
    const calls = llmToolCalls(step.output);
    const json = text ? jsonReply(text) : undefined;
    if (text || calls.length > 0) {
      return (
        <div className="flex flex-col gap-1.5">
          {text && (json ? <JsonReply text={text} value={json} /> : <PayloadText text={text} prose />)}
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
    <div>
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
 * promise the schema cannot keep; "Re-run from here" below is the real thing.
 *
 * EXPLAIN AND FIX IT LIVE HERE, beside the error they are about. They were a card over the composer
 * that came up on every click of a failed row; the answer and the proposed change still arrive in the
 * conversation, where they always did.
 */
export function ErrorView({ error, runStatus, actions }: {
  error: string;
  runStatus: RunStatus | undefined;
  /** What can be done about it, when the step's agent is the one selected. */
  actions?: { explain: () => void; fix: () => void };
}) {
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
        {actions && (
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={actions.explain}
              title="Ask why this step failed — the answer appears in the conversation"
              className="rounded-control border border-hair px-2.5 py-1 text-tiny text-ink transition-colors hover:bg-active focus-visible:outline-none focus-visible:shadow-focusring"
            >
              Explain
            </button>
            <button
              type="button"
              onClick={actions.fix}
              title="Propose a code change for this failure — it arrives in the conversation for you to apply"
              className="rounded-control border border-hair px-2.5 py-1 text-tiny text-ink transition-colors hover:bg-active focus-visible:outline-none focus-visible:shadow-focusring"
            >
              Fix it
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

// ── The drawer's tabs (2026-10-14): Input · Output · Prompt · State diff · Raw ─────────────────
//
// ONE QUESTION PER TAB. The drawer was one long scroll — input, output, state, raw event, the re-run
// editor — and the part somebody came for was below the fold of the part they did not. Each payload
// is now a tab of its own, with its copy button beside its name.

/** A tab's payload: its name and its copy, then the payload drawn for what it is — or why there is none. */
function PayloadTab({ label, value, copy, children }: {
  label: "Input" | "Output";
  value: unknown;
  copy?: { text: string; title: string };
  children: React.ReactNode;
}) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div>
      <div className="mb-1.5 flex min-h-8 items-center">
        <span className={TYPE.sectionLabel}>{label}</span>
        {!empty && (
          <CopyTurn
            source={copy?.text ?? jsonPretty(value)}
            label={`Copy ${label.toLowerCase()}`}
            title={copy?.title ?? `Copy this step's ${label.toLowerCase()} as captured`}
            className="ml-auto"
          />
        )}
      </div>
      {empty ? (
        <p className="text-tiny text-faint">
          {value === "" ? `The ${label.toLowerCase()} was an empty string.` : `No ${label.toLowerCase()} was recorded for this step.`}
        </p>
      ) : (
        children
      )}
    </div>
  );
}

export function InputTab({ step }: { step: Step }) {
  return (
    <PayloadTab label="Input" value={step.input}>
      <InputView step={step} />
    </PayloadTab>
  );
}

export function OutputTab({ step }: { step: Step }) {
  return (
    <PayloadTab
      label="Output"
      value={step.output}
      // A model call's copy is its reply, as drawn below — the envelope is in Raw.
      copy={step.type === "llm_call" ? { text: stepOutputText(step), title: "Copy the reply as shown" } : undefined}
    >
      <OutputView step={step} />
    </PayloadTab>
  );
}

/** The model calls whose prompts a step's Prompt tab shows: the step itself, or the calls inside it. */
export function promptCalls(step: Step, inside: readonly Step[]): Step[] {
  const calls = step.type === "llm_call" ? [step] : inside.filter((s) => s.type === "llm_call");
  return calls.filter((c) => asMessages(c.input) != null);
}

const roleOf = (m: Message): string => String(m.type ?? m.role ?? "message");

/** A prompt as one text, the way it would be pasted: each message under its role. */
function promptText(messages: readonly Message[]): string {
  return messages.map((m) => `${roleOf(m)}:\n${contentText(m.content) ?? JSON.stringify(m.content)}`).join("\n\n");
}

/**
 * WHAT THE MODEL WAS TOLD AND ASKED. A node's input is the whole state, and the prompt its model call
 * was sent was two clicks away inside it; a model call's prompt was forty messages to scroll. Here it
 * is the system prompt, then the last thing it was asked, with the whole conversation one press away.
 */
function PromptOf({ call, many }: { call: Step; many: boolean }) {
  const messages = asMessages(call.input) ?? [];
  const [all, setAll] = useState(false);
  const system = messages.find((m) => /^system$/i.test(roleOf(m)));
  const asked = [...messages].reverse().find((m) => /^(human|user)$/i.test(roleOf(m)));
  const systemText = system ? contentText(system.content) : null;
  const askedText = asked ? contentText(asked.content) : null;
  return (
    <section className="mt-4 first:mt-0" aria-label={`Prompt of #${call.seq}`}>
      <div className="mb-1.5 flex min-h-8 items-center gap-2">
        <span className={TYPE.sectionLabel}>{many ? `#${call.seq} ${call.name}` : "Prompt"}</span>
        <span className="text-tiny text-faint">{messages.length} {messages.length === 1 ? "message" : "messages"}</span>
        <CopyTurn source={promptText(messages)} label="Copy prompt" title="Copy the whole prompt as text, each message under its role" className="ml-auto" />
      </div>
      {systemText && (
        <div className="mb-2">
          <div className="mb-0.5 text-tiny uppercase tracking-wider text-faint">System</div>
          <PayloadText text={systemText} prose />
        </div>
      )}
      {askedText && (
        <div className="mb-2">
          <div className="mb-0.5 text-tiny uppercase tracking-wider text-faint">Asked</div>
          <PayloadText text={askedText} prose />
        </div>
      )}
      {messages.length > (system ? 1 : 0) + (asked ? 1 : 0) && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="rounded-xs text-tiny text-muted underline decoration-hair underline-offset-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
        >
          {all ? "Hide the conversation" : `Show the whole conversation (${messages.length})`}
        </button>
      )}
      {all && <div className="mt-2"><MessageList messages={messages} /></div>}
    </section>
  );
}

export function PromptTab({ step, inside }: { step: Step; inside: readonly Step[] }) {
  const calls = promptCalls(step, inside);
  if (calls.length === 0) return <p className="text-tiny text-faint">This step sent no prompt to a model.</p>;
  return <>{calls.map((c) => <PromptOf key={c.id} call={c} many={calls.length > 1 || c.id !== step.id} />)}</>;
}

/** Whether a step has any state to show. */
export const hasState = (step: Step): boolean => step.state_before != null || step.state_after != null;

export function StateTabBody({ step }: { step: Step }) {
  if (!hasState(step)) return <p className="text-tiny text-faint">This step recorded no state.</p>;
  if (canDiff(step.state_before, step.state_after)) return <StateView step={step} />;
  return (
    <>
      <Section label="state before" value={step.state_before} />
      <Section label="state after" value={step.state_after} />
    </>
  );
}

/** The step exactly as it arrived, for a field no other tab lays out. */
export function RawTab({ step }: { step: Step }) {
  return (
    <div>
      <div className="mb-1.5 flex min-h-8 items-center">
        <span className={TYPE.sectionLabel}>Raw event</span>
        <CopyTurn source={JSON.stringify(step, null, 2)} label="Copy raw event" title="Copy the step as JSON" className="ml-auto" />
      </div>
      <JsonTree value={step} openDepth={1} />
    </div>
  );
}
