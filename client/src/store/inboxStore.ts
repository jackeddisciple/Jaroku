// The inbox store — what is waiting on this person, as the server derived it.
//
// SEPARATED BY INVARIANT, NOT BY CONVENIENCE, which is this codebase's stated rule for stores. It is
// not a slice of `threadStore` even though both are lists on a full-snapshot channel: a thread list
// answers "what am I working on" and this answers "what is stuck", and the only thing they share is
// a socket. It is not a slice of `agentGridStore` either, though most items are ABOUT an agent —
// that store's invariant is one card per agent, and an agent with three missing credentials is three
// cards here.
//
// EVERY SNAPSHOT IS A REPLACE AND NEVER A MERGE, the discipline every channel in this client holds.
// A merge would let this store assemble a board out of two moments, and the counts — which the
// sidebar badge is drawn from — would then be a count of one moment beside rows from another.
//
// A DELTA IS THE ONE EXCEPTION, AND IT IS A NARROW ONE. §5.6 asks that a resolving card collapse and
// fade with no refresh and that only the affected card re-render, so a resolution arrives as one
// message rather than as a whole board. What makes that safe is that a delta only ever carries a
// fact that is true for everybody — an item resolved, a count moved, an item that has just come into
// existence. A dismissal has no delta, because it is one person's judgement.
//
// WHAT THIS STORE DOES NOT DECIDE: which column a card is in (the server assigns severity), what its
// subject line says, or what may be done about it. It also does not persist a filter — §5.1's rail
// is per session, so that lives in the view, exactly as the Threads filter does.

import { create } from "zustand";
import type { InboxAgentCount, InboxCounts, InboxItemView } from "../types.ts";

/** What a socket knows before the first snapshot lands. §5.3's zero state needs this apart from it. */
const NO_COUNTS: InboxCounts = {
  all: 0, blocking: 0, attention: 0, proposals: 0, team: 0, snoozed: 0, badge: 0,
};

/**
 * What a destructive action left behind, for the five seconds the toast is up.
 *
 * ONE SLOT, NOT A QUEUE. Dismissing two things in a row is two decisions and the second toast is the
 * one still true — the same shape `threadStore.archiveNotice` takes, and for the same reason.
 */
export interface InboxUndo {
  token: string;
  action: string;
  changed: number;
  /** When it arrived, so the view can fade it out without the store owning a timer. */
  at: number;
}

interface InboxState {
  items: InboxItemView[];
  snoozed: InboxItemView[];
  counts: InboxCounts;
  agents: InboxAgentCount[];
  clearedThisWeek: number;
  /**
   * False until the first snapshot arrives on this connection.
   *
   * §9's no-spinners rule needs this to be a distinct state, and here it matters more than usual:
   * "we have not been told yet" renders skeleton cards, and "there is nothing" renders §5.3's
   * celebration. Collapsing the two would put "Nothing needs you" in front of somebody whose
   * blocking items are still on the wire.
   */
  loaded: boolean;
  /** The last refusal on this channel, shown as a strip rather than swallowed. */
  error: string | null;
  /** §3's toast. Null when there is nothing to take back. */
  undo: InboxUndo | null;
  /**
   * Cards that have resolved and are still playing their collapse.
   *
   * §5.6: "the card collapses and fades, and the column count decrements". Removing the row the
   * instant the delta lands would make it vanish, which is not the same thing — so the id stays here
   * for the length of the animation and the view renders it leaving. The COUNTS drop immediately,
   * because the count is a fact and the animation is a rendering.
   */
  leaving: Record<string, true>;

  setSnapshot: (snapshot: {
    items: InboxItemView[];
    snoozed: InboxItemView[];
    counts: InboxCounts;
    agents: InboxAgentCount[];
    cleared_this_week: number;
  }) => void;
  /** §5.6's single-card resolution. */
  noteResolved: (itemId: string) => void;
  /** The card has finished leaving; drop it. */
  dropLeaving: (itemId: string) => void;
  noteCount: (itemId: string, count: number, lastSeenAt: string) => void;
  noteAdded: (item: InboxItemView) => void;
  setError: (message: string | null) => void;
  setUndo: (undo: InboxUndo | null) => void;
}

export const useInboxStore = create<InboxState>((set) => ({
  items: [],
  snoozed: [],
  counts: NO_COUNTS,
  agents: [],
  clearedThisWeek: 0,
  loaded: false,
  error: null,
  undo: null,
  leaving: {},

  setSnapshot: (snapshot) =>
    set({
      items: snapshot.items,
      snoozed: snapshot.snoozed,
      counts: snapshot.counts,
      agents: snapshot.agents,
      clearedThisWeek: snapshot.cleared_this_week,
      loaded: true,
      // A FRESH SNAPSHOT CLEARS THE REFUSAL, because the board being right again is what makes the
      // message stale — the same rule the thread list's error strip follows. And it clears
      // `leaving`, because a card the snapshot no longer carries has finished leaving whatever the
      // animation was doing.
      error: null,
      leaving: {},
    }),

  noteResolved: (itemId) =>
    set((s) => {
      if (!s.items.some((i) => i.id === itemId)) return s;
      const item = s.items.find((i) => i.id === itemId)!;
      // THE COUNTS MOVE NOW AND THE ROW LEAVES LATER. §4.3 says resolution is carried by the card
      // physically collapsing and fading; the column header's number is a fact, and holding it at
      // the old value for the length of an animation would make the two disagree on screen.
      const counts = { ...s.counts, all: Math.max(0, s.counts.all - 1) };
      if (item.severity === "blocking") counts.blocking = Math.max(0, counts.blocking - 1);
      else if (item.severity === "attention") counts.attention = Math.max(0, counts.attention - 1);
      else counts.proposals = Math.max(0, counts.proposals - 1);
      counts.badge = counts.blocking + counts.proposals;
      return { counts, leaving: { ...s.leaving, [itemId]: true } };
    }),

  dropLeaving: (itemId) =>
    set((s) => {
      if (!s.leaving[itemId]) return s;
      const leaving = { ...s.leaving };
      delete leaving[itemId];
      return { items: s.items.filter((i) => i.id !== itemId), leaving };
    }),

  noteCount: (itemId, count, lastSeenAt) =>
    set((s) => ({
      items: s.items.map((i) => (i.id === itemId ? { ...i, count, last_seen_at: lastSeenAt } : i)),
    })),

  noteAdded: (item) =>
    set((s) => {
      // IDEMPOTENT, because a delta and the snapshot that follows it can both carry the same card —
      // a client that appended blindly would render it twice and count it twice.
      if (s.items.some((i) => i.id === item.id)) return s;
      const counts = { ...s.counts, all: s.counts.all + 1 };
      if (item.severity === "blocking") counts.blocking += 1;
      else if (item.severity === "attention") counts.attention += 1;
      else counts.proposals += 1;
      counts.badge = counts.blocking + counts.proposals;
      return { items: [...s.items, item], counts };
    }),

  setError: (error) => set({ error }),
  setUndo: (undo) => set({ undo }),
}));
