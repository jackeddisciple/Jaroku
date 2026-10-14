// Debug depth (Week 6): inspect + optionally edit the agent's state at a step, then BRANCH from
// there — a new run forks from that node's durable checkpoint, the original stays intact.
//
// Editing is scoped (decision: validated domain fields): every state key EXCEPT `messages` is
// editable — a string as text, anything else as JSON. `messages` is not offered — its add_messages
// reducer makes naive replacement of LangChain message objects a corrupt-resume risk. An edited JSON
// field must parse before a re-run is allowed; an invalid edit is refused client-side and the
// original checkpoint is never touched.

import { useMemo, useState } from "react";
import type { Step } from "../types.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { stepNodeId } from "../lib/traceGraphMap.ts";
import { sendBranchRun } from "../lib/socket.ts";
import { TYPE } from "../lib/tokens.ts";
import { primaryBtn } from "./buttons.ts";

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
    sendBranchRun(activeRunId, step.seq, node ?? undefined, editedState);
  };

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

      {/* THE DRAWER'S TWO DECISIONS, BOTH BLACK — the product owner's call on 2026-10-12, that every
          major button there is the app's ink-filled primary. Re-run leads because it always works;
          Re-run with edits waits, greyed, until a field has been changed. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => branch(false)}
          className={`${primaryBtn} flex-1 justify-center focus-visible:outline-none focus-visible:shadow-focusring`}
          title="Start a new run from this step, as it was — this run stays as it is"
        >
          Re-run from here
        </button>
        <button
          type="button"
          onClick={() => branch(true)}
          disabled={dirtyKeys.length === 0}
          className={`${primaryBtn} flex-1 justify-center focus-visible:outline-none focus-visible:shadow-focusring`}
          title={dirtyKeys.length === 0 ? "Edit a field above to re-run with changes" : "Start a new run from this step with these edits — this run stays as it is"}
        >
          Re-run with edits{dirtyKeys.length ? ` (${dirtyKeys.length})` : ""}
        </button>
      </div>
      </div>
    </section>
  );
}
