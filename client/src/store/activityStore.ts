// The Activity tab's state — six answers to one question, and the one window they all describe.
//
// SEPARATED BY INVARIANT, NOT BY CONVENIENCE, which is this codebase's stated rule for stores. It is
// not a slice of `agentGridStore` even though its leaderboard is a list of agents: that store's
// invariant is one card per agent and this one's is one figure per module, and an agent that did
// nothing this week is a card there and no row here. It is not a slice of `billingStore` either —
// that answers "what do we owe", which is a question about an invoice period, and this answers "what
// did we do", which is a question about a window somebody picked.
//
// THE RANGE IS THE STORE'S CENTRE OF GRAVITY. Every payload carries the range it answers for, and
// anything that does not match the range currently selected is DROPPED. That is §1's single global
// window made structural: six messages arriving after somebody has changed the range would otherwise
// assemble a page out of two windows, which is exactly the ambiguity §3.4's cross-highlighting
// cannot survive.
//
// AND EACH MODULE LOADS INDEPENDENTLY. §3.6: "Cards fill independently as their queries return — a
// slow leaderboard must not hold up the hero row." So there is no single `loaded` flag; each slice
// carries its own, and a card renders a skeleton until its own answer lands.

import { create } from "zustand";
import type {
  ActivityFeedRow,
  ActivityLeaderboardRow,
  ActivityModelMix,
  ActivityRange,
  ActivityReleaseEntry,
  ActivitySummary,
  ActivityTeamMember,
  ActivityToolUsage,
  ActivityPersonalSummary,
  FeedCursor,
} from "../types.ts";

/**
 * What §3.4's cross-highlight is looking at. One subject, in one place.
 *
 * A SINGLE HOVER SUBJECT IN A SMALL STORE, which §3.4 asks for by name: "Implement it as a single
 * hover-subject in a small store — `{ kind: 'agent' | 'model', id }` — that every module subscribes
 * to. Do not wire module-to-module." Four modules wired to each other is six connections and, more
 * to the point, six places for a module to be added and forgotten.
 *
 * NOTHING IS FETCHED WHEN IT CHANGES. §3.4 is explicit: "Nothing is clicked. Nothing changes.
 * Nothing is fetched. It is one dataset seen through four lenses." Everything the highlight needs is
 * already in the payload — a leaderboard row carries the models it ran, a feed row carries its
 * agent — which is why those fields exist.
 */
export interface HoverSubject {
  kind: "agent" | "model";
  id: string;
}

/** Freshness, as §5.3 requires it to travel: when, and whether it was computed for this request. */
export interface Freshness {
  computedAt: string;
  live: boolean;
}

interface ActivityState {
  /** The window every figure describes. Persisted per workspace — see `lib/activityRange.ts`. */
  range: ActivityRange;
  /** Both ends, for `range: "custom"`. Null otherwise. */
  custom: { from: string; to: string } | null;

  summary: ActivitySummary | null;
  summaryFresh: Freshness | null;

  leaderboard: ActivityLeaderboardRow[];
  leaderboardTruncated: boolean;
  mix: ActivityModelMix | null;
  leaderboardFresh: Freshness | null;

  releases: ActivityReleaseEntry[];
  releasesFresh: Freshness | null;

  tools: ActivityToolUsage | null;
  toolsFresh: Freshness | null;

  teamScope: "team" | "personal";
  members: ActivityTeamMember[];
  personal: ActivityPersonalSummary | null;
  teamFresh: Freshness | null;

  /**
   * The feed, accumulated across pages.
   *
   * THE ONE SLICE THAT APPENDS RATHER THAN REPLACES, and it is safe for exactly one reason: keyset
   * pagination. A cursor says "everything strictly older than this row", so a page can only ever add
   * rows below what is already held — it cannot reorder, cannot duplicate, and cannot depend on how
   * many rows arrived above it while the reader was scrolling. An offset-paginated feed appended the
   * same way would silently repeat and silently skip.
   */
  feed: ActivityFeedRow[];
  feedNext: FeedCursor | null;
  /** True while a page is in flight, so the virtualiser does not ask for the same one twice. */
  feedLoading: boolean;
  feedLoaded: boolean;

  /** §3.4's hover subject. Null when the pointer is on nothing. */
  hover: HoverSubject | null;

  /** The last refusal on this channel, shown as a strip rather than swallowed. */
  error: string | null;

  setRange: (range: ActivityRange, custom?: { from: string; to: string } | null) => void;
  applySummary: (range: string, fresh: Freshness, summary: ActivitySummary) => void;
  applyLeaderboard: (
    range: string,
    fresh: Freshness,
    rows: ActivityLeaderboardRow[],
    truncated: boolean,
    mix: ActivityModelMix,
  ) => void;
  applyReleases: (range: string, fresh: Freshness, entries: ActivityReleaseEntry[]) => void;
  applyTools: (range: string, fresh: Freshness, usage: ActivityToolUsage) => void;
  applyTeam: (
    range: string,
    fresh: Freshness,
    scope: "team" | "personal",
    members: ActivityTeamMember[],
    personal: ActivityPersonalSummary | null,
  ) => void;
  applyFeed: (
    range: string,
    rows: ActivityFeedRow[],
    cursor: FeedCursor | null,
    next: FeedCursor | null,
  ) => void;
  feedRequested: () => void;
  setHover: (hover: HoverSubject | null) => void;
  setError: (message: string | null) => void;
}

