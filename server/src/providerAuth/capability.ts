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
import type { Effort } from "../effort.ts";

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
  readonly serve: { readonly argv: readonly string[]; readonly protocol: string };
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

/**
 * How Jaroku's five effort levels reach ONE provider's real parameter.
 *
 * NOT ASSUMED TO BE THE SAME SHAPE ANYWHERE. Codex takes a named level on a config key; Claude
 * takes a slash-command argument; Muse Spark takes nothing at all. A single "effort" value sent to
 * all three would be a parameter two of them reject and one ignores, so what is stored here is the
 * PARAMETER'S NAME and a table from our level to that provider's own vocabulary.
 *
 * A level that maps to a word below its own is a CLAMP, and the clamp is visible: `mapEffort`
 * reports which level was really applied, so §3.2's "never report an effort that wasn't used"
 * survives the translation.
 */
export interface ReasoningCapability {
  /** The provider's own parameter, exactly as its CLI or API spells it. */
  readonly param: string;
  /** Jaroku's levels this provider actually accepts, in order. */
  readonly levels: readonly Effort[];
  /** Our level -> the provider's word for it. Null means send nothing rather than something close. */
  readonly map: Readonly<Record<Effort, string | null>>;
}

/**
 * Everything the product needs to decide what a provider may do, in one record.
 *
 * FOUR BOOLEANS RATHER THAN ONE, because they answer four genuinely different questions and
 * collapsing them is how a gated provider gets deleted by a refactor:
 *
 *   subscriptionChatSupported   does an official mechanism EXIST at all
 *   subscriptionChatAvailable   may we use it TODAY
 *   requiresProviderApproval    is the gap between those two a business step
 *   runtimeApiSupported         may an agent run on this provider with the user's own API key
 *
 * Claude is the case that proves they are different: supported, not available, approval pending,
 * and fully usable for agent runtime. A single `available` flag would lose three of those facts,
 * and the product would have nothing true to render.
 */
export interface ProviderCapability {
  readonly id: ProviderId;
  /**
   * What the SUBSCRIPTION is called, which is not always what the company is called.
   *
   * `providerLabel` says "OpenAI", and that is right for an API key — the key is an OpenAI platform
   * credential. It is wrong here: what somebody signs into is CODEX, with their ChatGPT plan, and a
   * row headed "OpenAI" reading "runs on your OpenAI plan" told a user with a ChatGPT subscription
   * that they were connected to something they did not think they had. Claude happens to be called
   * the same thing in both systems; Codex does not, and one table that assumed they always agreed
   * is how that confusion shipped.
   */
  readonly subscriptionLabel: string;
  readonly subscriptionChatSupported: boolean;
  /** Never true when `subscriptionChatSupported` is false — asserted, not merely intended. */
  readonly subscriptionChatAvailable: boolean;
  readonly requiresProviderApproval: boolean;
  readonly runtimeApiSupported: boolean;
  /** Which pool subscription-backed chat spends. Null when there is no such path. */
  readonly usageSource: "subscription" | null;
  /** How to reach it. Present even while gated, because the implementation is finished. */
  readonly mechanism: LocalAgentMechanism | null;
  /** Why it is not available, for a person. Null when it is. */
  readonly reason: string | null;
  /** The provider's own page this verdict was read from. Always present. */
  readonly citation: string;
  /** What would change a "no". Null when nothing would, or when it is already "yes". */
  readonly unblock: string | null;
  /** How effort reaches this provider. Null when it has no reasoning control. */
  readonly reasoning: ReasoningCapability | null;
}

/**
 * The verdicts, one per provider, verified 2026-09-13.
 *
 * KEYED BY THE SAME `ProviderId` THE API-KEY SIDE USES, and that shared key is the only thing the
 * two credential systems have in common. It is a name, not a credential: this module never reads
 * `PROVIDER_ENV_KEY`, and `providers.ts` never reads this table. The separation the product owner
 * asked for is kept by the two modules not importing each other's secrets rather than by a comment
 * asking them not to.
 */
