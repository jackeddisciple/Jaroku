// Which agents the composer's chooser offers before anybody types.
//
// THE ONES LAST WORKED IN — the product owner's call on 2026-09-10. With no agent chosen, the tray
// behind the composer says "Choose agent", and its dropdown opens on a search box and the two most
// recent agents; everything else is a search away. It never chooses for you: nothing is selected
// until somebody picks a row.
//
// "Last worked in" is the rule `lib/selection.ts` uses to pick an agent's session and the server
// uses in `ThreadStore.ensureForAgent`: the latest activity on an unarchived thread. An agent with
// no session yet ranks below every agent that has one, newest first, so a workspace of freshly
// generated agents still offers the last ones made.
//
// Pure, so the order is a suite rather than something checked by opening the dropdown.
//
//   npm run test:recent-agent

import type { AgentSummary, ThreadView } from "../types.ts";

/** Every listed agent's id, the one last worked in first. */
export function recentAgents(
  agents: readonly Pick<AgentSummary, "agent_id" | "created_at">[],
  threads: readonly Pick<ThreadView, "agent_id" | "archived_at" | "last_activity_at">[],
): string[] {
  const lastActive = new Map<string, string>();
  for (const t of threads) {
    if (t.archived_at !== null || t.agent_id === null) continue;
    const seen = lastActive.get(t.agent_id);
    if (!seen || t.last_activity_at > seen) lastActive.set(t.agent_id, t.last_activity_at);
  }
  return agents
    .map((a, i) => ({ id: a.agent_id, at: lastActive.get(a.agent_id) ?? null, created: a.created_at ?? "", i }))
    .sort((x, y) =>
      // Worked in outranks never worked in; then the latest activity; then the newest; then list order.
      (x.at === null ? 1 : 0) - (y.at === null ? 1 : 0)
      || (y.at ?? "").localeCompare(x.at ?? "")
      || y.created.localeCompare(x.created)
      || x.i - y.i)
    .map((r) => r.id);
}
