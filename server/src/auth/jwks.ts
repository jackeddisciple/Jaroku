// The auth provider's public keys, fetched and cached.
//
// A JWT is verified against a key the issuer publishes at a well-known URL. That URL is a
// third party on the critical path of every request, so this module is written the way
// mcpClient.ts is written: every wait is bounded, every response is a claim rather than a
// fact, and a failure is classified rather than swallowed.
//
// THE CACHE IS NOT AN OPTIMISATION. Verifying one token per request against a network fetch
// would make the auth provider's latency this server's latency and its outage this server's
// outage. Keys rotate on the order of months; a ten-minute TTL is generous.
//
// THE FORCED REFRESH IS THE ROTATION STORY, and it is also the thing that needs a leash. When
// a provider rotates, tokens start arriving signed by a `kid` this cache has never seen, and
// the only correct response is to re-fetch. But `kid` is attacker-controlled — it is a header
// field on an unverified token — so "re-fetch on unknown kid" with no rate limit is a remote
// trigger that makes this server hammer its own auth provider on demand. So a forced refresh
// happens at most once per `minRefreshMs`, and outside that window an unknown kid is simply a
// rejected token, which is what it almost always is.
//
// NEGATIVE CACHING, for the same shape of reason in the other direction. If the JWKS endpoint
// is down, every request retrying it turns one provider outage into a thundering herd against
// a service that is already unwell — and every one of those requests fails anyway.
//
// ASYMMETRIC KEYS ONLY. `oct` (symmetric) entries are dropped rather than imported, because
// the classic JWT attack is algorithm confusion: a server that will verify HS256 against a key
// it also publishes lets anyone who can read the JWKS mint their own tokens. There is no key
// type here that can be used to sign as well as verify.

import { createPublicKey, type KeyObject } from "node:crypto";

/** The signature algorithms this codebase accepts, and the key types each needs. */
export const SUPPORTED_ALGS = ["RS256", "RS384", "RS512", "ES256", "ES384", "PS256"] as const;
export type SupportedAlg = (typeof SUPPORTED_ALGS)[number];

export function isSupportedAlg(v: unknown): v is SupportedAlg {
  return typeof v === "string" && (SUPPORTED_ALGS as readonly string[]).includes(v);
}

/** A JWKS document is small. Anything this size is not one, and reading it is not free. */
const MAX_JWKS_BYTES = 256 * 1024;
/** A provider with hundreds of active signing keys is a provider doing something else. */
const MAX_KEYS = 32;

export interface JwksOptions {
  /** Where the keys live. Usually `<issuer>/.well-known/jwks.json`. */
  url: string;
  /** How long a successful fetch is trusted. */
  ttlMs?: number;
  /** The floor between two forced refreshes, whatever a token's `kid` claims. */
  minRefreshMs?: number;
  /** How long a failed fetch is remembered before another is attempted. */
  negativeTtlMs?: number;
  /** Ceiling on one fetch. A hung request must not become a hung sign-in. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class JwksError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "malformed" | "unknown_key",
  ) {
    super(message);
    this.name = "JwksError";
  }
}

interface CachedKey {
  key: KeyObject;
  alg: SupportedAlg | null;
  kty: string;
}

export class JwksClient {
  private keys = new Map<string, CachedKey>();
  private fetchedAt = 0;
  private lastAttemptAt = 0;
  private lastError: { message: string; at: number } | null = null;
  /** One in-flight fetch, shared. Ten simultaneous sign-ins are one request, not ten. */
  private inFlight: Promise<void> | null = null;

