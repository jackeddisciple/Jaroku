// The rules the board is arranged by, as pure functions with a suite.
//
// EVERYTHING HERE LOOKS OBVIOUSLY RIGHT IN A SCREENSHOT AND IS WRONG IN THE CASE NOBODY HAD THAT
// DAY, which is this codebase's stated reason for pulling a view's decisions out into their own
// module: `threadGroups`, `threadFilter`, `agentTags` and `agentFilter` all exist for it. The
// filter that quietly drops a column, the age bar that fills instantly because one item is old, the
// tray line that says "next returns in -3h" — none of those is visible in a happy-path render.
//
// WHAT IS DELIBERATELY NOT HERE: which column a card is in, what its subject line says, and what may
// be done about it. All three are the server's, because all three are facts rather than renderings.

import type { InboxItemView, InboxSeverity } from "../types.ts";

/** §5.1's filters, in the order the rail lists them. Positional, so 1–6 is a stable address. */
export const INBOX_FILTERS = ["all", "blocking", "attention", "proposals", "team", "snoozed"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

export const INBOX_FILTER_LABEL: Record<InboxFilter, string> = {
  all: "All",
  blocking: "Blocking",
  attention: "Attention",
  proposals: "Proposals",
  team: "Team",
  snoozed: "Snoozed",
};

/** §4.2's three columns, left to right. Severity is assigned by the system; a card never moves. */
export const INBOX_COLUMNS: readonly InboxSeverity[] = ["blocking", "attention", "proposal"];

export const COLUMN_LABEL: Record<InboxSeverity, string> = {
  blocking: "BLOCKING",
  attention: "ATTENTION",
  proposal: "PROPOSALS",
};

/**
 * §5.3's per-column empties. "Blocking 0 should feel like an achievement."
 *
 * THREE DIFFERENT SENTENCES, because the three columns being empty mean three different things.
 * Nothing blocked is genuinely good news; nothing to look at is ordinary; nothing being asked is the
 * absence of a question. One shared "no items" would flatten all of that into a placeholder.
 */
export const COLUMN_EMPTY: Record<InboxSeverity, string> = {
  blocking: "Nothing is blocked",
  attention: "Nothing to look at",
  proposal: "Nothing to decide",
};

/** The team-only types, which is what §5.1's Team filter selects. */
const TEAM_TYPES = new Set(["invite_pending", "member_joined", "agent_deleted_by_other"]);

export function isTeamItem(item: InboxItemView): boolean {
  return TEAM_TYPES.has(item.type);
}

/**
 * §5.1's rail, applied.
 *
 * `snoozed` IS NOT A FILTER OVER `items` and never can be — a snoozed card is not on the board at
 * all, it is in the tray, and the server sends the two lists separately. The chip selects which
 * LIST is being shown, which is why this takes both and returns one.
 *
 * AN AGENT FILTER IS SEPARATE FROM THE SEVERITY CHIP, and they compose: §5.1's per-agent breakdown
 * says "clicking an agent filters the board", and somebody who has clicked an agent and then
 * Blocking means both. Collapsing them into one selection would make the second click undo the
 * first, which is the behaviour of a radio group somebody built out of two.
 */
export function filterInbox(
  items: readonly InboxItemView[],
  snoozed: readonly InboxItemView[],
  filter: InboxFilter,
  agentId: string | null,
): InboxItemView[] {
  const source = filter === "snoozed" ? snoozed : items;
  return source.filter((item) => {
    if (agentId && item.subject_id !== agentId) return false;
    if (filter === "all" || filter === "snoozed") return true;
    if (filter === "team") return isTeamItem(item);
    if (filter === "proposals") return item.severity === "proposal";
    return item.severity === filter;
  });
}

/**
 * §4.2's order within a column: severity, then age. The user does not choose it.
 *
 * OLDEST FIRST, which is the reading of "age" that makes a board shrink — the thing that has been
 * waiting longest is the thing to deal with, and a newest-first board buries it under every arrival.
 * The server sorts the same way; this exists because the client re-sorts after a filter and after a
 * delta, and two sorts that disagree would make a card jump when nothing about it changed.
 */
export function sortForBoard(items: readonly InboxItemView[]): InboxItemView[] {
  return [...items].sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at));
}

