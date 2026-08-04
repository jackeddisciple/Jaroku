// Debug depth (Week 6): inspect + optionally edit the agent's state at a step, then BRANCH from
// there — a new run forks from that node's durable checkpoint, the original stays intact.
//
// Editing is scoped (decision: validated domain fields): every state key EXCEPT `messages` is
// exposed as editable JSON. `messages` is shown read-only in v1 — its add_messages reducer makes
// naive replacement of LangChain message objects a corrupt-resume risk. Each edited field must be
// valid JSON before a branch is allowed; an invalid edit is refused client-side and the original
// checkpoint is never touched.

import { useMemo, useState } from "react";
import type { Step } from "../types.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { stepNodeId } from "../lib/traceGraphMap.ts";
import { sendBranchRun } from "../lib/socket.ts";
import { TYPE } from "../lib/tokens.ts";

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
    Object.fromEntries(fieldKeys.map((k) => [k, JSON.stringify(fields[k], null, 2)])),
  );
  const [error, setError] = useState<string | null>(null);

  if (!activeRunId) return null;

  const dirtyKeys = fieldKeys.filter((k) => draft[k] !== JSON.stringify(fields[k], null, 2));

  const branch = (withEdits: boolean) => {
    setError(null);
    let editedState: Record<string, unknown> | undefined;
    if (withEdits) {
      editedState = {};
      for (const k of dirtyKeys) {
        try {
          editedState[k] = JSON.parse(draft[k]!);
        } catch {
          setError(`"${k}" is not valid JSON — fix it before branching.`);
          return; // refuse: the original checkpoint is never touched
        }
      }
    }
    sendBranchRun(activeRunId, step.seq, node ?? undefined, editedState);
  };

  return (
    <div className="mt-4 border-t border-hair pt-3">
      <div className="flex items-center gap-2 mb-2">
        <span className={TYPE.panelLabel}>Branch from here</span>
        {node && <span className="text-[10px] text-muted">node: {node}</span>}
      </div>

      {fieldKeys.length === 0 ? (
        <p className="text-[11px] text-muted mb-2">
          No editable domain fields at this step. You can still re-run the graph from this point.
        </p>
      ) : (
        <div className="space-y-2 mb-2">
          {fieldKeys.map((k) => (
            <label key={k} className="block">
              <span className="text-[11px] text-muted">{k}</span>
              <textarea
                value={draft[k]}
                onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                spellCheck={false}
                rows={Math.min(6, (draft[k]?.split("\n").length ?? 1) + 1)}
                className="w-full mt-1 bg-bg text-ink text-[11px] font-mono rounded-control p-2 resize-y
                  outline-none border border-hair focus:border-faint leading-relaxed"
              />
            </label>
          ))}
          <p className="text-[10px] text-faint">
            messages is read-only in v1. Edits replace the field value on the branch.
          </p>
        </div>
      )}

      {error && <p className="text-[11px] text-err mb-2">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={() => branch(true)}
          disabled={dirtyKeys.length === 0}
          className="flex-1 rounded-control py-1.5 text-[12px] border border-hair text-ink
            enabled:hover:bg-active disabled:opacity-40 disabled:cursor-not-allowed"
          title={dirtyKeys.length === 0 ? "Edit a field to branch with changes" : "Fork a new run with these edits"}
        >
          Branch with edits{dirtyKeys.length ? ` (${dirtyKeys.length})` : ""}
        </button>
        <button
          onClick={() => branch(false)}
          className="rounded-control px-3 py-1.5 text-[12px] border border-hair text-muted hover:bg-active hover:text-ink"
          title="Fork a new run from this checkpoint without changes"
        >
          Re-run from here
        </button>
      </div>
    </div>
  );
}
