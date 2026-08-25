// The order the switcher lists workspaces in, and the two numbers that decide how it is drawn.
//
// A MODULE RATHER THAN A `.sort()` INSIDE THE COMPONENT, for the reason `threadGroups.ts` and
// `inboxBoard.ts` are modules: an arrangement rule looks obviously right in a screenshot and is
// wrong in the case nobody had that day. The cases here are a workspace whose name differs from
// another's only by case, a workspace named with a leading digit, and — the one that actually
// happens — an account with no personal workspace at all, which the product says cannot exist and
// which a client is nonetheless holding a list from a server about.
//
// NOTHING HERE READS A STORE. It takes the list and answers with a list, so a suite can put four
// workspaces in and read the order out without a React tree, a socket or a session.

import type { SessionWorkspace } from "./auth.ts";

/**
 * §2.3 — the dropdown does not scroll below this many workspaces.
 *
 * EIGHT, AND THE SPEC GIVES THE REASONING RATHER THAN THE NUMBER BEING A TASTE: "at 25-30 teams of
 * 2-6 people, no individual will be in more than 3-4 workspaces". So the scrolling branch is the
 * one nobody will see, and the default is a list that is entirely visible — which matters because
 * a menu that scrolls at four items hides the two actions underneath it, and those are how a
 * workspace gets created or joined in the first place.
 */
export const SCROLL_AFTER = 8;

/** Whether the list needs its own scroll region. See `SCROLL_AFTER`. */
export function shouldScroll(count: number): boolean {
  return count > SCROLL_AFTER;
}

/**
 * §2.2's order: the personal workspace first, then the teams alphabetically.
 *
 * PERSONAL FIRST BECAUSE IT IS THE ONE THAT IS ALWAYS THERE. Every account has exactly one,
 * created in the same transaction as the user, and it is where somebody lands when they leave a
 * team or when a team is deleted under them. A list that sorted it among the teams would move the
 * one fixed point in the menu every time a workspace was renamed.
 *
 * `localeCompare` WITH `sensitivity: "base"` FOR THE TEAMS, not `<`. Two facts about the plain
 * comparison make it wrong here rather than merely unusual: it is byte order, so every capitalised
 * name sorts above every lowercase one — "Acme", "Zebra", "acme co" — which reads as no ordering at
 * all to somebody scanning for a name; and it does not know that "Ångström" belongs next to "A".
 * Base sensitivity also makes the comparison stable under a rename that only changes case.
 *
 * TIE-BROKEN BY ID, because `localeCompare` returning 0 for two workspaces genuinely named the
 * same thing would leave their order to `sort`'s stability over whatever order the session
 * happened to serialise them in — and a menu whose two "Design" rows swap places between reloads
 * is one where somebody clicks the wrong one.
 */
export function orderWorkspaces(workspaces: readonly SessionWorkspace[]): SessionWorkspace[] {
  const personal = workspaces.filter((w) => w.kind === "personal");
  const rest = workspaces.filter((w) => w.kind !== "personal");
  const byName = (a: SessionWorkspace, b: SessionWorkspace): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
  // The personal ones are sorted too. There is meant to be exactly one — `adoptWorkspace`
  // guarantees at most one — and "meant to be" is not a reason to leave two in an order the
  // server happened to answer in.
  return [...personal.sort(byName), ...rest.sort(byName)];
}

/**
 * The role, in the word a person reads.
 *
 * THE SERVER'S VALUE IS LOWERCASE AND IS AN IDENTIFIER: `owner`, `admin`, `member`. Capitalising
 * it at the point of render rather than storing a second label is the same rule the plan chip
 * follows for the opposite reason — the plan's label comes from the server because it encodes a
 * pricing decision, and the role's does not, because a role is one of three words that will not
 * change and a second table for them would be a translation nobody maintains.
 *
 * An unrecognised value is passed through rather than replaced. A role the client does not know is
 * a server that has grown a fourth one, and rendering "Member" over it would be a lie about what
 * somebody can do.
 */
export function roleLabel(role: string): string {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : "";
}
