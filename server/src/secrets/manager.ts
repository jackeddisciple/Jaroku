// What the Secrets surface actually does, between the route layer and the vault.
//
// The routes decide WHO may act; this decides what acting means. It exists as its own object
// rather than as closures in `index.ts` because three of its rules are worth testing without a
// server in the way, and because every one of them is a place a credential could escape:
//
//   A VALUE IS PROVED BEFORE IT IS STORED, when there is anything to prove it against. That is the
//   existing BYOK rule — `verifyProviderKey` is a models-list call, which authenticates as
//   conclusively as a completion and costs nothing — applied to the new surface. A key rejected by
//   its own provider is a typo caught at the moment of the mistake rather than three screens later,
//   and it is NOT stored: a row saying `invalid` beside a vault holding something unusable is two
//   facts that will disagree.
//
//   THE MASK IS COMPUTED HERE, ONCE, while the plaintext is in hand and about to be discarded.
//   Never on read, because on read there is no plaintext and getting one would mean opening a
//   decrypt path for cosmetics.
//
//   `store` IS THE ONLY WRITER, so adding and rotating cannot drift apart. Rotation is the same
//   call against a name that already exists, which is what makes "rotation replaces, history is
//   metadata" true by construction rather than by two code paths agreeing to be careful.
//
// AND THE ONE THING IT WILL NOT DO: there is no method here that returns a stored value. `test`
// comes closest and deliberately answers with a boolean and a sentence — the key it probes with
// goes out to the provider over HTTPS and never comes back into a response.

import type { SecretRefRepository, SecretKind, SecretRefRow } from "../db/repositories/secretRefs.ts";
import type { SecretUsageRepository, UsageRow } from "../db/repositories/secretUsages.ts";
import type { TenantContext } from "../db/tenant.ts";
import { PROVIDER_ENV_KEY, isProviderId, verifyProviderKey, type ProviderId } from "../providers.ts";
import { protectSecret } from "../obs/log.ts";
import type { ElevationReceipt } from "./elevation.ts";
import { maskFor } from "./mask.ts";
import { scanForSecretNames, type ScannedFile } from "./scan.ts";
import { assertSecretName, unstorableReason, type SecretStore } from "./secretStore.ts";

/** What a client learns about one credential. No field here fits a credential. */
export interface SecretSummary {
  name: string;
  kind: SecretKind;
  provider: string | null;
  scope: "workspace" | "agent";
  agentId: string | null;
  configured: boolean;
  maskedHint: string | null;
  status: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  rotatedAt: string | null;
  connectorId: string | null;
  rotateEveryDays: number | null;
  createdAt: string;
}

export interface StoreInput {
  name: string;
  value: string;
  kind: SecretKind;
  provider?: string | null;
  agentId?: string | null;
  expiresAt?: string | null;
  rotateEveryDays?: number | null;
  /** Attribution for `created_by` and the rotation log. Never authorisation — see ADR-018. */
  actorUserId?: string | null;
}

export interface StoreOutcome {
  ok: boolean;
  message: string | null;
  summary?: SecretSummary;
  /** True when this replaced a value that was already there, so the caller can audit it as one. */
  rotated?: boolean;
}

export interface SecretsManagerDeps {
  secrets: SecretStore;
  refs: SecretRefRepository;
  usages: SecretUsageRepository;
  /** Injected so a test can prove the reject path without reaching a provider. */
  verify?: (provider: ProviderId, key: string) => Promise<{ ok: boolean; message: string | null }>;
  /**
   * Why this value cannot be stored under this name, for the connector credentials that have a
   * rule — or null when there is nothing to say.
   *
   * INJECTED RATHER THAN IMPORTED, the same way `verify` is, so this module keeps knowing about
   * the vault and nothing else. The rules themselves are the connectors' and live beside them.
   *
   * AND IT HANGS OFF `store` RATHER THAN OFF THE ROUTE, which is the half that matters. The route
   * guards the three verbs a person presses; `store` is also what the bulk `.env` import calls, so
   * a pasted file containing `HTTP_ALLOWED_DOMAINS=*.example.com` would walk straight past a check
   * that only lived on the form. That is the same reasoning the managed-kind backstop below is
   * written for, applied to a value whose correctness is a safety property rather than an
   * authorisation one.
   */
  validateConnectorValue?: (name: string, value: string) => Promise<string | null>;
}

/** Which provider a credential name belongs to, or null when it is not a provider key. */
export function providerForName(name: string): ProviderId | null {
  for (const [id, envKey] of Object.entries(PROVIDER_ENV_KEY)) {
    if (envKey === name) return id as ProviderId;
  }
  return null;
}

function toSummary(row: SecretRefRow): SecretSummary {
  return {
    name: row.name,
    kind: row.kind,
    provider: row.provider,
    scope: row.scope,
    agentId: row.agent_id,
    configured: row.configured,
    maskedHint: row.masked_hint,
    status: row.status,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    rotatedAt: row.rotated_at,
    connectorId: row.connector_id,
    rotateEveryDays: row.rotate_every_days,
    createdAt: row.created_at,
  };
}

