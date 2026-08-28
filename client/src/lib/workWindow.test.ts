// §24's `test:work-window`: "the windowing at ten thousand rows: overscan on both sides, the bottom
// clamp, the fetch threshold in rows".
//
// §18 AND §22 BOTH NAME THE NUMBER: "Test it at ten thousand rows, not at fifty. That is the
// standard the feed was held to and this list has no reason to be held to a lower one." The reason
// the number is in the specification is that fifty rows pass every version of this code including
// the one that renders all of them — a virtualiser is not wrong at fifty, it is merely pointless,
// and the bugs it has are all at the edges of a list long enough to have edges.
//
// THE THREE MISTAKES `feedWindow.ts` NAMES are asserted here against the Cockpit's own row height,
// because that is the whole of what this tab changes: the arithmetic is the feed's, the height is
// not, and a parameter passed wrongly is indistinguishable from a parameter not passed at all until
// somebody scrolls to row nine thousand.
//
// AND THE ONE THING THAT IS NOT THE FEED'S: the flattening. A day heading is a row here, which is
// what lets `feedWindow` apply unchanged — so the assertions worth making are that the flattening
// is faithful (no row lost, no row duplicated, order preserved) and that `dayAt` answers correctly
// for an index in the middle of a day, which is what the pinned heading reads.
//
//   npm run test:work-window

import { ROW_HEIGHT } from "./cockpitLayout.ts";
import { FEED_OVERSCAN, FEED_PREFETCH_ROWS } from "./feedWindow.ts";
import { dayAt, flattenWork, workShouldFetch, workWindow } from "./workWindow.ts";
import type { WorkItemView } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const NOW = new Date("2026-08-28T14:00:00");
const VIEWPORT = 700;

let seq = 0;
const item = (createdAt: Date): WorkItemView => ({
  id: `w-${++seq}`, agent_id: "a", agent_name: "billing_bot", deployment_id: "d", run_id: "r",
  created_by: "u", created_by_name: "Tester", input_preview: "refund order 4471",
  status: "succeeded", output_preview: null, error: null, failure_kind: null,
  created_at: createdAt.toISOString(), started_at: null, ended_at: null,
  cost_usd: 0.0031, tokens: 900, duration_ms: 4200, cost_complete: true,
});

/** Ten thousand jobs over a hundred days, newest first — the shape §18 names. */
const TEN_THOUSAND: WorkItemView[] = [];
for (let day = 0; day < 100; day++) {
  for (let n = 0; n < 100; n++) {
    const at = new Date(NOW);
    at.setDate(at.getDate() - day);
    at.setHours(12, 0, n);
    TEN_THOUSAND.push(item(at));
  }
}
const ENTRIES = flattenWork(TEN_THOUSAND, NOW);

// --- 1. the flattening is faithful ------------------------------------------------------------------

console.log("\nten thousand jobs, a hundred days");
{
  check(`the fixture is ten thousand rows (${TEN_THOUSAND.length})`, TEN_THOUSAND.length === 10_000);

  const rows = ENTRIES.filter((e) => e.kind === "row");
  const headings = ENTRIES.filter((e) => e.kind === "day");
  check("every job survives the flattening", rows.length === 10_000, String(rows.length));
  check("a hundred days become a hundred headings", headings.length === 100, String(headings.length));
  check(`so the flat list is ten thousand and a hundred (${ENTRIES.length})`, ENTRIES.length === 10_100);

  // ORDER PRESERVED, which §18 requires of the whole list and which a flattening is the easiest
  // place to lose: "Sort is by creation time and creation time does not change."
  check("the order the server sent is the order that comes out",
    rows.every((e, i) => e.kind === "row" && e.item.id === TEN_THOUSAND[i]!.id));

  // NO KEY COLLIDES, because React keys the slice by them and a duplicate key in a virtualised
  // list is a row that renders somebody else's job.
  check("every entry has a distinct key", new Set(ENTRIES.map((e) => e.key)).size === ENTRIES.length,
    `${new Set(ENTRIES.map((e) => e.key)).size} of ${ENTRIES.length}`);

  // A HEADING ALWAYS PRECEDES ITS ROWS, which is what `dayAt` relies on.
  check("the first entry is a heading", ENTRIES[0]?.kind === "day");
}

