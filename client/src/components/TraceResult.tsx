// What the run came to, above the steps that got it there.
//
// THE ANSWER CARD ONLY EXISTED FOR A RUN THAT FINISHED WITH TEXT. Every other ending left the slot
// empty: a failed run's reason was in the Runs list and nowhere in its own trace, a stopped run looked
// like one that never answered, and a live one gave no sign that an answer was coming. Now the slot
// always says how the run ended, in the run's own words:
//
//   finished — the answer, the same string the eval judge scores (`extractAgentOutput`), with copy;
//   failed   — the run's error, and a way straight to the step that failed;
//   stopped  — that somebody stopped it;
//   live     — that the answer arrives when the run finishes.
//
// FOLDABLE, AND THE FOLD IS ONE CHOICE FOR THE SESSION (`answerOpen`). Somebody reading steps does not
// want twenty lines of prose above them on every run they open; somebody reading answers does. A long
// answer is clamped as well, so an open answer still leaves the timeline on screen.

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { extractAgentOutput } from "../lib/agentOutput.ts";
import { Icon } from "../lib/icons/registry.ts";
import { isVerdict, readVerdict, type RunVerdict, type VerdictTone } from "../lib/runVerdict.ts";
import { finalState } from "../lib/traceCompare.ts";
import { errorParts, ownSteps, runElapsed, stepsTime } from "../lib/traceView.ts";
import { fmtDuration } from "../lib/format.ts";
import { TYPE } from "../lib/tokens.ts";
import { CANCELLED_BY_USER, useTraceStore } from "../store/traceStore.ts";
import type { RunEvalScore, RunSummary, Step } from "../types.ts";
import { CollapsibleRegion } from "./CollapsibleRegion.tsx";
import { CopyTurn } from "./composer/CopyTurn.tsx";
import { Markdown } from "./Markdown.tsx";

/** Taller than this and an answer is clamped until somebody asks for the rest. */
const CLAMP_PX = 240;

const SURFACE = "mb-3 rounded-card border border-hair bg-panel px-3 py-2";

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
 * a folded answer shows, so folding it away still says what the run came to.
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

function FinalAnswer({ text }: { text: string }) {
  const open = useTraceStore((s) => s.answerOpen);
  const setOpen = useTraceStore((s) => s.setAnswerOpen);
  const preview = useMemo(() => answerPreview(text), [text]);
  return (
    <section className={SURFACE} aria-label="Final answer">
      <CollapsibleRegion label="Final answer" open={open} onToggle={() => setOpen(!open)} trailing={<CopyTurn source={text} />} chevron={Icon.trace.fold}>
        <div className="pb-1">
          <ClampedAnswer text={text} />
        </div>
      </CollapsibleRegion>
      {/* FOLDED, IT STILL SAYS WHAT THE RUN CAME TO: the answer's first line, which opens it. The
          fold itself stays one choice for the session (`answerOpen`) — the product owner's call. */}
      {!open && preview && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Show the final answer"
          className="-mx-1 mb-0.5 mt-0.5 block w-[calc(100%+0.5rem)] truncate rounded-control px-1 text-left text-caption text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
        >
          {preview}
        </button>
      )}
    </section>
  );
}

// ── The verdict card (2026-10-14) ───────────────────────────────────────────

/** Advance green, reject red, anything else grey — the product owner's call on 2026-10-14. */
const CHIP: Record<VerdictTone, string> = {
  advance: "bg-ok/10 text-ok",
  reject: "bg-err/10 text-err",
  other: "bg-active text-muted",
};

const capital = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "Advance · 92": the decision and the score, as one chip. */
export function verdictChipText(v: RunVerdict): string {
  const head = v.decision ? capital(v.decision) : "Score";
  return v.score ? `${head} · ${v.score}` : head;
}

