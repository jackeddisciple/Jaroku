// The board, for one person: three verbs, and what each of them does to what they see.
//
// §3 IS THREE VERBS AND NOT ONE, and the whole of this file is the consequence:
//
//   RESOLVE  — the underlying problem is fixed. Shared, because the problem is. Returns only if it
//              recurs. Nothing here performs it; the sweep does, from the registry's predicate.
//   SNOOZE   — not now. Personal, and it RETURNS on a timer, which is why a snoozed item is still
//              in a visible tray rather than gone: "snoozed work stays visible, otherwise snooze
//              silently becomes dismissal".
//   DISMISS  — I don't care about this instance. Personal, and it does not return.
//
// TWO OF THE THREE ARE PER USER, WHICH IS WHY THIS IS A FUNCTION OF A PERSON AND NOT OF A WORKSPACE.
// A teammate's dismissal must not clear anybody else's board, and a resolution must clear everybody's
// — so the shared rows and one person's decisions are read together and the difference between them
// is applied here, once, rather than in each of the four surfaces that ask.
//
// WHAT IS NOT HERE: any decision about what a card LOOKS like. Size carries severity, colour barely
// participates, the age bar fills as the item ages — all of that is the client's, from the severity
// and the two timestamps this sends. What the server decides is which items exist, which column each
// is in, what its subject line says, and what may be done about it, because every one of those is a
// fact rather than a rendering.

import type { TenantContext } from "../db/tenant.ts";
import type { InboxItemForUser, InboxStore } from "./inboxStore.ts";
import {
  inboxType,
  type InboxActionName,
  type InboxIconName,
  type InboxItemType,
  type InboxSeverity,
  type InboxSubjectType,
} from "./registry.ts";

/**
 * §3's three durations, and no more.
 *
 * NAMES RATHER THAN MILLISECONDS ON THE WIRE. "Tomorrow" is not a fixed offset — it is nine in the
 * morning, wherever the person is — and a client sending a duration in milliseconds would be a
 * client deciding what tomorrow means. It sends which of the three was chosen; the server resolves
 * it against a clock everything else in this feature already reads.
 */
export type SnoozeDuration = "hour" | "tomorrow" | "week";

export const SNOOZE_DURATIONS: readonly SnoozeDuration[] = ["hour", "tomorrow", "week"];

export function isSnoozeDuration(v: unknown): v is SnoozeDuration {
  return typeof v === "string" && (SNOOZE_DURATIONS as readonly string[]).includes(v);
}

/**
 * When a snooze ends.
 *
 * `tomorrow` IS NINE IN THE MORNING AND NOT "IN 24 HOURS", which is the whole reason this is a
 * function rather than a table of offsets. Somebody snoozing something at four in the afternoon
 * means "deal with it tomorrow", and returning it at four the next afternoon puts it back in the
 * middle of the next day's work rather than at the start of it.
 *
 * IN UTC, WHICH IS A LIMIT WORTH STATING RATHER THAN HIDING. The server has no idea what timezone
 * the person is in — nothing in this product records one — so "nine in the morning" is nine UTC, and
 * for somebody in Los Angeles that is one in the morning. The honest fix is a timezone on the user
 * row, which is a decision for whoever adds one; the dishonest one would be to let the client send
 * an absolute time, which makes the duration a thing a client can invent.
 *
 * `week` is seven days, not "next Monday", for the same reason `hour` is an hour: only `tomorrow`
 * has a natural time of day attached to it.
 */
