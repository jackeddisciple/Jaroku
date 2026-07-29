// Diff card — the fix loop's trust surface (doc §4.4). Every proposed change renders
// inline in the conversation: files touched, +adds/−removes, expandable hunks, and explicit
// Apply / Discard / Undo. Borderless-first: the card sits on the background, separated by
// spacing and the same +/− visual language as the state diff (StateDiff.tsx).

import { useState } from "react";
import type { FileDiff } from "../types.ts";
import type { ProposalTurn } from "../store/chatStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { sendApplyEdit, sendDiscardEdit, sendUndoEdit } from "../lib/socket.ts";
import { StatusBadge, StatusDot } from "./StatusBadge.tsx";
import { STAT_ICON } from "./StatRow.tsx";
import { FileIcon } from "./panelIcons.tsx";

function HunkLines({ file }: { file: FileDiff }) {
  return (
    // Diff bodies are the most literally-code thing in the pane — mono, always.
    <div className="mt-1 overflow-x-auto font-mono">
      {file.hunks.map((h, hi) => (
        <div key={hi} className={hi > 0 ? "mt-2" : ""}>
          <div className="px-2 text-[11px] text-faint tabular-nums select-none">
            @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
          </div>
          {h.lines.map((line, li) => {
            const sign = line[0];
            const cls =
              sign === "+"
                ? "bg-ok/[0.07] text-ok"
                : sign === "-"
                  ? "bg-err/[0.07] text-err"
                  : "text-muted";
            return (
              <div key={li} className={`px-2 text-[12px] leading-relaxed whitespace-pre ${cls}`}>
                {line || " "}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function FileRow({ file, defaultOpen }: { file: FileDiff; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const openInCode = useBuildStore((s) => s.openInCode);

  return (
    <div className="mt-1.5 first:mt-0">
      <div className="flex items-center gap-2 text-[12px]">
        <button onClick={() => setOpen((o) => !o)} className="text-faint hover:text-ink w-3 shrink-0">
          {open ? "▾" : "▸"}
        </button>
        <button
          onClick={() => openInCode(file.path)}
          className="font-mono text-ink truncate hover:underline underline-offset-2"
          title="Open in Code tab"
        >
          {file.path}
        </button>
        {file.status === "added" && <span className="text-faint text-[11px]">new file</span>}
        <span className="ml-auto shrink-0 font-mono tabular-nums text-[11px]">
          <span className="text-ok">+{file.additions}</span>{" "}
          <span className="text-err">−{file.deletions}</span>
        </span>
      </div>
      {open && <HunkLines file={file} />}
    </div>
  );
}

const btn =
  "rounded px-3 py-1.5 text-[12px] bg-panel text-ink hover:bg-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

export function DiffCard({ turn }: { turn: ProposalTurn }) {
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === turn.agentId));

  // Streaming: the model is rewriting files right now.
  if (turn.status === "streaming") {
    return (
      <div className="text-[12px]">
        <div className="text-run">Proposing changes…</div>
        <div className="mt-1 space-y-0.5">
          {turn.streaming.map((f) => (
            <div key={f.path} className="flex items-center gap-2 animate-slide-in">
              <StatusDot
                state={f.done ? "ok" : "pending"}
                pulse={!f.done}
                title={f.done ? "Rewritten" : "Still rewriting"}
              />
              <span className="font-mono text-muted truncate">{f.path}</span>
              <span className="ml-auto font-mono text-faint text-[11px] tabular-nums">
                {f.done ? `${f.bytes} B` : "rewriting…"}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (turn.status === "error") {
    return (
      <div className="text-[12px]">
        <div className="text-err">Edit failed — {turn.error}</div>
        {turn.problems && turn.problems.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-muted">
            {turn.problems.map((p, i) => (
              <li key={i} className="pl-3">· {p}</li>
            ))}
          </ul>
        )}
        <div className="mt-1.5 text-faint">Nothing was changed — the project is untouched.</div>
      </div>
    );
  }

  // No-op: the model declined and said why. Renders as a plain reply.
  if (turn.status === "noop") {
    return <div className="text-[12px] text-ink">{turn.summary}</div>;
  }

  const totals = turn.files.reduce(
    (acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }),
    { add: 0, del: 0 },
  );
  const nFiles = turn.files.length;
  // Undo only reverts the *latest* applied edit — offering it on an older card would
  // revert something else than what the button says.
  const isLatestApplied = turn.status === "applied" && turn.version === agent?.edit_count;

  return (
    <div className="text-[12px] animate-slide-in">
      <div className="text-ink">{turn.summary}</div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-muted">
        {/* The same shape as the generation stat row: a glyph to jump to, a tabular figure to
            read. Adds and removes stay a single paired stat — they are one fact about the diff,
            not two, and splitting them would imply they can be compared separately. */}
        <span className="inline-flex items-center gap-1.5">
          <span className="shrink-0 flex items-center opacity-70" aria-hidden>
            <FileIcon size={STAT_ICON} />
          </span>
          <span className="font-mono tabular-nums">{nFiles}</span>
          <span>{nFiles === 1 ? "file" : "files"}</span>
        </span>
        <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
          <span className="text-ok">+{totals.add}</span>
          <span className="text-err">−{totals.del}</span>
        </span>
        {turn.status === "applied" && (
          <StatusBadge
            state="ok"
            label={`applied · v${turn.version}`}
            title="These changes are on disk"
          />
        )}
        {turn.status === "undone" && (
          <StatusBadge state="neutral" label="undone" title="These changes were reverted" />
        )}
        {turn.status === "discarded" && (
          <StatusBadge state="neutral" label="discarded" title="These changes were never applied" />
        )}
      </div>

      <div className={`mt-2 ${turn.status !== "pending" ? "opacity-70" : ""}`}>
        {turn.files.map((f) => (
          <FileRow key={f.path} file={f} defaultOpen={turn.status === "pending"} />
        ))}
      </div>

      {turn.status === "pending" && (
        <div className="mt-3 flex items-center gap-2">
          <button className={btn} onClick={() => turn.proposalId && sendApplyEdit(turn.proposalId)}>
            Apply
          </button>
          <button
            className="rounded px-3 py-1.5 text-[12px] text-muted hover:text-ink transition-colors"
            onClick={() => turn.proposalId && sendDiscardEdit(turn.proposalId)}
          >
            Discard
          </button>
          {turn.usage && (
            <span className="ml-auto text-faint text-[11px] tabular-nums">
              ${turn.usage.cost_usd.toFixed(4)}
              {turn.usage.cache_read_input_tokens > 0 && " · cache hit"}
            </span>
          )}
        </div>
      )}

      {isLatestApplied && (
        <div className="mt-2">
          <button className={btn} onClick={() => sendUndoEdit(turn.agentId)}>
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
