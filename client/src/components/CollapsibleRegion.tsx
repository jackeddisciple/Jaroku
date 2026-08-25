// A panel region that can be folded away, with the size of what is inside it on the header.
//
// The plan card has had per-section collapse since v0.1.11 and the GitHub panel's four regions
// reuse it — but "reuse the pattern" left the HEADERS inconsistent, and at scale that is the part
// that matters. `CHANGES 3 files` reads fine; `CHANGES 238 files` post-pull reads as a wall of
// text with no way to judge scope before expanding, which is precisely the moment somebody needs
// to judge scope before expanding.
//
// So one header shape, applied to all four:
//
//   THE COUNT IS THE NUMBER OF ITEMS THE SECTION'S OWN ACTION OPERATES OVER — files for Changes,
//   versions and commits together for History. Right-aligned and tabular, in the same numeric
//   weight the eval comparison table uses for figures, so a column of them is scannable as numbers
//   rather than read as words.
//
//   A SECTION WITH NO NATURAL COUNT OMITS THE SLOT rather than showing a fake `1`. An empty count
//   column reads as "not applicable"; a `1` reads as "one of something", and a `0` reads as
//   "empty" — which are three different claims, and only one of them is true of a verdict line.
//   Same distinction the cost accounting draws between `null` and `$0`.
//
//   THE CHEVRON SITS AT A FIXED RIGHT EDGE whether or not a count is present, so the four headers
//   stay vertically aligned as one column of click targets. Collapse state should not require
//   re-locating the control per row.
//
// THE WHOLE HEADER IS THE TARGET, not the chevron. A 12px glyph is a hard thing to hit, the row is
// already there, and every other disclosure in this app toggles from its label.

import { ICON, TYPE } from "../lib/tokens.ts";
import { ChevronDownIcon } from "./panelIcons.tsx";

export function CollapsibleRegion({
  label,
  /**
   * How many items the section's action operates over, or undefined for a section with no count.
   *
   * `undefined` and `0` MEAN DIFFERENT THINGS and are rendered differently — see the header. A
   * caller that has a count and it happens to be zero should pass the zero.
   */
  count,
  open,
  onToggle,
  /** A control that belongs beside the count — History's Versions/Both switch. */
  trailing,
  children,
}: {
  label: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          title={open ? `Hide ${label}` : `Show ${label}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-control text-left focus-visible:outline-none focus-visible:shadow-focusring"
        >
          {/* THE TOKEN, not a copy of it. This string was a verbatim duplicate of
              `TYPE.sectionLabel` — in the one component whose entire job is to be the reusable
              panel header, which is the last file in the client that should be hardcoding the
              header treatment. */}
          <h3 className={`min-w-0 ${TYPE.sectionLabel}`}>
            {label}
          </h3>
          {/* Right-aligned, tabular, and only when there is a count to show. */}
          {count !== undefined && (
            <span className="ml-auto shrink-0 text-tiny tabular-nums text-faint">
              {count}
            </span>
          )}
          {/* The fixed right edge. `ml-auto` on the chevron as well as on the count so a header
              with no count still pushes it to the same column — which is the whole reason the four
              read as one stack of controls rather than as four rows that happen to be near each
              other. */}
          <span
            className={`shrink-0 text-faint transition-transform duration-fast ${
              count === undefined ? "ml-auto" : ""
            } ${open ? "" : "-rotate-90"}`}
            aria-hidden
          >
            <ChevronDownIcon size={ICON.xs} />
          </span>
        </button>
        {trailing && <span className="shrink-0">{trailing}</span>}
      </div>
      {/* UNMOUNTED WHEN COLLAPSED rather than hidden with a class. History renders a rail of thirty
          rows and Changes can render two hundred and thirty-eight; keeping them mounted behind
          `display: none` would mean a user who collapsed a region to stop looking at it is still
          paying to render it on every snapshot. */}
      {open && <div className="mt-1.5">{children}</div>}
    </section>
  );
}
