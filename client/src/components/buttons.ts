// The panel's three button weights, in one place.
//
// The plan card and the diff card ask the same shape of question — here is what would happen, do
// you want it — and they were answering it with two byte-identical copies of the same two class
// strings. Two copies is how "Apply" and "Generate" end up a pixel apart after somebody adjusts one
// of them, which is the sort of difference nobody can name and everybody notices.
//
// Three weights, because the panel has three kinds of control:
//
//   primary    the decision the card exists to ask — Generate, Apply
//   quiet      the other answer, which must be available without being urged — Discard
//   secondary  not a decision at all: a way back, or a thing to look at — Undo, the version picker
//
// Class strings rather than a Button component on purpose. These call sites need their own
// disabled logic, titles, icons and layout, and a component that took all of that as props would be
// a worse way of saying the same thing.
//
// Reusable beyond this panel — the evals bar has its own copies of the same geometry — but that is
// outside this pass and stays where it is.

/**
 * The decision. Filled surface, ink text.
 *
 * `inline-flex items-center gap-1.5` for the same reason `secondaryBtn` has it: several call sites
 * pass an icon *and* a label, and without a flex context the glyph is a block that stacks above the
 * words. That was visible on the GitHub tab, where the primary call to action rendered the mark on
 * one line and "Connect GitHub" on the next.
 */
export const primaryBtn =
  "inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-[12px] bg-panel text-ink hover:bg-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * The other answer. Same box as primary so the two sit level, but no surface until you hover —
 * declining should be one step away, never one step *down*.
 */
export const quietBtn =
  "rounded-control px-3 py-1.5 text-[12px] text-muted hover:text-ink transition-colors";

/**
 * Not a decision. Same surface and radius as primary, one size down and muted until you reach for
 * it. `inline-flex` because everything at this weight carries an icon.
 */
export const secondaryBtn =
  "inline-flex items-center gap-1.5 rounded-control px-2.5 py-1 text-[11px] bg-panel text-muted hover:text-ink hover:bg-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
