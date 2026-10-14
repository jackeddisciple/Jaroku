// Debug depth (Week 6): inspect + optionally edit the agent's state at a step, then BRANCH from
// there — a new run forks from that node's durable checkpoint, the original stays intact.
//
// Editing is scoped (decision: validated domain fields): every state key EXCEPT `messages` is
// editable — a string as text, anything else as JSON. `messages` is not offered — its add_messages
// reducer makes naive replacement of LangChain message objects a corrupt-resume risk. An edited JSON
// field must parse before a re-run is allowed; an invalid edit is refused client-side and the
// original checkpoint is never touched.
//
// THREE PIECES SINCE 2026-10-14, because the buttons moved: `useRerun` holds the drafts and what the
// buttons do, `RerunFields` is the editor in the drawer's Overview, and `RerunFooter` is the drawer's
// pinned footer — the two re-run buttons stay in reach on every tab and however far the step scrolls.

import { useEffect, useMemo, useState } from "react";
import type { Step } from "../types.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { stepNodeId } from "../lib/traceGraphMap.ts";
import { rerunBlocked } from "../lib/traceView.ts";
import { sendBranchRun } from "../lib/socket.ts";
import { diffHunks, lineDiff } from "../lib/textDiff.ts";
import { Icon } from "../lib/icons/registry.ts";
import { EDITED, ICON, TYPE } from "../lib/tokens.ts";
import { primaryBtnSm } from "./buttons.ts";
import { IconButton } from "./IconButton.tsx";

/**
 * How a field is edited, and read back: a STRING as the text it is, anything else as JSON.
 *
 * Every field was JSON, so a string showed as `"shortlist"` — quotes somebody had to keep intact,
 * and a missing one refused the branch. Text in, text out now; only numbers, lists and objects are
 * written as JSON, and say so.
 */
const asText = (v: unknown): boolean => typeof v === "string";
const draftOf = (v: unknown): string => (asText(v) ? (v as string) : JSON.stringify(v, null, 2));

function domainFields(stateAfter: unknown): Record<string, unknown> {
  if (!stateAfter || typeof stateAfter !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stateAfter as Record<string, unknown>)) {
    if (k === "messages") continue; // guarded in v1
    out[k] = v;
  }
  return out;
}

/** Why a JSON draft does not parse, in the parser's words — or null when it does. */
function jsonProblem(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "not valid JSON";
  }
}

export interface Rerun {
  node: string | undefined;
  fields: Record<string, unknown>;
  fieldKeys: string[];
  draft: Record<string, string>;
  setField: (key: string, text: string) => void;
  resetField: (key: string) => void;
  dirtyKeys: string[];
  /** Each JSON field's parse error, by key, for the fields that have one. */
  invalid: Record<string, string>;
  blocked: string | null;
  starting: boolean;
  refusal: string | null;
  branch: (withEdits: boolean) => void;
}

/**
 * The re-run's state for one step: its editable fields and their drafts, whether it can run, and the
 * press. THE DRAFTS ARE THIS STEP'S: moving the drawer to another step starts them again from its
 * values, so prev/next never offers to re-run a step with another step's edits.
 */
