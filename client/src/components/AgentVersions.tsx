// §6's version history — a complete timeline, for free, because `agent_versions` already stores one.
//
// WHAT MAKES IT FREE. Migration 014 put the instruction, the summary, the per-file diff stat and the
// undone flag onto the version row, precisely so the history would stop being a directory somebody's
// laptop happened to hold. Every field this list renders is already on the row the detail read; the
// list is a render, not a query.
//
// DIFFING ANY TWO VERSIONS, WITHOUT A DIFF ENGINE. §6 asks for it, and what a version row carries is
// `file_stats` — what CHANGED in that version — so the honest answer to "what is between v3 and v7"
// is the union of the stats of v4 through v7. That is a real, exact answer to "which files moved and
// by how much between these two points", and it is NOT a line-by-line diff: producing one would mean
// fetching two versions out of the object store and running a differ in the browser, for a question
// the code viewer already answers per file. So the comparison names the files and the figures, and
// the file browser below is where somebody reads the text.
//
// RESTORE PUBLISHES FORWARD. The button says so, because the distinction is the whole safety
// property: nothing here moves `current_version` backwards, so no pointer ever lands on objects a
// retention sweep is entitled to consider superseded, and the history the request was made from is
// still the history afterwards.

import { useState } from "react";
import { Chip } from "./Chip.tsx";
import { DiffStat } from "./DiffStat.tsx";
import { Truncate } from "./Truncate.tsx";
import { CollapsibleRegion } from "./CollapsibleRegion.tsx";
import { sendLoadAgentVersion, sendRestoreAgentVersion } from "../lib/socket.ts";
import { fmtBytes } from "../lib/agentFormat.ts";
import { relTime } from "../lib/format.ts";
import { ACCENT, ICON, STATUS, TEXT } from "../lib/tokens.ts";
import { ArchiveRestoreIcon } from "./agentIcons.tsx";
import { UndoIcon } from "./panelIcons.tsx";
import type { AgentDetailView, AgentVersionView } from "../types.ts";

/** What made a version, as one word and one colour. Borrowed, never invented. */
const SOURCE_COLOR: Record<AgentVersionView["source"], string> = {
  generation: ACCENT.bespoke,
  edit: ACCENT.state,
  // The reviewed teal already means audited-and-copied-in everywhere else, and a deploy artifact is
  // exactly that: host-owned code written into the project rather than by a model.
  deploy: ACCENT.reviewed,
  // Grey. `import` is the one source the validator never saw — see agentHealth — and calling that
  // out in a colour would be claiming it is a problem rather than an absence of evidence.
  import: TEXT.faint,
};

/** The two ends of a comparison, or fewer. */
type Selection = { from: number | null; to: number | null };

/**
 * The union of what changed between two versions, exclusive of the lower one.
 *
 * EXCLUSIVE OF `from` AND INCLUSIVE OF `to`, which is what "between v3 and v7" means to somebody
 * asking: v3's own changes are what got it TO v3 and are not between the two. Summed per path rather
 * than concatenated, because a file touched in three of the four versions is one row with the total.
 */
