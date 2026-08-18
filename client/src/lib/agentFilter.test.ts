// §4's header controls: what the search matches, what the filters gate, and what the sorts order by.
//
// THE CASES WORTH HAVING are the ones a grid of eight healthy agents never produces: an agent that
// has never run, one that has spent nothing, two made in the same second, and the archived/live
// asymmetry that makes "archived" a state rather than a decoration. Every one is a line here and none
// is reachable from a screenshot.
//
// THE ORDERINGS ARE ASSERTED TO BE TOTAL, which is the one property a sort has to have on a surface
// that re-renders on every broadcast: without a tiebreak, two agents with the same key swap places
// when an unrelated card updates, and the grid appears to shuffle itself.
//
//   npm run test:agent-filter

import {
  NO_FILTERS, activeAt, connectorOptions, describeFilters, filterAgents, hasActiveFilters,
  matchesQuery, sortAgents, visibleAgents,
} from "./agentFilter.ts";
import type { AgentCardView } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const card = (over: Partial<AgentCardView> & { slug: string }): AgentCardView => ({
  agent_id: over.slug,
  uuid: `uuid-${over.slug}`,
  name: over.slug,
  slug: over.slug,
  description: null,
  created_at: "2026-08-01T00:00:00.000Z",
  created_by: null,
  archived_at: null,
  hand_written: false,
  current_version: 3,
  version_source: "edit",
  creation_cost: null,
  connectors: [],
  mcp_tools: [],
  required_env: [],
  missing_env: [],
  high_impact_tools: 0,
  default_provider: "fake",
  thread_count: 1,
  latest_thread: null,
  runtime: "idle",
  health: "healthy",
  activity: "quiet",
  last_run_at: "2026-08-10T00:00:00.000Z",
  runs_7d: 3,
  errors_7d: 0,
  outcomes: [],
  last_error: null,
  spend_7d: 1,
  spend_known: true,
  deployment: null,
  drift: null,
  ...over,
});

console.log("\nsearch is the two fields the card shows as its identity");
{
  const a = card({ slug: "api_gateway", name: "API Gateway", description: "handles rate limiting" });
  check("the display name matches", matchesQuery(a, "gateway"));
  check("...case-insensitively", matchesQuery(a, "GATEWAY"));
  check("the slug matches too, which is what somebody types from a run row", matchesQuery(a, "api_"));
  // NOT THE DESCRIPTION, deliberately. Matching prose means typing three words and getting six cards
  // for a reason you cannot see on any of them.
  check("the description does NOT match, so every hit is explicable from the card",
    !matchesQuery(a, "rate limiting"));
  check("an empty query matches everything", matchesQuery(a, ""));
  check("...and so does a query of only spaces, which is what mid-typing looks like",
    matchesQuery(a, "   "));
}

console.log("\narchived is a gate rather than a filter value (§4)");
{
  const live = card({ slug: "live_one" });
  const put = card({ slug: "put_away", archived_at: "2026-08-12T00:00:00.000Z" });
  const all = [live, put];

  check("archived agents are hidden by default",
    filterAgents(all, NO_FILTERS).map((c) => c.slug).join() === "live_one");
  // THE ASYMMETRY IS THE POINT. Showing both together would make "archived" a decoration instead of
  // a state — the same argument the Threads list makes for its own Archived chip.
  check("...and turning the filter on shows ONLY archived ones, not both",
    filterAgents(all, { ...NO_FILTERS, archived: true }).map((c) => c.slug).join() === "put_away");
}

console.log("\nthe filters and the query compose, filters first");
{
  const all = [
    card({ slug: "webhook_live", health: "failing", deployment: { id: "d", status: "live", url: null, version: 2 } }),
    card({ slug: "webhook_idle", health: "failing" }),
    card({ slug: "other_live", deployment: { id: "d", status: "live", url: null, version: 2 } }),
  ];
  check("status narrows to one health value",
    filterAgents(all, { ...NO_FILTERS, status: "failing" }).length === 2);
  check("deployed narrows to what is serving",
    filterAgents(all, { ...NO_FILTERS, deployed: true }).map((c) => c.slug).join() === "webhook_live,other_live");
  check("...and `false` is not the same as `null`",
    filterAgents(all, { ...NO_FILTERS, deployed: false }).map((c) => c.slug).join() === "webhook_idle");
  check("the query narrows what the filters left",
    filterAgents(all, { ...NO_FILTERS, deployed: true, query: "webhook" }).map((c) => c.slug).join() === "webhook_live");

  const withConnectors = [card({ slug: "a", connectors: ["gmail", "slack"] }), card({ slug: "b", connectors: ["slack"] })];
  check("connector is a membership test, not a match",
    filterAgents(withConnectors, { ...NO_FILTERS, connector: "gmail" }).map((c) => c.slug).join() === "a");
  check("the connector picker offers every connector any agent has, sorted",
    JSON.stringify(connectorOptions(withConnectors)) === JSON.stringify(["gmail", "slack"]));

  const byPerson = [card({ slug: "mine", created_by: "u1" }), card({ slug: "theirs", created_by: "u2" })];
  check("created_by narrows to one person",
    filterAgents(byPerson, { ...NO_FILTERS, createdBy: "u1" }).map((c) => c.slug).join() === "mine");
}

