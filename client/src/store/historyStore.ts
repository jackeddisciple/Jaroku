// Where you have been in this application, and how to step back through it.
//
// THERE IS NO ROUTER, WHICH IS WHY THIS EXISTS. This client has no URLs: a "place" is two pieces
// of store state — which full-width destination is up (`navView`) and which agent the three panes
// are pointed at (`activeAgentId`) — and the browser's own Back button is therefore about the page
// that hosts the application rather than about anything inside it. Under the desktop shell there
// is not even that. So moving between six destinations and a list of agents left no trail at all,
// and the way back to what you were just looking at was to remember it.
//
// A SPOT IS THOSE TWO FIELDS AND NOTHING ELSE. Not the right panel's tab, not the trace's selected
// step, not scroll offsets: those are the STATE OF a place rather than which place it is, and
// restoring them would make Back an undo button for things the user never navigated. The panes
// stay mounted across a destination change (see App.tsx), so returning to one finds it as it was
// without this store having to carry it.
//
// PAST / FUTURE, THE ONLY SHAPE THAT SURVIVES A BRANCH. Going back and then somewhere new must
// discard what was ahead — anything else offers a Forward that leads somewhere you have decided
// against. `record` clears `future` for exactly that reason, and it is the one line here that
// makes this a history rather than a ring buffer.

import { create } from "zustand";
import type { NavDestination } from "./uiStore.ts";

export interface Spot {
  /** The full-width destination, or null for the three-pane view. */
  nav: NavDestination | null;
  /** The agent the panes are pointed at. `null` IS a place — the empty composer. */
  agentId: string | null;
}

export const sameSpot = (a: Spot | null, b: Spot | null): boolean =>
  a !== null && b !== null && a.nav === b.nav && a.agentId === b.agentId;

/**
 * How far back this remembers.
 *
 * Fifty is past what anybody walks back through by pressing an arrow, and it is here so a session
 * left open all day does not grow an unbounded array of two-field objects. The oldest entry is
 * dropped rather than the newest refused, because a full history must not stop recording.
 */
const DEPTH = 50;

interface HistoryState {
  past: Spot[];
  current: Spot | null;
  future: Spot[];
  /**
   * True while `back`/`forward` are applying a spot.
   *
   * The subscriber that feeds `record` cannot tell the difference between somebody navigating and
   * this store putting the state back — both are the same field changing. Without this, stepping
   * back would record the place it just returned to as a NEW visit, clearing `future` and making
   * Forward dead the instant it was used.
   */
  restoring: boolean;
  record: (spot: Spot) => void;
  back: () => Spot | null;
  forward: () => Spot | null;
  setRestoring: (restoring: boolean) => void;
  /** Nothing survives a workspace switch — see `store/reset.ts`. */
  reset: () => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  past: [],
  current: null,
  future: [],
  restoring: false,

  record: (spot) => {
    const { current, past, restoring } = get();
    // A place is not visited twice in a row. Re-selecting the agent you are already on, or
    // re-pressing the destination you are already in, is not a step.
    if (restoring || sameSpot(current, spot)) return;
    set({
      past: current === null ? past : [...past, current].slice(-DEPTH),
      current: spot,
      future: [],
    });
  },

  back: () => {
    const { past, current } = get();
    const previous = past[past.length - 1];
    if (previous === undefined || current === null) return null;
    set({
      past: past.slice(0, -1),
      current: previous,
      future: [current, ...get().future].slice(0, DEPTH),
    });
    return previous;
  },

  forward: () => {
    const { future, current } = get();
    const next = future[0];
    if (next === undefined || current === null) return null;
    set({
      past: [...get().past, current].slice(-DEPTH),
      current: next,
      future: future.slice(1),
    });
    return next;
  },

  setRestoring: (restoring) => set({ restoring }),
  reset: () => set({ past: [], current: null, future: [], restoring: false }),
}));

/** Whether the arrows have anywhere to go. Read by the two buttons and by nothing else. */
export const canGoBack = (s: HistoryState): boolean => s.past.length > 0;
export const canGoForward = (s: HistoryState): boolean => s.future.length > 0;
