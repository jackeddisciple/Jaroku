// The Cockpit's store — what is live, and what has been asked of it.
//
// SEPARATED BY INVARIANT, NOT BY CONVENIENCE, which is this codebase's stated rule for stores. It
// is not a slice of `traceStore`, which holds steps keyed by run and has invariants about ordering
// and expansion that nothing here needs; it is not a slice of `deployStore`, whose invariant is
// one row per deploy while this holds one card per LIVE agent and a list of jobs beside it; and it
// is not a slice of `inboxStore`, which answers "what is stuck" from rows that die on their own.
// This answers "what did we ask, and what happened" from rows that are a record.
//
// A SNAPSHOT REPLACES AND A DELTA TOUCHES ONE ROW, the discipline every channel in this client
// holds — and here the delta is the common case rather than the exception. A work list moves every
// few seconds under four agents on a schedule, so §5 makes a transition a single item and a
// snapshot the answer to a filter change or a fresh connect.
//
// THE DELTA IS FILTERED HERE, WHICH IS THE ONE THING THIS STORE DECIDES. A broadcast item carries
// no filter — it cannot, it goes to every socket in the workspace — so a client holding "mine,
// failed" receives transitions for jobs it is not showing. Dropping them is a rendering decision
// made against a list this store already has, and it is the reason the server is allowed to
// broadcast one payload to everybody: the alternative is a per-recipient snapshot, which is what
// the Inbox needs and what this deliberately avoids.
//
// THE COUNTS ARE NEVER DERIVED FROM `items`. They arrive with the snapshot and are the WORKSPACE's
// whatever the page is narrowed to — a count of the page would go to zero the moment somebody
// filtered, and the sidebar badge is drawn from the same numbers.

import { create } from "zustand";
import type {
  FleetCardView, WorkCounts, WorkFilters, WorkItemDetailView, WorkItemView, WorkStatus,
} from "../types.ts";

/** What a socket knows before the first snapshot lands. The zero state needs this apart from it. */
const NO_COUNTS: WorkCounts = {
  queued: 0, running: 0, waiting: 0, succeeded: 0, failed: 0, cancelled: 0,
};

const DEFAULT_FILTERS: WorkFilters = { scope: "mine", status: null, agentId: null };

interface WorkState {
  items: WorkItemView[];
  /** Null when there is no further page. */
  nextCursor: string | null;
  counts: WorkCounts;
  /** The filters the page in hand answers for, echoed by the server. */
  filters: WorkFilters;
  fleet: FleetCardView[];
  /**
   * Whether this workspace has any live deployment at all.
   *
   * SEPARATE FROM `fleet.length`, because §11.4's three zero states need to tell "no agents are
   * live yet" from "nothing has been asked of them yet" — and an empty strip is the first while a
   * full one with no jobs is the second. Collapsing them would offer Deploy to somebody who has
   * already deployed.
   */
  anyLive: boolean;
  /**
   * False until the first snapshot arrives on this connection.
   *
   * The no-spinners rule needs this to be a distinct state: "we have not been told yet" renders
   * skeleton rows and "there is nothing" renders a zero state, and collapsing the two would put
   * "Nothing has been asked of them yet" in front of somebody whose jobs are still on the wire.
   */
  loaded: boolean;
  /** Whichever job the detail panel is open on, in full. Null when it is closed. */
  open: WorkItemDetailView | null;
  /** The id the panel is opening on, before its detail has landed. */
  openingId: string | null;
  /** One container's runtime log window, and the cursor that continues it. */
  logs: { deploymentId: string; lines: { timestamp: string; message: string; severity: string | null }[]; cursor: string | null } | null;
  /** The last refusal on this channel, shown as a strip rather than swallowed. */
  error: string | null;
  /** The last thing that went right, for the sentence a reconnect or a kill has to say. */
  notice: string | null;

  setSnapshot: (s: { items: WorkItemView[]; nextCursor: string | null; counts: WorkCounts; filters: WorkFilters }) => void;
  /** A second page, appended. The cursor is what makes this an append rather than a replace. */
  appendPage: (s: { items: WorkItemView[]; nextCursor: string | null }) => void;
  noteItem: (item: WorkItemView) => void;
  setFleet: (fleet: FleetCardView[], anyLive: boolean) => void;
  openItem: (item: WorkItemDetailView) => void;
  openingItem: (itemId: string | null) => void;
  closeItem: () => void;
  setLogs: (logs: { deploymentId: string; lines: { timestamp: string; message: string; severity: string | null }[]; cursor: string | null }) => void;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  /** What the client is asking for. Set before the request so the view can show it immediately. */
  setFilters: (filters: Partial<WorkFilters>) => void;
}