// --- 2. overscan on BOTH sides ---------------------------------------------------------------------

console.log("\nthe half people forget");
{
  // §18 AND `feedWindow.ts`: "overscanning only downwards leaves the blank strip when somebody
  // scrolls back up, which is the half people forget."
  const mid = workWindow(ENTRIES.length, 200 * ROW_HEIGHT, VIEWPORT);
  const firstVisible = Math.floor((200 * ROW_HEIGHT) / ROW_HEIGHT);
  check("the window starts above what is visible", mid.start < firstVisible,
    `${mid.start} vs ${firstVisible}`);
  check(`...by the overscan (${firstVisible - mid.start})`, firstVisible - mid.start === FEED_OVERSCAN,
    String(firstVisible - mid.start));

  const lastVisible = firstVisible + Math.ceil(VIEWPORT / ROW_HEIGHT);
  check("and ends below it", mid.end > lastVisible, `${mid.end} vs ${lastVisible}`);
  check(`...by the same overscan (${mid.end - lastVisible})`, mid.end - lastVisible === FEED_OVERSCAN,
    String(mid.end - lastVisible));

  // AT THE VERY TOP THERE IS NOTHING ABOVE, and the window must not go negative.
  const top = workWindow(ENTRIES.length, 0, VIEWPORT);
  check("the window never starts before the list", top.start === 0, String(top.start));
  check("...and its offset is zero there", top.offsetTop === 0, String(top.offsetTop));
}

// --- 3. the bottom clamp ---------------------------------------------------------------------------

console.log("\nempty rows read as 'there is more coming'");
{
  // `feedWindow.ts`: "`start + count` past the end renders empty rows below the last one, which on
  // a feed that is still loading looks identical to 'there is more coming' and stops the reader
  // scrolling for it."
  const total = ENTRIES.length;
  const bottom = workWindow(total, total * ROW_HEIGHT, VIEWPORT);
  check("the window never ends past the list", bottom.end <= total, `${bottom.end} vs ${total}`);
  check("...and reaches it", bottom.end === total, `${bottom.end} vs ${total}`);

  // AND PAST THE END ENTIRELY, which is what a momentary over-scroll produces on a trackpad.
  const overscrolled = workWindow(total, (total + 50) * ROW_HEIGHT, VIEWPORT);
  check("an over-scroll still clamps", overscrolled.end === total, String(overscrolled.end));
  // AND `start` IS CLAMPED TOO, which `feedWindow` was not doing. An offset past the content —
  // exactly what a rubber-band overscroll reports on macOS and iOS — gave `start > end`: an
  // inverted slice, so the list renders nothing, with an `offsetTop` past the scroller's own
  // height. The symptom is a list that empties itself for a frame when somebody flicks past the
  // end. Fixed in the shared module rather than worked around here, because the feed has the same
  // scroller and the same flick.
  check("...and its start never passes its end", overscrolled.start <= overscrolled.end,
    `${overscrolled.start} vs ${overscrolled.end}`);
  check("...nor goes negative", overscrolled.start >= 0, String(overscrolled.start));
}

// --- 4. the row height is this list's, and it is passed ---------------------------------------------