export function useRerun(step: Step | undefined): Rerun {
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const bucket = useTraceStore((s) => (activeRunId ? s.stepsByRun[activeRunId] : undefined));
  const node = useMemo(() => (step && bucket ? stepNodeId(step, bucket) ?? undefined : undefined), [step, bucket]);

  const fields = useMemo(() => domainFields(step?.state_after), [step?.state_after]);
  const fieldKeys = Object.keys(fields);
  const initial = useMemo(() => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, draftOf(v)])), [fields]);
  const [drafts, setDrafts] = useState<{ stepId: string | undefined; values: Record<string, string> }>({ stepId: step?.id, values: initial });
  const draft = drafts.stepId === step?.id ? drafts.values : initial;
  const setField = (key: string, text: string): void => setDrafts({ stepId: step?.id, values: { ...draft, [key]: text } });
  const resetField = (key: string): void => setDrafts({ stepId: step?.id, values: { ...draft, [key]: initial[key] ?? "" } });

  // WHETHER IT CAN WORK, BEFORE IT IS PRESSED (`rerunBlocked`): another run holding the workspace, or
  // no checkpoint after this step. Said under the buttons, which wait, rather than learnt from a
  // two-second toast after a press that made nothing.
  const runs = useTraceStore((s) => s.runs);
  const boundarySeq = useTraceStore((s) => (activeRunId ? s.boundaryByRun[activeRunId] : undefined));
  const blocked = step ? rerunBlocked(step as Step & { checkpoint_id?: string | null }, Object.values(runs), boundarySeq) : null;
  // AND AFTER: pressed, the buttons wait until the new run opens (this panel goes with the old run)
  // or the server refuses — which is then said here, in its own words, until something changes.
  const [pressedAt, setPressedAt] = useState<number | null>(null);
  const refusal = useTraceStore((s) =>
    pressedAt !== null && s.controlError && s.controlError.runId === activeRunId && s.controlError.at >= pressedAt
      ? s.controlError.message
      : null);
  useEffect(() => {
    if (pressedAt === null || refusal) return;
    const id = setTimeout(() => setPressedAt(null), 15_000);
    return () => clearTimeout(id);
  }, [pressedAt, refusal]);
  const starting = pressedAt !== null && !refusal;

  const dirtyKeys = fieldKeys.filter((k) => draft[k] !== initial[k]);
  const invalid: Record<string, string> = {};
  for (const k of dirtyKeys) {
    if (asText(fields[k])) continue;
    const problem = jsonProblem(draft[k] ?? "");
    if (problem) invalid[k] = problem;
  }

  const branch = (withEdits: boolean): void => {
    if (!activeRunId || !step) return;
    let editedState: Record<string, unknown> | undefined;
    if (withEdits) {
      // Refused while any edit does not parse: the button says so, and the original checkpoint is
      // never touched.
      if (Object.keys(invalid).length > 0) return;
      editedState = {};
      for (const k of dirtyKeys) editedState[k] = asText(fields[k]) ? (draft[k] ?? "") : JSON.parse(draft[k]!);
    }
    setPressedAt(Date.now());
    sendBranchRun(activeRunId, step.seq, node, editedState);
  };

  return { node, fields, fieldKeys, draft, setField, resetField, dirtyKeys, invalid, blocked, starting, refusal, branch };
}

