// What the Secrets tab knows, and one thing it deliberately does not.
//
// THE ELEVATION TOKEN IS NOT IN HERE. It lives in a module variable in `lib/secrets.ts`, and the
// omission is the point: a store is a thing devtools serialise, session-replay tools capture and
// error reporters attach to a bug report. `elevated` and `expiresAt` are in here because a
// countdown has to render from something; the credential that grants access is not.
//
// NOR IS ANY SECRET VALUE. A revealed credential is returned to the component that asked and held
// in its local state for as long as the dialog is open. Putting one here would make it outlive the
// dialog, survive into a devtools snapshot, and — worst — be there to be accidentally rendered by
// the next person to add a row to the list.
//
// THE PENDING ACTION IS THE INTERESTING FIELD. The brief asks that elevation expiring mid-form
// hold the user's input, show the lock inline, and resume on unlock: "losing a half-typed secret
// to a timer is a self-inflicted wound." That is what `pending` is — a thunk captured when a
// mutation was refused for want of elevation, replayed after a successful unlock.

import { create } from "zustand";
import type { SecretSummary, SecretsHealth } from "../lib/secrets.ts";

/** A mutation that was interrupted by an expiry, waiting to be replayed. */
export interface PendingAction {
  /** What to say on the lock screen, so somebody knows what they are unlocking to finish. */
  label: string;
  run: () => Promise<void>;
}

interface SecretsState {
  /** Whether THIS SESSION is elevated, as the server last reported it. */
  elevated: boolean;
  expiresAt: string | null;
  /** Recomputed by a ticking effect, so the countdown does not re-fetch once a second. */
  remainingMs: number;
  /** False means the first-run setup flow rather than the unlock flow. */
  passcodeSet: boolean;
  gate: "tab" | "mutations";
  /** Whether the gate state has been fetched at least once — the lock screen must not flash. */
  gateLoaded: boolean;

  secrets: SecretSummary[];
  /** Loaded at least once, so an empty list renders an empty state rather than a spinner forever. */
  loaded: boolean;
  health: SecretsHealth | null;

  busy: Record<string, true>;
  error: string | null;
  notice: string | null;
  /** Held across a lock so the action can be finished rather than retyped. */
  pending: PendingAction | null;

  setElevation: (e: { elevated: boolean; expiresAt: string | null; remainingMs: number; passcodeSet: boolean; gate: "tab" | "mutations" }) => void;
  tick: (now: number) => void;
  setSecrets: (secrets: SecretSummary[]) => void;
  setHealth: (health: SecretsHealth) => void;
  startBusy: (key: string) => void;
  endBusy: (key: string) => void;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  setPending: (action: PendingAction | null) => void;
}

export const useSecretsStore = create<SecretsState>((set) => ({
  elevated: false,
  expiresAt: null,
  remainingMs: 0,
  passcodeSet: false,
  gate: "tab",
  gateLoaded: false,

  secrets: [],
  loaded: false,
  health: null,

  busy: {},
  error: null,
  notice: null,
  pending: null,

  setElevation: (e) =>
    set((s) => ({
      ...e,
      gateLoaded: true,
      // LOCKING DROPS THE LIST. A locked tab that kept the rows would keep rendering what a
      // workspace integrates with after the gate closed — which is the whole thing the gate is
      // for, defeated by a stale array. Under `mutations` the list is legitimately readable
      // while locked, so it survives there.
      ...(e.elevated || e.gate === "mutations" ? {} : { secrets: [], loaded: false }),
      // An expiry clears a pending action only when there is nothing to come back to; a pending
      // action is precisely what SHOULD survive a lock, so it is untouched here.
      ...(s.error && e.elevated ? { error: null } : {}),
    })),

  /**
   * Recompute the countdown from a clock the caller owns.
   *
   * Takes `now` rather than reading `Date.now()` so the tick is testable, and clamps at zero: a
   * negative countdown is not something a renderer should have to defend against.
   */
  tick: (now) =>
    set((s) => {
      if (!s.expiresAt) return s.remainingMs === 0 ? {} : { remainingMs: 0 };
      const remaining = Math.max(0, Date.parse(s.expiresAt) - now);
      // The client does not decide it is locked — the server does, and the next request will say
      // so. What it does here is stop the countdown at zero and stop claiming to be elevated, so
      // the UI locks the instant the timer runs out rather than at the next poll.
      return remaining === 0 ? { remainingMs: 0, elevated: false } : { remainingMs: remaining };
    }),

  setSecrets: (secrets) => set({ secrets, loaded: true }),
  setHealth: (health) => set({ health }),
  startBusy: (key) => set((s) => ({ busy: { ...s.busy, [key]: true }, error: null })),
  endBusy: (key) =>
    set((s) => {
      const busy = { ...s.busy };
      delete busy[key];
      return { busy };
    }),
  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),
  setPending: (pending) => set({ pending }),
}));

/** Whether the tab should show its warning dot. Computed here so the tab bar holds no policy. */
export function needsAttention(health: SecretsHealth | null): boolean {
  if (!health) return false;
  return health.expiringSoon > 0 || health.invalid > 0 || health.rotationDue > 0;
}

/** The three groups the brief specifies, in its order. Each origin needs different verbs. */
export function groupSecrets(secrets: SecretSummary[]): {
  providers: SecretSummary[];
  managed: SecretSummary[];
  custom: SecretSummary[];
} {
  return {
    providers: secrets.filter((s) => s.kind === "provider_key"),
    managed: secrets.filter((s) => s.kind === "managed"),
    custom: secrets.filter((s) => s.kind === "custom"),
  };
}

/** `6:12`. Minutes and seconds, because a countdown in milliseconds is not a countdown. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The last minute, which the brief renders differently.
 *
 * A named predicate rather than an inline comparison, because two places need it — the amber tone
 * and the icon change — and the accessibility rule is that the final minute must not be signalled
 * by colour alone. Two readers of one predicate cannot disagree about when it starts.
 */
export function isFinalMinute(ms: number): boolean {
  return ms > 0 && ms <= 60_000;
}
