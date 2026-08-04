// How big a change is, and what kind — as a shape rather than two numbers.
//
// A diff row ends in "+14 −0", which is precise and slow. Reading a five-file card means reading
// ten figures and holding them in your head to work out which file the change actually lives in.
// The figures stay, because eventually you want the exact number; the bar is there so you rarely
// have to.
//
// Two things are encoded, because both are questions people ask of a diff:
//
//   *how much*  — how many segments are filled, relative to the largest file in the same card. One
//                 segment is a footnote, eight is the file the change is really about.
//   *what kind* — how those segments split green to red. All green is new code, all red is a
//                 deletion, half and half is a rewrite.
//
// Scaling against the card's own largest file rather than some absolute line count is what makes it
// readable: a diff is always understood relative to itself. A single-file card fills the bar, which
// is correct — that file *is* the whole change.
//
// Colours are the diff colours already used by the hunks below (STATUS.ok / STATUS.error), and the
// empty track is the same surface as a chip. Nothing new.
//
// The trace panel could use this shape for step durations later — same question, "which of these is
// the big one" — but it is not wired there.

import { STATUS, SURFACE } from "../lib/tokens.ts";

/** Eight is enough to show a proportion and short enough to sit inside a row. */
const SEGMENTS = 8;

export function DiffBar({
  additions,
  deletions,
  scale,
}: {
  additions: number;
  deletions: number;
  /**
   * The largest total in this card, so files can be compared against each other. Omit and the bar
   * fills completely — the honest reading when there is nothing to compare against.
   */
  scale?: number;
}) {
  const total = additions + deletions;
  const ceiling = Math.max(scale ?? total, total, 1);

  // A file that changed at all gets at least one segment: rounding a two-line change in a
  // thousand-line card down to nothing would say it didn't happen.
  const filled = total === 0 ? 0 : Math.max(1, Math.round((total / ceiling) * SEGMENTS));

  // Same rule inside the bar: a change that has any additions shows at least one green segment,
  // and any deletions at least one red, so "mostly one thing" never renders as "entirely" it.
  const added =
    additions === 0
      ? 0
      : deletions === 0
        ? filled
        : Math.min(filled - 1, Math.max(1, Math.round((additions / total) * filled)));

  return (
    <span
      className="inline-flex shrink-0 items-center gap-[2px]"
      title={`${additions} added, ${deletions} removed`}
      aria-hidden
    >
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span
          key={i}
          // Below the radius scale's floor on purpose: a 3px-wide segment given the 4px chip
          // radius clamps to a lozenge, and eight lozenges in a row stop reading as a bar.
          className="h-2 w-[3px] rounded-[1px]"
          style={{
            background: i < added ? STATUS.ok : i < filled ? STATUS.error : SURFACE.active,
          }}
        />
      ))}
    </span>
  );
}