/** An edited field against what it was: the changed lines and a line either side, before red, after green. */
function EditDiff({ before, after }: { before: string; after: string }) {
  const hunks = useMemo(() => diffHunks(lineDiff(before, after)), [before, after]);
  return (
    <div className="mt-1 overflow-hidden rounded-control border border-hair font-mono text-tiny leading-relaxed" aria-label="Changes against the original">
      {hunks.map((l, i) =>
        l === null ? (
          <div key={i} className="px-2 text-faint">⋯</div>
        ) : (
          <div
            key={i}
            className={`whitespace-pre-wrap break-words px-2 [overflow-wrap:anywhere] ${l.kind === "del" ? "bg-err/[0.06] text-ink" : l.kind === "add" ? "bg-ok/[0.06] text-ink" : "text-muted"}`}
          >
            <span aria-hidden className={`mr-1.5 select-none ${l.kind === "del" ? "text-err" : l.kind === "add" ? "text-ok" : "text-faint"}`}>
              {l.kind === "del" ? "−" : l.kind === "add" ? "+" : " "}
            </span>
            {l.text || " "}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * The editor: each field, and — once somebody changes one — an orange dot beside its name, a way back
 * to what it was, the change against the original, and, for JSON, whether it parses, as it is typed.
 */
export function RerunFields({ rerun }: { rerun: Rerun }) {
  const { node, fields, fieldKeys, draft, setField, resetField, dirtyKeys, invalid } = rerun;
  return (
    <section aria-label="Re-run from this step" className="mt-5">
      <div className="mb-1.5 flex items-center gap-2">
        {/* ONE NAME FOR ONE ACTION. It was "Re-run" on the composer's card, "Re-run from here" and
            "Branch with edits" here, and "Branch a run from here" on the graph: all of them fork a
            new run from this step's checkpoint and leave this one as it was. */}
        <span className={TYPE.sectionLabel}>Re-run from this step</span>
        {node && <span className="text-tiny text-muted">node: {node}</span>}
      </div>
      <div className="rounded-card border border-hair bg-panel p-3">
        {fieldKeys.length === 0 ? (
          <p className="text-tiny text-muted">
            Nothing at this step can be edited. You can still re-run from here.
          </p>
        ) : (
          <div className="space-y-3">
            {fieldKeys.map((k) => {
              const edited = dirtyKeys.includes(k);
              const problem = invalid[k];
              const json = !asText(fields[k]);
              return (
                <div key={k}>
                  <div className="flex min-h-6 items-center gap-1.5">
                    {edited && (
                      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: EDITED }} />
                    )}
                    <label htmlFor={`rerun-field-${k}`} className="min-w-0 truncate text-tiny text-muted">
                      {k}
                      {json && <span className="text-faint"> · JSON</span>}
                      {edited && <span className="sr-only"> (edited)</span>}
                    </label>
                    {edited && (
                      <IconButton
                        icon={Icon.trace.resetField}
                        label={`Put ${k} back as it was`}
                        size={ICON.xs}
                        className="-my-2 ml-auto"
                        onClick={() => resetField(k)}
                      />
                    )}
                  </div>
                  <textarea
                    id={`rerun-field-${k}`}
                    value={draft[k]}
                    onChange={(e) => setField(k, e.target.value)}
                    spellCheck={false}
                    aria-invalid={problem ? true : undefined}
                    rows={Math.min(6, (draft[k]?.split("\n").length ?? 1) + 1)}
                    className={`mt-1 w-full resize-y rounded-input border bg-elevated p-2 text-tiny leading-relaxed text-ink outline-none focus-visible:shadow-focusring ${
                      problem ? "border-err" : "border-edge focus:border-faint"
                    } ${json ? "font-mono" : ""}`}
                  />
                  {problem && <p className="mt-0.5 text-tiny text-err">Not valid JSON: {problem}</p>}
                  {edited && !problem && <EditDiff before={draftOf(fields[k])} after={draft[k] ?? ""} />}
                </div>
              );
            })}
            <p className="text-tiny text-faint">
              An edited field replaces its value in the new run. The conversation (messages) can't be edited here.
            </p>
          </div>
        )}
      </div>
      {/* A small reminder of where the buttons went, for a reader who scrolled down looking for them. */}
      <p className="mt-1.5 text-tiny text-faint">Re-run from the buttons at the bottom of the panel.</p>
    </section>
  );
}

/**
 * THE DRAWER'S TWO DECISIONS, PINNED UNDER IT (2026-10-14) — on every tab, however far the step
 * scrolls. Both black — the product owner's call on 2026-10-12, that every major button there is the
 * app's ink-filled primary — and SMALL: two full-width primaries were the loudest thing in the drawer.
 * Re-run leads because it always works; Re-run with edits waits, greyed, until a field has been
 * changed, and counts them.
 */
export function RerunFooter({ rerun }: { rerun: Rerun }) {
  const { dirtyKeys, invalid, blocked, starting, refusal, branch } = rerun;
  const broken = Object.keys(invalid);
  const said = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
  return (
    <div className="shrink-0 border-t border-hair bg-elevated px-4 py-2.5">
      {refusal && (
        <p role="alert" className="mb-1.5 text-tiny text-err">
          Couldn't re-run from here: {said(refusal)}.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => branch(false)}
          disabled={blocked !== null || starting}
          className={`${primaryBtnSm} focus-visible:outline-none focus-visible:shadow-focusring`}
          title={blocked ?? (starting ? "Starting the new run…" : "Start a new run from this step, as it was — this run stays as it is")}
        >
          {starting ? "Starting…" : "Re-run from here"}
        </button>
        <button
          type="button"
          onClick={() => branch(true)}
          disabled={dirtyKeys.length === 0 || broken.length > 0 || blocked !== null || starting}
          className={`${primaryBtnSm} focus-visible:outline-none focus-visible:shadow-focusring`}
          title={
            blocked
            ?? (broken.length > 0
              ? `${broken.join(", ")} ${broken.length === 1 ? "isn't" : "aren't"} valid JSON — fix ${broken.length === 1 ? "it" : "them"} first`
              : dirtyKeys.length === 0
                ? "Edit a field in Overview to re-run with changes"
                : "Start a new run from this step with these edits — this run stays as it is")
          }
        >
          {dirtyKeys.length ? `Re-run with ${dirtyKeys.length} ${dirtyKeys.length === 1 ? "edit" : "edits"}` : "Re-run with edits"}
        </button>
        {dirtyKeys.length > 0 && (
          <span className="flex items-center gap-1 text-tiny text-muted">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: EDITED }} />
            {broken.length > 0 ? `${broken.length} not valid JSON` : `${dirtyKeys.length} edited`}
          </span>
        )}
      </div>
      {blocked && <p className="mt-1.5 text-tiny text-muted">{blocked}.</p>}
    </div>
  );
}
