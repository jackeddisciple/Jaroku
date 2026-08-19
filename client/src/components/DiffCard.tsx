// Diff card — the fix loop's trust surface (doc §4.4). Every proposed change renders
// inline in the conversation: files touched, +adds/−removes, expandable hunks, and explicit
// Apply / Discard / Undo.
//
// Three levels, because the content has three. The summary and its figures are Jaroku speaking
// in the conversation and stay on the thread's own surface, unboxed. The file list is the
// artefact being spoken about, and takes a card. Each file's hunks are what that row is about,
// and take a well inside it. Before this they were one flat stack: eight rows and eight loose
// blocks of code with nothing saying where a file ended and the next one began.

import { useEffect, useRef, useState } from "react";
import type { FileDiff } from "../types.ts";
import type { ProposalTurn } from "../store/chatStore.ts";
import { useBuildStore } from "../store/buildStore.ts";
import { sendApplyEdit, sendDiscardEdit, sendUndoEdit } from "../lib/socket.ts";
import { fmtCost } from "../lib/format.ts";
import { primaryBtn, quietBtn, secondaryBtn } from "./buttons.ts";
import { ChevronDownIcon } from "./composerIcons.tsx";
import { DiffStat } from "./DiffStat.tsx";
import { StreamingFileRow } from "./FileList.tsx";
import { iconForPath } from "./fileIcons.tsx";
import { Prose } from "./InlineCode.tsx";
import { Truncate } from "./Truncate.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { STAT_ICON } from "./StatRow.tsx";
import { ICON, TYPE } from "../lib/tokens.ts";
import { CheckIcon, FileIcon, PlusIcon, UndoIcon } from "./panelIcons.tsx";

function HunkLines({ file }: { file: FileDiff }) {
  return (
    // Diff bodies are the most literally-code thing in the pane — mono, always.
    // A well inside the file row: one step darker than the list it sits in, with its own
    // hairline. Hunks are the thing the row is about rather than more of the row, and unbounded
    // they ran straight into the next file's header.
    <div className="mt-1.5 overflow-x-auto rounded-control border border-hair bg-bg/60 py-1.5 font-mono">
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
    // One container per file: the row and its hunks belong together, and a flat stack of eight
    // rows with eight loose hunk blocks under them gave no answer to "where does this file end".
    <div className="border-t border-hair px-2.5 py-2 first:border-t-0">
      <div className="flex items-center gap-2 text-[12px]">
        {/* One mark that turns, not two glyphs — the same disclosure the plan card's sections
            use, so opening a file and opening a section are visibly the same gesture. */}
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={open ? "Hide this file's changes" : "Show this file's changes"}
          className={`shrink-0 text-faint transition-transform duration-fast hover:text-ink ${
            open ? "" : "-rotate-90"
          }`}
        >
          <ChevronDownIcon size={ICON.xs} />
        </button>
        {/* Between the disclosure and the path, so the type is the first thing on the row that is
            about the file itself. Faint: it classifies the row, it doesn't compete with the name. */}
        <span className="shrink-0 flex items-center text-faint" aria-hidden>
          <TypeIcon size={STAT_ICON} />
        </span>
        <button
          onClick={() => openInCode(file.path)}
          className="min-w-0 font-mono text-ink hover:underline underline-offset-2"
          title="Open in Code tab"
        >
          <Truncate>{file.path}</Truncate>
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
        <DiffStat
          additions={file.additions}
          deletions={file.deletions}
          bar
          scale={scale}
          className="ml-auto shrink-0"
        />
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
        <div className="absolute bottom-full left-0 z-30 mb-1 min-w-[150px] animate-slide-in rounded-card border border-edge bg-panel p-1 shadow-floating motion-reduce:animate-none">
          <div className={`px-3 pb-1 pt-1.5 ${TYPE.sectionLabel}`}>
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
  /**
   * This card's Apply or Discard has been sent and not yet answered.
   *
   * LOCAL, AND ONLY UNTIL THE SERVER SPEAKS. `turn.status` is the shared truth and it stays
   * "pending" until the `applied` / `discarded` event lands, which on a hosted object store is
   * several round trips away — so with no in-flight state of its own the card offered a live Apply
   * button for the whole of that window. Keyed by proposal id so a card that is re-rendered for a
   * different proposal starts clean.
   */
  const [answeredId, setAnsweredId] = useState<string | null>(null);
  const answered = answeredId !== null && answeredId === turn.proposalId;
  const setAnswered = (): void => setAnsweredId(turn.proposalId);

  // Streaming: the model is rewriting files right now.
  if (turn.status === "streaming") {
    return (
      <div className="text-[12px]">
        <div className="text-run">Proposing changes…</div>
        <div className="mt-2 space-y-0.5">
          {turn.streaming.map((f) => (
            // The fix loop rewrites files that already exist, so the verb says so — "Rewriting
            // pg_query.py" is a different claim from "Writing" it, and the difference is exactly
            // what a reviewer of a proposal needs to know.
            <StreamingFileRow
              key={f.path}
              rewrite
              path={f.path}
              state={f.done ? "done" : "active"}
              bytes={f.bytes}
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
    <div className="animate-slide-in text-[12px] motion-reduce:animate-none">
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
        {/* No scale here: the totals bar is the whole change, so it fills. What it carries is
            the mix — is this card mostly new code, or mostly a deletion. */}
        <DiffStat additions={totals.add} deletions={totals.del} bar />
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

      {/* The change itself, bounded. The card above the fold — the summary and the figures —
          is Jaroku speaking in the conversation; this is the artefact it is speaking about, and
          the two were running into each other with nothing but a margin between them. */}
      <div
        className={`mt-3 overflow-hidden rounded-card border border-edge bg-panel/30 ${
          turn.status !== "pending" ? "opacity-70" : ""
        }`}
      >
        {turn.files.map((f) => (
          <FileRow key={f.path} file={f} defaultOpen={turn.status === "pending"} scale={largest} />
        ))}
      </div>

      {turn.status === "pending" && (
        <div className="mt-5 flex items-center gap-2">
          {/* DISABLED ON THE FIRST CLICK, because `turn.status` only leaves "pending" when the
              server's `applied` event arrives — and on a hosted object store an apply is several
              network round trips, so the window is comfortably human-sized. The correctness fix is
              the editor's, which claims the proposal before its first await; this is what stops the
              user watching two requests go out and wondering which one counted. */}
          <button
            className={primaryBtn}
            disabled={answered}
            onClick={() => {
              if (answered || !turn.proposalId) return;
              setAnswered();
              sendApplyEdit(turn.proposalId);
            }}
          >
            Apply
          </button>
          <button
            className={quietBtn}
            disabled={answered}
            onClick={() => {
              if (answered || !turn.proposalId) return;
              setAnswered();
              sendDiscardEdit(turn.proposalId);
            }}
          >
            Discard
          </button>
          {turn.usage && (
            <span className="ml-auto text-faint text-[11px] tabular-nums">
              {fmtCost(turn.usage.cost_usd)}
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
