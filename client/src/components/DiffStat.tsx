// How much was added, how much was taken away.
//
// Three places in the client summarise a change and all three wrote the figure by hand. The diff
// card's file rows and its totals each had their own `<span className="text-ok">+{n}</span>{" "}
// <span className="text-err">−{n}</span>` — byte-identical, and the space between them was a
// literal `{" "}` in one and a flex gap in the other, so the two sat a pixel apart on the same
// card. The state diff did not show figures at all: it said "+3 items" in the same grey as
// everything else in the row, which is a sentence about a change rather than a measurement of one.
//
// One component. Green for additions, red for deletions, both tabular so a column of them lines
// up, both mono because they are counts rather than prose.
//
// The minus is U+2212, not a hyphen. A hyphen is narrower than a plus at the same size, so a
// column of `+12 -3` visibly staggers; the real minus sign is drawn to match the plus.

import { DiffBar } from "./DiffBar.tsx";

export function DiffStat({
  additions,
  deletions,
  /** What the counts are of. Omit for lines, which is the default reading of a diff. */
  unit,
  /** Pair the figures with the proportion bar. */
  bar = false,
  /** The largest change alongside this one, so several bars share an axis. See DiffBar. */
  scale,
  className = "",
}: {
  additions: number;
  deletions: number;
  unit?: string;
  bar?: boolean;
  scale?: number;
  className?: string;
}) {
  const label = unit
    ? `${additions} ${unit} added, ${deletions} ${unit} removed`
    : `${additions} added, ${deletions} removed`;
  return (
    <span
      className={`inline-flex items-center gap-2 text-tiny tabular-nums ${className}`}
      title={label}
    >
      <span className="inline-flex items-center gap-1.5">
        {/* Both halves always render, including the zero. "+14" alone leaves the reader working
            out whether nothing was deleted or whether the deletion count was omitted. */}
        <span className="text-ok">+{additions}</span>
        <span className="text-err">−{deletions}</span>
        {unit && <span className="text-faint">{unit}</span>}
      </span>
      {bar && <DiffBar additions={additions} deletions={deletions} scale={scale} />}
    </span>
  );
}
