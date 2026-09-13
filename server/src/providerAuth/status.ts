// One row per provider in "connect your subscription", derived from two things that must never be
// confused: what the PROVIDER permits, and what the USER'S MACHINE currently has.
//
// THE WHOLE MODULE IS A PURE FUNCTION, and that is the point. The inputs are a table of verdicts
// (capability.ts) and a set of observations the desktop shell reported; the output is what the UI
// renders and what dispatch is allowed to route to. Nothing here spawns a process, opens a socket
// or reads a file — those belong to the shell, which is the only thing in this system standing on
// the machine where the user's credential lives.
//
// THE ORDER OF THE TWO INPUTS IS LOAD-BEARING. Permission is checked FIRST and cannot be overturned
// by observation. A user with Claude Code installed and signed in still gets `connected: false`,
// because Anthropic has not approved this product to use it — and the shape of that bug, had it
// gone the other way, is a product that works beautifully on the developer's laptop and quietly
// violates a provider's terms for every user who happens to have the right CLI installed. Hence
// `gatedEvenWhenPresent` below, which exists to be asserted rather than to be read.
//
// WHAT A HOST OBSERVATION IS NOT. It is not a credential and never carries one. `signedIn` is a
// boolean the provider's own CLI reported about itself; `account` is a display string that CLI
// printed. Jaroku never opens the credential store those facts come from — see capability.ts's
// `credentialPath`, which is recorded so the product can TELL somebody where their sign-in lives.
//
//   npm run test:provider-auth-status

import { providerLabel, type ProviderId } from "../providers.ts";
import type { Effort } from "../effort.ts";
import { capabilityOf, mapEffort, reasoningLevels } from "./capability.ts";

/**
 * What the desktop shell last saw on this machine for one provider.
 *
 * REPORTED RATHER THAN ASKED FOR, because the backend may be a continent away: in the shipped build
 * the relay runs on a server and the provider's CLI runs on somebody's laptop, so the server cannot
 * go and look. The shell observes and tells it. That direction is also the security property — the
 * side holding the credential is the side that never has to send anything about it.
 */
export interface HostObservation {
  readonly provider: ProviderId;
  /** Whether the provider's own CLI was found. False is an ordinary, expected state. */
  readonly installed: boolean;
  /** What that CLI reported as its version, when it was found. Display only. */
  readonly version: string | null;
  /**
   * Whether that CLI says it holds an active subscription sign-in.
   *
   * ITS ANSWER, NOT OURS. We ask the provider's tool about its own state and believe it. The
   * alternative — inspecting the credential file to decide for ourselves — is the intermediation
   * every one of these providers explicitly forbids.
   */
  readonly signedIn: boolean;
  /** The account that CLI printed, if it printed one. Shown so a user can see WHICH account. */
  readonly account: string | null;
  /** When the shell looked. ISO 8601. */
  readonly observedAt: string;
}

/** One row of the connect list, as a client renders it. */
export interface SubscriptionStatus {
  readonly provider: ProviderId;
  readonly label: string;
  /** Which PLAN pays. Codex runs on a ChatGPT plan, so the two names differ there. */
  readonly planLabel: string;
  /** May Chat use this provider's subscription TODAY. The client renders a gated row, not a hole. */
  readonly available: boolean;
  /** Does an official mechanism exist at all. True for Claude while `available` is false. */
  readonly supported: boolean;
  /** Is the gap between the two a provider approval we do not hold. */
  readonly requiresApproval: boolean;
  /** May an agent run on this provider with an API key from Secrets. Independent of all the above. */
  readonly runtimeApiSupported: boolean;
  /** Why not, when not. Null when available. */
  readonly reason: string | null;
  /** The provider's own page the verdict came from. Always present, both ways. */
  readonly citation: string;
  /** What would change a "no", when anything would. */
  readonly unblock: string | null;
  /** The CLI the user installs, when there is one. */
  readonly binary: string | null;
  /** What the user runs to sign in, as a displayable command. */
  readonly loginCommand: string | null;
  /** Where the provider keeps its own credential, so the product can say so. Never opened. */
  readonly credentialPath: string | null;
  /** The provider's own reasoning parameter, so the composer names a real control or omits it. */
  readonly effortParam: string | null;
  /** The levels this provider accepts. Empty means it has no reasoning control at all. */
  readonly effortLevels: Effort[];
  /** What this machine has, or null when nothing has reported — a browser, or a shell too old. */
  readonly host: {
    readonly installed: boolean;
    readonly version: string | null;
    readonly signedIn: boolean;
    readonly account: string | null;
    readonly observedAt: string;
  } | null;
  /**
   * The single derived answer: may Chat run on this provider's subscription right now.
   *
   * EVERY CALLER USES THIS AND NO CALLER RECOMPUTES IT. Dispatch, the model selector and the connect
   * list all ask the same question, and a second implementation of this `&&` is how one of them ends
   * up permitting something the other two refuse.
   */
  readonly connected: boolean;
}

