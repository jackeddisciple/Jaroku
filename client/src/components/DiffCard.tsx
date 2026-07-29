// Diff card — the fix loop's trust surface (doc §4.4). Every proposed change renders
// inline in the conversation: files touched, +adds/−removes, expandable hunks, and explicit
// Apply / Discard / Undo. Borderless-first: the card sits on the background, separated by
// spacing and the same +/− visual language as the state diff (StateDiff.tsx).

import { useEffect, useRef, useState } from "react";
import type { FileDiff } from "../types.ts";
import type { ProposalTurn } from "../store/chatStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { sendApplyEdit, sendDiscardEdit, sendUndoEdit } from "../lib/socket.ts";
import { primaryBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { ChevronDownIcon } from "./composerIcons.tsx";
import { DiffBar } from "./DiffBar.tsx";
import { StreamingFileRow } from "./FileList.tsx";
import { iconForPath } from "./fileIcons.tsx";
import { Prose } from "./InlineCode.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { STAT_ICON } from "./StatRow.tsx";
import { ICON } from "../lib/tokens.ts";
import { CheckIcon, FileIcon, PlusIcon, UndoIcon } from "./panelIcons.tsx";

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
              // Code wants tighter leading than prose — a diff is read as a block of related
              // lines, and prose spacing pulls them apart into separate statements.
              <div key={li} className={`px-2 text-[12px] leading-[1.45] whitespace-pre ${cls}`}>
                {line || " "}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function FileRow({
  file,
  defaultOpen,
  scale,
}: {
  file: FileDiff;
  defaultOpen: boolean;
  /** The largest change in this card, so every row's bar is drawn on the same axis. */
  scale: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const openInCode = useBuildStore((s) => s.openInCode);
  const TypeIcon = iconForPath(file.path);

  return (
    <div className="mt-2 first:mt-0">
      <div className="flex items-center gap-2 text-[12px]">
        <button onClick={() => setOpen((o) => !o)} className="text-faint hover:text-ink w-3 shrink-0">
          {open ? "▾" : "▸"}
        </button>
        {/* Between the disclosure and the path, so the type is the first thing on the row that is
            about the file itself. Faint: it classifies the row, it doesn't compete with the name. */}
        <span className="shrink-0 flex items-center text-faint" aria-hidden>
          <TypeIcon size={STAT_ICON} />
        </span>
        <button
          onClick={() => openInCode(file.path)}
          className="font-mono text-ink truncate hover:underline underline-offset-2"
          title="Open in Code tab"
        >
          {file.path}
        </button>
        {/* Whether a file is new or edited is the first thing that changes how you read its diff —
            a +14/−0 on a new file is the whole file, on an existing one it is a change. As faint
            text it sat below the weight of the applied/undone badges a few pixels above, so the
            more important fact was the quieter one. Same pill, outlined rather than filled,
            because this is a property of the file and not something that happened to it.

            Green because a new file is entirely additions, and green already means added in the
            hunks directly below — not a new colour, the same one one line up. */}
        {file.status === "added" && (
          <span className="shrink-0">
            <StatusBadge
              state="ok"
              variant="outline"
              icon={PlusIcon}
              label="new file"
              title="This file did not exist before this change"
            />
          </span>
        )}
        <span className="ml-auto shrink-0 flex items-center gap-2 font-mono tabular-nums text-[11px]">
          <span>
            <span className="text-ok">+{file.additions}</span>{" "}
            <span className="text-err">−{file.deletions}</span>
          </span>
          <DiffBar additions={file.additions} deletions={file.deletions} scale={scale} />
        </span>
      </div>
      {open && <HunkLines file={file} />}
    </div>
  );
}

/**
 * Which version of the agent is on disk, and what else there is.
 *
 * UI ONLY. Nothing here switches anything — the entries are not buttons, and the popover says so
 * rather than offering a click that does nothing. There is no version-switching path in the store
 * or on the server yet; when there is, this is where it attaches.
 *
 * It still earns its place unbuilt. "APPLIED · V1" tells you where this card sits; it does not tell
 * you that there are four versions and you are looking at the second. On an agent you have edited
 * five times, that is the thing you actually want to know before reaching for Undo, and Undo is
 * exactly what it sits next to.
 *
 * Newest first, because that is the one you are standing on.
 */
function VersionPicker({ current, count }: { current: number; count: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={secondaryBtn}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={`Version ${current} of ${count}`}
      >
        <span className="font-mono tabular-nums">v{current}</span>
        <ChevronDownIcon size={ICON.xs} />
      </button>
      {open && (
        // Opens upward: this sits at the bottom of a card, near the bottom of a scrolling thread.
        // Same surface as the composer's model popover, which is the only other one in this pane.
        <div className="absolute bottom-full mb-1 left-0 z-30 min-w-[150px] rounded-lg bg-panel border border-edge shadow-2xl py-1">
          <div className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wide text-faint">
            Versions
          </div>
          {Array.from({ length: count }, (_, i) => count - i).map((v) => (
            <div
              key={v}
              className={`flex items-center gap-2 px-3 py-1 font-mono text-[12px] ${
                v === current ? "text-ink" : "text-faint"
              }`}
            >
              <span className="w-3 shrink-0 flex items-center text-ok">
                {v === current && <CheckIcon size={ICON.xs} />}
              </span>
              v{v}
            </div>
          ))}
          <div className="mt-1 border-t border-hair px-3 pt-1.5 pb-0.5 text-[10px] text-faint">
            Switching versions isn’t built yet.
          </div>
        </div>
      )}
    </div>
  );
}

export function DiffCard({ turn }: { turn: ProposalTurn }) {
  const agent = useBuildStore((s) => s.agents.find((a) => a.agent_id === turn.agentId));

  // Streaming: the model is rewriting files right now.
  if (turn.status === "streaming") {
    return (
      <div className="text-[12px]">
        <div className="text-run">Proposing changes…</div>
        <div className="mt-2 space-y-1">
          {turn.streaming.map((f) => (
            <StreamingFileRow
              key={f.path}
              path={f.path}
              done={f.done}
              figure={f.done ? `${f.bytes} B` : "rewriting…"}
              title={f.done ? "Rewritten" : "Still rewriting"}
            />
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
          <ul className="mt-2 space-y-1 text-muted">
            {turn.problems.map((p, i) => (
              // Validation problems name the rule and the symbol that broke it — exactly the two
              // things worth being able to pick out of the sentence.
              <li key={i} className="pl-3">· <Prose text={p} /></li>
            ))}
          </ul>
        )}
        <div className="mt-2 text-faint">Nothing was changed — the project is untouched.</div>
      </div>
    );
  }

  // No-op: the model declined and said why. Renders as a plain reply.
  if (turn.status === "noop") {
    return (
      <div className="text-[12px] text-ink">
        <Prose text={turn.summary ?? ""} />
      </div>
    );
  }

  const totals = turn.files.reduce(
    (acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }),
    { add: 0, del: 0 },
  );
  const nFiles = turn.files.length;
  // Every row's bar is drawn against the biggest file in this card, so the bars can be compared
  // with each other rather than each being scaled to itself.
  const largest = turn.files.reduce((m, f) => Math.max(m, f.additions + f.deletions), 0);
  // Undo only reverts the *latest* applied edit — offering it on an older card would
  // revert something else than what the button says.
  const isLatestApplied = turn.status === "applied" && turn.version === agent?.edit_count;

  return (
    <div className="text-[12px] animate-slide-in">
      {/* A change summary is mostly about named things — "added a LIMIT clause to pg_query" — so
          it is the sentence in the panel that most needs its identifiers marked. No vocabulary to
          pass here: a proposal carries no plan, so shape is all there is to go on. */}
      <div className="text-ink">
        <Prose text={turn.summary ?? ""} />
      </div>

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
          {/* No scale here: the totals bar is the whole change, so it fills. What it carries is
              the mix — is this card mostly new code, or mostly a deletion. */}
          <DiffBar additions={totals.add} deletions={totals.del} />
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

      <div className={`mt-4 ${turn.status !== "pending" ? "opacity-70" : ""}`}>
        {turn.files.map((f) => (
          <FileRow key={f.path} file={f} defaultOpen={turn.status === "pending"} scale={largest} />
        ))}
      </div>

      {turn.status === "pending" && (
        <div className="mt-5 flex items-center gap-2">
          <button className={primaryBtn} onClick={() => turn.proposalId && sendApplyEdit(turn.proposalId)}>
            Apply
          </button>
          <button
            className={quietBtn}
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
        <div className="mt-2 flex items-center gap-2">
          <button
            className={secondaryBtn}
            onClick={() => sendUndoEdit(turn.agentId)}
            title="Put the files back the way they were before this change"
          >
            <UndoIcon size={STAT_ICON} />
            Undo
          </button>
          {/* Only once there is a history to speak of. With a single version there is nothing to
              compare against, and a picker listing one entry is furniture. */}
          {(agent?.edit_count ?? 0) > 1 && turn.version !== undefined && (
            <VersionPicker current={turn.version} count={agent?.edit_count ?? turn.version} />
          )}
        </div>
      )}
    </div>
  );
}