export class SecretsManager {
  private verify: (provider: ProviderId, key: string) => Promise<{ ok: boolean; message: string | null }>;

  constructor(private deps: SecretsManagerDeps) {
    this.verify = deps.verify ?? verifyProviderKey;
  }

  /** Everything this workspace has, as metadata. One query; no value is read to build it. */
  async list(ctx: TenantContext): Promise<SecretSummary[]> {
    return (await this.deps.refs.list(ctx)).map(toSummary);
  }

  async get(ctx: TenantContext, name: string): Promise<SecretSummary | undefined> {
    const row = await this.deps.refs.get(ctx, name);
    return row ? toSummary(row) : undefined;
  }

  /**
   * Store a value under a name, adding or replacing.
   *
   * The order is the point:
   *
   *   1. Refuse what cannot be stored FAITHFULLY. `unstorableReason` is the shared rule both store
   *      implementations obey, and it runs first because a value with a newline in it is not the
   *      value the user meant to paste — refusing it beats storing a mangled one that produces a
   *      401 from a third party with no explanation anywhere.
   *   2. Prove it, when there is a provider to prove it against, and DO NOT STORE ON FAILURE.
   *   3. Write the value, through the vault, which is the only thing that ever holds one.
   *   4. Write the metadata — mask, kind, status — computed from the plaintext we are about to
   *      let go of.
   *   5. Record a rotation when this replaced something.
   */
  async store(ctx: TenantContext, input: StoreInput): Promise<StoreOutcome> {
    const name = assertSecretName(input.name);
    const unstorable = unstorableReason(input.value);
    if (unstorable) return { ok: false, message: unstorable };

    // Step 1b: the connector rules, before anything is written and before any provider is asked.
    // A `HTTP_ALLOWED_DOMAINS` that is not a list of hostnames is not a credential that will fail
    // at first use — it is an allowlist that silently matches nothing, whose symptom is every
    // request being refused with a message about a host that looks like it is on the list.
    const connectorProblem = this.deps.validateConnectorValue
      ? await this.deps.validateConnectorValue(name, input.value)
      : null;
    if (connectorProblem) return { ok: false, message: connectorProblem };

    const before = await this.deps.refs.get(ctx, name);
    const rotated = Boolean(before?.configured);

    // A CONNECTOR'S CREDENTIAL IS NOT WRITABLE FROM HERE, and this backstop is not the route's
    // check repeated. The route guards the three verbs a person presses; this guards `store`
    // itself, which the bulk import also calls — a pasted .env containing `GITHUB_TOKEN=` would
    // otherwise walk straight past the guard by never touching a route that has one. Only a caller
    // that says `managed` outright, which no request body can (see `readKind`), may write one.
    if (before?.kind === "managed" && input.kind !== "managed") {
      return {
        ok: false,
        message: `${name} is managed by a connector — reconnect it instead of writing a value over it`,
      };
    }

    // The provider a key belongs to comes from its NAME, not from what the client claimed. A body
    // saying `provider: "anthropic"` against `OPENWEATHER_API_KEY` would otherwise send somebody's
    // weather key to Anthropic to be validated.
    const providerId = input.kind === "provider_key" ? providerForName(name) : null;
    if (input.kind === "provider_key" && !providerId) {
      return {
        ok: false,
        message: `${name} is not a provider key this build knows how to validate`,
      };
    }
    if (providerId) {
      const proof = await this.verify(providerId, input.value);
      if (!proof.ok) {
        // Marked invalid ONLY if it was already there. A brand-new key that fails is not stored at
        // all, so there is no row to mark — and marking one would create the row the failure was
        // supposed to prevent.
        if (before?.configured) {
          await this.deps.refs.setMetadata(ctx, name, { status: "invalid" });
        }
        return { ok: false, message: proof.message ?? "the provider rejected that key" };
      }
    }

    const written = await this.deps.secrets.set(ctx, name, input.value);
    if (!written.ok) return { ok: false, message: written.warning ?? "that credential could not be stored" };

    await this.deps.refs.markConfigured(ctx, {
      name,
      provider: providerId ?? input.provider ?? null,
      scope: input.agentId ? "agent" : "workspace",
      agentId: input.agentId ?? null,
      createdBy: input.actorUserId ?? null,
    });
    await this.deps.refs.setMetadata(ctx, name, {
      kind: input.kind,
      // COMPUTED HERE AND STORED. The last moment a plaintext exists above the vault.
      maskedHint: maskFor(input.value),
      // A key that has just answered a models-list call is `valid`; anything else is `unknown`
      // rather than `valid`, because nothing has actually checked it.
      status: providerId ? "valid" : "unknown",
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.rotateEveryDays !== undefined ? { rotateEveryDays: input.rotateEveryDays } : {}),
    });

    if (rotated) {
      await this.deps.refs.recordRotation(ctx, {
        name,
        rotatedBy: input.actorUserId ?? null,
        maskedHint: maskFor(input.value),
        reason: "replaced by the user",
      });
    }

