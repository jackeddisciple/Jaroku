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
 * The decision. Ink fill, background-coloured text — the one control on a card that is
 * unmistakably the thing being asked.
 *
 * IT USED TO BE `bg-panel text-ink`, which is #18181b on a #0d0d0f page: a four percent lightness
 * step, and therefore the *least* visible control on the card it appeared on. The weight named
 * "primary" was quieter than the muted-text "Discard" beside it, which inverts the whole hierarchy
 * — a card asking "apply this, or not?" was drawing the yes softer than the no. That recipe is
 * still here, correctly named, as `outlineBtn`.
 *
 * Ink rather than an accent because the accent is spent on interaction — selection, links, focus,
 * live iconography — and a filled button is not any of those. Ink fill is the app's loudest
 * treatment and this is the one weight allowed to use it.
 *
 * `inline-flex items-center gap-1.5` for the same reason `secondaryBtn` has it: several call sites
 * pass an icon *and* a label, and without a flex context the glyph is a block that stacks above the
 * words. That was visible on the GitHub tab, where the primary call to action rendered the mark on
 * one line and "Connect GitHub" on the next.
 */
export const primaryBtn =
  "inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-[12px] bg-ink text-bg font-medium hover:bg-ink/90 active:bg-ink/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * A real action that is not *the* action — the second button in a pair, or the primary of a card
 * that is not the screen's centre. Filled one surface step, ink text.
 *
 * This is the recipe `primaryBtn` used to be. It was never a bad button; it was a bad *primary*.
 */
export const outlineBtn =
  "inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-[12px] bg-panel text-ink hover:bg-active active:bg-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * The other answer. Same box as primary so the two sit level, but no surface until you hover —
 * declining should be one step away, never one step *down*.
 *
 * It had no surface at *any* state before this, only a text-colour shift, which meant "Discard"
 * beside "Apply" read as a caption rather than as the other half of a real decision. A ghost
 * button still has to show its hit area on approach; that is what makes it a button rather than
 * a word somebody happened to make clickable.
 */
export const quietBtn =
  "inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-[12px] text-muted hover:bg-active hover:text-ink active:bg-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/**
 * Not a decision. Same surface and radius as primary, one size down and muted until you reach for
 * it. `inline-flex` because everything at this weight carries an icon.
 */
export const secondaryBtn =
  "inline-flex items-center gap-1.5 rounded-control px-2.5 py-1 text-[11px] bg-panel text-muted hover:text-ink hover:bg-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