export function snoozeUntil(duration: SnoozeDuration, now: number): string {
  if (duration === "hour") return new Date(now + 3_600_000).toISOString();
  if (duration === "week") return new Date(now + 7 * 86_400_000).toISOString();
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(9, 0, 0, 0);
  // Snoozing something at three in the morning must not return it six hours later — that is not
  // "tomorrow" by any reading. Push to the following day when today's nine has not happened yet.
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/** One card, as the board renders it. */
export interface InboxItemView {
  id: string;
  type: InboxItemType;
  severity: InboxSeverity;
  icon: InboxIconName;
  subject_type: InboxSubjectType | null;
  subject_id: string | null;
  /** §4.4's bold first line, decided on the server — see `InboxTypeDef.subjectLine`. */
  subject: string;
  /** Names, ids, counts and short summaries. Never a value — §6.5. */
  payload: Record<string, unknown>;
  /** Law 3's badge. `1` renders nothing; the client draws `×40` from this. */
  count: number;
  /** The age bar fills from here. */
  first_seen_at: string;
  last_seen_at: string;
  /** In order, primary first. The `×` renders only when this contains `dismiss`. */
  actions: readonly InboxActionName[];
  /** Set when this person has snoozed it and the timer has not fired. Null on the board. */
  snoozed_until: string | null;
}

/**
 * §5.1's left rail: what each filter counts.
 *
 * COMPUTED ONCE ON THE SERVER AND RENDERED TWICE, which is the same rule the Threads badge follows
 * and for the same reason: the sidebar badge and the rail's `Blocking` chip are the same question,
 * and two independently-derived answers that disagree are visible in two places somebody compares.
 */
export interface InboxCounts {
  all: number;
  blocking: number;
  attention: number;
  proposals: number;
  /** §2.4's three types, which exist only in a Team workspace. Zero in Personal, always. */
  team: number;
  /** Snoozed by this person and not yet returned. The tray's number. */
  snoozed: number;
  /**
   * §5.2's badge: BLOCKING PLUS PROPOSALS ONLY.
   *
   * ATTENTION IS DELIBERATELY EXCLUDED AND THIS IS NOT AN OVERSIGHT — the specification says so in
   * as many words and asks that nobody "fix" it. If the badge counted everything it would never
   * reach zero, and a badge that is never zero is a badge people train themselves to ignore.
   *
   * ON THE SNAPSHOT rather than added up in the client, because it is the same quantity the rail's
   * two chips are drawn from and deriving it twice is how the two end up disagreeing.
   */
  badge: number;
}

/** §5.1's per-agent breakdown: the top five agents by open item count. */
export interface InboxAgentCount {
  agent_id: string;
  name: string;
  count: number;
}

export interface InboxSnapshot {
  items: InboxItemView[];
  /** Snoozed by this person, soonest return first. §5.4's tray. */
  snoozed: InboxItemView[];
  counts: InboxCounts;
  agents: InboxAgentCount[];
  /**
   * §5.3's one line of real statistic: how many items this workspace CLEARED this week.
   *
   * RESOLVED, NEVER DISMISSED. "Cleared 14 items this week" is a statement about work that got done,
   * and counting dismissals in it would let somebody clear their own board by hiding things and be
   * congratulated for it.
   */
  cleared_this_week: number;
}

/** How many agents the left rail's breakdown names. §5.1: the top five. */
export const RAIL_AGENT_LIMIT = 5;

/** The window §5.3's statistic is counted over. */
export const CLEARED_WINDOW_MS = 7 * 86_400_000;

const EMPTY_COUNTS: InboxCounts = {
  all: 0, blocking: 0, attention: 0, proposals: 0, team: 0, snoozed: 0, badge: 0,
};

export const EMPTY_INBOX: InboxSnapshot = {
  items: [], snoozed: [], counts: EMPTY_COUNTS, agents: [], cleared_this_week: 0,
};

/**
 * Turn a row plus this person's decisions into a card.
 *
 * THE SEVERITY, ICON AND ACTIONS COME OFF THE REGISTRY AND NOT OFF THE ROW, even though `severity`
 * is a column. The column exists so the board's index can order by it in the database; the registry
 * is what the type MEANS. Reading the column here would mean a row written by an older build — with
 * a severity that entry has since changed — rendering in a column the current code does not put that
 * type in, and the count beside it computed from the other answer.
 */
function view(item: InboxItemForUser): InboxItemView {
  const def = inboxType(item.type);
  return {
    id: item.id,
    type: item.type,
    severity: def.severity,
    icon: def.icon,
    subject_type: item.subject_type,
    subject_id: item.subject_id,
    subject: def.subjectLine(item.payload),
    payload: item.payload as Record<string, unknown>,
    count: item.count,
    first_seen_at: item.first_seen_at,
    last_seen_at: item.last_seen_at,
    actions: def.actions,
    snoozed_until: item.user_state.snoozed_until,
  };
}

/**
 * §4.2's order within a column: severity, then age. The user does not choose it.
 *
 * OLDEST FIRST WITHIN A SEVERITY, which is the reading of "age" that makes a board shrink: the thing
 * that has been waiting longest is the thing to deal with, and a newest-first board buries it under
 * every new arrival. It is also why there is no manual reordering — a board somebody has arranged is
 * a board that stops telling them anything.
 */
const SEVERITY_ORDER: Record<InboxSeverity, number> = { blocking: 0, attention: 1, proposal: 2 };

function byBoardOrder(a: InboxItemView, b: InboxItemView): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySeverity !== 0) return bySeverity;
  return a.first_seen_at.localeCompare(b.first_seen_at);
}

