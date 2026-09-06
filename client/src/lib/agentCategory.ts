// Which category an agent is in, for the surfaces whose payload names it by slug and nothing else.
//
// EXACTLY THE ARRANGEMENT `agentEmoji.ts` USES, next door, and for the same reason. A thread row
// carries its agent's attribution and a Cockpit work row carries `agent_name`; neither payload has
// a column for a category and neither should grow one — it would be a third copy of a fact that
// changes on one table, and the copies would go stale in three different ways.
//
// SO IT IS RESOLVED CLIENT-SIDE, AGAINST THE ONE LIST THAT DOES CARRY IT. `listAgents` is in the
// store on every surface in the product, so this is a lookup rather than a fetch, and an agent that
// has been swept answers `null` and renders nothing.
//
// A MAP RATHER THAN A `find`, because the Cockpit's work list is virtualised at ten thousand rows
// and the Threads list is unbounded: a linear scan per row over forty agents is the shape of an N+1
// that never shows up in review and is instantly visible in a real workspace.

import { showsCategory } from "./agentCategories.ts";
import type { AgentSummary } from "../types.ts";

/**
 * Slug → category, for one render pass, with `Uncategorized` left out.
 *
 * THE NEUTRAL VALUE IS ABSENT RATHER THAN PRESENT, which is §7's sidebar rule applied everywhere the
 * category is shown beside a name. An agent nobody has categorised should read as a name, and a
 * column of "· Uncategorized" down a list is noise that says nothing about any row in it — most
 * loudly on the day this ships, when every agent is in it.
 */
export function categoryBySlug(agents: readonly AgentSummary[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of agents) if (showsCategory(a.category)) out.set(a.agent_id, a.category);
  return out;
}
