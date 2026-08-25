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
import { can, canRun, ROUTE_CAPABILITY } from "./capabilities.ts";

/**
 * Whether this account holds a capability in the current workspace.
 *
 * `useCapability("connector:manage") && <ConnectButton />` — §8.1's own shape. Prefer
 * `useCanRun` where the affordance sends a command; this one is for the surfaces that do not, and
 * for a guard over several controls that share one capability.
 */
export function useCapability(capability: string): boolean {
  const role = useSessionStore((s) => s.role());
  return can(role, capability);
}

/**
 * Whether this account may send a command.
 *
 * THE ONE TO REACH FOR. `useCanRun("deploy")` names the thing the button does; `useCapability(
 * "deploy:manage")` names a conclusion somebody drew about it, and a wrong conclusion looks
 * exactly as plausible in review as a right one. §8.2's own checklist files Deploy under
 * `agent:write`, which is a member capability — every member in every team would have seen a
 * Deploy button that 403s — and that is the mistake this signature removes rather than documents.
 */
export function useCanRun(cmd: string): boolean {
  const role = useSessionStore((s) => s.role());
  return canRun(role, cmd);
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
