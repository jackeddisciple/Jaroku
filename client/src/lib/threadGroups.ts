// §4.2's grouping — the opinionated part.
//
// THE LIST DOES NOT SORT BY RECENCY. That is the whole reason Threads earns a full-screen surface
// instead of a sidebar list: a build session with side effects is interesting for what it LEFT, and
// the question the view answers is "which threads are waiting on me" rather than "what did I do
// last". Three sections in a fixed order, and the order is the answer.
//
// ONE MODULE, TWO SORTING RULES, and the second one is the exception v1 did not carve out:
//
//   NEEDS YOU SORTS OLDEST FIRST. A pending diff from eighteen minutes ago and one from four days ago
//   wear the identical amber ◆, and they are not the same kind of problem. The section's own stated
//   purpose is that forgetting one is the most expensive failure this view can prevent — which is
//   served by surfacing the longest-forgotten item, not the most recent. Age is carried by the
//   existing relative-time formatter and by the ORDER, with no colour change: this product has four
//   colours and none of them is spare for a second severity signal (§3.3).
//
//   RUNNING AND RECENT SORT NEWEST FIRST, unchanged. Live cost is ticking in the first and the second
//   is ordinary browsing.
//
// AN EMPTY SECTION IS NOT RENDERED AT ALL — no header, no "0 items", no placeholder. Section presence
// is itself the signal, which is why this returns only the sections that have something in them
// rather than three sections and a flag per section.
//
// A PURE FUNCTION OVER THE SNAPSHOT, in its own module rather than inside the view, so the two
// sorting rules can be asserted without rendering anything. The rule that matters most here is an
// ORDERING, and an ordering is exactly the kind of thing that looks right in a screenshot and is
// wrong in the case nobody had that day.

import type { ThreadView } from "../types.ts";

export type ThreadSectionId = "needs_you" | "running" | "recent";

export interface ThreadSection {
  id: ThreadSectionId;
  /** As §4.1's wireframe writes it: NEEDS YOU, RUNNING, RECENT. */
  label: string;
  threads: ThreadView[];
}

/** Ascending by activity — oldest first. See the header for why this section is the exception. */
const oldestFirst = (a: ThreadView, b: ThreadView): number =>
  a.last_activity_at < b.last_activity_at ? -1 : a.last_activity_at > b.last_activity_at ? 1 : 0;

const newestFirst = (a: ThreadView, b: ThreadView): number => -oldestFirst(a, b);

/**
 * Whether a thread belongs in Needs You.
 *
 * BOTH BLOCKED STATUSES, which is what §4.2 puts in the section: `needs_you` is work waiting on a
 * person and `errored` is a session that stopped. They are different glyphs — amber ◆ and red ✕ —
 * because they are different facts, and one section because the response to both is to go and look.
 */
export const isBlockedThread = (t: ThreadView): boolean =>
  t.status === "needs_you" || t.status === "errored";

/**
 * The active threads, in sections, in the fixed order §4.2 states.
 *
 * ARCHIVED THREADS ARE NOT IN ANY OF THEM. §3.4 is explicit that an archived thread leaves the default
 * list and appears under the Archived filter — so it is not "a fourth section that happens to be
 * collapsed", it is out of this view entirely, and the filter that shows it renders a flat list rather
 * than asking this function for a section it does not have.
 */
export function groupThreads(threads: ThreadView[]): ThreadSection[] {
  const active = threads.filter((t) => t.archived_at === null);

  const sections: ThreadSection[] = [
    { id: "needs_you", label: "NEEDS YOU", threads: active.filter(isBlockedThread).sort(oldestFirst) },
    {
      id: "running",
      label: "RUNNING",
      threads: active.filter((t) => t.status === "running").sort(newestFirst),
    },
    {
      id: "recent",
      // Everything else, which today is `idle` and stays correct if a sixth status is ever added:
      // a new state nobody has taught this function about lands in ordinary browsing rather than
      // vanishing from the list.
      label: "RECENT",
      threads: active
        .filter((t) => !isBlockedThread(t) && t.status !== "running")
        .sort(newestFirst),
    },
  ];

  return sections.filter((s) => s.threads.length > 0);
}

/**
 * How long a blocked thread has been waiting, in whole hours.
 *
 * §4.2's refinement asks for the exact age on anything outstanding for more than a day, and the
 * existing relative-time formatter already renders `4d` — so this exists only to answer the
 * threshold question, and returns hours rather than a formatted string precisely so it cannot become
 * a second formatter.
 */
export function hoursOutstanding(t: ThreadView, now = Date.now()): number {
  const at = Date.parse(t.last_activity_at);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, (now - at) / 3_600_000);
}

/** More than a day. The point at which §4.2 says the age is worth rendering exactly. */
export const STALE_HOURS = 24;