console.log("\nthe one number this tab changes");
{
  // A PARAMETER PASSED WRONGLY IS INDISTINGUISHABLE FROM ONE NOT PASSED, until somebody scrolls to
  // row nine thousand and the slice is somewhere else entirely. So the height is asserted through
  // the arithmetic rather than by reading the constant back.
  const w = workWindow(ENTRIES.length, 100 * ROW_HEIGHT, VIEWPORT);
  check("the offset is a whole number of this list's rows",
    w.offsetTop === w.start * ROW_HEIGHT, `${w.offsetTop} vs ${w.start * ROW_HEIGHT}`);
  check("the total height is the list at this row height",
    w.totalHeight === ENTRIES.length * ROW_HEIGHT, String(w.totalHeight));

  // A VIEWPORT OF ZERO RENDERS NOTHING, not everything. `feedWindow.ts` says why: a container that
  // has not been measured reports zero, and treating that as "render everything" would render ten
  // thousand rows on the one frame the virtualiser exists to protect.
  const unmeasured = workWindow(ENTRIES.length, 0, 0);
  check("an unmeasured viewport renders no rows", unmeasured.end === 0, String(unmeasured.end));
  check("...but still sizes the scrollbar", unmeasured.totalHeight === ENTRIES.length * ROW_HEIGHT);

  check("an empty list windows to nothing", workWindow(0, 0, VIEWPORT).end === 0);
}

// --- 5. the fetch threshold, in rows -------------------------------------------------------------

console.log("\nin rows, not in pixels");
{
  const total = ENTRIES.length;
  const near = workWindow(total, (total - FEED_PREFETCH_ROWS - 2) * ROW_HEIGHT, VIEWPORT);
  check("near the end, the next page is asked for",
    workShouldFetch(near, total, true, false), `end ${near.end} of ${total}`);

  const far = workWindow(total, 100 * ROW_HEIGHT, VIEWPORT);
  check("in the middle, it is not", !workShouldFetch(far, total, true, false), `end ${far.end}`);

  // THE TWO REFUSALS, which are what stop a list at its end from asking for ever.
  check("nothing is asked for when there is no more", !workShouldFetch(near, total, false, false));
  check("...nor while a page is already in flight", !workShouldFetch(near, total, true, true));
  check("...nor for an empty list", !workShouldFetch(workWindow(0, 0, VIEWPORT), 0, true, false));

  // IN ROWS MEANS THE SAME POINT ON ANY SCREEN. A tall viewport and a short one reach the
  // threshold at the same row index, which is the property a pixel threshold does not have.
  const tall = workWindow(total, (total - FEED_PREFETCH_ROWS - 2) * ROW_HEIGHT, 1400);
  const short = workWindow(total, (total - FEED_PREFETCH_ROWS - 2) * ROW_HEIGHT, 400);
  check("a tall screen and a short one both ask",
    workShouldFetch(tall, total, true, false) && workShouldFetch(short, total, true, false));
}

// --- 6. which heading is in force ------------------------------------------------------------------

console.log("\nthe pinned heading, computed rather than stuck");
{
  // The first day's heading is entry 0 and its rows are 1..100; entry 101 is the second heading.
  check("a row's day is the heading above it", dayAt(ENTRIES, 50) === "Today", String(dayAt(ENTRIES, 50)));
  check("a heading is its own day", dayAt(ENTRIES, 0) === "Today", String(dayAt(ENTRIES, 0)));
  check("the row after a boundary takes the new day",
    dayAt(ENTRIES, 102) === "Yesterday", String(dayAt(ENTRIES, 102)));
  check("...and the row before it does not",
    dayAt(ENTRIES, 100) === "Today", String(dayAt(ENTRIES, 100)));

  // DEEP IN THE LIST, which is the case CSS sticky gets wrong under virtualisation: the group's box
  // is only as tall as the slice in the DOM, so the heading unsticks halfway down a long day.
  const deep = dayAt(ENTRIES, 9_000);
  check("a row nine thousand deep still knows its day", deep !== null && deep.length > 0, String(deep));

  check("an index past the end takes the last heading there is", dayAt(ENTRIES, 99_999) !== null);
  check("an empty list has no heading in force", dayAt([], 0) === null);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
