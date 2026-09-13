// What each model provider OFFICIALLY permits a third-party application to do with an end user's
// own subscription — and, for the two that permit nothing, the sentence that says so.
//
// THIS FILE IS A GATE RATHER THAN A CONFIGURATION. Every other module in this subsystem asks it
// whether a provider may be connected at all, and the answer is a compile-time constant with a
// citation attached. The failure it exists to prevent is the one that is invisible in review: a
// provider quietly wired up because the code path was already there, shipped to users who then
// authenticate a subscription in a way its owner forbids, and discover it when their account is
// enforced against rather than when we merged it.
//
// THE RULE THE WHOLE SUBSYSTEM IS WRITTEN UNDER, from the product owner, 2026-09-13:
//
//   "If a provider officially supports subscription-backed third-party usage, implement it. If a
//    provider does not officially support it, leave that provider unavailable for subscription-
//    backed Chat rather than replacing it with API-key authentication."
//
// So `available: false` is a SHIPPED STATE, not a TODO. A gated provider renders in the product
// with its reason and its citation, and the only thing that changes it is the provider changing
// its terms — never a flag, never an environment variable, never a build.
//
// WHAT WAS VERIFIED, AND WHERE. Each entry below was checked against the provider's own developer
// documentation on 2026-09-13. The `citation` is the page the verdict came from, so the next person
// to doubt this can re-read the source rather than re-derive the conclusion.
//
// AND THE MECHANISM IS ALWAYS DELEGATION, NEVER INTERMEDIATION. Where a provider does permit this,
// the shape is the same: the user signs in through THE PROVIDER'S OWN browser flow, the provider's
// own CLI caches the credential in its own store, and Jaroku drives that local process over a
// documented protocol. Jaroku never sees, stores, forwards or refreshes a credential — which is
// not merely good practice but the literal condition every one of these providers attaches:
// "developers may not collect, store, or intermediate ... credentials or session tokens".
//
//   npm run test:provider-auth-capability

import { PROVIDER_IDS, type ProviderId } from "../providers.ts";

/**
 * How Jaroku reaches a provider that permits subscription-backed use.
 *
 * ONE SHAPE, DELIBERATELY. There is a temptation to model this as an open union — an OAuth variant,
 * a device-code variant, a token variant — because that is what a credential system usually looks
 * like. Every one of those variants would require Jaroku to HOLD something, and holding is the
 * thing that is forbidden. `local-agent` is the only shape that never does, so it is the only shape
 * this type admits: a second variant could not be added without someone first re-reading the terms,
 * which is exactly the pause this is meant to force.
 */
export interface LocalAgentMechanism {
  readonly kind: "local-agent";
  /** The executable the user installs. Detected on PATH; never bundled, never vendored. */
  readonly binary: string;
  /**
   * What the user runs to sign in.
   *
   * IT IS THE PROVIDER'S COMMAND AND THE PROVIDER'S BROWSER FLOW. Jaroku may invoke it and may show
   * what it printed; it may not scrape the page, pre-fill the form, or read the result out of the
   * store it writes to.
   */
  readonly loginCommand: readonly string[];
  /** The documented subprocess mode Jaroku drives, and the protocol it speaks. */
  readonly serve: { readonly argv: readonly string[]; readonly protocol: "json-rpc-2.0/stdio" };
  /**
   * Where the provider's own CLI caches its own credential.
   *
   * RECORDED SO THE PRODUCT CAN NAME IT, AND FOR NO OTHER REASON. Nothing in this repository opens
   * this path. It appears in the UI so a user can be told where their sign-in lives and how to
   * revoke it, which is a thing they are entitled to know about software running on their machine.
   */
  readonly credentialPath: string;
  /** The provider's own documentation that sanctions embedding it in another product. */
  readonly citation: string;
  /** The sentence that documentation uses, quoted, so the claim travels with the code. */
  readonly sanction: string;
}

/** A provider that does not permit this, and the reason it does not. */
export interface Unavailable {
  readonly available: false;
  /** Rendered to the user verbatim. Plain, factual, and never apologetic. */
  readonly reason: string;
  /** The page the verdict came from. */
  readonly citation: string;
  /**
   * What would change the verdict, when anything would.
   *
   * Anthropic's restriction is "unless previously approved", which makes it a business step rather
   * than a permanent no — and a product owner who is told that can act on it. A provider that has
   * simply not built the mechanism gets `null`, because there is nothing to do but wait.
   */
  readonly unblock: string | null;
}

export type SubscriptionSupport = { readonly available: true; readonly mechanism: LocalAgentMechanism } | Unavailable;

