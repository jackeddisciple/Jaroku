// The members list's two pure rules: what order the rows are in, and what colour each person is.
//
// A MODULE FOR THE SAME REASON `workspaceList.ts` IS ONE. Both of these look obviously right in a
// screenshot of the four-person workspace somebody tested with, and both have a wrong answer that
// only appears in a case nobody had that day — two admins whose names differ by case, a person
// with no display name whose row therefore sorts by an email address the list is not showing, a
// colour that is stable within a session and moves on the next deploy.

import { hash32 } from "./agentArt.ts";

/** What the members list needs of a member. The store's row is wider; this is the part that sorts. */
export interface Sortable {
  user_id: string;
  role: string;
  email: string;
  display_name: string | null;
}

/**
 * §6.2's order: the owner first, then admins, then members, each group alphabetical.
 *
 * BY RANK AND THEN BY NAME, and the rank has to come first rather than being a tiebreak, because
 * the question this list answers most often is "who can do something about this" — and a list
 * sorted by name alone makes that a scan of every row. Three groups, so a person can stop reading
 * at the top when the answer is "the owner".
 *
 * THE SORT KEY IS THE STRING THE ROW SHOWS. A member with no display name renders their email, so
 * sorting them by email is sorting them by what is on screen; sorting by `display_name ?? ""` would
 * put every nameless person at the top of their group under a blank key, which reads as an
 * ordering bug rather than as an ordering.
 *
 * `localeCompare` at base sensitivity for the reason `orderWorkspaces` uses it: plain `<` is byte
 * order, which puts every capitalised name above every lowercase one. Tie-broken by `user_id`, so
 * two people genuinely named the same do not swap places between snapshots.
 */
export function orderMembers<T extends Sortable>(members: readonly T[]): T[] {
  const rank = (role: string): number => (role === "owner" ? 0 : role === "admin" ? 1 : 2);
  const label = (m: Sortable): string => m.display_name || m.email || "";
  return [...members].sort(
    (a, b) =>
      rank(a.role) - rank(b.role) ||
      label(a).localeCompare(label(b), undefined, { sensitivity: "base" }) ||
      a.user_id.localeCompare(b.user_id),
  );
}

/**
 * The avatar palette. Eight colours, none of which is a token from `tokens.ts`.
 *
 * THAT ABSENCE IS THE DESIGN. `ACCENT` spends its colours on what a thing IS — reviewed, bespoke,
 * state, MCP — `STATUS` spends its on how a thing is DOING, and `INTERACTION.accent` is reserved
 * for "this one, right now". A person is none of those, and borrowing from any of the three would
 * put a colour with an established meaning on a row where it means nothing: a member who happened
 * to hash to amber would be wearing the colour this product has decided means RUNNING.
 *
 * SO THEY ARE OFF-PALETTE ON PURPOSE, and low-saturation so that a column of eight of them reads
 * as a list rather than as a set of badges. They are hex rather than Tailwind classes for the
 * reason `ACCENT` is: a class name cannot be handed to an inline style, and this one is computed.
 *
 * EIGHT, NOT SIXTEEN. At 2-6 people per team a collision inside one workspace is possible and
 * harmless — the letter and the name are what identify somebody; the colour is what makes the row
 * findable again after you have seen it once. More colours would buy a smaller collision rate in a
 * list nobody scrolls, at the cost of several that are hard to tell apart.
 */
// EACH ONE DEEPENED FOR THE LIGHT SYSTEM, and the reason is the letter rather than the fill. These
// are backgrounds with a near-white glyph on top, so what has to hold is the contrast between the
// swatch and that glyph — and eight mid-tones chosen against a near-black page were chosen with a
// dark letter's worth of room to spare. The hues and the "low-saturation, off-palette" argument
// above are unchanged; every step is the same colour with the light taken out of it.
export const AVATAR_COLORS = [
  "#5C6F95", // slate blue
  "#6A7A4D", // moss
  "#956B4D", // clay
  "#7B5F88", // mauve
  "#4D7A77", // teal-grey
  "#886B4D", // sand
  "#6B5F95", // periwinkle-grey
  "#83515F", // rose-grey
] as const;

/**
 * The colour for one person, from a stable hash of their user id.
 *
 * THE USER ID, NOT THE EMAIL OR THE NAME, and it is the same argument `artFor` makes about taking
 * the agent uuid rather than the slug: a display name changes the first time somebody fills in the
 * onboarding screen, and an address changes when somebody's company renames its domain. Either
 * would move the colour under a person their teammates have learned to recognise, which is the one
 * thing this is for.
 *
 * `hash32` is FNV-1a, shared with the agent gradients rather than reimplemented — §6.2 asks for
 * "the same FNV-1a approach", and two copies of a hash is two places for the `>>> 0` to be missing.
 */
export function avatarColor(userId: string): string {
  return AVATAR_COLORS[hash32(userId) % AVATAR_COLORS.length]!;
}

/**
 * The letter in the square: the first character of whatever the row is showing.
 *
 * FROM THE SAME STRING THE ROW RENDERS, so the initial and the name beneath it cannot disagree —
 * a `J` over "ada@example.com" is what happens when the letter comes from a display name the row
 * has fallen back away from.
 */
export function avatarLetter(member: Pick<Sortable, "display_name" | "email">): string {
  return (member.display_name || member.email || "?").trim().charAt(0).toUpperCase() || "?";
}
