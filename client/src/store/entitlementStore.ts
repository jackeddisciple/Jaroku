// The last thing this workspace's tier refused, and what the card about it should say.
//
// A STORE RATHER THAN A FIELD ON EIGHTEEN MESSAGE SHAPES. A refusal arrives on whichever channel the
// command belonged to — `gen` for a fourth agent, `deploy` for a sixth deployment, `members` for an
// invite — and every one of those already has its own `type: "error"`. Threading the structure
// through all of them would mean eighteen union members gaining an optional field and eighteen
// handlers deciding whether to read it, which is eighteen chances to forget. The socket lifts it out
// once, here, and the panels read one store.
//
// AND THE CHANNEL'S OWN ERROR STILL LANDS, unchanged. Every panel that shows an error string keeps
// showing one, so a surface with no card to render is not a surface where the refusal vanishes. The
// card is an upgrade on that, not a replacement for it — the same relationship `EnforcementStrip`
// has with the errors an enforced workspace sees.
//
// ONE AT A TIME, NOT A LIST. A refusal is about the thing the user just tried, and it is answered by
// upgrading or by waiting for the month to turn — so a second one supersedes the first rather than
// stacking beneath it. A pile of upsell cards is an advertisement; one card next to the button that
// did not work is an explanation.
//
// NOTHING HERE IS COMPUTED, for the reason billingStore says the same: the figure and the limit come
// from the server that did the refusing. A client that recalculated "3 of 3" would eventually show a
// number that disagrees with the refusal the user is reading, and a billing surface that disagrees
// with a refusal is worse than no billing surface.

import { create } from "zustand";

/** A limit that may not exist. The server sends the word rather than the absence. */
export type Limit = number | "unlimited";

/** A count against a cap: agents, runs this month, seats. Carries the figures a meter needs. */
export interface QuotaRefusal {
  error: "quota_exceeded";
  /** Names the LIMIT, not the check — `runs_per_month`, never `canStartRun`. */
  kind: string;
  current: number;
  limit: number;
  tier: string;
  upgradeUrl: string;
}

/**
 * A gate that is off on this tier.
 *
 * NO NUMBERS, DELIBERATELY. "GitHub is not on Free" is not zero of zero, and a card that rendered a
 * meter at 0/0 would be worse than one with no meter — it reads as a quota that can be topped up by
 * waiting, which this one cannot.
 */
export interface FeatureRefusal {
  error: "feature_unavailable";
  kind: string;
  tier: string;
  upgradeUrl: string;
}

export type EntitlementRefusal = QuotaRefusal | FeatureRefusal;

/**
 * Whether a value off the wire is a refusal.
 *
 * CHECKED RATHER THAN CAST, because this arrives on a socket and the client's types are a
 * description of what the server sends rather than a guarantee — the same posture `parseDeepLink`
 * takes toward a URL. A half-understood refusal renders a card with `undefined of undefined` in it,
 * which is worse than the plain error string the panel would otherwise have shown.
 */
export function isRefusal(v: unknown): v is EntitlementRefusal {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (typeof r["tier"] !== "string" || typeof r["kind"] !== "string") return false;
  if (typeof r["upgradeUrl"] !== "string") return false;
  if (r["error"] === "feature_unavailable") return true;
  return r["error"] === "quota_exceeded" &&
    typeof r["current"] === "number" && typeof r["limit"] === "number";
}

interface EntitlementState {
  /** The refusal to render, or null when nothing has been refused since the last dismissal. */
  refusal: EntitlementRefusal | null;
  /**
   * Which channel it came in on.
   *
   * So a panel can ask "was this refusal about ME" and stay quiet when it was not. Without it, a
   * refused invite would put a card on the composer, beside a button that works fine.
   */
  channel: string | null;

  refuse: (channel: string, refusal: EntitlementRefusal) => void;
  clear: () => void;
}

export const useEntitlementStore = create<EntitlementState>((set) => ({
  refusal: null,
  channel: null,

  refuse: (channel, refusal) => set({ channel, refusal }),
  // Cleared by dismissing the card, and by a workspace switch through reset.ts — a limit is a fact
  // about one workspace and must never be carried into another.
  clear: () => set({ refusal: null, channel: null }),
}));