/**
 * The verdicts, one per provider, verified 2026-09-13.
 *
 * KEYED BY THE SAME `ProviderId` THE API-KEY SIDE USES, and that shared key is the only thing the
 * two credential systems have in common. It is a name, not a credential: `providerAuth` never reads
 * `PROVIDER_ENV_KEY`, and `providers.ts` never reads this table. The separation the product owner
 * asked for — "these are two completely independent credential systems" — is kept by the two
 * modules not importing each other's secrets rather than by a comment asking them not to.
 */
export const SUBSCRIPTION_SUPPORT: Readonly<Record<ProviderId, SubscriptionSupport>> = {
  // ------------------------------------------------------------------------------------------
  // Claude — permitted only with prior written approval from Anthropic.
  //
  // The support article "Use the Claude Agent SDK with your Claude plan" does say that third-party
  // app usage draws on a subscription's limits, and read alone it sounds like a green light. It is
  // describing what happens to an INDIVIDUAL'S OWN usage, and it sits under a paused billing
  // change. The operative sentence for a developer is in the Agent SDK overview and it is specific
  // enough to name the SDK itself, which is why it wins.
  // ------------------------------------------------------------------------------------------
  anthropic: {
    available: false,
    reason:
      "Anthropic does not allow third-party developers to offer Claude.ai login or subscription "
      + "rate limits in their own products — including agents built on the Claude Agent SDK — "
      + "unless the developer has been approved in advance.",
    citation: "https://code.claude.com/docs/en/agent-sdk/overview",
    unblock:
      "Anthropic grants exceptions: the restriction reads \"unless previously approved\". Request "
      + "approval through https://www.anthropic.com/contact-sales. This provider turns on the day "
      + "that approval lands, with no code change beyond this entry.",
  },

  // ------------------------------------------------------------------------------------------
  // Codex — permitted, and documented for exactly this.
  //
  // OpenAI publishes `codex app-server` as the interface its OWN rich clients use — the VS Code
  // extension is the example the page gives — and tells third-party developers to use it when they
  // want a deep integration inside their own product, naming authentication as one of the things it
  // carries. `codex login` completes in OpenAI's browser flow and caches to the path below, which
  // is the provider holding its own credential exactly as its terms require.
  // ------------------------------------------------------------------------------------------
  openai: {
    available: true,
    mechanism: {
      kind: "local-agent",
      binary: "codex",
      loginCommand: ["codex", "login"],
      serve: { argv: ["codex", "app-server"], protocol: "json-rpc-2.0/stdio" },
      credentialPath: "~/.codex/auth.json",
      citation: "https://learn.chatgpt.com/docs/app-server",
      sanction:
        "Use it when you want a deep integration inside your own product: authentication, "
        + "conversation history, approvals, and streamed agent events.",
    },
  },

  // ------------------------------------------------------------------------------------------
  // Muse Spark — no documented third-party path.
  //
  // Muse Code offers a browser sign-in, so the mechanism plainly exists inside Meta's own client;
  // what is absent is any documentation letting another product drive it. The docs point the other
  // way for exactly the case Jaroku is: "for non-interactive environments, set META_API_KEY
  // instead." An undocumented path is not a permitted one, and `muse exec` under somebody's browser
  // sign-in would be us deciding that on Meta's behalf.
  // ------------------------------------------------------------------------------------------
  meta: {
    available: false,
    reason:
      "Meta documents no way for a third-party application to drive Muse Code under a user's "
      + "subscription sign-in. Its own guidance for non-interactive use is to set META_API_KEY, "
      + "which is API billing rather than subscription access.",
    citation: "https://dev.meta.ai/docs",
    unblock: null,
  },
} as const;

/** What a provider permits. Total over `ProviderId`, so there is no "unknown provider" branch. */
export function subscriptionSupport(id: ProviderId): SubscriptionSupport {
  return SUBSCRIPTION_SUPPORT[id];
}

/**
 * Whether this provider may be connected as a subscription at all.
 *
 * THE ONE PREDICATE EVERY CALLER USES. Dispatch asks it before routing a turn, the relay asks it
 * before accepting a connect command, and the client asks it before offering a button. Three
 * questions with one answer, so a provider cannot be live in one of them and gated in another.
 */
export function subscriptionAvailable(id: ProviderId): boolean {
  return SUBSCRIPTION_SUPPORT[id].available;
}

/**
 * The mechanism for a provider that has one, or null.
 *
 * Returning null rather than throwing for a gated provider: callers reach this while building a
 * snapshot for the UI, where "this one is gated" is an ordinary row to render and not an error.
 */
export function localAgentFor(id: ProviderId): LocalAgentMechanism | null {
  const support = SUBSCRIPTION_SUPPORT[id];
  return support.available ? support.mechanism : null;
}

/** Every provider that may be connected today. Empty is a legitimate answer. */
export function availableSubscriptionProviders(): ProviderId[] {
  return PROVIDER_IDS.filter(subscriptionAvailable);
}