    return {
      ok: true,
      message: written.warning,
      rotated,
      summary: await this.get(ctx, name),
    };
  }

  /**
   * Forget a credential.
   *
   * The vault drops the value; the registry keeps the NAME with `configured = false`. That is the
   * existing rule and it matters here: a name an agent still declares is a name the user needs to
   * keep seeing, now with an empty state beside it. Dropping the row would make the panel forget
   * what the agent asked for the moment somebody revoked a value.
   *
   * The usage rows stay too. "What broke when I revoked this" is a question asked AFTER the revoke.
   */
  async revoke(ctx: TenantContext, name: string): Promise<void> {
    await this.deps.secrets.delete(ctx, name);
    await this.deps.refs.setMetadata(ctx, name, { status: "unknown", maskedHint: null });
  }

  /**
   * Re-run the provider probe against what is already stored.
   *
   * THE ONE PLACE THIS FEATURE READS A STORED VALUE, and it goes through `getForPlatformCall` —
   * the vault's existing second exit, whose contract is that a value flows INTO a call the
   * platform makes on the workspace's behalf and never back out. A models-list probe is exactly
   * that shape: the key leaves over HTTPS to the provider, and what returns to the caller here is
   * a boolean and a sentence.
   *
   * The two failures are kept distinct, which the brief asks for by name: "we could not reach the
   * provider" and "the provider rejected your key" send somebody to different places, and
   * collapsing them into "invalid" tells a user to rotate a key that is fine.
   */
  async test(ctx: TenantContext, name: string): Promise<{ ok: boolean; message: string | null }> {
    const providerId = providerForName(name);
    if (!providerId) return { ok: false, message: "only model-provider keys can be tested" };
    const row = await this.deps.refs.get(ctx, name);
    if (!row?.configured) return { ok: false, message: "there is no key stored under that name" };

    const env = await this.deps.secrets.getForPlatformCall(ctx, [name]);
    const key = env[name];
    if (!key) {
      // The registry says configured and the vault has nothing. Reported rather than smoothed
      // over: the two disagreeing is a real fault, and answering "invalid" would send somebody
      // rotating a key that is not the problem.
      await this.deps.refs.setMetadata(ctx, name, { status: "unknown" });
      return { ok: false, message: "this workspace's vault has no value under that name" };
    }
    const proof = await this.verify(providerId, key);
    await this.deps.refs.setMetadata(ctx, name, { status: proof.ok ? "valid" : "invalid" });
    return proof;
  }

  /** Whether anything references this credential. Drives the typed-name revoke confirmation. */
  async isReferenced(ctx: TenantContext, name: string): Promise<boolean> {
    return this.deps.usages.isReferenced(ctx, name);
  }

  /** Every recorded site for one credential, static and runtime, each labelled with its source. */
  async usage(ctx: TenantContext, name: string): Promise<UsageRow[]> {
    return this.deps.usages.forSecret(ctx, name);
  }

  /**
   * Re-scan one agent's current source for every credential name this workspace has.
   *
   * REPLACES that agent's static hits rather than adding to them, so a credential an agent stopped
   * mentioning stops being listed. Its runtime reads survive: a scan of the current source has no
   * standing to say a run did not happen, and an agent that is still deployed is still using what
   * it used yesterday.
   *
   * Cheap enough to run on demand — it reads one version's files and does a substring walk — which
   * is why the Usage view triggers it rather than depending on a background job somebody has to
   * remember to schedule.
   */
  async rescanAgent(
    ctx: TenantContext,
    agentId: string,
    files: readonly ScannedFile[],
  ): Promise<number> {
    const names = (await this.deps.refs.list(ctx)).map((r) => r.name);
    const hits = scanForSecretNames(files, names);
    await this.deps.usages.clearStaticFor(ctx, agentId);
    for (const hit of hits) {
      await this.deps.usages.record(ctx, {
        name: hit.name,
        source: "static_scan",
        agentId,
        location: hit.location,
      });
    }
    return hits.length;
  }

  /**
   * Record that a run received these credentials.
   *
   * Called from the store layer rather than from the request path, because eval runs and the queue
   * worker never touch `index.ts` — hooking the caller would have recorded interactive runs only,
   * which is the half of the traffic least likely to matter at three in the morning.
   */
  async recordRuntimeReads(ctx: TenantContext, names: readonly string[], agentId?: string | null): Promise<void> {
    for (const name of names) {
      await this.deps.usages.record(ctx, { name, source: "runtime_read", agentId: agentId ?? null });
    }
  }

  /**
   * Read a stored credential back to the person who owns it. ADR-035.
   *
   * The receipt is the authorisation and carries the workspace, so this method takes no context —
   * there is nothing for a caller to assert. What it adds on top of the vault call is the one
   * thing the vault cannot do for itself: registering the value with the log redactor, so that
   * from this moment on the process will scrub it out of any line anything writes. A credential
   * that has been handed to a browser is one that can come back in a stack trace, an error report
   * or a support paste, and `protectSecret` is the existing machinery for exactly that.
   */
  async reveal(receipt: ElevationReceipt, name: string): Promise<string | null> {
    const value = await this.deps.secrets.revealForUser(receipt, name);
    if (value !== null) protectSecret(value, name);
    return value;
  }
}

/** Re-exported so callers do not need two imports to talk about a provider. */
export { isProviderId };
