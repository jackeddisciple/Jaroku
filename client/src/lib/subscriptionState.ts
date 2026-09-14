// What a provider subscription row's state is called — one vocabulary for the model menu's Chat
// section and for Settings.
//
// TWO SURFACES HAD TWO VOCABULARIES, AND ONE OF THEM WAS WRONG. Settings said "Not signed in" and
// "Not installed"; the model menu's Chat section borrowed the Test section's badge and said "no API
// key" beside every model it could not use — in the one section where an API key is explicitly not
// the credential, pointing somebody at Secrets, the one place that cannot help. The tooltip under it
// was right; the word on screen contradicted it.
//
//   npm run test:subscription-state

import type { SubscriptionStatus } from "../types.ts";

/** A row's state in one word, so a badge, a menu and a sentence cannot disagree about it. */
export type SubscriptionState = "connected" | "signed-out" | "missing" | "unavailable";

/**
 * PERMISSION FIRST, like the server's derivation: a provider that permits nothing is unavailable
 * whatever this machine reports about it.
 */
export function subscriptionState(row: SubscriptionStatus): SubscriptionState {
  if (!row.available) return "unavailable";
  if (row.connected) return "connected";
  if (!row.host?.installed) return "missing";
  return "signed-out";
}

/**
 * The short word the model menu puts beside a Chat model it cannot use, or null when it can.
 *
 * NEVER ABOUT AN API KEY. A subscription is the credential in Chat, and a badge naming a key would
 * send somebody to Secrets for something Secrets cannot provide.
 */
export function subscriptionBadge(row: SubscriptionStatus | undefined): string | null {
  if (!row) return "not connected";
  switch (subscriptionState(row)) {
    case "connected": return null;
    case "signed-out": return "not signed in";
    case "missing": return "not installed";
    case "unavailable": return "unavailable";
  }
}

/** Why a listed Chat provider cannot be picked, in the provider's own terms. */
export function subscriptionBlockedReason(row: SubscriptionStatus | undefined): string {
  if (!row) return "This provider is not available for Chat.";
  switch (subscriptionState(row)) {
    // The provider's own reason, verbatim — paraphrasing a terms decision is how it drifts.
    case "unavailable": return row.reason ?? "This provider is not available for Chat yet.";
    case "missing": return `${row.binary ?? "The CLI"} isn't installed on this machine.`;
    case "signed-out":
      // THE SHELL'S OWN SENTENCE FIRST, when it named why. "Signed in with API credentials rather than
      // a ChatGPT plan" is the one case where "run the sign-in command" reads as nonsense to somebody
      // who can see they are signed in.
      if (row.host?.note) return row.host.note;
      return row.loginCommand
        ? `Run \`${row.loginCommand}\` to sign in with your plan.`
        : "Not signed in with a subscription.";
    case "connected": return "Connected.";
  }
}