  private readonly ttlMs: number;
  private readonly minRefreshMs: number;
  private readonly negativeTtlMs: number;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  constructor(private opts: JwksOptions) {
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.minRefreshMs = opts.minRefreshMs ?? 30_000;
    this.negativeTtlMs = opts.negativeTtlMs ?? 10_000;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * The public key for a `kid`, fetching or refreshing if it is not already known.
   *
   * `alg` is the token header's claim about how it was signed, and it is checked against the
   * key rather than trusted: a JWKS entry that declares `alg: "RS256"` must not be used to
   * verify an ES256 token, because "the algorithm the token says" and "the algorithm the key
   * is for" disagreeing is precisely the confusion this is guarding.
   */
  async keyFor(kid: string, alg: SupportedAlg): Promise<KeyObject> {
    const fresh = this.now() - this.fetchedAt < this.ttlMs;
    if (!fresh || !this.keys.has(kid)) await this.refresh(this.keys.has(kid) === false);

    const entry = this.keys.get(kid);
    if (!entry) {
      throw new JwksError(`no signing key with kid "${kid}" at ${this.opts.url}`, "unknown_key");
    }
    if (entry.alg && entry.alg !== alg) {
      throw new JwksError(`key "${kid}" is published for ${entry.alg}, not ${alg}`, "malformed");
    }
    const needs = alg.startsWith("ES") ? "EC" : "RSA";
    if (entry.kty !== needs) {
      throw new JwksError(`key "${kid}" is ${entry.kty}, which cannot verify ${alg}`, "malformed");
    }
    return entry.key;
  }

  /** For `/readyz`-style reporting: what the last fetch did, without triggering one. */
  status(): { keys: number; fetchedAt: number; lastError: string | null } {
    return { keys: this.keys.size, fetchedAt: this.fetchedAt, lastError: this.lastError?.message ?? null };
  }

  /** Drop everything. For tests, and for a deliberate operator-triggered reload. */
  reset(): void {
    this.keys.clear();
    this.fetchedAt = 0;
    this.lastAttemptAt = 0;
    this.lastError = null;
  }

  private async refresh(forced: boolean): Promise<void> {
    const now = this.now();
    // A forced refresh is triggered by an unverified token header, so it is rate-limited to a
    // floor. Inside that window an unknown kid stays unknown, which is the right answer for
    // the overwhelmingly common case: a token that was not signed by this issuer.
    if (forced && this.fetchedAt > 0 && now - this.lastAttemptAt < this.minRefreshMs) return;
    // A recent failure is remembered, so an issuer that is down costs one request per
    // negativeTtlMs rather than one per sign-in.
    if (this.lastError && now - this.lastError.at < this.negativeTtlMs) {
      throw new JwksError(this.lastError.message, "unreachable");
    }
    if (this.inFlight) return this.inFlight;

    this.lastAttemptAt = now;
    this.inFlight = this.fetchKeys()
      .then((keys) => {
        this.keys = keys;
        this.fetchedAt = this.now();
        this.lastError = null;
      })
      .catch((err: Error) => {
        this.lastError = { message: err.message, at: this.now() };
        // A failed refresh does NOT empty the cache. The keys already held are still the
        // issuer's keys — signing keys do not stop being valid because a CDN had a bad
        // minute — and discarding them would turn a blip into every session ending at once.
        // The same reasoning the MCP registry applies to a failed re-discovery.
        if (this.keys.size === 0) throw new JwksError(err.message, "unreachable");
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async fetchKeys(): Promise<Map<string, CachedKey>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let text: string;
    try {
      const res = await this.doFetch(this.opts.url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`${this.opts.url} answered ${res.status}`);
      text = await res.text();
    } catch (err) {
      const e = err as Error;
      throw new Error(e.name === "AbortError" ? `${this.opts.url} did not answer in ${this.timeoutMs}ms` : e.message);
    } finally {
      clearTimeout(timer);
    }
    if (text.length > MAX_JWKS_BYTES) throw new Error(`${this.opts.url} returned more than ${MAX_JWKS_BYTES} bytes`);

    let doc: { keys?: unknown };
    try {
      doc = JSON.parse(text) as { keys?: unknown };
    } catch {
      throw new Error(`${this.opts.url} did not return JSON`);
    }
    if (!doc || !Array.isArray(doc.keys)) throw new Error(`${this.opts.url} has no "keys" array`);

    const out = new Map<string, CachedKey>();
    for (const raw of doc.keys.slice(0, MAX_KEYS)) {
      const jwk = raw as Record<string, unknown>;
      const kid = typeof jwk["kid"] === "string" ? jwk["kid"] : null;
      const kty = typeof jwk["kty"] === "string" ? jwk["kty"] : null;
      if (!kid || !kty) continue;
      // A key published for encryption is not a key to verify signatures with, and a
      // symmetric one cannot be published at all without also handing out the ability to
      // SIGN. Both are dropped rather than imported.
      if (jwk["use"] !== undefined && jwk["use"] !== "sig") continue;
      if (kty !== "RSA" && kty !== "EC") continue;
      const alg = isSupportedAlg(jwk["alg"]) ? jwk["alg"] : null;
      try {
        out.set(kid, { key: createPublicKey({ key: jwk as never, format: "jwk" }), alg, kty });
      } catch {
        // One malformed entry must not cost the whole document — a provider mid-rotation can
        // publish something this version of Node will not import, and the other keys are fine.
        continue;
      }
    }
    if (out.size === 0) throw new Error(`${this.opts.url} published no usable signing keys`);
    return out;
  }
}
