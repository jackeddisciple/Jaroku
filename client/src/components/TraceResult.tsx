// What the run came to — split between two places since 2026-10-15 (the product owner's call: "remove
// response entirely, and move it to … artifacts"):
//
//   on Steps     — only a FAILURE, as one red line that opens: the run's error, and the step that
//                  failed a press away. Nothing else stands between the figures and the steps.
//   in Artifacts — what the run MADE, at the top of the tab that lists what it produced: its text
//                  Response (the same string the eval judge scores, `extractAgentOutput`) with the tools
//                  it called, or — when it replied nothing — the tools it called, "Did". A JSON reply or
//                  a structured final state is already an artifact below it, and is not repeated.
//
// From what the run recorded and nothing inferred: an earlier verdict card read a decision out of the
// output by guesswork, which a developer cannot trust, and is gone. An eval's judge, when one scored
// the run, is a chip beside the Response — a real score.

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { extractAgentOutput } from "../lib/agentOutput.ts";
import { Icon } from "../lib/icons/registry.ts";
import { finalState } from "../lib/traceCompare.ts";
import { errorParts, jsonReply } from "../lib/traceView.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { CANCELLED_BY_USER, useTraceStore } from "../store/traceStore.ts";
import type { RunEvalScore, RunSummary, Step } from "../types.ts";
import { CopyTurn } from "./composer/CopyTurn.tsx";
import { PayloadText } from "./JsonTree.tsx";
import { Markdown } from "./Markdown.tsx";

/** Taller than this and an opened answer is clamped until somebody asks for the rest. */
const CLAMP_PX = 240;

const SURFACE = "mb-3 rounded-card border border-hair bg-panel";

/** Select a step and open its details — an explicit "show me", unlike a plain row click. */
function inspectStep(id: string): void {
  const trace = useTraceStore.getState();
  trace.selectStep(id);
  trace.setExpandedStep(id);
}

function ClampedAnswer({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [all, setAll] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setOverflows(el.scrollHeight > CLAMP_PX + 4);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const clamped = overflows && !all;
  return (
    <>
      <div
        ref={ref}
        className={`${TYPE.body} break-words ${clamped ? "overflow-hidden [mask-image:linear-gradient(to_bottom,#000_75%,transparent)]" : ""}`}
        style={clamped ? { maxHeight: CLAMP_PX } : undefined}
      >
        <Markdown text={text} />
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="mt-1 rounded-control text-tiny text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
        >
          {all ? "Show less" : "Show all"}
        </button>
      )}
    </>
  );
}


// ── What a finished run made ─────────────────────────────────────────────────

/** What a finished run produced, in the order the row prefers it. */
export type RunOutput =
  | { kind: "answer"; text: string; calls: Step[] }
  | { kind: "result"; value: object; copy: string; calls: Step[] }
  | { kind: "did"; calls: Step[] };

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * WHAT THE RUN MADE, FROM WHAT IT RECORDED: its text reply; failing that a JSON reply, or the fields
 * its final state holds besides the conversation; failing that the tools it called. Null when it made
 * none of these.
 */
export function runOutput(steps: readonly Step[]): RunOutput | null {
  const calls = steps.filter((s) => s.type === "tool_call");
  const text = extractAgentOutput(steps);
  if (text) {
    const json = jsonReply(text);
    return json ? { kind: "result", value: json, copy: text, calls } : { kind: "answer", text, calls };
  }
  const state = finalState(steps);
  if (isMap(state)) {
    const fields = Object.fromEntries(Object.entries(state).filter(([k, v]) => k !== "messages" && v != null && v !== ""));
    if (Object.keys(fields).length > 0) return { kind: "result", value: fields, copy: JSON.stringify(fields, null, 2), calls };
  }
  return calls.length > 0 ? { kind: "did", calls } : null;
}