/**
 * What one person's board looks like right now.
 *
 * ONE READ OF THE ROWS AND ONE COUNT, whatever is on it. The join that attaches this person's
 * decisions happens in the database; everything below is filtering and arithmetic over an array that
 * is already in hand, which is what keeps the board's cost independent of how many people have
 * dismissed things.
 *
 * A SNOOZE THAT HAS FIRED IS SIMPLY BACK. There is no sweep that un-snoozes, no job to run and
 * nothing to go wrong at the boundary: `snoozed_until <= now` is not snoozed, evaluated at read
 * time, so the item returns the first time anybody looks after the timer. The alternative — a job
 * that clears the column — is a second thing that has to run for an item to come back, and the
 * failure mode is an item that never does.
 */
export async function inboxSnapshot(
  store: InboxStore,
  ctx: TenantContext,
  userId: string | null,
  opts: { team: boolean; agentNames?: ReadonlyMap<string, string>; now?: number },
): Promise<InboxSnapshot> {
  const now = opts.now ?? Date.now();
  const rows = await store.listForUser(ctx, userId);
  const cleared = await store.resolvedSince(ctx, new Date(now - CLEARED_WINDOW_MS).toISOString());

  const items: InboxItemView[] = [];
  const snoozed: InboxItemView[] = [];
  const counts: InboxCounts = { ...EMPTY_COUNTS };
  const perAgent = new Map<string, number>();

  for (const row of rows) {
    const def = inboxType(row.type);
    // §2.4: TEAM ITEMS ARE HIDDEN IN PERSONAL, not greyed and not shown empty. A Personal workspace
    // has one member and no invitations, so an "invite pending" card there is a card about a
    // capability that does not exist.
    if (def.teamOnly && !opts.team) continue;
    // A DISMISSAL IS THIS PERSON'S AND REMOVES IT FROM THIS PERSON'S BOARD ONLY. It is not filtered
    // in the query, because the same rows answer the tray and the counts.
    if (row.user_state.dismissed_at) continue;

    const card = view(row);
    const until = row.user_state.snoozed_until;
    if (until && Date.parse(until) > now) {
      snoozed.push(card);
      counts.snoozed++;
      // A SNOOZED ITEM IS NOT IN `all` OR IN ITS COLUMN'S COUNT. It is not on the board, and a chip
      // that counted it would send somebody looking for a card that is in the tray at the bottom.
      continue;
    }

    items.push(card);
    counts.all++;
    if (card.severity === "blocking") counts.blocking++;
    else if (card.severity === "attention") counts.attention++;
    else counts.proposals++;
    if (def.teamOnly) counts.team++;

    if (row.subject_type === "agent" && row.subject_id) {
      perAgent.set(row.subject_id, (perAgent.get(row.subject_id) ?? 0) + 1);
    }
  }

  counts.badge = counts.blocking + counts.proposals;

  items.sort(byBoardOrder);
  // Soonest return first: the tray's own line is "4 snoozed · next returns in 3h", and the number in
  // it is the head of this list.
  snoozed.sort((a, b) => (a.snoozed_until ?? "").localeCompare(b.snoozed_until ?? ""));

  const agents: InboxAgentCount[] = [...perAgent.entries()]
    .map(([agent_id, count]) => ({ agent_id, name: opts.agentNames?.get(agent_id) ?? agent_id, count }))
    // Most first, then by name so a tie does not reorder between two snapshots that are otherwise
    // identical — a rail whose rows swap places on every refresh is a rail nobody can click.
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, RAIL_AGENT_LIMIT);

  return { items, snoozed, counts, agents, cleared_this_week: cleared };
}
