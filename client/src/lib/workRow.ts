// §6's row, as the two rules that are not markup: which columns are there, and where the days break.
//
// A ROW, NOT A CARD. §6 opens with it: "Cards are for objects you choose between; rows are for a
// record you scan. Forty cards is a wall." Everything below follows from that — a row is one line,
// so a column that cannot fit has to LEAVE rather than wrap, and which one leaves first is a
// decision about what the reader is actually scanning for.
//
// THE SHEDDING ORDER IS §13's AND IT IS AN ORDER RATHER THAN A SET: "The work list sheds columns in
// this order: actor, then agent name, then cost. Time and status never leave." Each of the three is
// dropped for its own reason, and the reasons are what make the order the right one:
//
//   ACTOR GOES FIRST because in the `mine` scope it is always the reader, so it is a column
//   repeating one value down the page — and §6 already only shows it in `all` for that reason. At a
//   narrow width the same argument applies one step harder.
//
//   AGENT NAME GOES SECOND, and it also goes at ANY width when the list is filtered to one agent:
//   "a column that repeats one value forty times is forty pixels of nothing". That is the same rule
//   twice, once for scope and once for space.
//
//   COST GOES THIRD, last of the three, because it is the only one of them that is a figure the
//   reader cannot reconstruct. A name they can get by opening the row; a number they cannot.
//
//   TIME AND STATUS NEVER LEAVE, because they are what the list IS. Sorting is time descending
//   always, and a record ordered by a column it does not show is a record nobody can read.
//
// NO NEW BREAKPOINTS — §13. The thresholds below are Tailwind's own `sm`, `md` and `lg`, which this
// client already uses; what is different is that they are measured against the CONTAINER rather
// than the viewport, which is `InboxView`'s and `AgentDetail`'s existing pattern (`STACK_BELOW_PX`
// and a `ResizeObserver`). It has to be the container here: the Cockpit sits beside a sidebar the
// user can drag, so a viewport query would keep every column while the pane holding them shrank to
// nothing.
//
// PURE, AND ITS OWN FILE, for the reason `inboxBoard.ts` and `threadGroups.ts` are: both of these
// rules look obviously right in a screenshot and are wrong in the case nobody had that day — a
// workspace of one agent, a list filtered to that agent, a day boundary at the top of a page.
//
//   npm run test:work-row

import type { WorkFilters, WorkItemView } from "../types.ts";

/**
 * Tailwind's own steps, as values.
 *
 * WRITTEN OUT RATHER THAN IMPORTED because the config does not export them and a `@media` query
 * cannot be asked a question by JavaScript. They are the framework's defaults, unchanged, which is
 * what keeps §13's "do not add a breakpoint that is not already in the app's set" true: these are
 * the same numbers `sm:`, `md:` and `lg:` already mean at the eighteen call sites that use them.
 */
export const BREAKPOINT = { sm: 640, md: 768, lg: 1024 } as const;

/** Which of the three sheddable columns are drawn. Status, input and time are not in here: they
 *  are never absent, so a flag for them would be a flag that is always true. */
export interface RowColumns {
  agent: boolean;
  actor: boolean;
  cost: boolean;
}

/**
 * §13's shedding, and §6's two scope rules, in one answer.
 *
 * WIDTH IS THE CONTAINER'S, in pixels. A width of zero — a container that has not been measured yet
 * — renders the FULL set rather than the narrowest, which is the opposite of what a naive
 * comparison gives. The first frame of a list is the one the reader sees resolve, and a row that
 * arrived with three columns and grew to six a frame later is exactly the layout shift §Craft 1 is
 * about; a row that arrived complete and never moved is right, and a container is only unmeasured
 * for that one frame.
 */
