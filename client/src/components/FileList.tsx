// A file streaming onto disk.
//
// Generation and the fix loop both stream files, and both drew the row by hand: a status dot, a
// path, and a figure that is a byte count once the file lands and a word ("writing…", "rewriting…")
// until it does. Two copies of the same row in two files is how they end up subtly different, so
// this is the one copy.
//
// The trace panel shows file paths too — a tool that read or wrote one — and would read better with
// the same type glyph in the same slot. Not wired there in this pass; iconForPath is the reusable
// half and this row is the panel-specific half.
//
// The leading slot is the file's type rather than its status. Type is what you scan a list of seven
// files for; status is what you glance at, and it now sits beside the figure it qualifies — the dot
// and "writing…" say the same thing, so they belong together rather than at opposite ends of the
// row. Nothing is lost: a finished file still has its check, still in the same colour it had before.

import { iconForPath } from "./fileIcons.tsx";
import { StatusDot } from "./StatusBadge.tsx";
import { STAT_ICON } from "./StatRow.tsx";

export function StreamingFileRow({
  path,
  done,
  figure,
  title,
}: {
  path: string;
  done: boolean;
  /** The right-hand figure: a byte count when it lands, a live word until then. */
  figure: string;
  /** What the status dot means here — written, rewritten, still going. */
  title: string;
}) {
  const TypeIcon = iconForPath(path);
  return (
    <div className="flex items-center gap-2 animate-slide-in">
      <span className="shrink-0 flex items-center text-faint" aria-hidden>
        <TypeIcon size={STAT_ICON} />
      </span>
      <span className="font-mono text-muted truncate">{path}</span>
      <span className="ml-auto shrink-0 flex items-center gap-1.5">
        <StatusDot state={done ? "ok" : "pending"} pulse={!done} title={title} />
        <span className="font-mono text-faint text-[11px] tabular-nums">{figure}</span>
      </span>
    </div>
  );
}
