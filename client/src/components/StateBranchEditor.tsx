// Debug depth (Week 6): inspect + optionally edit the agent's state at a step, then BRANCH from
// there — a new run forks from that node's durable checkpoint, the original stays intact.
//
// Editing is scoped (decision: validated domain fields): every state key EXCEPT `messages` is
// editable — a string as text, anything else as JSON. `messages` is not offered — its add_messages
// reducer makes naive replacement of LangChain message objects a corrupt-resume risk. An edited JSON
// field must parse before a re-run is allowed; an invalid edit is refused client-side and the
// original checkpoint is never touched.

import { useEffect, useMemo, useState } from "react";
import type { Step } from "../types.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { stepNodeId } from "../lib/traceGraphMap.ts";
import { rerunBlocked } from "../lib/traceView.ts";
import { sendBranchRun } from "../lib/socket.ts";
import { TYPE } from "../lib/tokens.ts";
import { primaryBtnSm } from "./buttons.ts";

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

export function StateBranchEditor({ step }: { step: Step }) {
  const activeRunId = useTraceStore((s) => s.activeRunId);
  const bucket = useTraceStore((s) => (activeRunId ? s.stepsByRun[activeRunId] : undefined));
  const node = useMemo(() => (bucket ? stepNodeId(step, bucket) : undefined), [step, bucket]);

  const fields = useMemo(() => domainFields(step.state_after), [step.state_after]);
  const fieldKeys = Object.keys(fields);

  // Draft JSON text per editable field, seeded from the current value.
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(fieldKeys.map((k) => [k, draftOf(fields[k])])),
  );
  const [error, setError] = useState<string | null>(null);

  // WHETHER IT CAN WORK, BEFORE IT IS PRESSED (`rerunBlocked`): another run holding the workspace, or
  // no checkpoint after this step. Said under the buttons, which wait, rather than learnt from a
  // two-second toast after a press that made nothing.
  const runs = useTraceStore((s) => s.runs);
  const boundarySeq = useTraceStore((s) => (activeRunId ? s.boundaryByRun[activeRunId] : undefined));
  const blocked = rerunBlocked(step as Step & { checkpoint_id?: string | null }, Object.values(runs), boundarySeq);
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

  if (!activeRunId) return null;

  const dirtyKeys = fieldKeys.filter((k) => draft[k] !== draftOf(fields[k]));

  const branch = (withEdits: boolean) => {
    setError(null);
    let editedState: Record<string, unknown> | undefined;
    if (withEdits) {
      editedState = {};
      for (const k of dirtyKeys) {
        if (asText(fields[k])) {
          editedState[k] = draft[k] ?? "";
          continue;
        }
        try {
          editedState[k] = JSON.parse(draft[k]!);
        } catch {
          setError(`${k} isn't valid JSON — fix it before re-running.`);
          return; // refuse: the original checkpoint is never touched
        }
      }
    }
    setPressedAt(Date.now());
    sendBranchRun(activeRunId, step.seq, node ?? undefined, editedState);
  };
  const said = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

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
        <p className="text-tiny text-muted mb-2">
          Nothing at this step can be edited. You can still re-run from here.
        </p>
      ) : (
        <div className="space-y-2 mb-2">
          {fieldKeys.map((k) => (
            <label key={k} className="block">
              <span className="text-tiny text-muted">
                {k}
                {!asText(fields[k]) && <span className="text-faint"> · JSON</span>}
              </span>
              <textarea
                value={draft[k]}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, [k]: e.target.value }));
                  // The complaint below was about the text that was here when Branch was
                  // pressed. Editing makes it a statement about something that no longer
                  // exists, so it goes; the next press re-checks what is actually there.
                  setError(null);
                }}
                spellCheck={false}
                rows={Math.min(6, (draft[k]?.split("\n").length ?? 1) + 1)}
                className={`w-full mt-1 bg-elevated text-ink text-tiny rounded-input p-2 resize-y
                  outline-none focus-visible:shadow-focusring border border-edge focus:border-faint leading-relaxed ${asText(fields[k]) ? "" : "font-mono"}`}
              />
            </label>
          ))}
          <p className="text-tiny text-faint">
            An edited field replaces its value in the new run. The conversation (messages) can't be edited here.
          </p>
        </div>
      )}

      {error && <p className="text-tiny text-err mb-2">{error}</p>}
      {refusal && (
        <p role="alert" className="mb-2 text-tiny text-err">
          Couldn't re-run from here: {said(refusal)}.
        </p>
      )}

      {/* THE DRAWER'S TWO DECISIONS, BOTH BLACK — the product owner's call on 2026-10-12, that every
          major button there is the app's ink-filled primary — and SMALL (2026-10-14): two full-width
          primaries were the loudest thing in the drawer. Re-run leads because it always works;
          Re-run with edits waits, greyed, until a field has been changed, and counts them. */}
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
          disabled={dirtyKeys.length === 0 || blocked !== null || starting}
          className={`${primaryBtnSm} focus-visible:outline-none focus-visible:shadow-focusring`}
          title={blocked ?? (dirtyKeys.length === 0 ? "Edit a field above to re-run with changes" : "Start a new run from this step with these edits — this run stays as it is")}
        >
          {dirtyKeys.length ? `Re-run with ${dirtyKeys.length} ${dirtyKeys.length === 1 ? "edit" : "edits"}` : "Re-run with edits"}
        </button>
      </div>
      {blocked && <p className="mt-2 text-tiny text-muted">{blocked}.</p>}
      </div>
    </section>
  );
}
