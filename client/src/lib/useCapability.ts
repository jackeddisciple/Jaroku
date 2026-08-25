// §8.1's three hooks: what this account may do in the workspace this tab is in.
//
// SEPARATE FROM `capabilities.ts`, which holds the table, because the table has to be importable
// without React or a store. `test:permission-ui` reads it under `tsx` and compares it against the
// server's own source; a module that pulled in `useSessionStore` on the way would drag the session
// vault and `import.meta.env` behind it, which is the trap `lib/auth.ts`'s `viteEnv` exists to
// avoid one level down.
//
// THE ROLE IS SUBSCRIBED TO, NOT READ ONCE. `revalidateAll` updates a socket's role in place once
// a minute without reconnecting — a promotion or a demotion arrives mid-session and does not close
// anything — so a component that resolved its role at mount would keep offering an admin's
// controls to somebody who stopped being one twenty minutes ago, until they happened to reload.
// Reading it through the store selector is what makes the demotion visible on the next render.
//
// WHAT THESE DECIDE IS WHAT TO RENDER, never what is allowed. Every command is checked again by
// the relay against the same table and every route checks at its door — see capabilities.ts. §8
// asks for an affordance a role cannot use to be ABSENT from the DOM rather than disabled or
// hidden, and these are what an affordance asks in order to be absent.

import { useSessionStore } from "../store/sessionStore.ts";
import { useAccessStore } from "../store/accessStore.ts";
import {
  agentCapabilityFor, agentCeiling, can, canRun, effectiveAgentCapabilities, isAgentCapability,
  ROUTE_CAPABILITY,
  type AgentCapability,
} from "./capabilities.ts";

/**
 * Whether this account holds a capability — in the workspace, or on ONE AGENT.
 *
 * ONE FUNCTION WITH AN OPTIONAL SECOND ARGUMENT, AND NOT A SECOND HOOK. A `useAgentCapability`
 * would be the two-resolver drift the whole per-agent feature exists to prevent, one layer out from
 * the server where the same rule is written: two things that answer "may this person" will
 * eventually disagree, and the one that drifts OPEN is the one nobody reports, because nothing
 * fails. So the signature widened rather than forking.
 *
 * WITHOUT `agentId` — the workspace-level check, unchanged, and every existing call site keeps
 * meaning exactly what it meant. `useCapability("connector:manage")` is still §8.1's own shape.
 *
 * WITH `agentId` — the same resolution the server makes: the workspace role's ceiling, narrowed or
 * widened by whatever grant `loadAccess` returned, closed under implication. The vocabularies are
 * disjoint on purpose — `deploy:manage` is a workspace capability and `deploy` is an agent one — so
 * a call that passed the wrong string with the wrong argument answers `false` rather than
 * accidentally answering something.
 *
 * AND WHEN NO GRANT HAS BEEN FETCHED, it falls back to the WORKSPACE-level check rather than to
 * `false`. §8.2's rule, and the direction is the safe one: the pane has only just opened,
 * `loadAccess` has not answered, and affordances appear at their workspace default until it does —
 * possibly narrowing a moment later. Briefly showing a button that will be removed costs one
 * refused click; briefly hiding one that should be there is a feature somebody concludes is not in
 * the product. The server enforces regardless, which is what makes the choice available at all.
 */
export function useCapability(capability: string, agentId?: string | null): boolean {
  const role = useSessionStore((s) => s.role());
  // SUBSCRIBED, NOT READ ONCE, for the reason the role is: a teammate can write a grant while this
  // tab is open, the recheck empties this map, and the next `loadAccess` refills it — a component
  // that read the store imperatively would keep rendering the answer it got at mount.
  const grant = useAccessStore((s) => (agentId ? s.byAgent[agentId]?.viewer ?? null : null));
  if (!agentId) return can(role, capability);
  // Not an agent capability at all — a workspace capability passed with an agent id, or a typo.
  // Answered as false rather than falling through to the workspace check, because a guard written
  // that way is asking a question about an agent and must not be answered about a workspace.
  if (!isAgentCapability(capability)) return false;
  // The fallback. `null` is "not fetched"; an empty array is a real narrowing grant.
  if (grant === null) return workspaceFallbackFor(role, capability);
  return effectiveAgentCapabilities(role, grant).has(capability);
}

/**
 * What a workspace role alone would answer for an agent capability, before any grant has landed.
 *
 * IT ASKS THE CEILING, which is the only honest answer available at that moment: with no grant
 * fetched, a person's effective set IS their role's default set — that is step 2 of the server's
 * resolver, and it is what the server itself would answer for somebody with no grant row.
 */
