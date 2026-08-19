// The feed virtualiser, at ten thousand rows rather than at fifty.
//
// §6 asks for exactly that, and the reason it says the number is that fifty rows pass every version
// of this code including the one that renders all of them. What ten thousand rows catch is the
// window that is not a window.
//
// AND THE THREE THINGS THE NAIVE VERSION GETS WRONG, each of which looks fine in a screenshot taken
// while nothing is moving:
//
//   Overscan on ONE side only. Scrolling down is smooth and scrolling up flickers, which is the half
//   that gets shipped because that is the direction people test in.
//
//   No clamp at the end. Empty rows below the last one, which on a feed that is still loading is
//   indistinguishable from "more is coming" and stops the reader scrolling for it.
//
//   A pixel threshold for the next page, which is eight rows on a desktop and two on a phone.
//
//   npm run test:feed-window

import {
  FEED_OVERSCAN,
  FEED_PREFETCH_ROWS,
  FEED_ROW_HEIGHT,
  feedWindow,
  shouldFetchMore,
} from "./feedWindow.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const VIEWPORT = 480;
const ROWS = 10_000;

console.log("\nten thousand rows render a window, not ten thousand rows");
{
  const top = feedWindow(ROWS, 0, VIEWPORT);
  const rendered = top.end - top.start;
  check(`at the top it renders ${rendered} rows`, rendered < 40, `${rendered}`);
  check("...which is the viewport plus overscan", rendered <= Math.ceil(VIEWPORT / FEED_ROW_HEIGHT) + FEED_OVERSCAN * 2 + 1);
  // The scrollbar has to be the size of the whole feed, or the reader cannot get to the end of it.
  check("the spacer is the full list's height", top.totalHeight === ROWS * FEED_ROW_HEIGHT);
  check("and the slice starts at the top", top.start === 0 && top.offsetTop === 0);

  const middle = feedWindow(ROWS, 5_000 * FEED_ROW_HEIGHT, VIEWPORT);
  // The FULL window: the viewport plus overscan on both sides. The one at the top is smaller
  // because its upper overscan is clamped away by the start of the list, which is correct and is
  // why the two counts are asserted apart rather than as equal.
  check(
    "in the middle it renders the viewport plus overscan both ways",
    middle.end - middle.start === Math.ceil(VIEWPORT / FEED_ROW_HEIGHT) + FEED_OVERSCAN * 2,
    `${middle.end - middle.start}`,
  );
  check("...which is more than at the top, where the upper overscan is clamped", middle.end - middle.start > rendered);
  check("...offset to where it actually is", middle.offsetTop === middle.start * FEED_ROW_HEIGHT);
  check("...and containing the row under the scroll position", middle.start <= 5_000 && middle.end > 5_000);
}

console.log("\noverscan is on both sides, or scrolling up flickers");
{
  const w = feedWindow(ROWS, 100 * FEED_ROW_HEIGHT, VIEWPORT);
  check("there are rows rendered above the viewport", w.start < 100, `${w.start} vs 100`);
  check(`...exactly the overscan (${FEED_OVERSCAN})`, w.start === 100 - FEED_OVERSCAN);
  const visible = Math.ceil(VIEWPORT / FEED_ROW_HEIGHT);
  check("and rows rendered below it", w.end > 100 + visible, `${w.end}`);
}

console.log("\nthe end is clamped, so no empty rows are drawn past the last one");
{
  const bottom = feedWindow(ROWS, (ROWS - 4) * FEED_ROW_HEIGHT, VIEWPORT);
  check("the window never runs past the list", bottom.end === ROWS, `${bottom.end}`);
  check("...and still renders the last rows", bottom.start < ROWS && bottom.end - bottom.start > 0);

  // A list shorter than the viewport renders all of it and nothing more.
  const tiny = feedWindow(3, 0, VIEWPORT);
  check("three rows render three rows", tiny.start === 0 && tiny.end === 3);
  check("...and the spacer is three rows tall", tiny.totalHeight === 3 * FEED_ROW_HEIGHT);
}

console.log("\nan unmeasured container renders nothing rather than everything");
{
  // THE ONE FRAME THIS EXISTS TO PROTECT. A container that has not been measured reports a height of
  // zero, and a virtualiser that read that as "no limit" would render ten thousand rows on mount.
  const unmeasured = feedWindow(ROWS, 0, 0);
  check("a zero-height viewport renders no rows", unmeasured.end - unmeasured.start === 0);
  check("...but still sizes the scrollbar, so the first measure is correct", unmeasured.totalHeight === ROWS * FEED_ROW_HEIGHT);
  check("an empty feed renders nothing and has no height", feedWindow(0, 0, VIEWPORT).totalHeight === 0);
}

console.log("\nthe next page is asked for in rows, not in pixels");
{
  const near = feedWindow(100, (100 - FEED_PREFETCH_ROWS - 2) * FEED_ROW_HEIGHT, VIEWPORT);
  check("near the bottom it asks", shouldFetchMore(near, 100, true, false));

  const far = feedWindow(100, 0, VIEWPORT);
  check("at the top it does not", !shouldFetchMore(far, 100, true, false));

  // The two guards that stop a scroll from launching a request per frame.
  check("a page already in flight does not trigger another", !shouldFetchMore(near, 100, true, true));
  check("and neither does the end of the feed", !shouldFetchMore(near, 100, false, false));
  check("an empty feed asks for nothing", !shouldFetchMore(feedWindow(0, 0, VIEWPORT), 0, true, false));

  // THE PROPERTY THE ROW THRESHOLD BUYS: a tall viewport and a short one reach the same row before
  // asking, so the same feed behaves the same on a laptop and on a phone.
  const tall = feedWindow(100, 65 * FEED_ROW_HEIGHT, 900);
  const short = feedWindow(100, 65 * FEED_ROW_HEIGHT, 240);
  check(
    "a tall viewport reaches the threshold first, because it can SEE further",
    shouldFetchMore(tall, 100, true, false) && !shouldFetchMore(short, 100, true, false),
  );
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
// The same exit the other client suites use: this runs under tsx with no node types in scope.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
