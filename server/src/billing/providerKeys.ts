// A workspace's own provider keys: where they are stored, where they are allowed to go, and
// where they are deliberately not.
//
// The product has always been bring-your-own-key. What changes hosted is only WHOSE box the key
// is on: locally it lived in `runtime/.env`, a file the one user owned, and the worst case of a
// leak was showing somebody their own credential. Hosted it is ~6,000 people's keys, and the
// same sentence in providers.ts — "a key is used at the moment of use and dropped" — has to be
// true across a network, a database and a sandbox rather than across one function.
//
// THREE RULES, AND THE FIRST TWO ARE THE SECURITY BOUNDARY.
//
//   1. THE KEY GOES THROUGH `SecretStore` AND NOWHERE ELSE. There is deliberately no
//      `get(ctx, name)` on that interface — a request handler cannot ask for a plaintext value,
//      because no method would answer — so a key can reach a run's environment and no other
//      destination. Not a log line, not a WebSocket frame, not an error message. Locally the
//      store still wraps `envWriter.ts` and still writes the same file, so `npm run dev` is
//      byte-for-byte what it was.
//
//   2. IT IS INJECTED INTO A RUN'S ENVIRONMENT, AND ONLY FOR THE PROVIDER THAT RUN NAMED. An
//      agent running on Anthropic gets `ANTHROPIC_API_KEY` and does not get `OPENAI_API_KEY`,
//      even when the workspace has configured both. That is the same least-privilege rule the
//      egress policy follows — a run may talk to the provider endpoint for `JAROKU_PROVIDER`
//      and not to both — and it is worth applying to the credential as well as to the socket,
//      because model-written Python is what receives it.
//
//   3. IT DOES NOT PAY FOR THE PLATFORM'S OWN THINKING UNLESS SOMEBODY SAID SO. Planning,
//      generation, the fix loop, explain and the judge are calls the platform makes on a
//      workspace's behalf, and by default they bill to the platform's key. Using a tenant's
//      credential for a call they did not ask for is a use they did not consent to, whatever
//      the accounting says. `own_key_for_platform` is how somebody says otherwise; it defaults
//      to false and no migration turns it on.
//
// A KEY IS PROVED BEFORE IT IS STORED. `verifyProviderKey` is a models-list call: it
// authenticates just as conclusively as a completion and costs nothing, which matters because
// the alternative is billing somebody for finding out whether they typed their own key
// correctly. A key that does not authenticate is refused rather than saved, so "connected" in
// the UI means connected rather than "typed".

import type { TenantContext } from "../db/tenant.ts";
import type { BillingRepository } from "../db/repositories/billing.ts";
import type { SecretStore } from "../secrets/secretStore.ts";
import {
  PROVIDER_ENV_KEY, isProviderId, verifyProviderKey, type ProviderId,
} from "../providers.ts";

export interface SaveKeyResult {
  ok: boolean;
  /** Why not, for the person who pasted it. Never contains any part of the key. */
  message: string | null;
  /** Something they should know even though it worked — see SecretStore.SetResult. */
  warning?: string | null;
}

/** How a key is proved. Injected so a suite can assert the refusal without calling a provider. */
export type VerifyKey = (provider: ProviderId, key: string) => Promise<{ ok: boolean; message: string | null }>;

export class WorkspaceProviderKeys {
  constructor(
    private secrets: SecretStore,
    private billing: BillingRepository,
    /**
     * The probe. Defaults to the real one — a models-list call against the provider.
     *
     * Injectable for one reason and it is not mocking for its own sake: the property worth
     * asserting is "a key that does not authenticate is never written", and a suite that
     * exercised it against the real endpoint would need a network, would be slow, and would
     * report somebody else's outage as a failure of this code.
     */
    private verify: VerifyKey = verifyProviderKey,
  ) {}