export const PROVIDER_CAPABILITY: Readonly<Record<ProviderId, ProviderCapability>> = {
  // ------------------------------------------------------------------------------------------
  // Claude — permitted, under a section written for exactly this.
  //
  // Anthropic governs two different acts with two different sentences, and what separates them is
  // WHICH THING IS DOING THE AUTHENTICATING.
  //
  // PROHIBITED: offering Claude.ai login inside your own application, routing requests through plan
  // credentials on a user's behalf, or holding their tokens. The Agent SDK overview names agents
  // built on that SDK specifically — because embedding the SDK as a library makes YOUR product the
  // thing logging in.
  //
  // PERMITTED: "Can customers offer Claude Code in their products?" — a section of the legal page
  // whose title is the question this integration asks. It permits preinstalling or running Claude
  // Code in a product subject to four conditions, and the authentication section says it again:
  // "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with
  // their own Claude subscription, including where a platform hosts Claude Code."
  //
  // THE FOUR CONDITIONS, AND WHAT SATISFIES EACH HERE:
  //
  //   the binary is unmodified         the user's own install, found on PATH, never bundled
  //   its auth methods are untouched   `claude auth login` is Anthropic's flow, run unchanged
  //   usage is not paid for or resold  `recordChatTurn` books no cost and meters nothing
  //   each end user authenticates      no token is ever held; it stays in their Keychain
  //
  // THE ONE REAL OBLIGATION, which is a business act rather than a property of this code: running
  // Claude Code inside a product "requires agreeing to our Commercial Terms of Service". That is a
  // click-through the product owner accepts once — which is what this entry had wrong before, having
  // read the Agent SDK's "unless previously approved" as governing the subprocess case as well.
  //
  // AND A BRANDING RULE, a product constraint rather than a code one: "Powered by Claude" and
  // "Claude Agent" are permitted, "Claude Code" as part of a product or feature name is not.
  // `PROVIDER_LABEL` says "Claude", which is inside the line.
  // ------------------------------------------------------------------------------------------
  anthropic: {
    id: "anthropic",
    subscriptionLabel: "Claude",
    subscriptionChatSupported: true,
    subscriptionChatAvailable: true,
    requiresProviderApproval: false,
    runtimeApiSupported: true,
    usageSource: "subscription",
    mechanism: {
      kind: "local-agent",
      binary: "claude",
      // `claude auth login` rather than the in-session `/login`: this is what somebody types in a
      // terminal to sign in, and therefore what a disconnected row can usefully print.
      loginCommand: ["claude", "auth", "login"],
      // NEVER `--bare`. That mode "never reads OAuth credentials or the system keychain" and wants
      // ANTHROPIC_API_KEY instead, so it would turn subscription chat into API billing without
      // anything appearing to go wrong — the exact crossing this architecture exists to prevent.
      serve: {
        argv: ["claude", "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
        protocol: "stream-json/stdio",
      },
      credentialPath: "the macOS Keychain, or ~/.claude/.credentials.json",
      citation: "https://code.claude.com/docs/en/legal-and-compliance",
      sanction:
        "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with "
        + "their own Claude subscription, including where a platform hosts Claude Code.",
    },
    reason: null,
    citation: "https://code.claude.com/docs/en/legal-and-compliance",
    unblock: null,
    // `/effort <level>` in the prompt string, with the same five names Jaroku uses. One-to-one
    // because both were written from the product owner's level names, not because it was assumed.
    reasoning: {
      param: "/effort",
      levels: ["low", "medium", "high", "xhigh", "max"],
      map: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    },
  },

  // ------------------------------------------------------------------------------------------
  // Codex — documented for exactly this, and verified against codex-cli 0.154.0 on 2026-09-13.
  // ------------------------------------------------------------------------------------------
  openai: {
    id: "openai",
    subscriptionLabel: "Codex",
    subscriptionChatSupported: true,
    subscriptionChatAvailable: true,
    requiresProviderApproval: false,
    runtimeApiSupported: true,
    usageSource: "subscription",
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
    reason: null,
    citation: "https://learn.chatgpt.com/docs/app-server",
    unblock: null,
    // `model_reasoning_effort`, set per invocation with `-c model_reasoning_effort="high"`. Codex
    // stops at xhigh, so Jaroku's Max CLAMPS to it rather than inventing a level the CLI rejects.
    reasoning: {
      param: "model_reasoning_effort",
      levels: ["low", "medium", "high", "xhigh"],
      map: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" },
    },
  },

  // ------------------------------------------------------------------------------------------
  // Muse Spark — no official third-party mechanism, so there is nothing to gate and nothing to
  // approve. It remains a first-class provider for agent runtime on the user's own API key.
  // ------------------------------------------------------------------------------------------
  meta: {
    id: "meta",
    subscriptionLabel: "Muse Spark",
    subscriptionChatSupported: false,
    subscriptionChatAvailable: false,
    requiresProviderApproval: false,
    runtimeApiSupported: true,
    usageSource: null,
    mechanism: null,
    reason:
      "Meta documents no way for a third-party application to drive Muse Code under a user's "
      + "subscription sign-in. Its own guidance for non-interactive use is to set META_API_KEY, "
      + "which is API billing rather than subscription access.",
    citation: "https://dev.meta.ai/docs",
    unblock: null,
    // No reasoning control at all, by the product owner's call — which is why the composer omits
    // the slider for Muse Spark rather than drawing one that would change nothing.
    reasoning: null,
  },
} as const;

/** What a provider permits. Total over `ProviderId`, so there is no "unknown provider" branch. */
export function capabilityOf(id: ProviderId): ProviderCapability {
  return PROVIDER_CAPABILITY[id];
}

/**
 * Whether this provider may be connected as a subscription TODAY.
 *
 * THE ONE PREDICATE EVERY CALLER USES. Dispatch asks it before routing a turn, the relay asks it
 * before accepting a connect command, and the client asks it before offering a button. Three
 * questions with one answer, so a provider cannot be live in one of them and gated in another.
 */
export function subscriptionAvailable(id: ProviderId): boolean {
  return PROVIDER_CAPABILITY[id].subscriptionChatAvailable;
}

/**
 * The mechanism for a provider that has one, or null.
 *
 * PRESENT EVEN WHILE GATED, which is deliberate: Claude's integration is finished and this is what
 * it is built from. Nothing may USE it while `subscriptionChatAvailable` is false — that is
 * `subscriptionAvailable`'s job, and `status.ts` checks it first.
 */
export function localAgentFor(id: ProviderId): LocalAgentMechanism | null {
  return PROVIDER_CAPABILITY[id].mechanism;
}

/**
 * Translate a level into what THIS provider's parameter actually takes.
 *
 * Returns both halves, because they differ and the difference is what the UI has to show: `applied`
 * is the level really asked for after clamping, `value` is the provider's own word for it. A
 * provider with no reasoning control returns nulls and the caller sends nothing at all.
 */
export function mapEffort(id: ProviderId, requested: Effort): { applied: Effort | null; value: string | null } {
  const reasoning = PROVIDER_CAPABILITY[id].reasoning;
  if (!reasoning) return { applied: null, value: null };
  const value = reasoning.map[requested] ?? null;
  if (value === null) return { applied: null, value: null };
  // The level that word really corresponds to — `requested` unless the map clamped it. Found by
  // looking up rather than assumed, so a clamp is reported as the level actually spent.
  const applied = reasoning.levels.find((l) => reasoning.map[l] === value) ?? requested;
  return { applied, value };
}

/** The levels this provider's control should offer. Empty when it has no reasoning control. */
export function reasoningLevels(id: ProviderId): readonly Effort[] {
  return PROVIDER_CAPABILITY[id].reasoning?.levels ?? [];
}

/** Every provider that may be connected today. Empty is a legitimate answer. */
export function availableSubscriptionProviders(): ProviderId[] {
  return PROVIDER_IDS.filter(subscriptionAvailable);
}

/** Providers with an official mechanism, whether or not we may use it yet. */
export function supportedSubscriptionProviders(): ProviderId[] {
  return PROVIDER_IDS.filter((id) => PROVIDER_CAPABILITY[id].subscriptionChatSupported);
}

/** Providers an agent may run on with an API key from Secrets. Independent of everything above. */
export function runtimeApiProviders(): ProviderId[] {
  return PROVIDER_IDS.filter((id) => PROVIDER_CAPABILITY[id].runtimeApiSupported);
}
