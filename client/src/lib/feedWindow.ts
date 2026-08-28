// The event feed's virtualiser, as arithmetic rather than as a component.
//
// §5: "Virtualise the list. A busy workspace will have tens of thousands of events in a 30-day
// window." §6 adds the test: "The feed virtualiser checked at ten thousand rows, not at fifty."
//
// NO DEPENDENCY, FOR THE REASON THE INBOX'S DRAG HAS NONE. A virtualisation library earns its keep
// on variable row heights, horizontal windows, sticky groups and measurement caches — none of which
// this list has. What it actually needs is: given a scroll offset and a viewport height, which slice
// of a fixed-height list is on screen. That is four lines of arithmetic and one spacer, and the hard
// part is not the maths.
//
// THE HARD PART IS THE THREE THINGS THE NAIVE VERSION GETS WRONG, and all three are why this is a
// pure module with a suite rather than an expression inside a `useMemo`:
//
//   OVERSCAN. A window computed exactly to the viewport renders a blank strip at the edge on every
//   scroll frame, because the browser paints before React commits. A few rows either side is the
//   whole fix and it has to be on BOTH sides — overscanning only downwards leaves the blank strip
//   when somebody scrolls back up, which is the half people forget.
//
//   THE BOTTOM CLAMP. `start + count` past the end renders empty rows below the last one, which on a
//   feed that is still loading looks identical to "there is more coming" and stops the reader
//   scrolling for it.
//
//   THE FETCH THRESHOLD IN ROWS, NOT PIXELS. "Within 400px of the bottom" means eight rows on a
//   desktop and two on a phone, so the same feed pre-fetches at different times on different
//   screens. In rows it is the same everywhere.

/**
 * How tall one feed row is, in pixels.
 *
 * FIXED, AND THAT IS A CONSTRAINT ON THE ROW RATHER THAN AN ASSUMPTION ABOUT IT. A virtualiser over
 * variable heights needs a measurement cache, and a measurement cache over ten thousand rows is the
 * complexity this module exists to avoid — so the row is built to this height instead: one line of
 * narrative, one line of context, no wrapping. `Truncate` is what makes that true for a long tool
 * name, which is the same component every other dense row in this app uses.
 */
export const FEED_ROW_HEIGHT = 44;

/** How many rows beyond the viewport to render, each way. See the header. */
export const FEED_OVERSCAN = 6;

/**
 * How close to the end, in ROWS, the next page is asked for.
 *
 * TWELVE, which is about a screen at this row height. Fewer and the reader reaches the bottom before
 * the page arrives, which is a visible stall on a surface whose whole promise is that it scrolls;
 * more and a feed nobody is really reading pulls pages it never shows.
 */
export const FEED_PREFETCH_ROWS = 12;

export interface FeedWindow {
  /** Index of the first row to render. */
  start: number;
  /** Index one past the last row to render. */
  end: number;
  /** The pixel offset the rendered slice is translated to. */
  offsetTop: number;
  /** The full list's height, so the scrollbar is the right size for the whole feed. */
  totalHeight: number;
}

/**
 * Which slice of the feed is on screen.
 *
 * `scrollTop` AND `viewportHeight` ARE BOTH REQUIRED, and a viewport of zero returns an empty
 * window rather than the whole list. A container that has not been measured yet reports zero, and a
 * virtualiser that treated that as "render everything" would render ten thousand rows on the first
 * frame — which is the one frame it exists to protect.
 */
export function feedWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = FEED_ROW_HEIGHT,
  overscan = FEED_OVERSCAN,
): FeedWindow {
  const totalHeight = total * rowHeight;
  if (total === 0 || viewportHeight <= 0) {
    return { start: 0, end: 0, offsetTop: 0, totalHeight };
  }
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(viewportHeight / rowHeight);
  const end = Math.min(total, first + visible + overscan);
  // BOTH SIDES, which is the half people forget — see the header. And CLAMPED AT BOTH ENDS, which
  // is the half the clamp itself was missing: `end` was bounded by `total` and `start` was not, so
  // a scroll offset past the content — which is exactly what a rubber-band overscroll reports on
  // macOS and iOS — produced `start > end`. That is an inverted slice: `slice` returns nothing, so
  // the list goes blank, and `offsetTop` lands past `totalHeight`, so the spacer above it is taller
  // than the scroller. The symptom is a feed that empties itself for a frame when somebody flicks
  // past the end, which reads as the list having been lost rather than as having been over-scrolled.
  const start = Math.min(Math.max(0, first - overscan), end);
  return { start, end, offsetTop: start * rowHeight, totalHeight };
}

/**
 * Whether the next page should be asked for.
 *
 * IN ROWS RATHER THAN PIXELS, so the same feed pre-fetches at the same point on a laptop and a
 * phone. Takes the window it already computed rather than the scroll offset again: the two would be
 * one frame apart otherwise, and a threshold that disagreed with what is rendered would fire while
 * the reader is nowhere near the end.
 */
export function shouldFetchMore(
  window: FeedWindow,
  total: number,
  hasMore: boolean,
  loading: boolean,
  threshold = FEED_PREFETCH_ROWS,
): boolean {
  if (!hasMore || loading || total === 0) return false;
  return window.end >= total - threshold;
}
