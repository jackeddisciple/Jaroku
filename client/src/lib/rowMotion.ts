// Rows that move rather than jump.
//
// WHAT THIS IS FOR. Pinning a chat lifts it out of a list and onto the shelf above; unpinning drops
// it back; archiving takes it out of the column altogether. Each is one store write, and React
// commits the result in a single frame — so on the next paint every row under the change is
// somewhere else, having travelled no distance. The column reads as a page that reloaded rather than
// as a list that rearranged, which is the same objection `Collapse` exists for one level up: a
// disclosure that mounts is not a fast animation, it is no animation.
//
// FLIP, AND MEASURED AT THE PRESS RATHER THAN AT THE RENDER. Row positions are read in the handler,
// BEFORE the store is written; the write is flushed synchronously, so the DOM is already in its new
// shape when this function resumes; then every row that ended up somewhere else is asked to travel
// from where it was — First, Last, Invert, Play, with the inverse of the move animated back to
// nothing.
//
// WHY NOT A LAYOUT EFFECT, which is the usual shape of this. A render-driven version has to hold the
// previous positions BETWEEN renders, and this column has two scrollers: scrolling moves every row
// without re-rendering anything, so the positions it holds go stale the moment somebody scrolls the
// list, and the next pin then animates rows in from somewhere off screen. Measuring inside the press
// cannot go stale, because nothing happens between the two measurements except the write itself.
//
// IT ANIMATES TRANSFORMS AND NOTHING ELSE, through the Web Animations API rather than through React
// state or inline styles. A transform is composited — no layout, no repaint of the rows' contents —
// and an animation that lives outside the tree React is diffing cannot be clobbered by the re-render
// that caused it. A second press mid-flight replaces the first animation rather than fighting it.
//
// WHAT IT DOES NOT DO IS ANIMATE A ROW OUT. An archived chat is gone from the tree by the time this
// resumes, and keeping it mounted to fade it would mean a list holding rows its store says are not
// there — a second source of truth about what is in the column, for a fifth of a second of polish.
// What the eye actually follows is the gap closing, and that is the rows BELOW it, which do animate.

import { flushSync } from "react-dom";

/**
 * The attribute that marks the region whose rows move — the sidebar column.
 *
 * ONE SCOPE RATHER THAN A REF PASSED DOWN SEVEN COMPONENTS. The rows that rearrange are spread
 * across four components and three lists, and the thing they have in common is the column they are
 * in; a data attribute on that column is a name for it that any handler can find, including the two
 * in the chat header, which are nowhere near it in the tree and reorder the same lists.
 */
export const MOTION_SCOPE = "data-row-motion";

/** The attribute a row carries, holding a key that identifies it across a rearrangement. */
export const MOTION_ROW = "data-row";

/**
 * How long a row takes to travel, and on what curve.
 *
 * THE COLUMN'S OWN NUMBERS, not new ones: 220ms is `duration-collapse` in tailwind.config.js and the
 * curve is `ease-smooth`, which that file documents as "the curve for anything that OPENS". A fold
 * and the rows under it are the same movement seen from two sides, so a second speed here would be
 * two things moving at once at different rates.
 */
const MS = 220;
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

/** Under a pixel is a rounding difference rather than a movement, and not worth a compositor layer. */
const FLOOR = 1;

/** Whether this person has asked for less movement. Read at the press, never cached. */
function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function rows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[${MOTION_ROW}]`)];
}

/**
 * Run a store write, and let the rows it moves travel to their new places.
 *
 * Safe everywhere: with no column on screen, with reduced motion asked for, or in a renderer with no
 * `animate` at all, this is the write and nothing else — which is the behaviour that was there before
 * any of this existed.
 */
export function withRowMotion(write: () => void): void {
  const root = document.querySelector<HTMLElement>(`[${MOTION_SCOPE}]`);
  if (!root || reducedMotion()) {
    write();
    return;
  }

  const before = new Map<string, number>();
  for (const row of rows(root)) {
    const key = row.getAttribute(MOTION_ROW);
    if (key) before.set(key, row.getBoundingClientRect().top);
  }

  // SYNCHRONOUS ON PURPOSE. React would otherwise commit this write after the handler returns, and
  // the measurement below would then read the OLD layout and animate every row by zero. This is the
  // one thing `flushSync` is for, and it is called from an event handler, which is where it is legal.
  flushSync(write);

  for (const row of rows(root)) {
    const key = row.getAttribute(MOTION_ROW);
    if (!key) continue;
    const was = before.get(key);
    const now = row.getBoundingClientRect().top;

    // A ROW THAT WAS NOT THERE A MOMENT AGO — the shelf and its heading on a first pin, a chat
    // coming back from the shelf. It has no previous place to travel from, so it arrives instead:
    // the same short rise `slide-in` gives a trace step landing in a list.
    if (was === undefined) {
      row.animate(
        [{ opacity: "0", transform: "translateY(-4px)" }, { opacity: "1", transform: "none" }],
        { duration: MS, easing: EASE },
      );
      continue;
    }

    const dy = was - now;
    if (Math.abs(dy) < FLOOR) continue;
    row.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
      { duration: MS, easing: EASE },
    );
  }
}