function workspaceFallbackFor(role: string | null, capability: AgentCapability): boolean {
  return agentCeiling(role).has(capability);
}

/**
 * Whether this account may send a command — in the workspace, or against ONE AGENT.
 *
 * THE ONE TO REACH FOR. `useCanRun("deploy", agent.id)` names the thing the button does;
 * `useCapability("deploy", agent.id)` names a conclusion somebody drew about it, and a wrong
 * conclusion looks exactly as plausible in review as a right one. §8.2's own checklist files
 * Deploy under `agent:write`, which is a member capability — every member in every team would have
 * seen a Deploy button that 403s — and that is the mistake this signature removes rather than
 * documents.
 *
 * BOTH GATES, IN SERIES, when an agent is named: the workspace capability the command needs AND the
 * agent capability it needs. That mirrors the relay, which asks both at one dispatch point — and
 * it matters for exactly the commands where the two differ, like the GitHub writes, which are an
 * admin's at the workspace scope and `deploy` at the agent scope.
 *
 * A COMMAND THAT IS NOT AGENT-SCOPED IGNORES THE ID rather than refusing. `listAgents` passed an
 * agent id is still a workspace read, and answering `false` for it would make the argument a trap:
 * a caller threading `agent.id` through a helper would silently lose affordances that have nothing
 * to do with any agent.
 */
export function useCanRun(cmd: string, agentId?: string | null): boolean {
  const role = useSessionStore((s) => s.role());
  const grant = useAccessStore((s) => (agentId ? s.byAgent[agentId]?.viewer ?? null : null));
  if (!canRun(role, cmd)) return false;
  const agentCapability = agentId ? agentCapabilityFor(cmd) : undefined;
  if (!agentCapability) return true;
  if (grant === null) return workspaceFallbackFor(role, agentCapability);
  return effectiveAgentCapabilities(role, grant).has(agentCapability);
}

/**
 * Whether this account may reach one of the HTTP surfaces §8.2 lists that are not commands.
 *
 * The key is a name from `ROUTE_CAPABILITY` rather than a path, because a path is a thing that
 * gets renamed and a surface is not: `useCanReach("workspaceExport")` still means the same thing
 * the day the route moves.
 */
export function useCanReach(route: keyof typeof ROUTE_CAPABILITY): boolean {
  const role = useSessionStore((s) => s.role());
  const capability = ROUTE_CAPABILITY[route];
  return capability === undefined ? false : can(role, capability);
}

/**
 * Whether this account may take an action named by `ACTION_COMMAND`-style key.
 *
 * TWO KINDS OF KEY THROUGH ONE HOOK, because the Inbox's actions are a mix of both and a card
 * cannot know which: `__route:secretWrite` names an HTTP surface, anything else names a command.
 * The prefix is ugly on purpose — it is a discriminator in a table, not a string anybody types —
 * and the alternative was two parallel tables on the Inbox with the same keys, which is the shape
 * that goes out of step.
 *
 * AN UNKNOWN KEY IS REFUSED, which is what makes the table's own default safe: an Inbox action
 * added later with no entry answers `undefined` here and the card renders nothing, rather than
 * offering a fix that 403s.
 */
export function useCanTake(key: string | undefined): boolean {
  const role = useSessionStore((s) => s.role());
  const routeKey = key?.startsWith("__route:") ? key.slice("__route:".length) : null;
  const routeCapability = routeKey ? ROUTE_CAPABILITY[routeKey] : undefined;
  if (routeKey) return routeCapability === undefined ? false : can(role, routeCapability);
  return canRun(role, key ?? "");
}

/**
 * §8.3's toast — the role a refusal names, or null when it was not a role refusal.
 *
 * IT READS THE SERVER'S ANSWER RATHER THAN RE-DERIVING ONE. §13.5 puts `reason: "requires_role"`
 * and `role` on the refusal precisely so this does not have to guess, and guessing would be wrong
 * in the case that matters: a client whose matrix has drifted would explain a refusal it did not
 * predict by consulting the same table that failed to predict it.
 *
 * A SAFETY NET, NOT A FLOW. §8.3 is explicit: "If both gates are correctly implemented (affordance
 * absent for wrong role, UpsellCard for wrong tier), neither toast should ever appear in normal
 * use." Seeing one means an affordance was rendered that should not have been, which is a bug in
 * whichever surface rendered it.
 */
export function refusedRole(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as { reason?: unknown; role?: unknown };
  if (m.reason !== "requires_role") return null;
  return typeof m.role === "string" && m.role ? m.role : null;
}
