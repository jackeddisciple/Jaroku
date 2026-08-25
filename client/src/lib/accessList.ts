// The People section's four pure rules: what order the rows are in, what the search matches, what
// each capability chip means, and what the provenance line says.
//
// A MODULE FOR THE REASON `memberList.ts` IS ONE. Every rule here looks obviously right in a
// screenshot of the four-person workspace somebody tested with, and every one of them has a wrong
// answer that only appears in a case nobody had that day: two people whose capability sets are the
// same size, a search for "deploy" typed by somebody looking for a person rather than a permission,
// a grant that was written before the person's role was reduced under it.
//
// AND BECAUSE THE PROVENANCE LINE IS THE ENTIRE POINT OF THE PANEL. §10.2: "A list of names with
// permission badges is a report. A list that answers WHY each person has what they have —
// inherited from a workspace role, granted specifically here, or capped by their role — is a
// tool." Without it an admin cannot tell whether removing somebody from this agent means revoking
// a grant or changing a workspace role, and will do the wrong one. That sentence is built here,
// once, rather than assembled inline in a row component where each of its four branches would be a
// conditional somebody could get subtly wrong.

import type { AccessPerson } from "../store/accessStore.ts";
import type { AgentCapability } from "./capabilities.ts";

/**
 * §10.3's order: capability breadth descending, then name.
 *
 * BREADTH FIRST, NOT ROLE FIRST, and that is the one place this list deliberately disagrees with
 * the Members panel beside it. `orderMembers` sorts by rank because the question a member list
 * answers is "who can do something about this" and rank is the answer. Here the answer is the
 * effective set — a workspace admin narrowed to `view` on this agent can do less about it than a
 * member granted `deploy`, and a list that put the admin first would be sorted by a fact that is
 * true somewhere else.
 *
 * ROLE IS THE FIRST TIE-BREAK, which is what "owners first, viewers last" means once breadth has
 * had its say: among people who can do the same things here, the workspace's own hierarchy is the
 * next most useful ordering.
 *
 * AND THE NAME LAST, from the string the row actually SHOWS — `display_name || email` — for the
 * reason `orderMembers` gives: sorting a nameless person by `display_name ?? ""` puts them at the
 * top of their group under a blank key, which reads as a bug rather than as an ordering.
 * `localeCompare` at base sensitivity, because plain `<` is byte order and puts every capitalised
 * name above every lowercase one. Tie-broken by `user_id` so two identical rows never swap places
 * between snapshots.
 */
export function orderAccess(people: readonly AccessPerson[]): AccessPerson[] {
  const rank = (role: string | null): number =>
    role === "owner" ? 0 : role === "admin" ? 1 : role === "member" ? 2 : 3;
  const label = (p: AccessPerson): string => p.display_name || p.email || "";
  return [...people].sort(
    (a, b) =>
      b.capabilities.length - a.capabilities.length ||
      rank(a.role) - rank(b.role) ||
      label(a).localeCompare(label(b), undefined, { sensitivity: "base" }) ||
      a.user_id.localeCompare(b.user_id),
  );
}

/**
 * §10.3's search: by name AND by capability, in one field.
 *
 * ONE FIELD FOR BOTH, which is the decision worth stating. The obvious design is a search box plus
 * a capability filter, and it is worse for the question this panel is opened to answer: "who can
 * deploy this" is one word, and making somebody find a dropdown for it turns a glance into a
 * navigation. Typing `deploy` shows everybody who can deploy; typing `sam` shows Sam. Neither
 * reading is ambiguous, because no person is named after a capability and none of the seven is a
 * name.
 *
 * IT MATCHES THE EFFECTIVE SET, not the granted one. Somebody whose grant says `deploy` and whose
 * role has capped it away must NOT appear under a search for deploy — they cannot deploy, and a
 * list that showed them would be answering with the row's history rather than with its state.
 * Their row still says "capped by role" when it is on screen for another reason, which is where
 * that fact belongs.
 */
export function matchesAccess(person: AccessPerson, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if ((person.display_name ?? "").toLowerCase().includes(q)) return true;
  if (person.email.toLowerCase().includes(q)) return true;
  if ((person.role ?? "").toLowerCase().includes(q)) return true;
  return person.capabilities.some((c) => c.toLowerCase().includes(q));
}

/**
 * How one capability chip on a row should be drawn. §10.2's two treatments plus the capped case.
 *
 * `role`    — it comes from the workspace role. Neutral, no mark.
 * `granted` — it was given here specifically. Accented, prefixed `+`.
 * `capped`  — the grant asked for it and the role does not allow it. Struck, with a reason.
 *
 * §17 — NOT COLOUR-ONLY, AND THAT IS WHY THIS RETURNS A KIND RATHER THAN A COLOUR. Granted carries
 * a `+` and capped carries an icon and a tooltip, so the three are distinguishable with no colour
 * perception at all. A function that answered "which colour" would make the mark an afterthought
 * at each of the call sites that had to remember it.
 */