export function rowColumns(width: number, filters: Pick<WorkFilters, "scope" | "agentId">): RowColumns {
  // Unmeasured means "assume there is room" — see above.
  const w = width <= 0 ? Number.POSITIVE_INFINITY : width;

  return {
    // §6: "Actor, shown only in the `all` view. In `mine` it is always the reader." And §13 sheds
    // it first when there is not room, which is the same argument under pressure.
    actor: filters.scope === "all" && w >= BREAKPOINT.md,
    // §6: "Hidden when the list is filtered to a single agent — a column that repeats one value
    // forty times is forty pixels of nothing." Then §13's second shed.
    agent: filters.agentId === null && w >= BREAKPOINT.sm,
    // §13's third and last shed, at the narrowest supported width.
    cost: w >= BREAKPOINT.sm,
  };
}

/** One day of the record, newest day first, with its rows in the order they happened. */
export interface DayGroup {
  /** The local calendar day, `YYYY-MM-DD`. The key, never rendered. */
  key: string;
  /** What the sticky heading says. See `dayLabel`. */
  label: string;
  items: WorkItemView[];
}

/**
 * A local calendar day key for an instant.
 *
 * LOCAL AND NOT UTC, which is the one place this differs from the server's "today". `snapshot.ts`
 * counts a day from UTC midnight and says so — nothing in this product records a person's timezone,
 * so an aggregate has to pick one. A HEADING is different: it sits directly above rows carrying
 * local times, and a heading that said "Tuesday" over a row reading "11:40pm Monday" would be the
 * two halves of one line disagreeing where the reader can see both at once.
 */
function dayKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * What a day heading says.
 *
 * NOT `relTime`, AND THAT IS NOT A SECOND CLOCK. §17's rule is about the time of an EVENT — "do not
 * write a second one, do not add a ceiling of your own" — and every event time in this tab still
 * goes through `relTime`. A heading names a calendar day rather than an elapsed interval, and
 * "4h ago" is not a name a day can have: two rows eleven hours apart belong under one heading and
 * would be given two different relative labels.
 *
 * "TODAY" AND "YESTERDAY" ARE NAMED, everything older is dated. Those two are the days a reader
 * holds in their head; a third named day ("Wednesday") starts being ambiguous within a week, which
 * is exactly the ceiling argument `relTime` already makes for itself one unit up.
 *
 * THE YEAR APPEARS ONLY WHEN IT IS NOT THIS ONE, which is `relTime`'s own convention — borrowed
 * deliberately, so a heading and the rows under it date things the same way.
 */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const today = dayKey(now);
  if (dayKey(at) === today) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(at) === dayKey(yesterday)) return "Yesterday";
  return at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * §6's day grouping.
 *
 * IT PRESERVES THE ORDER IT WAS GIVEN AND DOES NOT SORT. The list arrives newest-first from the
 * server and §18 is emphatic that it stays that way: "Sort is by creation time and creation time
 * does not change. If you ever find yourself re-sorting on status, stop." A grouping function that
 * sorted would be a second opinion about the order, and the one place the two could disagree is
 * mid-delta, under a reader's cursor.
 *
 * A DAY WITH NO ITEMS RENDERS NOTHING, which falls out of deriving the groups FROM the items rather
 * than from a calendar. §6 names the discipline and points at `InboxView` line 145 for it — the
 * alternative is a heading for every day between the newest row and the oldest, most of them empty,
 * on a workspace that runs jobs on weekdays.
 *
 * A SINGLE ROW STILL GETS ITS HEADING — §22: "One job. The day grouping still renders its heading.
 * A single row with no heading looks like a fragment."
 */
export function groupByDay(items: WorkItemView[], now: Date = new Date()): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const item of items) {
    const at = new Date(item.created_at);
    // AN UNPARSEABLE INSTANT STILL GETS A ROW. It goes under the group it arrived beside rather
    // than into a group of its own with a blank heading — a row is a record of something that
    // happened, and dropping it because its timestamp is malformed would be the list quietly
    // deciding a job did not exist.
    const key = Number.isNaN(at.getTime()) ? (groups[groups.length - 1]?.key ?? "") : dayKey(at);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(item.created_at, now), items: [item] });
  }
  return groups;
}
