// §4's header controls: the search, the four filters, and the four sort orders.
//
// A PURE MODULE FOR THE SAME REASON `threadFilter.ts` IS ONE. What the grid renders is decided by a
// match rule and an ordering, and both are exactly the kind of thing that looks right against the
// eight agents somebody happened to have and is wrong the first time an agent has no runs, no
// deployment and no thread. Testing that against a rendered grid means seeding a database and reading
// pixels; testing it here is a function call.
//
// SEARCH IS `display_name` AND `slug`, WHICH §4 NAMES AND NOTHING ELSE. Not the description — a
// description is prose and matching it means typing three words and getting six cards for a reason
// you cannot see. The two searchable fields are the two the card shows as its identity, which is what
// makes a match explicable: you can see why the row came back.
//
// PLAIN CASE-INSENSITIVE SUBSTRING, NOT FUZZY, for the reason the thread filter gives at length:
// fuzzy matching finds something for every query, so a typo returns three unrelated agents instead of
// none and somebody opens the wrong one before noticing. §5.5's ⌘K jump is a different surface with a
// different job and is allowed to be looser.
//
// THE FILTERS AND THE QUERY COMPOSE, in that order: the filters decide which agents are eligible and
// the query narrows them. "Archived" plus `webhook` is the archived agents whose name mentions
// webhook, which is the only reading that lets somebody find the thing they put away last week.

import type { AgentCardView } from "../types.ts";

/** §4's sort orders, in the order the control lists them. `active` is the default. */
export const AGENT_SORTS = ["active", "name", "created", "spend"] as const;
export type AgentSort = (typeof AGENT_SORTS)[number];

export const SORT_LABEL: Record<AgentSort, string> = {
  active: "Last active",
  name: "Name",
  created: "Created",
  spend: "7-day spend",
};

/** §4's density toggle. Both are real layouts, not a CSS scale — see the card. */
export type AgentDensity = "comfortable" | "compact";

/**
 * The header's filter state, all of it, as one object.
 *
 * ONE OBJECT RATHER THAN FIVE PIECES OF STATE, because every consumer needs all of them at once and
 * because the empty state has to be able to name which filters are active — which means it needs the
 * whole set in hand rather than five props it might forget one of.
 *
 * `null` MEANS "NO OPINION" FOR EACH OF THE THREE PICKERS, deliberately, and it is not the same as a
 * value that happens to match everything. "Any status" is not a status.
 */
export interface AgentFilterState {
  query: string;
  /** One of the four health values, or null for any. */
  status: AgentCardView["health"] | null;
  /** A connector id every shown agent must have, or null for any. */
  connector: string | null;
  /** True: deployed only. False: not deployed. Null: either. */
  deployed: boolean | null;
  /** A user id, for Team workspaces. Null for anybody. */
  createdBy: string | null;
  /** §4: archived agents are hidden by default and appear only when this is on. */
  archived: boolean;
}

export const NO_FILTERS: AgentFilterState = {
  query: "",
  status: null,
  connector: null,
  deployed: null,
  createdBy: null,
  archived: false,
};

/** Whether anything is narrowing the grid. What tells the two empty states apart. */
export function hasActiveFilters(f: AgentFilterState): boolean {
  return (
    f.query.trim() !== "" ||
    f.status !== null ||
    f.connector !== null ||
    f.deployed !== null ||
    f.createdBy !== null ||
    f.archived
  );
}

/**
 * The active filters, named, for §4's second empty state.
 *
 * SENTENCES RATHER THAN KEYS, because the empty state's whole job is to say why the grid is blank in
 * words somebody can act on. "status: failing" is a debug dump; "Failing" beside "Deployed" is the
 * two chips they clicked.
 */
export function describeFilters(f: AgentFilterState): string[] {
  const out: string[] = [];
  if (f.query.trim()) out.push(`matching ${f.query.trim()}`);
  if (f.status) out.push(f.status);
  if (f.connector) out.push(f.connector);
  if (f.deployed === true) out.push("deployed");
  if (f.deployed === false) out.push("not deployed");
  if (f.createdBy) out.push("created by one person");
  if (f.archived) out.push("archived");
  return out;
}