/** Met ✓ green, unmet ✗ red. */
function RequirementPills({ items }: { items: RunVerdict["requirements"] }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Requirements">
      {items.map((r, i) => (
        <li
          key={`${r.label}-${i}`}
          className={`max-w-full truncate rounded-full px-2 py-0.5 text-tiny ${r.met ? "bg-ok/[0.08] text-ok" : "bg-err/[0.08] text-err"}`}
          title={`${r.met ? "Met" : "Not met"}: ${r.label}`}
        >
          <span aria-hidden>{r.met ? "✓" : "✗"}</span> {r.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * WHY, IN TWO LINES UNTIL ASKED FOR MORE. The reasoning was the whole card — a wall of text over the
 * steps — and the decision it argued for was somewhere inside it. Now the decision is the chip, and
 * this is two lines and "Show reasoning".
 */
function Reasoning({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const preview = useMemo(() => text.split("\n").map((l) => answerPreview(l)).filter(Boolean).join(" "), [text]);
  return (
    <div>
      {all ? (
        <div className={`${TYPE.body} break-words`}><Markdown text={text} /></div>
      ) : (
        <p className="line-clamp-2 break-words text-caption text-muted">{preview}</p>
      )}
      <button
        type="button"
        onClick={() => setAll((v) => !v)}
        aria-expanded={all}
        className="mt-1 rounded-control text-tiny text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
      >
        {all ? "Hide reasoning" : "Show reasoning"}
      </button>
    </div>
  );
}

function VerdictCard({ verdict, text }: { verdict: RunVerdict; text: string }) {
  const open = useTraceStore((s) => s.answerOpen);
  const setOpen = useTraceStore((s) => s.setAnswerOpen);
  const chip = verdictChipText(verdict);
  return (
    <section className={SURFACE} aria-label="Verdict">
      <CollapsibleRegion label="Verdict" open={open} onToggle={() => setOpen(!open)} trailing={<CopyTurn source={text} />} chevron={Icon.trace.fold}>
        <div className="flex flex-col gap-2 pb-1">
          <div>
            <span className={`inline-block rounded-control px-3 py-1 text-label font-medium tabular-nums ${CHIP[verdict.tone]}`}>{chip}</span>
          </div>
          {verdict.requirements.length > 0 && <RequirementPills items={verdict.requirements} />}
          {(verdict.reasoning ?? text) && <Reasoning text={verdict.reasoning ?? text} />}
        </div>
      </CollapsibleRegion>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Show the verdict"
          className="-mx-1 mb-0.5 mt-0.5 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-2 rounded-control px-1 text-left text-caption text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
        >
          <span className={`shrink-0 rounded-control px-1.5 text-tiny font-medium ${CHIP[verdict.tone]}`}>{chip}</span>
          <span className="truncate">{answerPreview(verdict.reasoning ?? text)}</span>
        </button>
      )}
    </section>
  );
}

// ── The run summary card (2026-10-14) ───────────────────────────────────────

/**
 * THE RUN IN ONE LINE OF RESULTS: how many of its requirements it met — "3/3 must-haves matched", as a
 * pull request shows its checks — and, when an eval ran it, what the judge gave it, criterion by
 * criterion.
 */
function RunSummaryCard({ verdict, evalScore }: { verdict: RunVerdict | null; evalScore: RunEvalScore | undefined }) {
  const reqs = verdict?.requirements ?? [];
  const met = reqs.filter((r) => r.met).length;
  const allMet = reqs.length > 0 && met === reqs.length;
  return (
    <section className={`${SURFACE} flex flex-col gap-1 py-2.5`} aria-label="Run summary">
      <div className={TYPE.sectionLabel}>Summary</div>
      {reqs.length > 0 && (
        <p className="flex min-w-0 items-center gap-1.5 text-caption text-ink" title={reqs.map((r) => `${r.met ? "✓" : "✗"} ${r.label}`).join("\n")}>
          <span aria-hidden className={allMet ? "text-ok" : "text-err"}>{allMet ? "✓" : "✗"}</span>
          <span className="truncate"><span className="tabular-nums">{met}/{reqs.length}</span> {verdict!.noun} matched</span>
        </p>
      )}
      {evalScore && (
        <p className="min-w-0 truncate text-caption text-ink" title={evalScore.rationale ?? evalScore.error ?? undefined}>
          {evalScore.score == null ? (
            <span className="text-muted">The eval's judge could not score this run{evalScore.error ? `: ${evalScore.error}` : ""}</span>
          ) : (
            <>
              <span>Judge <span className="tabular-nums">{Math.round(evalScore.score * 100)}%</span></span>
              {evalScore.criteria.map((c) => (
                <span key={c.id} className="text-muted"> · {c.label} <span className="tabular-nums">{c.score}/{evalScore.scale_max}</span></span>
              ))}
            </>
          )}
        </p>
      )}
    </section>
  );
}

/**
 * A failed run's reason, in the same place an answer would have been.
 *
 * RED WORDS ON THE ORDINARY SURFACE, not a red panel: the failure has to be findable at a glance,
 * and a block of red the size of an answer would be louder than anything it is trying to explain.
 */
function RunFailure({ error, failedStep }: { error: string; failedStep: Step | undefined }) {
  const { type, message } = errorParts(error);
  return (
    <section className={SURFACE} aria-label="Run failed">
      <div className="flex min-h-8 items-center gap-2">
        <span className={`${TYPE.sectionLabel} !text-err`}>Run failed</span>
        <span className="ml-auto flex items-center gap-1">
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
        </span>
      </div>
      <div className="pb-1">
        <p className="line-clamp-4 break-words text-caption text-ink" title={error}>
          {type && <span className="mr-1.5 font-medium text-err">{type}</span>}
          {message}
        </p>
      </div>
    </section>
  );
}

/** One quiet line for an ending with nothing more to show. */
function Note({ children }: { children: React.ReactNode }) {
  return <p className={`${SURFACE} py-2.5 text-caption text-muted`}>{children}</p>;
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
      Cancelled by a user before it finished, so there is no final answer.
      {explain && (
        <>
          {" "}Its steps ran for {fmtDuration(busy)}; the rest of its {fmtDuration(total!)} it was paused or waiting until it was stopped.
        </>
      )}
    </Note>
  );
}

export function TraceResult({ run, steps }: { run: RunSummary; steps: readonly Step[] }) {
  const answer = useMemo(() => (run.status === "completed" ? extractAgentOutput(steps) : ""), [run.status, steps]);
  const failedStep = useMemo(() => steps.find((s) => s.error != null), [steps]);
  const verdict = useMemo(() => (run.status === "completed" ? readVerdict(finalState(steps), answer) : null), [run.status, steps, answer]);
  const evalScore = useTraceStore((s) => s.evalByRun[run.id]);
  const summary = (verdict?.requirements.length ?? 0) > 0 || evalScore ? <RunSummaryCard verdict={verdict} evalScore={evalScore} /> : null;

  if (run.status === "running") return <Note>The final answer appears here when the run finishes.</Note>;
  if (run.status === "paused") return <Note>Paused. The final answer appears here once the run is resumed and finishes.</Note>;
  if (run.status === "error") {
    if (run.error === CANCELLED_BY_USER) return <Stopped run={run} steps={steps} />;
    const error = run.error ?? failedStep?.error ?? null;
    return error ? <RunFailure error={error} failedStep={failedStep} /> : <Note>The run failed without saying why.</Note>;
  }
  const result = isVerdict(verdict) ? <VerdictCard verdict={verdict} text={answer} />
    : answer ? <FinalAnswer text={answer} /> : <Note>The run finished without a text answer.</Note>;
  return summary ? <>{summary}{result}</> : result;
}
