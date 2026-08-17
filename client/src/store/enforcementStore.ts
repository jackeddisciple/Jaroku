// Which rung of the abuse ladder this workspace is under, and what it has said about it.
//
// FULL SNAPSHOT, like every other channel's store. The state and the history arrive together
// because they are one read: "what is in force" and "what has been in force" are the same question
// at two tenses, and a strip that merged two arrivals could show a lifted rung above a live one.
//
// NOTHING HERE IS DERIVED. Whether a rung refuses work and the sentence explaining it both come
// from the server, computed by the same functions a refusal is built from — so the strip and the
// refusal a user just hit cannot disagree about what is happening to them.

import { create } from "zustand";

export type EnforcementLevel = "none" | "watch" | "soft_limit" | "verify" | "suspended" | "blocked";

export interface EnforcementState {
  level: EnforcementLevel;
  reason: string;
  appliedAt: string | null;
  expiresAt: string | null;
  /** Whether a person applied it. The two rungs that stop work outright always have one. */
  byHuman: boolean;
  /** The rung's own sentence, as a refusal would carry it. Null when nothing is in force. */
  explain: string | null;
  /** Whether new work is refused outright, rather than merely narrowed. The server's answer. */
  refusesWork: boolean;
}

export interface EnforcementRow {
  id: number;
  level: EnforcementLevel;
  reason: string;
  applied_at: string;
  expires_at: string | null;
  lifted_at: string | null;
  lifted_reason: string | null;
  appeal_note: string | null;
  appealed_at: string | null;
}

interface EnforcementStoreState {
  state: EnforcementState | null;
  history: EnforcementRow[];
  loaded: boolean;
  notice: string | null;
  error: string | null;

  apply: (state: EnforcementState, history: EnforcementRow[]) => void;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
}

export const useEnforcementStore = create<EnforcementStoreState>((set) => ({
  state: null,
  history: [],
  loaded: false,
  notice: null,
  error: null,

  apply: (state, history) => set({ state, history, loaded: true, error: null }),
  setNotice: (notice) => set({ notice }),
  setError: (error) => set({ error }),
}));

/** Whether anything is in force. `none` is the ordinary case and renders nothing at all. */
export function underEnforcement(state: EnforcementState | null): boolean {
  return state !== null && state.level !== "none";
}