/** Does this agent match what was typed? An empty query, or one of only spaces, matches everything. */
export function matchesQuery(a: AgentCardView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return a.name.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q);
}

/**
 * The agents the header's controls are asking for, in the order the sort asks for.
 *
 * ARCHIVED IS A GATE, NOT A FILTER VALUE, and that asymmetry is §4's: archived agents are hidden by
 * default and appear ONLY when the archived filter is on — at which point they are what the grid is
 * about. Showing both together would make "archived" a decoration rather than a state, which is the
 * same argument the Threads list makes for its own Archived chip.
 */
export function filterAgents(agents: readonly AgentCardView[], f: AgentFilterState): AgentCardView[] {
  return agents.filter((a) => {
    if (f.archived !== (a.archived_at !== null)) return false;
    if (f.status !== null && a.health !== f.status) return false;
    if (f.connector !== null && !a.connectors.includes(f.connector)) return false;
    if (f.deployed !== null && f.deployed !== (a.deployment !== null && a.deployment.status === "live")) return false;
    if (f.createdBy !== null && a.created_by !== f.createdBy) return false;
    return matchesQuery(a, f.query);
  });
}

/**
 * §4's four orders.
 *
 * EVERY ONE OF THEM IS TOTAL, and that is what stops the grid reshuffling under a live update. Two
 * agents that have never run have the same `last_run_at` (null), two made in the same second have the
 * same `created_at`, and two that have spent nothing have the same spend — so each comparator falls
 * through to the slug, which is unique per workspace. Without that tiebreak a card can swap places
 * with its neighbour on an unrelated broadcast, which is the animation nobody asked for.
 *
 * NULL SORTS LAST IN EVERY ORDER, never as zero. An agent that has never run has no last-active date
 * rather than one at the epoch, and an agent that has spent nothing has no figure rather than $0 —
 * the same rule the rest of this product applies to a missing number, applied to an ordering.
 */
export function sortAgents(agents: readonly AgentCardView[], sort: AgentSort): AgentCardView[] {
  const bySlug = (a: AgentCardView, b: AgentCardView): number => a.slug.localeCompare(b.slug);
  const copy = [...agents];
  switch (sort) {
    case "name":
      // The DISPLAY name, because that is what the sort control is beside on screen. Case-insensitive
      // and locale-aware, so `Zendesk` does not sort above `api gateway`.
      return copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || bySlug(a, b));
    case "created":
      return copy.sort((a, b) => b.created_at.localeCompare(a.created_at) || bySlug(a, b));
    case "spend":
      return copy.sort((a, b) => (b.spend_7d ?? -1) - (a.spend_7d ?? -1) || bySlug(a, b));
    case "active":
    default:
      // LAST ACTIVE IS THE LATER OF "a run finished" AND "a session moved", which is what somebody
      // means by it. An agent nobody has run this month but whose thread had a message this morning
      // is not stale, and ordering by runs alone would bury it under agents nobody has touched at
      // all. Both are ISO-8601 UTC, so a string compare is a chronological one.
      return copy.sort((a, b) => (activeAt(b) ?? "").localeCompare(activeAt(a) ?? "") || bySlug(a, b));
  }
}

/** The later of the agent's last run and its latest session's activity. Null when it has neither. */
export function activeAt(a: AgentCardView): string | null {
  const thread = a.latest_thread?.last_activity_at ?? null;
  if (a.last_run_at === null) return thread;
  if (thread === null) return a.last_run_at;
  return a.last_run_at > thread ? a.last_run_at : thread;
}

/** Everything the header does, in the order it does it: filter, then sort. */
export function visibleAgents(
  agents: readonly AgentCardView[],
  f: AgentFilterState,
  sort: AgentSort,
): AgentCardView[] {
  return sortAgents(filterAgents(agents, f), sort);
}

/** Every connector any agent in the workspace has, sorted, for the connector picker. */
export function connectorOptions(agents: readonly AgentCardView[]): string[] {
  return [...new Set(agents.flatMap((a) => a.connectors))].sort();
}