/** Everything a range change invalidates. Named once so no field can be forgotten. */
const EMPTY = {
  summary: null,
  summaryFresh: null,
  leaderboard: [] as ActivityLeaderboardRow[],
  leaderboardTruncated: false,
  mix: null,
  leaderboardFresh: null,
  releases: [] as ActivityReleaseEntry[],
  releasesFresh: null,
  tools: null,
  toolsFresh: null,
  teamScope: "personal" as const,
  members: [] as ActivityTeamMember[],
  personal: null,
  teamFresh: null,
  feed: [] as ActivityFeedRow[],
  feedNext: null,
  feedLoading: false,
  feedLoaded: false,
  error: null,
};

export const useActivityStore = create<ActivityState>((set, get) => ({
  range: "7d",
  custom: null,
  hover: null,
  ...EMPTY,

  /**
   * Change the window. Everything on the page becomes unanswered until its own reply arrives.
   *
   * CLEARING IS THE POINT, AND KEEPING WOULD BE THE BUG. §3.6 asks for skeletons at each card's
   * final dimensions while data is in flight; leaving the previous range's figures on screen would
   * be worse than a skeleton, because a number for the wrong window is indistinguishable from a
   * number for the right one. The hover subject is cleared too — it names an agent or a model that
   * may not be in the next window's data at all.
   */
  setRange: (range, custom = null) => set({ range, custom, hover: null, ...EMPTY }),

  applySummary: (range, fresh, summary) =>
    set((s) => (range === s.range ? { summary, summaryFresh: fresh, error: null } : s)),

  applyLeaderboard: (range, fresh, rows, truncated, mix) =>
    set((s) =>
      range === s.range
        ? { leaderboard: rows, leaderboardTruncated: truncated, mix, leaderboardFresh: fresh, error: null }
        : s,
    ),

  applyReleases: (range, fresh, entries) =>
    set((s) => (range === s.range ? { releases: entries, releasesFresh: fresh, error: null } : s)),

  applyTools: (range, fresh, usage) =>
    set((s) => (range === s.range ? { tools: usage, toolsFresh: fresh, error: null } : s)),

  applyTeam: (range, fresh, scope, members, personal) =>
    set((s) =>
      range === s.range ? { teamScope: scope, members, personal, teamFresh: fresh, error: null } : s,
    ),

  /**
   * A page of the feed. Appends when it answers a cursor, replaces when it answers the first page.
   *
   * THE CURSOR IS WHAT DECIDES WHICH, and it is echoed by the server for exactly this: a client
   * scrolling quickly has two pages in flight, and a page that arrived with no way to say which
   * request it answers can only be appended blindly. A first page appended rather than replaced is
   * how a virtualised list shows every row twice.
   *
   * AND A PAGE FOR A CURSOR THIS STORE HAS MOVED PAST IS DROPPED. Somebody who changed the range
   * mid-scroll has a page in flight for a window that is gone; the range guard catches that, and the
   * cursor comparison catches the narrower case of two pages racing inside one window.
   */
  applyFeed: (range, rows, cursor, next) =>
    set((s) => {
      if (range !== s.range) return s;
      if (!cursor) return { feed: rows, feedNext: next, feedLoading: false, feedLoaded: true, error: null };
      // Idempotent by id, because a delta and a retry can both carry the same row and a virtualiser
      // keyed on id would render the duplicate rather than ignoring it.
      const seen = new Set(s.feed.map((r) => r.id));
      const fresh = rows.filter((r) => !seen.has(r.id));
      return { feed: [...s.feed, ...fresh], feedNext: next, feedLoading: false, feedLoaded: true, error: null };
    }),

  feedRequested: () => {
    if (get().feedLoading) return;
    set({ feedLoading: true });
  },

  setHover: (hover) => set({ hover }),
  setError: (error) => set({ error, feedLoading: false }),
}));

/**
 * Whether a row should be dimmed by §3.4's highlight.
 *
 * "HIGHLIGHT IS A DE-EMPHASIS OF EVERYTHING ELSE, NOT A COLOUR CHANGE ON THE TARGET", which §3.4
 * asks for in one sentence and which this function is the whole of. The reason is the palette: this
 * app spends colour on status and on nothing else, so brightening a target would either invent a
 * hue or borrow one that already means something. Dimming the rest costs no colour at all.
 *
 * A PURE FUNCTION TAKING THE SUBJECT rather than a hook reading the store, so the leaderboard, the
 * mix, the feed and the timeline all decide it the same way — and so it can be exercised without
 * rendering anything.
 */
export function dimmedBy(
  hover: HoverSubject | null,
  row: { agentId?: string | null; models?: readonly string[]; model?: string | null },
): boolean {
  if (!hover) return false;
  if (hover.kind === "agent") {
    // A row with no agent at all — a member event, a platform model call — is not ABOUT the hovered
    // agent, so it recedes with everything else. Leaving it lit would make the highlight read as
    // "these rows plus some others".
    return row.agentId !== hover.id;
  }
  // Hovering a model segment highlights the leaderboard rows using that model, and the feed rows and
  // mix segments naming it. A row that carries neither is dimmed.
  if (row.models) return !row.models.includes(hover.id);
  if (row.model !== undefined && row.model !== null) return row.model !== hover.id;
  return true;
}
