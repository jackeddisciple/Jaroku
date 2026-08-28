// §18's virtualiser, which is `feedWindow.ts` — parameterised, not copied.
//
// §18 IS EXPLICIT AND THE REASON IS THE ONE THAT MATTERS: "Virtualise with `feedWindow.ts`. It
// already exists, it is deliberately dependency-free arithmetic, and its header names the three
// things a naive implementation gets wrong: overscan on BOTH sides, the bottom clamp, and a fetch
// threshold measured IN ROWS rather than pixels. Read that comment before you write a line of
// windowing. If work rows are a different fixed height than feed rows, parameterise the module
// rather than copying it — a second virtualiser is a second set of the same three bugs."
//
// IT IS ALREADY PARAMETERISED. `feedWindow(total, scrollTop, viewportHeight, rowHeight, overscan)`
// takes both of the numbers that differ, and `shouldFetchMore` takes its threshold. So nothing in
// that module changes and nothing here re-derives its arithmetic; this file supplies the Cockpit's
// row height and solves the ONE thing the feed does not have.
//
// ─── THE ONE THING: DAY HEADINGS ────────────────────────────────────────────────────────────────
//
// The feed is a flat list of identical rows. This list is grouped by day (§6), and a heading is not
// a row. Two ways that could have gone, and both were wrong:
//
//   A HEIGHTS ARRAY, so the window could sum variable heights. That is a measurement cache, which
//   is precisely the complexity `feedWindow.ts`'s header says it exists to avoid — and it would
//   have meant changing the module for one caller, which is the "second set of the same three
//   bugs" arriving by the other door.
//
//   WINDOWING EACH DAY SEPARATELY, so every group is its own flat list. That is N virtualisers with
//   N scroll offsets to keep in step, and a workspace with three hundred quiet days would render
//   three hundred windows to show forty rows.
//
// SO THE HEADING IS A ROW. The list is flattened into one array of entries, every entry the same
// height, and `feedWindow` applies to it completely unchanged. A heading occupying a row's height
// is not a compromise: it is a caps label with a row's worth of breathing room around it, which is
// what a section break wants anyway.
//
// AND CSS `position: sticky` IS REPLACED RATHER THAN FOUGHT. A sticky heading needs its group's box
// to span the group's real extent, and under virtualisation only a slice of the group is in the
// DOM — so the box is wrong and the heading unsticks halfway down a long day. `dayAt` below answers
// "which day is in force at this index" from the flat array, and the view pins that one heading
// itself. That is the standard answer to sticky-under-virtualisation and it is more honest than the
// CSS one: the pinned heading is computed from the data rather than from a box that is a lie.
//
//   npm run test:work-window

import { ROW_HEIGHT } from "./cockpitLayout.ts";
import { FEED_OVERSCAN, FEED_PREFETCH_ROWS, feedWindow, shouldFetchMore, type FeedWindow } from "./feedWindow.ts";
import { groupByDay } from "./workRow.ts";
import type { WorkItemView } from "../types.ts";

/**
 * One line of the flattened list. A heading or a job, and both are one row tall.
 *
 * A DISCRIMINATED UNION RATHER THAN A NULLABLE ROW, so the view switches exhaustively and a third
 * kind — §18's new-items pill is deliberately NOT one, see below — would be a compile error rather
 * than a blank line in the middle of somebody's record.
 */
export type WorkEntry =
  | { kind: "day"; key: string; label: string }
  | { kind: "row"; key: string; item: WorkItemView };

/**
 * The grouped list, flattened, in the order it is rendered.
 *
 * IT GOES THROUGH `groupByDay` RATHER THAN GROUPING AGAIN. That module owns the two rules — a day
 * with no items renders nothing, and the order it was given is preserved — and re-implementing
 * either here would be a second opinion about where the days break, which is the class of
 * disagreement that only shows up mid-delta.
 *
 * THE PILL IS NOT AN ENTRY. §18's "3 new" pill is pinned at the top of the LIST rather than
 * inserted into it — "The pill respects the day grouping and does not appear inside a group" — so
 * it is not in this array at all and cannot be scrolled past.
 */
export function flattenWork(items: WorkItemView[], now: Date = new Date()): WorkEntry[] {
  const out: WorkEntry[] = [];
  for (const day of groupByDay(items, now)) {
    out.push({ kind: "day", key: `day-${day.key}`, label: day.label });
    for (const item of day.items) out.push({ kind: "row", key: item.id, item });
  }
  return out;
}

/**
 * Which day heading is in force at an index — what the view pins to the top of the viewport.
 *
 * IT SCANS BACKWARDS FROM THE INDEX, which is O(days-in-view) rather than O(list) because the
 * nearest heading above any row is at most one day's worth of rows away. At ten thousand rows over
 * a hundred days that is a hundred steps in the pathological case and one or two in every real one.
 *
 * NULL BEFORE THE FIRST HEADING, which cannot happen for a well-formed list — `flattenWork` always
 * emits a heading before its rows — and is returned rather than asserted because the alternative is
 * a crash on an empty window during a filter change, where the honest answer is "no heading yet".
 */
export function dayAt(entries: WorkEntry[], index: number): string | null {
  for (let i = Math.min(index, entries.length - 1); i >= 0; i--) {
    const entry = entries[i];
    if (entry?.kind === "day") return entry.label;
  }
  return null;
}

/**
 * The Cockpit's window: `feedWindow`, with this list's row height.
 *
 * A NAMED CALL RATHER THAN A CALL SITE, so the row height is supplied in exactly one place. The
 * overscan is the feed's own — six rows either side — because the argument for it is about how a
 * browser paints rather than about what a row contains, and it is the same browser.
 */
export function workWindow(total: number, scrollTop: number, viewportHeight: number): FeedWindow {
  return feedWindow(total, scrollTop, viewportHeight, ROW_HEIGHT, FEED_OVERSCAN);
}

/**
 * Whether the next page should be asked for — `shouldFetchMore`, unchanged.
 *
 * IN ROWS AND NOT PIXELS, which is the third of the three mistakes `feedWindow.ts` names: "'within
 * 400px of the bottom' means eight rows on a desktop and two on a phone, so the same feed
 * pre-fetches at different times on different screens."
 *
 * THE COCKPIT'S PAGE IS FETCHED BY AN EXPLICIT CONTROL AS WELL. §18's list is keyset-paged and the
 * "Show older jobs" button stays: a list whose head moves every few seconds AND that also loads on
 * scroll is a list that jumps under the reader. This is the pre-fetch that makes the button rarely
 * necessary rather than the thing that replaces it.
 */
export function workShouldFetch(
  window: FeedWindow,
  total: number,
  hasMore: boolean,
  loading: boolean,
): boolean {
  return shouldFetchMore(window, total, hasMore, loading, FEED_PREFETCH_ROWS);
}
