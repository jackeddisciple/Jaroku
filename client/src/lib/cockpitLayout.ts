// §Craft 3's alignment spine, and §3's region geometry — as values, in one place.
//
// "ONE ALIGNMENT SPINE. The header's 'Cockpit' label, the fleet card's name, and the work row's
// status glyph sit on the same left edge, to the pixel. This is the single habit that separates a
// screen that reads as designed from one that reads as assembled — a two-pixel disagreement
// between two rows a user's eye crosses in the same glance is more damaging than a visibly
// different layout, because it registers as a mistake rather than as a choice."
//
// SO IT IS A VALUE AND NOT THREE PADDINGS THAT HAPPEN TO AGREE. Three components each writing
// `px-5` agree today and drift the first time one of them is edited by somebody who does not know
// the other two exist — which is exactly how this tab arrived at a `px-6` header over a `px-6`
// strip over a `px-4` list, three values that agreed with each other in pairs and with the Inbox
// one click away in none.
//
// IT IS NOT A NEW RUNG. `SPACE.section` is already 20, which is what `px-5` spells and what
// `InboxView`'s header already uses — so what this file adds is a NAME for the rung the spine
// stands on, not a number. §1's rule is absolute on that point: "no new values. Not a colour, not
// a radius, not a spacing step, not a type size."
//
// WHY A LIB MODULE RATHER THAN AN EXPORT FROM `CockpitView`. The strip and the list both need it,
// and both are imported BY the view — so exporting it from there would make the two leaf
// components import their parent, which is a cycle that happens to work under ESM and stops
// working the day somebody adds a value initialised at module scope. It is also what lets
// `test:cockpit-craft` read the spine without rendering anything.

import { SPACE } from "./tokens.ts";

/**
 * The left edge every region of this tab starts its content on, in pixels.
 *
 * TWO OF THE THREE THINGS §Craft 3 NAMES SIT ON IT EXACTLY, and the third cannot — which is worth
 * stating rather than papering over. A fleet card is a bordered box with its own padding, so its
 * NAME is inset by that border and that padding; putting the name itself at 20px would mean a card
 * whose text begins on its own border. What sits on the spine is the card's LEFT EDGE and, with
 * it, the connection glyph that is the first thing inside it — so the card's glyph, the row's
 * glyph and the header's label form one vertical line, and the card's name aligns with the row's
 * input text rather than with the label above it.
 *
 * That is the strongest alignment a bordered card admits, and it is arguably the better reading:
 * the two marks a reader's eye crosses in the same downward glance are the pair that had to agree.
 */
export const SPINE = SPACE.section;

/**
 * The Tailwind class that spells `SPINE`. One string, shared, so the regions cannot drift by a step.
 *
 * A CLASS AS WELL AS A NUMBER because both are genuinely needed: the regions want a class, and the
 * suite wants a value it can compare against `SPACE.section`. `tokens.ts` keeps `SPACE` and
 * `SPACE_CLASS` side by side for exactly this reason and says so.
 */
export const SPINE_X = "px-5";

/**
 * How wide one fleet card is.
 *
 * FIXED, AND THAT IS §4's INSTRUCTION rather than an assumption: "Fixed card width, so long names
 * truncate rather than reflow the strip." A strip whose cards sized themselves to their names would
 * have a different rhythm on every workspace, and a forty-agent strip would scroll by a distance
 * nobody could predict from looking at it.
 *
 * IT IS HERE SO THE SKELETON CAN BE THE SAME WIDTH. §Craft 1: "every skeleton's geometry matches
 * its final content exactly: the same row height, the same column widths, the same card width".
 * A skeleton that guessed would produce the one pixel of jump that whole section is about.
 */
export const CARD_WIDTH = 248;

/**
 * How tall one fleet card is — the sum of §4's three lines, not a number somebody liked.
 *
 * IT IS DERIVED FROM THE ANATOMY and written out so the arithmetic is checkable: the identity line
 * is `TYPE_SCALE.title`'s 22px line height, the sentence is `caption`'s 16, the health strip is
 * `AgentSparkline`'s own 14, two `gap-1.5` gaps are 6 each, and `py-2.5` adds 10 above and below
 * with the card's hairline either side. 22 + 16 + 14 + 12 + 20 + 2 = 86.
 *
 * WHY IT IS DECLARED AT ALL, given that a flex column would compute it: §Craft 1. "Every skeleton's
 * geometry matches its final content EXACTLY: the same row height, the same column widths, the same
 * card width." A skeleton that guessed at the card's height produces the one pixel of jump that
 * whole section says makes a surface read as unfinished — and the only way two files agree on a
 * number is for there to be one number.
 *
 * AND BECAUSE LINE THREE CAN BE EMPTY. An agent that has never run has no bars, and
 * `AgentSparkline` renders nothing rather than twenty grey placeholders claiming runs that never
 * happened — so without a height the card would grow when its first run landed and take the whole
 * strip down with it.
 */
export const CARD_HEIGHT = 86;

/**
 * How tall one work row is.
 *
 * FIXED FOR THE VIRTUALISER'S SAKE — §18 windows this list with `feedWindow.ts`, and a window over
 * variable heights needs a measurement cache, which is the complexity that module exists to avoid.
 * So the row is BUILT to this height rather than measured at it: one line, no wrapping, `Truncate`
 * on the one element that can overflow.
 *
 * FORTY-FOUR, WHICH IS `FEED_ROW_HEIGHT` AND NOT A COINCIDENCE. §6 puts `SPACE.tight` above and
 * below `body`'s line height — 8 + 20 + 8 — plus the hairline that separates one row from the
 * next, which is 37; the feed's own row is 44 for the same shape one line taller. They are declared
 * separately because they are two lists, and `feedWindow` is parameterised rather than copied for
 * exactly that reason; this is the Cockpit's value and it is the one the skeleton and the
 * virtualiser both read.
 */
export const ROW_HEIGHT = 44;
