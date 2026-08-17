// §4.4's filter — five chips and a substring.
//
// PLAIN CASE-INSENSITIVE SUBSTRING, NOT FUZZY, and that is the composer's own intent-routing
// philosophy applied here: a mis-match just needs a rephrase, so the cost and unpredictability of
// fuzzy matching is not warranted. Fuzzy matching also fails in the direction that matters — it finds
// something for every query, so a typo returns three unrelated threads instead of none, and the person
// reads the wrong row before noticing.
//
// THREE FIELDS ARE MATCHED: the title, the agent name, and the last-message preview. Those are the
// three things on the row a person would recognise a session by, which is the same reason they are the
// three the row renders. The status and the cost are deliberately not searchable — "needs_you" is a
// chip, not a word to type, and a cost is a chip nobody would search for.
//
// THE CHIP AND THE QUERY COMPOSE, in that order: the chip decides which threads are eligible and the
// query narrows them. So "Archived" plus `webhook` is the archived threads mentioning webhook, which
// is the only reading that lets somebody find the thing they archived last week.

import type { ThreadView } from "../types.ts";
import { isBlockedThread } from "./threadGroups.ts";

/** §4.4's five, in the order they render. Position matters — the 1–5 shortcuts jump by it. */
export const THREAD_FILTERS = ["all", "needs_you", "running", "recent", "archived"] as const;
export type ThreadFilter = (typeof THREAD_FILTERS)[number];

export const FILTER_LABEL: Record<ThreadFilter, string> = {
  all: "All",
  needs_you: "Needs you",
  running: "Running",
  recent: "Recent",
  archived: "Archived",
};

/**
 * Does this thread match what was typed?
 *
 * An empty query matches everything, which is what makes the chip work on its own — and a query of
 * spaces is an empty query, because a trailing space while typing must not empty the list.
 */
export function matchesQuery(thread: ThreadView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  // The three fields the row renders, joined once. `agent_name` carries the deleted agent's snapshot
  // too, so a thread whose agent is gone is still findable by the name it was built against — which
  // is the whole reason that column exists (§3.2).
  const haystack = `${thread.title} ${thread.agent_name ?? ""} ${thread.preview ?? ""}`.toLowerCase();
  return haystack.includes(q);
}

/**
 * The threads a chip is about, narrowed by the query.
 *
 * `all` MEANS EVERY ACTIVE THREAD, not every row. Archived threads have their own chip, and a total
 * that included them would make All the one chip whose count does not match what clicking it shows —
 * which is the sort of small dishonesty that makes somebody stop trusting the numbers beside it.
 */
export function filterThreads(
  threads: ThreadView[],
  filter: ThreadFilter,
  query: string,
): ThreadView[] {
  const matched = threads.filter((t) => matchesQuery(t, query));
  const active = matched.filter((t) => t.archived_at === null);
  switch (filter) {
    case "all":
      return active;
    case "needs_you":
      return active.filter(isBlockedThread);
    case "running":
      return active.filter((t) => t.status === "running");
    case "recent":
      return active.filter((t) => !isBlockedThread(t) && t.status !== "running");
    case "archived":
      return matched.filter((t) => t.archived_at !== null);
  }
}