console.log("\nthe two empty states are told apart by whether anything is narrowing the grid");
{
  check("nothing set is not filtered", !hasActiveFilters(NO_FILTERS));
  check("a query alone counts", hasActiveFilters({ ...NO_FILTERS, query: "x" }));
  check("...but a query of spaces does not, because that is mid-typing",
    !hasActiveFilters({ ...NO_FILTERS, query: "  " }));
  check("the archived gate counts as a filter", hasActiveFilters({ ...NO_FILTERS, archived: true }));
  check("the empty state can name what is on",
    JSON.stringify(describeFilters({ ...NO_FILTERS, status: "failing", deployed: true })) ===
      JSON.stringify(["failing", "deployed"]));
}

console.log("\nevery sort is total, so a live update cannot reshuffle the grid");
{
  // Two of everything, identical in the sort key, so only the tiebreak can separate them.
  const same = [
    card({ slug: "zebra", last_run_at: null, spend_7d: null, created_at: "2026-08-01T00:00:00.000Z", name: "Same" }),
    card({ slug: "alpha", last_run_at: null, spend_7d: null, created_at: "2026-08-01T00:00:00.000Z", name: "Same" }),
  ];
  for (const sort of ["active", "name", "created", "spend"] as const) {
    const once = sortAgents(same, sort).map((c) => c.slug).join();
    const twice = sortAgents([...same].reverse(), sort).map((c) => c.slug).join();
    check(`${sort} orders identical agents the same way whichever order they arrive in`,
      once === twice && once === "alpha,zebra", `${once} vs ${twice}`);
  }
}

console.log("\nlast active is the later of a run and a session, and null sorts last");
{
  const ran = card({ slug: "ran", last_run_at: "2026-08-10T00:00:00.000Z", latest_thread: null });
  const talked = card({
    slug: "talked",
    last_run_at: "2026-08-01T00:00:00.000Z",
    latest_thread: { id: "t", title: "t", last_activity_at: "2026-08-17T00:00:00.000Z", last_turn: null },
  });
  const never = card({ slug: "never", last_run_at: null, latest_thread: null });

  check("an agent whose thread moved this morning is more recent than one whose run was last week",
    sortAgents([ran, talked, never], "active").map((c) => c.slug).join() === "talked,ran,never");
  check("...and one with neither sorts last rather than first",
    activeAt(never) === null);
  check("the later of the two is what counts, not whichever field is set",
    activeAt(talked) === "2026-08-17T00:00:00.000Z");
  check("...including when the run is the later one",
    activeAt({ ...talked, last_run_at: "2026-08-18T00:00:00.000Z" }) === "2026-08-18T00:00:00.000Z");
}

console.log("\nspend sorts high to low, and nothing-spent is not zero-spent");
{
  const rows = [
    card({ slug: "cheap", spend_7d: 0 }),
    card({ slug: "none", spend_7d: null }),
    card({ slug: "dear", spend_7d: 4.2 }),
  ];
  // A GENUINE ZERO IS ABOVE AN ABSENCE. `$0.00` means it ran and cost nothing; null means nothing
  // has happened — the same three-state rule the rest of this product applies to a missing figure.
  check("dear, then a genuine zero, then the one with no figure at all",
    sortAgents(rows, "spend").map((c) => c.slug).join() === "dear,cheap,none");
}

console.log("\nname sorts the way somebody reading the control expects");
{
  const rows = [card({ slug: "z", name: "api gateway" }), card({ slug: "a", name: "Zendesk" })];
  check("case does not send Zendesk above api gateway",
    sortAgents(rows, "name").map((c) => c.name).join() === "api gateway,Zendesk");
}

console.log("\nvisibleAgents is filter-then-sort, in that order");
{
  const rows = [
    card({ slug: "b", health: "failing", last_run_at: "2026-08-01T00:00:00.000Z" }),
    card({ slug: "a", health: "failing", last_run_at: "2026-08-17T00:00:00.000Z" }),
    card({ slug: "c", health: "healthy", last_run_at: "2026-08-18T00:00:00.000Z" }),
  ];
  check("the filter decides what is eligible and the sort orders what is left",
    visibleAgents(rows, { ...NO_FILTERS, status: "failing" }, "active").map((c) => c.slug).join() === "a,b");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