/** The cards in one column, in board order. */
export function columnItems(items: readonly InboxItemView[], severity: InboxSeverity): InboxItemView[] {
  return sortForBoard(items.filter((i) => i.severity === severity));
}

/**
 * How full the age bar under a card is, from 0 to 1.
 *
 * §4.3: "a hairline under the card that fills as the item ages". What it has to communicate is
 * URGENCY, which is not the same as elapsed time — an item that appeared four minutes ago and one
 * that appeared five minutes ago are equally new, and a linear bar over a week makes both of them
 * invisible while making anything over a week identical.
 *
 * SO IT IS LOGARITHMIC, over a week. The first hour moves it visibly, the first day fills about
 * two thirds of it, and a week fills it. That matches how somebody actually reads a backlog: the
 * difference between one hour and one day is the interesting one, and the difference between eight
 * days and nine is not.
 *
 * CLAMPED AT BOTH ENDS. A clock skew that puts `first_seen_at` in the future is a negative age and
 * would draw a bar filling backwards; an item older than the window is simply full.
 */
export const AGE_BAR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function ageFraction(firstSeenAt: string, now: number): number {
  const started = Date.parse(firstSeenAt);
  if (!Number.isFinite(started)) return 0;
  const age = now - started;
  if (age <= 0) return 0;
  if (age >= AGE_BAR_WINDOW_MS) return 1;
  // log1p over the window, normalised. `+1` on both so an age of zero is a fraction of zero rather
  // than a division nobody defined.
  return Math.log1p(age) / Math.log1p(AGE_BAR_WINDOW_MS);
}

/**
 * §5.4's tray line: "4 snoozed · next returns in 3h".
 *
 * NULL WHEN NOTHING IS SNOOZED, so the strip renders nothing at all rather than "0 snoozed" — the
 * same empty-sections discipline the nav badge follows.
 *
 * A RETURN IN THE PAST READS AS "any moment", not as "-3h". The board evaluates snoozes at read
 * time, so a timer that has fired and a snapshot that has not yet arrived is a real few seconds, and
 * a negative duration on screen is the kind of thing that makes somebody distrust the rest of the
 * surface.
 */
export function trayLine(snoozed: readonly InboxItemView[], now: number): string | null {
  if (snoozed.length === 0) return null;
  const count = `${snoozed.length} snoozed`;
  const next = snoozed
    .map((i) => (i.snoozed_until ? Date.parse(i.snoozed_until) : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0];
  if (next === undefined) return count;
  const ms = next - now;
  if (ms <= 0) return `${count} · next returns any moment`;
  return `${count} · next returns in ${shortDuration(ms)}`;
}

/** `3h`, `2d`, `45m`. One unit, because a tray strip is a glance rather than a countdown. */
export function shortDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * §4.5's shift-click range: every card between two, in the order they render.
 *
 * ACROSS COLUMN BOUNDARIES, in visual order, because that is what the keyboard does too (§5.5's J/K
 * "move between cards, across column boundaries in visual order") and two different meanings of
 * "the next card" in one surface is one meaning too many.
 *
 * ORDER-INDEPENDENT: shift-clicking upwards selects the same range as downwards. A range that only
 * worked in one direction is a range that silently selects nothing half the time.
 */
export function rangeBetween(
  ordered: readonly InboxItemView[],
  anchorId: string,
  targetId: string,
): string[] {
  const a = ordered.findIndex((i) => i.id === anchorId);
  const b = ordered.findIndex((i) => i.id === targetId);
  if (a === -1 || b === -1) return targetId ? [targetId] : [];
  const [from, to] = a <= b ? [a, b] : [b, a];
  return ordered.slice(from, to + 1).map((i) => i.id);
}
