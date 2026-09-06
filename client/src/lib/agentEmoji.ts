// Which mark an agent wears, for the four surfaces whose payload does not carry one.
//
// FOUR OF §8.4'S SEVEN SITES NAME AN AGENT BY SLUG AND NOTHING ELSE. A thread row carries its
// agent's attribution, a Cockpit work row carries `agent_name`, a fleet card carries `agent_slug`,
// and the command palette lists agents out of the build store. None of those payloads has a column
// for an identity mark and none of them should grow one: `emoji` would be a fifth copy of a fact
// that changes on one table, and the four copies would go stale in four different ways.
//
// SO IT IS RESOLVED CLIENT-SIDE, AGAINST THE ONE LIST THAT DOES CARRY IT. `listAgents` is already
// in the store on every surface in the product — the sidebar is built from it — so this is a lookup
// rather than a fetch, and an agent that has been swept answers `null`, which renders nothing.
//
// A MAP RATHER THAN A `find`, because the Cockpit's work list is virtualised at ten thousand rows
// and the Threads list is unbounded: a linear scan per row over forty agents is the shape of an
// N+1 that never shows up in review and is instantly visible in a real workspace.

import type { AgentSummary } from "../types.ts";

/**
 * Slug → mark, for one render pass.
 *
 * BUILT BY THE CALLER AND PASSED DOWN, so a list builds it once rather than once per row. The
 * component takes the resolved string; nothing below this line knows about a store.
 */
export function emojiBySlug(agents: readonly AgentSummary[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of agents) if (a.emoji) out.set(a.agent_id, a.emoji);
  return out;
}
