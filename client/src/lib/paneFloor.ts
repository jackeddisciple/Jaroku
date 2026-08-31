// A PIXEL FLOOR FOR A COLUMN WHOSE CONTENTS ARE FIXED-WIDTH, expressed in the only unit
// `react-resizable-panels` accepts.
//
// App.tsx already diagnosed this, in its own comment, and then fixed the symptom:
//
//   "the pane minimums are PERCENTAGES — at a 1000px window the sidebar's `minSize={14}` is 140px,
//    narrower than its own rows plus their padding, which is why its filter row used to clip. The
//    clipping was the symptom; a percentage floor on a fixed-content column is the cause."
//
// The remedy applied then was a `min-w-[900px]` on the shell and `minSize` 14 → 16. Both moved the
// threshold. Neither removed the cause, so at 1024×768 — a resolution above the shell's floor, and
// one the audit spec treats as supported — the same failure reappeared one rung down: every agent
// row lost its name entirely, seven of eight agents rendered as `× ✳ Aug 18` and were
// indistinguishable from each other, run rows were cut mid-word, the account row's `Adarsh` clipped
// to a single `A`, and a HORIZONTAL scrollbar appeared inside a vertical list.
//
// A PERCENTAGE FLOOR CANNOT EXPRESS WHAT THE COLUMN NEEDS. A sidebar row is a status dot, a
// provider mark, a name, a badge and a timestamp; every one of those but the name is a fixed number
// of pixels, so what the column requires is a number of pixels and not a share of the window. 16%
// is 307px at 1920 and 164px at 1024 — the same rule expressing two different requirements, and the
// narrow one is the one nobody is looking at while they write it.
//
// SO THE FLOOR IS STATED IN PIXELS AND CONVERTED AT MEASURE TIME. The library still receives a
// percentage, because that is its unit; what changed is that the percentage is now derived from the
// width the group actually has rather than chosen once for the window somebody happened to be
// using. On a wide screen the conversion lands below `defaultSize` and nothing moves at all, which
// is why this is a floor rather than a resize.
//
//   npm run test:pane-floor

/**
 * The sidebar's real requirement, in pixels.
 *
 * MEASURED FROM THE FAILURE RATHER THAN CHOSEN. At 1024×768 the sidebar's scroll container reported
 * a 181px scroll width inside a 149px client width — 32px of content it could not show — with the
 * pane itself at about 200px. That puts the column's true minimum at roughly 232px, and this is
 * that with a row's worth of headroom, so a name arrives with characters in it rather than with an
 * ellipsis and nothing else.
 */
export const SIDEBAR_MIN_PX = 248;

/**
 * The percentage the app shipped with, kept as the pre-measurement fallback.
 *
 * So an unmeasured group — the first render, a container the observer has not reported yet —
 * behaves exactly as it did before the floor existed, rather than collapsing or pinning for a frame.
 */
export const SIDEBAR_DEFAULT_MIN_PCT = 16;

/** Unchanged, and named here because the floor has to be clamped under it. */
export const SIDEBAR_MAX_PCT = 34;

/**
 * The composer column's real requirement, in pixels — and it is the same failure one column over.
 *
 * THE CONTROL BAR IS FIXED-WIDTH CONTENT and its own rules say so: `lib/composerBar.ts` states that
 * the bar never wraps and that "⊕, mic and send never collapse and never move into overflow". Both
 * clauses are about a row of controls whose widths are pixels — a 32px hit target each, an 8px gap
 * between them, a Chat/Test track — so what the column needs is a number of pixels, and `minSize={30}`
 * is 354px at 1440 and 192px at 900.
 *
 * MEASURED FROM THE FAILURE. Dragged to its percentage floor at 1440, the composer column was 316px
 * and the bar overflowed by about 100 of them: the mic and the send button — the two controls the
 * bar promises never to collapse — were outside the composer's own rounded box and could not be
 * clicked at all. The whole row is visible again at 436px, which is this with a little headroom, and
 * the model chip's label is the part that gives way first because it is the only one that can.
 */
export const COMPOSER_MIN_PX = 440;

/** The percentage the app shipped with, kept as the pre-measurement fallback — see the sidebar's. */
export const COMPOSER_DEFAULT_MIN_PCT = 30;

/**
 * The ceiling this floor is clamped under, and it is the RIGHT pane's own minimum subtracted from
 * the whole.
 *
 * `react-resizable-panels` is handed two minimums for one group; if they sum past 100 the group has
 * no valid layout at all and the library resolves that by ignoring one of them. At a 900px window —
 * the shell's own `min-w`, below which it scrolls instead — 440px is 68% of what is left after the
 * sidebar, and the right pane asks for 32. The two meet exactly, which is why the clamp is this
 * number rather than a round one.
 */
export const COMPOSER_MAX_MIN_PCT = 68;

/**
 * A pixel floor as a percentage of the group it sits in.
 *
 * `fallback` is returned whenever there is nothing to measure — the first render, a hidden pane, a
 * container the observer has not reported yet. That matters more than it looks: returning 0 there
 * would let the pane collapse for exactly one frame on every mount, and returning 100 would pin it
 * open. The fallback is the percentage the app shipped with, so an unmeasured group behaves exactly
 * as it did before this existed.
 *
 * CLAMPED TO `maxPercent`, because the library requires `minSize <= maxSize` and a window narrow
 * enough to invert them is a window the shell's own `min-w` has already decided to scroll instead.
 */
export function pixelFloorPercent(
  px: number,
  containerPx: number,
  maxPercent: number,
  fallback: number,
): number {
  if (!Number.isFinite(containerPx) || containerPx <= 0) return fallback;
  const pct = (px / containerPx) * 100;
  if (!Number.isFinite(pct)) return fallback;
  return Math.min(maxPercent, Math.max(0, pct));
}