  /**
   * Prove a key works, then store it for this workspace.
   *
   * PROVED FIRST, AND THE ORDER IS THE POINT. Storing an unverified key means the first thing
   * that discovers it is wrong is a run — which has by then spent a sandbox start, a Python
   * import and a user's attention to produce a 401 from somebody else's API. The probe costs
   * nothing and happens before anything is written.
   *
   * The value is used by `verifyProviderKey` and by `secrets.set` and is held nowhere else: not
   * logged, not returned, not kept past the await. The same discipline providers.ts has always
   * had, now with a store behind it instead of a file.
   */
  async save(ctx: TenantContext, provider: ProviderId, key: string): Promise<SaveKeyResult> {
    if (!isProviderId(provider)) return { ok: false, message: `${provider} is not a provider you can connect` };
    if (!key.trim()) return { ok: false, message: "no key was entered" };

    const proof = await this.verify(provider, key);
    if (!proof.ok) {
      // The provider's own words, which name the status and the reason and never the
      // credential. Better than "invalid key" — a 401 and a rate-limited probe are different
      // problems and the second one is not the user's fault.
      return { ok: false, message: proof.message ?? "that key was rejected" };
    }

    const written = await this.secrets.set(ctx, PROVIDER_ENV_KEY[provider], key);
    if (!written.ok) return { ok: false, message: written.warning ?? "could not store that key" };
    return { ok: true, message: null, warning: written.warning };
  }

  async forget(ctx: TenantContext, provider: ProviderId): Promise<void> {
    await this.secrets.delete(ctx, PROVIDER_ENV_KEY[provider]);
  }

  /** Which provider env-var names this workspace has a value for. Names only, never values. */
  async configuredNames(ctx: TenantContext): Promise<Set<string>> {
    return new Set((await this.secrets.listNames(ctx)).map((r) => r.name));
  }

  /**
   * The environment a run needs to reach its provider.
   *
   * ONLY THE NAMED PROVIDER'S KEY, and an empty object for the dry-run provider, which needs
   * none. Handing a run every key the workspace has would be handing model-written Python a
   * credential its own configuration says it will not use.
   *
   * Takes a run id rather than a context because that is what `getForRun` takes, and that is
   * deliberate upstream: by the time a sandbox's environment is being built the requesting
   * context is long gone, so the run is the unit of authorisation. See secrets/secretStore.ts.
   */
  async runEnv(runId: string, provider: string | undefined): Promise<Record<string, string>> {
    if (!provider || !isProviderId(provider)) return {};
    return this.secrets.getForRun(runId, [PROVIDER_ENV_KEY[provider]]);
  }

  /**
   * The key the PLATFORM should think with for this workspace, or undefined for its own.
   *
   * Undefined means "use whatever `anthropicClient()` finds in the environment" — the platform's
   * key, and the behaviour every deployment has today. A value comes back only when the
   * workspace explicitly opted in.
   *
   * Undefined is ALSO what comes back when a workspace opted in and then removed its key, and
   * that fallback is deliberate: the alternative is failing every generation with an
   * authentication error until somebody notices a checkbox. The platform pays, which is the
   * arrangement they had before they opted in.
   */
  async platformKey(ctx: TenantContext): Promise<string | undefined> {
    const balance = await this.billing.balance(ctx);
    if (!balance.own_key_for_platform) return undefined;
    // Anthropic only. Planning, generation, the fix loop, explain and the judge are all
    // Anthropic-only (providers.ts's `powers_jaroku`), so an OpenAI key opted in would buy the
    // workspace nothing and would be a credential handed to a call that cannot use it.
    const env = await this.secrets.getForPlatformCall(ctx, [PROVIDER_ENV_KEY.anthropic]);
    return env[PROVIDER_ENV_KEY.anthropic];
  }

  /** Turn the opt-in on or off. Explicit, not a toggle — see the repository's own note. */
  async setOwnKeyForPlatform(ctx: TenantContext, on: boolean): Promise<void> {
    await this.billing.setOwnKeyForPlatform(ctx, on);
  }

  async ownKeyForPlatform(ctx: TenantContext): Promise<boolean> {
    return (await this.billing.balance(ctx)).own_key_for_platform;
  }
}