function changesBetween(versions: readonly AgentVersionView[], from: number, to: number) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const byPath = new Map<string, { additions: number; deletions: number; touched: number }>();
  for (const v of versions) {
    if (v.version <= lo || v.version > hi) continue;
    for (const stat of v.file_stats) {
      const at = byPath.get(stat.path) ?? { additions: 0, deletions: 0, touched: 0 };
      at.additions += stat.additions;
      at.deletions += stat.deletions;
      at.touched += 1;
      byPath.set(stat.path, at);
    }
  }
  return [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function VersionRow({
  version,
  selection,
  onPick,
  onRestore,
  onOpenFiles,
}: {
  version: AgentVersionView;
  selection: Selection;
  onPick: () => void;
  onRestore: () => void;
  onOpenFiles: () => void;
}) {
  const picked = selection.from === version.version || selection.to === version.version;
  const additions = version.file_stats.reduce((n, s) => n + s.additions, 0);
  const deletions = version.file_stats.reduce((n, s) => n + s.deletions, 0);

  return (
    <div
      className={`group flex min-w-0 flex-col gap-1 rounded-control border px-2.5 py-2 transition-colors duration-fast ${
        picked ? "border-edge bg-active/50" : "border-transparent hover:border-hair hover:bg-active/30"
      } ${version.undone_at ? "opacity-60" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onPick}
          title={picked ? "Remove from the comparison" : "Compare from here"}
          aria-pressed={picked}
          className="shrink-0 font-mono text-[11px] tabular-nums text-muted transition-colors hover:text-ink"
        >
          v{version.version}
        </button>
        {version.current && (
          <Chip size="sm" caps color={STATUS.ok} className="shrink-0" title="The version currently live">
            live
          </Chip>
        )}
        <Chip size="sm" caps color={SOURCE_COLOR[version.source]} className="shrink-0" title="What made this version">
          {version.source}
        </Chip>
        {/* AN UNDONE VERSION IS SHOWN RATHER THAN HIDDEN. Migration 014 marks rather than deletes
            precisely so an undo stays evidence — the row is dimmed and says so, and it is still a
            version somebody can restore, because its objects were never touched. */}
        {version.undone_at && (
          <Chip size="sm" caps tone="faint" className="shrink-0" title={`Undone ${relTime(version.undone_at)}`}>
            undone
          </Chip>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-faint" title={version.created_at}>
          {relTime(version.created_at)}
        </span>
      </div>

      {/* The summary is what the model said it did; the instruction is what was asked for. Both are
          on the row already (014), and an edit is the only source that has an instruction. */}
      {version.summary && (
        <Truncate className="text-[12px] text-ink" title={version.summary}>
          {version.summary}
        </Truncate>
      )}
      {version.instruction && (
        <Truncate className="text-[11px] text-muted" title={version.instruction}>
          “{version.instruction}”
        </Truncate>
      )}

      <div className="flex min-w-0 items-center gap-2">
        {version.file_stats.length > 0 ? (
          <DiffStat additions={additions} deletions={deletions} bar />
        ) : (
          // AN EMPTY STAT IS A TRUTHFUL CLAIM, not a gap: migration 014's default is an empty array
          // and its header says why — nobody recorded a diff for a version published as-is.
          <span className="text-[11px] text-faint">no diff recorded</span>
        )}
        <span className="text-[10px] text-faint">{fmtBytes(version.total_bytes)}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-fast group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={onOpenFiles}
            title={`Browse the files of v${version.version}`}
            aria-label={`Browse the files of v${version.version}`}
            className="rounded-control px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink"
          >
            Files
          </button>
          {!version.current && (
            <button
              type="button"
              onClick={onRestore}
              // The tooltip says what actually happens, because the button says "Restore" and the
              // mechanism is the safety property.
              title={`Publish a new version pointing at v${version.version}'s files — nothing is rewritten`}
              aria-label={`Restore v${version.version}`}
              className="rounded-control p-1 text-muted transition-colors hover:bg-active active:bg-chrome hover:text-ink"
            >
              <ArchiveRestoreIcon size={ICON.xs} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function AgentVersions({ detail }: { detail: AgentDetailView }) {
  const [open, setOpen] = useState(true);
  const [selection, setSelection] = useState<Selection>({ from: null, to: null });

  const pick = (version: number): void => {
    setSelection((s) => {
      if (s.from === version) return { from: s.to, to: null };
      if (s.to === version) return { from: s.from, to: null };
      if (s.from === null) return { from: version, to: null };
      // The second pick completes a pair; a third starts a new one from it, so somebody comparing
      // repeatedly is never made to clear the previous comparison first.
      if (s.to === null) return { from: s.from, to: version };
      return { from: version, to: null };
    });
  };

  const both = selection.from !== null && selection.to !== null;
  const changes = both ? changesBetween(detail.versions, selection.from!, selection.to!) : [];

  return (
    <div className="border-b border-hair px-4 py-3">
    <CollapsibleRegion
      label="Version history"
      count={detail.versions.length}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {detail.versions.length === 0 ? (
        <div className="px-2.5 py-2 text-[11px] text-faint">
          Nothing has been published for this agent yet.
        </div>
      ) : (
        <div className="space-y-0.5">
          {both && (
            <div className="mb-1.5 rounded-control border border-edge bg-panel p-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-ink">
                  v{Math.min(selection.from!, selection.to!)} → v{Math.max(selection.from!, selection.to!)}
                </span>
                {/* TWO WORDS OF CHROME AT THE END OF A ROW THAT ALREADY CARRIES THREE FACTS — a
                    version number, a source and a timestamp — which is what pushed it to wrap. */}
                <button
                  onClick={() => setSelection({ from: null, to: null })}
                  title="Clear the comparison"
                  aria-label="Clear the comparison"
                  className="ml-auto rounded-control p-1 text-faint transition-colors hover:bg-active active:bg-chrome hover:text-ink"
                >
                  <UndoIcon size={ICON.xs} />
                </button>
              </div>
              {changes.length === 0 ? (
                <div className="mt-1.5 text-[11px] text-faint">
                  No file changes were recorded between these two.
                </div>
              ) : (
                <div className="mt-1.5 space-y-1">
                  {changes.map(([path, stat]) => (
                    <div key={path} className="flex min-w-0 items-center gap-2">
                      <Truncate variant="path" className="min-w-0 flex-1 font-mono text-[11px] text-muted">
                        {path}
                      </Truncate>
                      <DiffStat additions={stat.additions} deletions={stat.deletions} />
                      {stat.touched > 1 && (
                        <span className="shrink-0 text-[10px] text-faint" title="Versions that touched this file">
                          ×{stat.touched}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {detail.versions.map((v) => (
            <VersionRow
              key={v.version}
              version={v}
              selection={selection}
              onPick={() => pick(v.version)}
              onRestore={() => {
                if (
                  window.confirm(
                    `Restore v${v.version}?\n\nA new version is published pointing at its files. ` +
                      `Nothing is rewritten and nothing is lost.`,
                  )
                ) {
                  sendRestoreAgentVersion(detail.card.slug, v.version);
                }
              }}
              onOpenFiles={() => sendLoadAgentVersion(detail.card.slug, v.version)}
            />
          ))}
        </div>
      )}
    </CollapsibleRegion>
    </div>
  );
}