/** Each tool call, ✓ or ✗, opening its step. */
function CallList({ calls }: { calls: readonly Step[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Tools it called">
      {calls.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => inspectStep(c.id)}
            title={c.error ? `#${c.seq} ${c.name} failed — open its details` : `Open #${c.seq} ${c.name}`}
            className="flex items-center gap-1 rounded-full bg-active px-2 py-0.5 text-tiny text-ink transition-colors hover:bg-chrome focus-visible:outline-none focus-visible:shadow-focusring"
          >
            <span aria-hidden className={c.error ? "text-err" : "text-ok"}>{c.error ? "✗" : "✓"}</span>
            <span className="tabular-nums text-faint">#{c.seq}</span>
            {c.name}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** An eval's judge on this run, when one scored it: a real score, at the line's end. */
function JudgeChip({ score }: { score: RunEvalScore }) {
  const criteria = score.criteria.map((c) => `${c.label} ${c.score}/${score.scale_max}`).join(" · ");
  return (
    <span
      className="shrink-0 rounded-full bg-active px-2 py-0.5 text-tiny tabular-nums text-muted"
      title={score.score == null
        ? `The eval's judge could not score this run${score.error ? `: ${score.error}` : ""}`
        : `Scored by an eval's judge${criteria ? ` · ${criteria}` : ""}${score.rationale ? `\n${score.rationale}` : ""}`}
    >
      {score.score == null ? "Judge —" : `Judge ${Math.round(score.score * 100)}%`}
    </span>
  );
}

/**
 * The row: a word for what it holds, one line of it, and — opened — all of it. The fold is the
 * session's (`answerOpen`); the controls at the end stay outside the toggle, so a copy is not a fold.
 */
function ResultRow({ label, tone, line, trailing, children }: {
  label: string;
  tone?: "err";
  line: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  const open = useTraceStore((s) => s.answerOpen);
  const setOpen = useTraceStore((s) => s.setAnswerOpen);
  return (
    <section className={SURFACE} aria-label={label}>
      <div className="flex min-h-9 min-w-0 items-center gap-2 px-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={open ? "Fold to one line" : `Show the whole ${label.toLowerCase()}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-control py-1.5 text-left focus-visible:outline-none focus-visible:shadow-focusring"
        >
          <span aria-hidden className={`shrink-0 text-faint transition-transform duration-fast ${open ? "" : "-rotate-90"}`}>
            <Icon.trace.fold size={ICON.xs} />
          </span>
          <span className={`${TYPE.sectionLabel} shrink-0 ${tone === "err" ? "!text-err" : ""}`}>{label}</span>
          <span className="min-w-0 flex-1 truncate text-caption text-ink">{line}</span>
        </button>
        {trailing && <span className="flex shrink-0 items-center gap-1">{trailing}</span>}
      </div>
      {open && <div className="border-t border-hair px-3 pb-3 pt-2">{children}</div>}
    </section>
  );
}

/**
 * A failed run's reason, in the same place an answer would have been: red words on the ordinary
 * surface, one line until opened, and the step that failed a press away.
 */
function RunFailure({ error, failedStep }: { error: string; failedStep: Step | undefined }) {
  const { type, message, detail } = errorParts(error);
  return (
    <ResultRow
      label="Failed"
      tone="err"
      line={`${type ? `${type}: ` : ""}${message}`}
      trailing={
        <>
          {failedStep && (
            <button
              type="button"
              onClick={() => inspectStep(failedStep.id)}
              className="rounded-control px-2 py-1 text-tiny text-muted transition-colors hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
            >
              Inspect step #{failedStep.seq}
            </button>
          )}
          <CopyTurn source={error} label="Copy error" title="Copy the run's error" />
        </>
      }
    >
      <p className="whitespace-pre-wrap break-words text-caption text-ink [overflow-wrap:anywhere]">
        {type && <span className="mr-1.5 font-medium text-err">{type}</span>}
        {message}
      </p>
      {detail && <div className="mt-2"><PayloadText text={detail} /></div>}
    </ResultRow>
  );
}

/** A quiet sentence for a run that has not made anything yet. */
function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-caption text-muted">{children}</p>;
}

/** On the Steps tab: a failed run's reason, as one red line that opens. Nothing for any other run. */
export function RunFailureLine({ run, steps }: { run: RunSummary; steps: readonly Step[] }) {
  const failedStep = useMemo(() => steps.find((s) => s.error != null), [steps]);
  if (run.status !== "error" || run.error === CANCELLED_BY_USER) return null;
  const error = run.error ?? failedStep?.error ?? null;
  return error ? <RunFailure error={error} failedStep={failedStep} /> : null;
}

/** A section of the Artifacts tab's output: its word, what sits beside it, and the thing itself. */
function OutputSection({ label, trailing, children }: { label: string; trailing?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-label={label}>
      <div className="mb-1.5 flex min-h-8 min-w-0 items-center gap-2">
        <span className={TYPE.sectionLabel}>{label}</span>
        {trailing && <span className="ml-auto flex shrink-0 items-center gap-1">{trailing}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * At the top of the Artifacts tab: what the run made — its Response and the tools it called, or, when
 * it replied nothing, what it Did. Null when there is nothing of the sort (its JSON or structured
 * state is listed below as artifacts), and a sentence while the run is still going.
 */
export function RunOutputSection({ run, steps }: { run: RunSummary; steps: readonly Step[] }) {
  const output = useMemo(() => (run.status === "completed" ? runOutput(steps) : null), [run.status, steps]);
  const evalScore = useTraceStore((s) => s.evalByRun[run.id]);
  if (run.status === "running") return <Note>What the run makes shows here when it finishes.</Note>;
  if (run.status === "paused") return <Note>Paused. What the run makes shows here once it is resumed and finishes.</Note>;
  if (!output) return null;
  const judge = evalScore ? <JudgeChip score={evalScore} /> : null;
  if (output.kind === "answer") {
    return (
      <OutputSection label="Response" trailing={<>{judge}<CopyTurn source={output.text} /></>}>
        <div className="rounded-card border border-hair bg-panel px-3 py-2.5">
          <ClampedAnswer text={output.text} />
        </div>
        {output.calls.length > 0 && <div className="mt-2"><CallList calls={output.calls} /></div>}
      </OutputSection>
    );
  }
  // A RESULT IS ALREADY AN ARTIFACT (the JSON reply, the state's fields), listed below; what is said
  // here is only what the list does not — the tools it called.
  if (output.calls.length === 0 && !judge) return null;
  return (
    <OutputSection label="Did" trailing={judge}>
      {output.calls.length > 0 ? <CallList calls={output.calls} /> : null}
    </OutputSection>
  );
}
