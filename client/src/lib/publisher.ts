// Who published a version, by name.
//
// ONE LOOKUP FOR THE TWO PLACES THAT SAY IT — the agent's version history and the Graph tab's version
// menu — so they cannot drift. A name only in a team workspace and only for a member: a server-made
// publish, or a person who has left, is nobody this can name, and is not shown as "?".

import { useAgentGridStore } from "../store/agentGridStore.ts";
import { useMemberStore } from "../store/memberStore.ts";

export function usePublisherOf(): (userId: string | null) => string | null {
  const team = useAgentGridStore((s) => s.team);
  const members = useMemberStore((s) => s.members);
  return (userId) => {
    if (!team || !userId) return null;
    const m = members.find((x) => x.user_id === userId);
    return m ? (m.display_name || m.email || null) : null;
  };
}
