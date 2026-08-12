// What this workspace has spent, as the server last told it.
//
// Separate from providerStore for the reason that one is separate from uiStore: a different
// invariant, and a different rate of change. Which keys are connected changes when somebody
// pastes one; what has been spent changes on every step of every run. A single store would
// either be refreshed far too often or be stale half the time.
//
// EVERY MESSAGE IS A FULL SNAPSHOT, so `setUsage` replaces and never merges — the same
// discipline as mcpStore, providerStore and evalStore. A merged spend figure would be a number
// nobody could reproduce.
//
// AND NOTHING HERE IS COMPUTED. Not the total, not the headroom, not whether the workspace is
// over its ceiling. Every one of those comes from the same `BudgetGate.status` the server refuses
// a run with, and a client that recalculated any of them would eventually show a number that
// disagrees with the refusal the user is looking at. A billing page that disagrees with a
// refusal is worse than no billing page.

import { create } from "zustand";
import type { UsageSnapshot } from "../types.ts";

interface BillingState {
  usage: UsageSnapshot | null;
  /**
   * Whether a snapshot has ever landed.
   *
   * The same reason providerStore has one: before it does, "this workspace has spent nothing"
   * and "we have not been told yet" look identical, and showing $0.00 to somebody who has spent
   * forty dollars is worse than showing nothing at all.
   */
  loaded: boolean;
  error: string | null;

  setUsage: (usage: UsageSnapshot) => void;
  setError: (message: string | null) => void;
}

export const useBillingStore = create<BillingState>((set) => ({
  usage: null,
  loaded: false,
  error: null,

  // An error is cleared by a snapshot, because a snapshot answers whatever the error was about.
  setUsage: (usage) => set({ usage, loaded: true, error: null }),
  setError: (error) => set({ error }),
}));
