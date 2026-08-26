// §15's History section — which audit rows belong to an agent's access, and what each one says.
//
// A MODULE RATHER THAN THREE THINGS INSIDE `index.ts`, and the reason is the one `deepLink.ts`
// gives on the client: a rule that can only be exercised by starting the whole application is a
// rule nobody exercises. `index.ts` constructs a server on import — a suite that reached in for
// this would boot a listener to ask what a sentence reads like — so the sentence lived where the
// only available assertion was a regular expression run over the source text. That is a test of the
// spelling, not of the answer, and it is how `metadata.user` came to be printed as a uuid for a
// whole release: every assertion about that line passed, because every assertion was about the file
// rather than about the string.
//
// NOTHING HERE TOUCHES THE DATABASE OR THE CONTEXT. It is given rows that have already been read
// under a tenant context and a way to turn a user id into a name, and it decides two things: which
// rows are about this agent, and how each reads. Keeping it that shape is what lets a suite hand it
// a fabricated row and assert the sentence.

import { AGENT_CAPABILITIES } from "./capabilities.ts";

/**
 * The agent-scoped actions this section shows.
 *
 * These carry the agent's id in `target_id`, which is what makes them filterable to one agent —
 * see `belongsToAgent` below for the shape that id takes.
 */
export const ACCESS_HISTORY_AGENT = new Set([
  "access.granted", "access.modified", "access.revoked", "access.expired",
  "access.denied", "access.session_ended",
]);

/**
 * The workspace-wide actions that change what somebody can reach on an agent.
 *
 * NAMED RATHER THAN PATTERN-MATCHED. "Anything starting with member." would sweep in rows this
 * section has no business showing and, worse, would silently stop matching the day somebody renamed
 * an action — a history that quietly shows less is one nobody notices is broken.
 */
export const ACCESS_HISTORY_WORKSPACE = new Set([
  "member.added", "member.removed", "member.role_changed", "member.left",
  "member.invite", "invite.accepted", "invite.revoked",
]);

/** Whether an audit row belongs in this agent's history at all, and at which scope. */
export function accessHistoryScope(action: string): "workspace" | "agent" | null {
  if (ACCESS_HISTORY_WORKSPACE.has(action)) return "workspace";
  if (ACCESS_HISTORY_AGENT.has(action)) return "agent";
  return null;
}

/**
 * Whether an agent-scoped row is about THIS agent.
 *
 * `access.granted` files under `<agentId>:<userId>` and `access.denied` under the agent id alone,
 * so the prefix is what both have in common — and a `startsWith` on a uuid cannot collide.
 */
export function belongsToAgent(targetId: unknown, agentId: string): boolean {
  return String(targetId ?? "").startsWith(agentId);
}

/**
 * One audit row, as the sentence §15 asks a row to be.
 *
 * THE SUBJECT IS RESOLVED HERE AND STORED AS AN ID, and the split is deliberate rather than
 * incidental. An audit row that stored "Priya Raman" would be a record of who somebody was called
 * on the day it was written — it would survive a rename as a lie, and it would answer "which
 * account" with a string two accounts can share. So the row keeps the id, and the READING resolves
 * it, which is the same division the actor's name already makes.
 *
 * IT WAS PRINTING THE ID. `metadata.user` has always been a uuid and this read it as though it
 * were a name, so §15's sentence came out as "granted 5935135b-c901-4861-ad62-cb6b199a276a view" —
 * a line whose one job is to let somebody recognise a change they did not make, spelling the person
 * as the one string nobody recognises.
 *
 * CAPABILITIES COME OUT IN THE PANEL'S ORDER, not in the order they were stored. What is stored is
 * the closure — a grant of `edit` arrives as `deploy, view, edit, run` — and a history line listing
 * them in a different order from the chips two sections above it reads as a different set.
 */
export function accessHistoryLine(
  action: string,
  metadata: Record<string, unknown>,
  nameOf: (userId: string | null) => string,
): string {
  const who = typeof metadata["user"] === "string" ? nameOf(String(metadata["user"])) : null;
  const stored = Array.isArray(metadata["capabilities"]) ? (metadata["capabilities"] as string[]) : null;
  const caps = stored ? orderCapabilities(stored).join(", ") : null;
  switch (action) {
    case "access.granted":
      return `granted ${who ?? "somebody"}${caps ? ` ${caps}` : ""}`;
    case "access.modified":
      return `changed ${who ?? "somebody"}'s access${caps ? ` to ${caps}` : ""}`;
    case "access.revoked":
      return `revoked ${who ?? "somebody"}'s grant`;
    case "access.expired":
      return `${who ?? "somebody"}'s grant expired`;
    case "access.denied":
      // THE HIGHEST-SIGNAL ROW IN THE SECTION, and it names the capability that was missing rather
      // than only the command — "cannot deploy" is the fixable fact; "deploy was refused" is not.
      return `refused ${String(metadata["cmd"] ?? "a command")} — no "${String(metadata["capability"] ?? "capability")}"`;
    case "access.session_ended":
      return "ended a session";
    default:
      // The workspace rows, whose metadata belongs to the membership surface rather than to this
      // one. The action IS the sentence there, spelled without its prefix.
      return action.replace(/^[a-z]+\./, "").replace(/_/g, " ");
  }
}

/**
 * Capabilities in the order the panel draws them, with anything unrecognised kept at the end.
 *
 * KEPT RATHER THAN DROPPED. A capability this build does not know is one an older or newer one
 * wrote, and a history that silently omitted it would describe a grant as narrower than it was —
 * which is the wrong direction for the one surface somebody reads to find a grant that is too wide.
 */
function orderCapabilities(caps: readonly string[]): string[] {
  const rank = (c: string): number => {
    const at = (AGENT_CAPABILITIES as readonly string[]).indexOf(c);
    return at === -1 ? AGENT_CAPABILITIES.length : at;
  };
  return [...caps].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