/**
 * Whether a row belongs on the page the client is holding.
 *
 * EXPORTED AND PURE, because it is the one rule in this store worth testing on its own and it is
 * the rule that makes a broadcast delta safe: a transition arrives for every job in the workspace,
 * and a client showing "mine, failed" must not grow a colleague's running job.
 *
 * A ROW ALREADY ON THE PAGE THAT STOPS MATCHING IS REMOVED rather than left, which is the half
 * that is easy to get backwards. A job filtered to `running` that succeeds has left the filter,
 * and leaving it there would make the list a record of what once matched.
 */
export function matchesFilters(item: WorkItemView, filters: WorkFilters, viewerId: string | null): boolean {
  if (filters.scope === "mine" && viewerId && item.created_by !== viewerId) return false;
  if (filters.status && item.status !== filters.status) return false;
  if (filters.agentId && item.agent_id !== filters.agentId) return false;
  return true;
}

export const useWorkStore = create<WorkState>((set) => ({
  items: [],
  nextCursor: null,
  counts: NO_COUNTS,
  filters: DEFAULT_FILTERS,
  fleet: [],
  anyLive: false,
  loaded: false,
  open: null,
  openingId: null,
  logs: null,
  error: null,
  notice: null,

  setSnapshot: (s) =>
    set({
      items: s.items,
      nextCursor: s.nextCursor,
      counts: s.counts,
      // THE SERVER'S ECHO WINS OVER WHAT THE CLIENT ASKED FOR, and that is what makes a late
      // snapshot droppable rather than confusing: the page in hand is described by the filters it
      // was built under, not by whatever the person has since clicked.
      filters: s.filters,
      loaded: true,
      // A fresh snapshot clears the refusal, because the board being right again is what makes the
      // message stale — the same rule the thread and inbox lists follow.
      error: null,
    }),

  appendPage: (s) =>
    set((prev) => {
      // IDEMPOTENT, because a page can arrive twice — a double click on "load more", or a retry
      // after a reconnect. Appending blindly would render a row twice and count it twice in
      // whatever the view derives from the list.
      const have = new Set(prev.items.map((i) => i.id));
      return {
        items: [...prev.items, ...s.items.filter((i) => !have.has(i.id))],
        nextCursor: s.nextCursor,
      };
    }),

  noteItem: (item) =>
    set((prev) => {
      const at = prev.items.findIndex((i) => i.id === item.id);
      // THE DETAIL PANEL MOVES WITH THE ROW. Somebody watching a job they opened is the person most
      // likely to be watching it change, and a panel showing `running` over a row that says
      // `succeeded` is the two halves of one screen disagreeing.
      const open = prev.open?.id === item.id ? { ...prev.open, ...item } : prev.open;
      if (at < 0) return { open };
      const items = [...prev.items];
      items[at] = item;
      return { items, open };
    }),

  setFleet: (fleet, anyLive) => set({ fleet, anyLive }),
  openItem: (open) => set({ open, openingId: null }),
  openingItem: (openingId) => set({ openingId }),
  closeItem: () => set({ open: null, openingId: null, logs: null }),
  setLogs: (logs) => set({ logs }),
  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),
  setFilters: (patch) => set((prev) => ({ filters: { ...prev.filters, ...patch } })),
}));

/**
 * The sidebar badge: `waiting` and nothing else.
 *
 * §9 IS EMPHATIC AND THE REASON IS BEHAVIOURAL RATHER THAN AESTHETIC. "A badge that counts
 * everything never reaches zero, and a badge that is never zero is one people train themselves to
 * ignore." `waiting` is the only state where a HUMAN is the blocker, and that is the only thing a
 * badge should ever mean.
 *
 * NOT `running`: a job running is the product working, and a badge for it would be lit whenever
 * anything was happening. NOT `failed`: a failure is worth seeing and is not waiting on anybody —
 * it is already over, and the Inbox is what raises the ones that need a decision. NOT `queued`,
 * which is a moment.
 *
 * A FUNCTION HERE RATHER THAN A FIELD ON THE STORE, so there is one definition of it and a test can
 * hold it: `test:work-badge` is the equivalent of the Inbox's, which §9 asks for by name — the test
 * that fails if somebody "fixes" the badge to count more.
 */
export function workBadgeCount(counts: WorkCounts): number {
  return counts.waiting;
}

/** Every status, so a view that switches on one is exhaustive rather than defaulting. */
export const WORK_STATUS_ORDER: readonly WorkStatus[] = [
  "running", "waiting", "queued", "succeeded", "failed", "cancelled",
];