export type ChipKind = "role" | "granted" | "capped";

export function chipKindFor(person: AccessPerson, capability: string): ChipKind {
  if (person.capped.includes(capability)) return "capped";
  if (person.fromRole.includes(capability)) {
    // Held by the role AND named in a grant is still `role`: revoking the grant would not take it
    // away, so marking it `+` would tell an admin that a revocation removes something it does not.
    return "role";
  }
  return "granted";
}

/**
 * Every capability worth drawing a chip for, in the panel's own order.
 *
 * THE EFFECTIVE SET PLUS WHATEVER THE ROLE CAPPED. A row showing only what somebody can do would
 * be silent about the most confusing case in the whole panel — a grant that says `deploy` on a
 * person who cannot deploy — and an admin looking at it would conclude the grant is working.
 */
export function chipsFor(
  person: AccessPerson,
  order: readonly AgentCapability[],
): { capability: string; kind: ChipKind }[] {
  const shown = new Set<string>([...person.capabilities, ...person.capped]);
  return order
    .filter((c) => shown.has(c))
    .map((capability) => ({ capability, kind: chipKindFor(person, capability) }));
}

/**
 * §10.2's provenance line — the sentence that makes this a tool rather than a report.
 *
 * FOUR SHAPES, one per way somebody can have what they have, and each names the thing an admin
 * would have to change:
 *
 *   "from workspace role"                 — change their role, in the Members panel. Not here.
 *   "granted here by Priya · 3 days ago"  — revoke or edit the grant. Here.
 *   "granted here … · expires in 6 hours" — the same, plus when it stops by itself.
 *   "no longer in this workspace"         — the grant is inert; re-inviting would revive it.
 *
 * THE EXPIRED CASE READS AS THE ROLE ONE, deliberately, because that is what it now IS: an expired
 * grant falls back to the workspace role's default set, so a line saying "granted here" would
 * describe a row whose capabilities no longer come from the grant. It says the grant expired
 * instead, which is the fact that explains why the row changed.
 *
 * RELATIVE TIME IS TAKEN AS A PARAMETER rather than imported, so this module stays free of the
 * client's formatting layer and can be exercised by a suite with no clock of its own.
 */
export function provenanceLine(
  person: AccessPerson,
  relTime: (iso: string) => string,
): string {
  if (person.role === null) return "no longer in this workspace";
  if (person.provenance === "expired") {
    return person.expires_at
      ? `their grant expired ${relTime(person.expires_at)} — back to their workspace role`
      : "their grant has expired — back to their workspace role";
  }
  if (person.provenance !== "grant") return "from workspace role";

  const by = person.granted_by_name ? ` by ${person.granted_by_name}` : "";
  const when = person.granted_at ? ` · ${relTime(person.granted_at)}` : "";
  const until = person.expires_at ? ` · expires ${relTime(person.expires_at)}` : "";
  return `granted here${by}${when}${until}`;
}

/**
 * §10.2's second line, for a row whose role caps its grant. Empty when nothing was capped.
 *
 * NAMED, NOT COUNTED. "2 capabilities capped" is a number somebody has to go and investigate;
 * "their workspace role caps this at view, run, edit, eval" is the answer, and it also says which
 * role change would lift the cap without anybody having to work out what a member may hold.
 */
export function cappedLine(person: AccessPerson): string {
  if (person.capped.length === 0) return "";
  const held = person.capabilities.length ? person.capabilities.join(", ") : "nothing";
  return `their ${person.role ?? "workspace"} role caps this at ${held}`;
}

/**
 * §11.4's guards, answered for one row: may this person's grant be revoked from here?
 *
 * THE CONTROL DISABLES WITH A REASON RATHER THAN DISAPPEARING, which is the one place in this
 * whole feature that deliberately breaks §8's absent-not-disabled rule — and the exception is
 * argued in §11.4 rather than invented here. §8 is about AUTHORITY: a control a role may never use
 * is absent, because offering it tells somebody a feature exists for them when it exists for
 * somebody else. This is not that. The admin looking at it holds the authority; what stops them is
 * a STATE — this person is the last administrator — and a control that vanished on a state would
 * read as "there is nothing to revoke here", which is the opposite of what is true.
 *
 * THE LAST-ADMIN COUNT IS OVER EFFECTIVE ACCESS, not over grant rows, because most people who
 * administer an agent do so through their workspace role and have no grant at all. The server
 * refuses on the same basis; this is the client saying so before the click rather than after it.
 */
export function revokeBlockedReason(
  person: AccessPerson,
  everyone: readonly AccessPerson[],
): string | null {
  if (!person.capabilities.includes("admin")) return null;
  const otherAdmins = everyone.filter(
    (p) => p.user_id !== person.user_id && p.capabilities.includes("admin"),
  );
  if (otherAdmins.length > 0) return null;
  return "this is the last person who can manage access to this agent — grant admin to somebody else first";
}
