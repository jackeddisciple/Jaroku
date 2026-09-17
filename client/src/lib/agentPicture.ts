// Which picture an agent wears, for the three surfaces whose payload does not carry one.
//
// THREE OF §8.4'S SITES NAME AN AGENT BY SLUG AND NOTHING ELSE. A Cockpit work row carries
// `agent_name`, a fleet card carries `agent_slug`, and the command palette lists agents out of the
// build store. None of those payloads has a column for an identity and none of them should grow one:
// `picture` would be a fourth copy of a fact that changes on one table, and the copies would go
// stale in three different ways.
//
// SO IT IS RESOLVED CLIENT-SIDE, AGAINST THE ONE LIST THAT DOES CARRY IT. `listAgents` is already in
// the store on every surface in the product — the sidebar is built from it — so this is a lookup
// rather than a fetch, and an agent that has been swept answers `undefined`, which renders the
// agent's initial.
//
// A MAP RATHER THAN A `find`, because the Cockpit's work list is virtualised at ten thousand rows
// and the Threads list is unbounded: a linear scan per row over forty agents is the shape of an N+1
// that never shows up in review and is instantly visible in a real workspace.
//
// THIS IS `agentEmoji.ts` WITH ONE WORD CHANGED, which is the point: the three surfaces kept their
// arrangement exactly and only the thing being looked up moved from a glyph to a picture.

import type { AgentSummary } from "../types.ts";

/**
 * Slug → picture id, for one render pass.
 *
 * BUILT BY THE CALLER AND PASSED DOWN, so a list builds it once rather than once per row. The
 * component takes the resolved id; nothing below this line knows about a store.
 */
export function pictureBySlug(agents: readonly AgentSummary[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of agents) if (a.picture) out.set(a.agent_id, a.picture);
  return out;
}