/**
 * Whether a provider is gated despite the machine being fully set up for it.
 *
 * Exported because it is the property worth asserting: it is true exactly when somebody has the
 * provider's CLI installed and signed in and we still refuse. That combination is not a bug report,
 * it is the feature — and naming it means a future change that "fixes" it has to delete a function
 * with this comment on it rather than relax an `&&`.
 */
export function gatedEvenWhenPresent(id: ProviderId, host: HostObservation | undefined): boolean {
  return !capabilityOf(id).subscriptionChatAvailable && host !== undefined && host.installed && host.signedIn;
}

/** One row. `observations` is keyed by provider; a missing entry means nothing has reported. */
export function statusFor(id: ProviderId, host: HostObservation | undefined): SubscriptionStatus {
  const cap = capabilityOf(id);
  // THE MECHANISM IS SHOWN EVEN WHILE GATED. Claude's integration is finished and sitting under a
  // flag, and a row that names the binary and the sign-in command tells a user something true about
  // what is waiting for them. What it must never do is let that row be USED — which the line below
  // is responsible for, and which no field here can reach around.
  const mechanism = cap.mechanism;

  // PERMISSION FIRST. `connected` can only ever narrow from here — there is no branch below that
  // reaches it without passing through `subscriptionChatAvailable`.
  const connected = cap.subscriptionChatAvailable && host !== undefined && host.installed && host.signedIn;

  return {
    provider: id,
    label: cap.subscriptionLabel,
    planLabel: cap.id === "openai" ? "ChatGPT" : cap.subscriptionLabel,
    available: cap.subscriptionChatAvailable,
    supported: cap.subscriptionChatSupported,
    requiresApproval: cap.requiresProviderApproval,
    runtimeApiSupported: cap.runtimeApiSupported,
    reason: cap.reason,
    citation: cap.citation,
    unblock: cap.unblock,
    effortParam: cap.reasoning?.param ?? null,
    effortLevels: [...reasoningLevels(id)],
    binary: mechanism?.binary ?? null,
    loginCommand: mechanism ? mechanism.loginCommand.join(" ") : null,
    credentialPath: mechanism?.credentialPath ?? null,
    host: host
      ? {
        installed: host.installed,
        version: host.version,
        signedIn: host.signedIn,
        account: host.account,
        observedAt: host.observedAt,
      }
      : null,
    connected,
  };
}

/**
 * Every row, in a stable order.
 *
 * GATED PROVIDERS ARE INCLUDED. Hiding them would answer the user's question ("can I use my Claude
 * subscription?") with silence, and silence gets read as "not built yet" rather than as "Anthropic
 * does not permit it, here is the page, here is how that changes". A row that explains itself is
 * the difference between a missing feature and an informed decision.
 */
export function subscriptionStatuses(
  ids: readonly ProviderId[],
  observations: ReadonlyMap<ProviderId, HostObservation>,
): SubscriptionStatus[] {
  return ids.map((id) => statusFor(id, observations.get(id)));
}

/**
 * The providers Chat may actually run on right now.
 *
 * What the composer's Chat model selector is built from, and what dispatch checks before routing a
 * turn. Empty is an ordinary answer — on a machine with nothing installed, or in a browser.
 */
export function connectedProviders(statuses: readonly SubscriptionStatus[]): ProviderId[] {
  return statuses.filter((s) => s.connected).map((s) => s.provider);
}
