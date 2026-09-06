// State on the border, not the fill — and one ladder for when a card is several things at once.
//
// A CARD IS OFTEN MORE THAN ONE THING. It can be selected AND running, failed AND archived, running
// AND the one the keyboard is on. Every surface that has ever tried to draw all of that at once has
// invented its own order, and the orders disagree: the Agents grid decided selection wins, the
// Cockpit decided failure does, and a person moving between them learns that a strong edge means
// two different things two tabs apart. One ladder, applied everywhere, highest wins.
//
// ── THE LADDER (§9) ─────────────────────────────────────────────────────────────────────────────
//
//   1. Archived / lifecycle   an archived card is quiet regardless of what it used to be doing
//   2. Selected               the user's own focus outranks the card's state — they are looking at it
//   3. Failed                 rose
//   4. Running                amber
//   5. Everything else        the default elevation border
//
// THE GLYPH IS EXEMPT FROM THIS LADDER and always shows the true phase. That is the specific reason
// state was put on the border and phase on the glyph rather than both on one mark: a selected,
// running card has a strong border and an amber glyph — the border says "you are here", the glyph
// says "it is running", and neither has to lie. Collapse them into one mark and one of the two facts
// has to be dropped every time they disagree, which on a live list is most of the time.
//
// ── THE TWO CONSTRUCTION RULES ──────────────────────────────────────────────────────────────────
//
// A STATE BORDER CHANGES COLOUR, NEVER WIDTH. Elevation in this app is already a border plus a
// shadow; a state border RECOLOURS that border at the same width. Changing width on a state change
// reflows the card's contents by a pixel — and on a list that updates live, that is a visible twitch
// on every single run start, forty times a minute on a busy workspace.
//
// NO BACKGROUND FILLS. This app draws structure in hairlines and nests card / section / well. A
// tinted card background would flatten that, and it would be the first fill in the product — after
// which "amber card" and "amber edge" are two treatments of one state and somebody has to decide
// which surfaces get which.
//
// AND COLOUR IS NEVER THE ONLY SIGNAL. Every site that takes a border from this module also carries
// the Pattern 1 glyph or a tag that says the same thing in words. A card whose only "this failed"
// signal is a rose edge is unreadable to about one man in twelve and invisible in a greyscale
// screenshot — which is `test:state-border`'s job to keep true.
//
//   npm run test:state-border

import { STATUS, SURFACE } from "./tokens.ts";

/**
 * What a card can be, all at once. Every field is a fact about the card, not a rung.
 *
 * FLAGS RATHER THAN A RESOLVED STATE, deliberately: a call site that had to pick a rung itself is a
 * call site that has copied the ladder, and the whole point of this module is that the ladder is in
 * one place. Passing everything true is legal and answers `quiet`.
 */
export interface CardState {
  /** Archived, retired, superseded — anything whose lifecycle has ended. Rung 1. */
  archived?: boolean;
  /** The card the user is on. Rung 2. */
  selected?: boolean;
  /** Finished and did not succeed. Rung 3. Not `halted` — stopping deliberately is not a failure. */
  failed?: boolean;
  /** Work is happening right now. Rung 4, and the only amber. */
  running?: boolean;
}

/** The rungs, named, so a suite can assert the ORDER rather than five colours. */
export type BorderRung = "archived" | "selected" | "failed" | "running" | "default";

/**
 * Which rung a card lands on. Exported separately from the colour so the ladder can be tested as an
 * ordering rather than as a palette — a suite that only compared hexes would pass with two rungs
 * swapped if they happened to share a colour.
 */
export function stateRung(state: CardState): BorderRung {
  if (state.archived) return "archived";
  if (state.selected) return "selected";
  if (state.failed) return "failed";
  if (state.running) return "running";
  return "default";
}

/**
 * The five colours, at one width.
 *
 * `archived` IS QUIETER THAN THE DEFAULT, not equal to it. §9's rung 1 says an archived card is
 * quiet regardless of what it used to be doing, and "the same as every other card" is not quiet —
 * it is unremarkable, which is a different claim. `hair` is the quietest boundary this palette has.
 */
const RUNG_COLOUR: Record<BorderRung, string> = {
  archived: SURFACE.hair,
  selected: SURFACE.grip,
  failed: STATUS.error,
  running: STATUS.pending,
  default: SURFACE.edge,
};

/**
 * A card's border colour, for the elevation it already has.
 *
 * RETURNS A COLOUR AND NOTHING ELSE — no width, no shadow, no fill. It is composed onto whatever
 * `ELEVATION` the card is already at, which is what keeps I7 true by construction: there is nothing
 * here that could change a width even if somebody wanted to.
 */
export function stateBorder(state: CardState): string {
  return RUNG_COLOUR[stateRung(state)];
}

/**
 * The same ladder for a ROW rather than a card — a 2px left edge, never a full border.
 *
 * ROWS ARE NOT CARDS, and the difference is not stylistic. A thread row and a deploy stage row have
 * no border of their own to recolour; they are separated by a shared hairline that belongs to the
 * list. Drawing a full border around one row of a list would make that row a card, which is a
 * heavier claim than "this one is running" — so the state goes on the leading edge, which is the
 * treatment the Inbox already shipped for blocking items.
 *
 * `null` MEANS DRAW NOTHING, which is the honest answer for a row that is merely present: a
 * transparent 2px edge on every row is a 2px indent on every row, and the rule this app draws
 * structure by is that nothing is spent on saying "ordinary".
 */
export function rowEdge(state: CardState): string | null {
  const rung = stateRung(state);
  return rung === "default" || rung === "archived" ? null : RUNG_COLOUR[rung];
}
