// What the run came to, above the steps that got it there — ONE LINE, AND WHATEVER THE RUN MADE.
//
// THE PRODUCT OWNER'S CALL, 2026-10-15: "adaptive, and just one line by default." A final answer is the
// product of a Q&A agent and noise for most others — an extractor's is a JSON blob, an action agent's is
// "I've sent the email", a pipeline's is nothing at all — and a verdict card read a decision out of the
// output by guesswork, which a developer debugging the run cannot trust. So the row says what THIS run
// produced, from what it recorded and nothing inferred:
//
//   Answer — the text it replied with, the same string the eval judge scores (`extractAgentOutput`);
//   Result — what it made instead of prose: a JSON reply, or the fields of its final state;
//   Did    — the tools it called, when it answered nothing — an action agent's real output;
//   Failed — the run's error, with a way straight to the step that failed;
//   and a one-line note while it runs, while it is paused, or when somebody stopped it.
//
// A run that finished having made none of these shows no row at all: "finished without a text
// answer" told nobody anything.
//
// ONE LINE UNTIL OPENED, AND THE FOLD IS ONE CHOICE FOR THE SESSION (`answerOpen`, closed to begin
// with): the steps start right under the figures, and the line still says what the run came to. An
// eval's judge, when one scored the run, is a chip at the line's end — a real score, not a reading.

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { extractAgentOutput } from "../lib/agentOutput.ts";
import { Icon } from "../lib/icons/registry.ts";
import { finalState } from "../lib/traceCompare.ts";
import { errorParts, jsonReply, ownSteps, runElapsed, stepsTime } from "../lib/traceView.ts";
import { fmtDuration } from "../lib/format.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { CANCELLED_BY_USER, useTraceStore } from "../store/traceStore.ts";
import type { RunEvalScore, RunSummary, Step } from "../types.ts";
import { CopyTurn } from "./composer/CopyTurn.tsx";
import { JsonTree, PayloadText } from "./JsonTree.tsx";
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

/**
 * The answer's opening, as one line of plain words: its first line with the markdown taken off. What
 * the folded row shows, so folding it away still says what the run came to.
 */
export function answerPreview(text: string): string {
  const first = text.split("\n").map((l) => l.trim()).find((l) => l !== "" && !/^(```|---|\*\*\*)/.test(l)) ?? "";
  return first
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    // A single * or _ only where it is emphasis around words — an identifier keeps its underscores.
    .replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
    .trim();
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

/** A value as the folded row shows it: short text quoted, numbers as they are, lists and maps by size. */
function brief(v: unknown): string {
  if (typeof v === "string") return `"${v.length > 28 ? `${v.slice(0, 28)}…` : v}"`;
  if (Array.isArray(v)) return `[${v.length}]`;
  if (isMap(v)) return `{${Object.keys(v).length}}`;
  return String(v);
}

/** The folded line for a structured result: its top-level fields, `name: "Ada" · score: 92 · skills: [3]`. */
export function resultPreview(value: object): string {
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  return Object.entries(value).map(([k, v]) => `${k}: ${brief(v)}`).join(" · ");
}

/** The folded line for the tools a run called: each name once, in the order first called, with its count. */
export function callsPreview(calls: readonly Step[]): string {
  const seen = new Map<string, number>();
  for (const c of calls) seen.set(c.name, (seen.get(c.name) ?? 0) + 1);
  return [...seen].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(" · ");
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

/** What a finished run made, as one line: its answer, its result, or what it did. */
function Finished({ output, evalScore }: { output: RunOutput; evalScore: RunEvalScore | undefined }) {
  const judge = evalScore ? <JudgeChip score={evalScore} /> : null;
  if (output.kind === "answer") {
    return (
      <ResultRow label="Answer" line={answerPreview(output.text)} trailing={<>{judge}<CopyTurn source={output.text} /></>}>
        <ClampedAnswer text={output.text} />
        {output.calls.length > 0 && <div className="mt-3"><CallList calls={output.calls} /></div>}
      </ResultRow>
    );
  }
  if (output.kind === "result") {
    return (
      <ResultRow
        label="Result"
        line={resultPreview(output.value)}
        trailing={<>{judge}<CopyTurn source={output.copy} label="Copy result" title="Copy the result as JSON" /></>}
      >
        <JsonTree value={output.value} openDepth={1} />
        <button
          type="button"
          onClick={() => useTraceStore.getState().setRunTab("artifacts")}
          className="mt-1.5 rounded-xs text-tiny text-muted underline decoration-hair underline-offset-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
        >
          Open in Artifacts
        </button>
        {output.calls.length > 0 && <div className="mt-3"><CallList calls={output.calls} /></div>}
      </ResultRow>
    );
  }
  return (
    <ResultRow label="Did" line={callsPreview(output.calls)} trailing={judge}>
      <CallList calls={output.calls} />
    </ResultRow>
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

/** One quiet line for an ending with nothing more to show. */
function Note({ children }: { children: React.ReactNode }) {
  return <p className={`${SURFACE} px-3 py-2.5 text-caption text-muted`}>{children}</p>;
}

/**
 * A run somebody stopped, said as such — the trace never said "cancelled", only the Runs list did —
 * and, when its duration is mostly not its steps, where the rest of the time went: it sat paused or
 * waiting until the stop came.
 */
function Stopped({ run, steps }: { run: RunSummary; steps: readonly Step[] }) {
  const own = ownSteps(run, steps);
  const total = runElapsed(run, own, Date.now());
  const busy = stepsTime(own);
  const idle = total == null ? 0 : total - busy;
  const explain = total != null && own.length > 0 && idle > Math.max(2000, total / 4);
  return (
    <Note>
      Stopped before it finished.
      {explain && (
        <>
          {" "}Its steps ran for {fmtDuration(busy)}; the rest of its {fmtDuration(total!)} it was paused or waiting.
        </>
      )}
    </Note>
  );
}

export function TraceResult({ run, steps }: { run: RunSummary; steps: readonly Step[] }) {
  const output = useMemo(() => (run.status === "completed" ? runOutput(steps) : null), [run.status, steps]);
  const failedStep = useMemo(() => steps.find((s) => s.error != null), [steps]);
  const evalScore = useTraceStore((s) => s.evalByRun[run.id]);

  if (run.status === "running") return <Note>What it makes shows here when the run finishes.</Note>;
  if (run.status === "paused") return <Note>Paused. What it makes shows here once it is resumed and finishes.</Note>;
  if (run.status === "error") {
    if (run.error === CANCELLED_BY_USER) return <Stopped run={run} steps={steps} />;
    const error = run.error ?? failedStep?.error ?? null;
    return error ? <RunFailure error={error} failedStep={failedStep} /> : <Note>The run failed without saying why.</Note>;
  }
  // FINISHED HAVING MADE NOTHING THIS CAN SHOW: no row at all.
  return output ? <Finished output={output} evalScore={evalScore} /> : null;
}
