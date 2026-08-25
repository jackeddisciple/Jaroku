// The connectors nobody can connect FOR you.
//
// Gmail and Slack are OAuth: Jaroku owns the app, the user clicks Connect, and a short-lived
// access token reaches the run. Postgres cannot work that way and never will — there is no
// consent screen for "the database at the other end of this connection string", and the string
// itself IS the credential. So it stays a `user_secret`: the workspace supplies it, the vault
// holds it, and one run at a time receives it.
//
// WHICH MAKES IT THE ONE CONNECTOR WHOSE HOST IS CHOSEN BY THE USER, AND THEREFORE THE SSRF
// VECTOR THE MIGRATION SPEC NAMES. `gmail.googleapis.com` and `slack.com` are fixed strings in
// this repository that somebody reviewed. A `DATABASE_URL` is whatever was typed, and what
// connects to it is our infrastructure — so `postgres://127.0.0.1:5432/jaroku`,
// `postgres://10.0.1.7:5432/anything`, and a hostname that resolves to 169.254.169.254 are all,
// syntactically, perfectly ordinary connection strings. Session 4 wrote the refusal
// (`sandbox/databaseUrl.ts`, delegating to the egress policy's own block list so there is one
// copy of it); this module is where it stops being a function nothing calls.
//
// VALIDATED TWICE, AND THE SECOND TIME IS NOT REDUNDANT.
//
//   AT SAVE, so a value that could never work is refused while somebody is looking at the form
//   rather than three days later inside a run. This is the check that produces a sentence.
//
//   AT RUN, because a hostname is not a promise. DNS is controlled by whoever owns the domain,
//   and a name that answered with a public address when it was saved can answer with
//   169.254.169.254 at the moment a sandbox connects. Re-resolving and PINNING the addresses into
//   the run's egress policy is the whole of the DNS-rebinding defence, and doing it only at save
//   time would be doing it at exactly the moment it proves nothing.
//
// The value never comes back out to a request handler on either path. Saving goes through
// `SecretStore.set`; the run path reads it through `getForRun`, which takes a run id rather than
// a context precisely because by then the asking context is gone.

import type { TenantContext } from "./db/tenant.ts";
import type { SecretStore } from "./secrets/secretStore.ts";
import {
  DatabaseUrlError, probeReachable, validateDatabaseUrl, type ValidatedDatabaseUrl,
} from "./sandbox/databaseUrl.ts";
import {
  EgressPolicyError, realResolver, resolveAndPin, type EgressRule, type Resolver,
} from "./sandbox/egressPolicy.ts";

/** The one port the HTTP connector will ever open, because it refuses anything that is not https. */
const HTTPS_PORT = 443;

/** The env name the Postgres connector reads. */
export const DATABASE_URL_NAME = "DATABASE_URL";

/** The env name the HTTP connector reads. The allowlist IS that connector's whole safety model. */
export const HTTP_ALLOWED_DOMAINS_NAME = "HTTP_ALLOWED_DOMAINS";

/** Optional. A raw header the HTTP connector sends on every request — a credential like any other. */
export const HTTP_AUTH_HEADER_NAME = "HTTP_AUTH_HEADER";

/** The env name the Stripe connector reads. Expected to be a RESTRICTED key — see the rules below. */
export const STRIPE_SECRET_KEY_NAME = "STRIPE_SECRET_KEY";

/**
 * One allowlist entry, normalised, or null when it is not a bare hostname.
 *
 * THE SAME RULE `http_connector.normalise_domain` APPLIES, in the language this side is written
 * in — and it is stated twice for the reason the address block list is: the control plane cannot
 * run Python and the sandbox cannot call TypeScript, but both have to agree about what the
 * workspace typed. A domain this accepts and the template refuses is a workspace that configured
 * the connector and cannot use it; a domain this refuses and the template accepts is a request
 * the egress policy never granted, which fails as a network error naming nothing.
 *
 * A SCHEME, PATH, PORT OR WILDCARD MAKES IT NOT A HOSTNAME, and each is refused rather than
 * stripped. Stripping is how `https://evil.example/@api.example.com` becomes an entry somebody
 * did not mean to write, and a wildcard is refused because the domain anybody would want one on
 * is a shared platform — `*.herokuapp.com` grants every tenant of it, which is everybody.
 */
export function normaliseAllowedDomain(value: string): string | null {
  const text = value.trim().toLowerCase().replace(/\.+$/, "");
  if (!text || /[*/:@\s]/.test(text)) return null;
  if (!text.includes(".") || text.startsWith(".") || text.includes("..")) return null;
  let ascii: string;
  try {
    // IDN once, here, so a domain stored in unicode and compared against a punycode hostname is
    // not an allowlist that silently never matches.
    ascii = new URL(`https://${text}`).hostname;
  } catch {
    return null;
  }
  return ascii === text || ascii === text.normalize("NFC") || ascii.startsWith("xn--") || /^[a-z0-9.-]+$/.test(ascii)
    ? ascii
    : null;
}

/** The entries in a raw `HTTP_ALLOWED_DOMAINS` value, and the ones that are not hostnames. */
export function parseAllowedDomains(raw: string): { domains: string[]; rejected: string[] } {
  const domains: string[] = [];
  const rejected: string[] = [];
  for (const entry of raw.split(",")) {
    if (!entry.trim()) continue;
    const normalised = normaliseAllowedDomain(entry);
    if (!normalised) rejected.push(entry.trim().slice(0, 60));
    else if (!domains.includes(normalised)) domains.push(normalised);
  }
  return { domains, rejected };
}

export interface SaveConnectorSecretResult {
  ok: boolean;
  /** Why not, for the person who pasted it. Never contains any part of the value. */
  message: string | null;
  /** Something they should know even though it worked — see SecretStore.SetResult. */
  warning: string | null;
  /**
   * Whether anything answered at the host and port, when a probe was asked for.
   *
   * Null means nothing tried. Deliberately NOT a failure when false: a database behind a firewall
   * that opens for our egress IPs and not for this process is a perfectly ordinary production
   * setup, and refusing to save a correct connection string because a probe from the wrong box
   * timed out would be worse than useless.
   */
  reachable: boolean | null;
}

export interface ConnectorSecretsOptions {
  secrets: SecretStore;
  /** Injected so a suite exercises the private-range refusal with no live network. */
  resolver?: Resolver;
  /** Whether saving also opens a bare TCP connection. Off by default; the UI asks for it. */
  probe?: (host: string, port: number) => Promise<boolean>;
}

export class ConnectorSecrets {
  private readonly resolver: Resolver;
  private readonly probe: (host: string, port: number) => Promise<boolean>;

  constructor(private readonly opts: ConnectorSecretsOptions) {
    this.resolver = opts.resolver ?? realResolver;
    this.probe = opts.probe ?? ((host, port) => probeReachable(host, port));
  }

  /**
   * Store a workspace's `DATABASE_URL`, refusing one that points anywhere it must not.
   *
   * VALIDATED BEFORE IT IS WRITTEN, and the order is the point — the same order
   * `WorkspaceProviderKeys.save` uses for a provider key. A value stored first and checked later
   * is a value that exists in the vault for however long it takes somebody to notice, and the
   * first thing to discover it is wrong would be a run.
   */
  async saveDatabaseUrl(
    ctx: TenantContext,
    raw: string,
    opts: { probe?: boolean } = {},
  ): Promise<SaveConnectorSecretResult> {
    const value = raw.trim();
    if (!value) return { ok: false, message: "no connection string was entered", warning: null, reachable: null };

    let validated: ValidatedDatabaseUrl;
    try {
      validated = await validateDatabaseUrl(value, this.resolver);
    } catch (err) {
      // Both error types carry a message written in this codebase and safe to show — see
      // databaseUrl.ts, which is careful never to quote the URL back because a connection string
      // carries its password in the userinfo. Anything else is a bug and says nothing.
      const known = err instanceof DatabaseUrlError || err instanceof EgressPolicyError;
      return {
        ok: false,
        message: known ? (err as Error).message : "that connection string could not be checked",
        warning: null,
        reachable: null,
      };
    }

    const reachable = opts.probe ? await this.probe(validated.host, validated.port) : null;

    const written = await this.opts.secrets.set(ctx, DATABASE_URL_NAME, value);
    if (!written.ok) {
      return { ok: false, message: written.warning ?? "that value could not be stored", warning: null, reachable };
    }
    return { ok: true, message: null, warning: written.warning, reachable };
  }

  async forget(ctx: TenantContext): Promise<void> {
    await this.opts.secrets.delete(ctx, DATABASE_URL_NAME);
  }

  /**
   * Store a workspace's `HTTP_ALLOWED_DOMAINS`, refusing a list that is not one.
   *
   * VALIDATED BEFORE IT IS WRITTEN, exactly as the connection string is, and for a sharper
   * reason: this value is not a credential, it is a POLICY. A typo in a database URL fails
   * visibly at the first query. A typo here — `*.example.com`, or `https://api.example.com` —
   * produces an allowlist that silently matches nothing, and the symptom is every request being
   * refused with a message about a host that looks like it is on the list.
   *
   * THE DOMAINS ARE NOT RESOLVED HERE, and that is the deliberate half. A domain that does not
   * resolve today may resolve tomorrow, and refusing to save it would make configuring the
   * connector depend on the state of somebody else's DNS at the moment they pressed Save. The
   * resolution — and the private-range refusal that matters — happens at `httpEgress`, at
   * policy-build time, where it is pinned. Same split as the database URL: shape at save,
   * addresses at run.
   */
  async saveAllowedDomains(ctx: TenantContext, raw: string): Promise<SaveConnectorSecretResult> {
    const { domains, rejected } = parseAllowedDomains(raw);
    if (rejected.length > 0) {
      return {
        ok: false,
        message:
          `not a hostname: ${rejected.slice(0, 3).map((r) => JSON.stringify(r)).join(", ")}. Entries are ` +
          `bare exact hostnames — no scheme, no path, no port, and no wildcards.`,
        warning: null,
        reachable: null,
      };
    }
    if (domains.length === 0) {
      return {
        ok: false,
        message: "no domains listed — an empty allowlist refuses every request",
        warning: null,
        reachable: null,
      };
    }

    // Stored NORMALISED rather than as typed, so the run path and the panel are comparing the
    // same strings. A list saved as `API.Example.COM ` and matched against `api.example.com`
    // is an allowlist that works everywhere except where it is used.
    const written = await this.opts.secrets.set(ctx, HTTP_ALLOWED_DOMAINS_NAME, domains.join(","));
    if (!written.ok) {
      return { ok: false, message: written.warning ?? "that value could not be stored", warning: null, reachable: null };
    }
    return { ok: true, message: null, warning: written.warning, reachable: null };
  }

  /**
   * Why this value cannot be stored under this name, or null when there is nothing to say.
   *
   * THE ONE ENTRY POINT EVERY WRITE GOES THROUGH — the Connections panel, the Secrets tab and the
   * bulk `.env` import all reach `SecretsManager.store`, and this hangs off that rather than off a
   * form. A rule that only lived on the form would be one a pasted file walks past.
   *
   * DNS IS CONSULTED FOR THE ALLOWLIST AND A FAILURE TO RESOLVE IS NOT A REFUSAL, which is the
   * split worth stating. A domain that resolves into a private range TODAY is refused here,
   * because `metadata.internal` typed into a text field should be answered at the moment of the
   * mistake rather than at the first tool call — that is `validateMcpUrl`'s posture, and this is
   * the same class of value. A domain that does not resolve at all is ALLOWED, because refusing
   * it would make configuring the connector depend on the state of somebody else's DNS in the
   * second somebody pressed Save. Neither decision weakens anything: `httpEgress` re-resolves and
   * re-refuses at policy-build time, which is the check that actually holds.
   */
  async unstorableConnectorValue(name: string, value: string): Promise<string | null> {
    if (name === HTTP_ALLOWED_DOMAINS_NAME) {
      const { domains, rejected } = parseAllowedDomains(value);
      if (rejected.length > 0) {
        return (
          `not a hostname: ${rejected.slice(0, 3).map((r) => JSON.stringify(r)).join(", ")}. Entries are ` +
          `bare exact hostnames — no scheme, no path, no port, and no wildcards.`
        );
      }
      if (domains.length === 0) return "no domains listed — an empty allowlist refuses every request";
      for (const domain of domains) {
        try {
          await resolveAndPin(domain, this.resolver);
        } catch (err) {
          // Only the private-range refusal is fatal. "Did not resolve" is the other thing
          // `resolveAndPin` throws, and it is exactly the case that must stay saveable.
          if (err instanceof EgressPolicyError && /private|link-local|reserved/.test(err.message)) {
            return `${domain} resolves inside a private or reserved range, so it cannot be allowed`;
          }
        }
      }
      return null;
    }

    if (name === STRIPE_SECRET_KEY_NAME) {
      const key = value.trim();
      if (!/^(rk|sk)_(test|live)_/.test(key)) {
        return "that does not look like a Stripe secret key — they begin rk_ or sk_";
      }
      // THE SECOND LAYER OF THE READ-ONLY POSTURE, MADE REAL RATHER THAN DESCRIBED.
      //
      // The connector's whole safety story is double enforcement: the template exposes only
      // retrieve/list/search, AND the key itself cannot mutate. The second half is Stripe's to
      // enforce and ours to insist on — and until something checked, it was a sentence in a
      // catalog description, which is not a layer. `sk_live_` is a full-access key on a real
      // account: it can refund, it can cancel a subscription, it can delete a customer, and the
      // only thing standing between it and those is our own template being correct forever.
      //
      // Refused rather than warned, because a warning on this is a warning everybody clicks past
      // and the failure it prevents is somebody's money. `rk_` keys are free to create and take
      // under a minute, and the message says so.
      if (key.startsWith("sk_live_")) {
        return (
          "that is a full-access live Stripe key. This connector is read-only and asks for a " +
          "RESTRICTED key (rk_live_…) with read permissions only — create one under Developers → " +
          "API keys → Restricted keys, so that even a modified template could not charge anybody."
        );
      }
      return null;
    }

    return null;
  }

  /**
   * The pinned egress a run's HTTP connector needs, and the entries that could not be granted.
   *
   * THE HARDEST INTEGRATION POINT IN THIS RELEASE, because every other connector's hosts are
   * fixed strings somebody reviewed and these are whatever a workspace typed. So this is the
   * `databaseUrl` shape rather than the `CONNECTOR_HOSTS` shape: resolved FRESH, here, at
   * policy-build time, refused on any private answer, and handed to `buildEgressPolicy` already
   * pinned. Reading something the save path recorded would be the DNS-rebinding hole — a name
   * that answered publicly while somebody filled in a form and answers 169.254.169.254 when the
   * sandbox connects.
   *
   * FAILURES ARE COLLECTED RATHER THAN THROWN, which is `mcpEgressRules`'s decision and not
   * `postgresEgress`'s, and the difference is that this list has MANY entries. A workspace with
   * four allowed domains, one of which has been repointed at a private address, should keep the
   * other three: refusing the whole run would let one bad entry take down an agent that may
   * never call it. The refused entry contributes no rule, so the request fails at the point of
   * use with the template's own message — and the caller logs the reason.
   */
  async httpEgress(runId: string): Promise<{ rules: EgressRule[]; refused: { domain: string; reason: string }[] }> {
    const env = await this.opts.secrets.getForRun(runId, [HTTP_ALLOWED_DOMAINS_NAME]);
    const raw = env[HTTP_ALLOWED_DOMAINS_NAME];
    const rules: EgressRule[] = [];
    const refused: { domain: string; reason: string }[] = [];
    if (!raw) return { rules, refused };

    const { domains, rejected } = parseAllowedDomains(raw);
    for (const bad of rejected) refused.push({ domain: bad, reason: "not a bare hostname" });

    for (const domain of domains) {
      try {
        const ips = await resolveAndPin(domain, this.resolver);
        rules.push({ host: domain, ips, ports: [HTTPS_PORT], reason: "the http connector's allowlist" });
      } catch (err) {
        const known = err instanceof EgressPolicyError;
        refused.push({ domain, reason: known ? (err as Error).message : "could not be checked" });
      }
    }
    return { rules, refused };
  }

  /**
   * The pinned egress a run's Postgres connector needs, or null when it has none.
   *
   * RESOLVED FRESH, HERE, AT THE MOMENT THE POLICY IS BUILT. Not read from something the save
   * path recorded — that is the DNS-rebinding hole, and the whole reason `resolveAndPin` exists
   * is that a hostname's answer is not a fact about the hostname. The addresses this returns are
   * literals the sandbox's network layer is handed; nothing downstream re-resolves anything.
   *
   * Takes a run id because that is what `getForRun` takes, and that is deliberate upstream: a
   * sandbox's environment is assembled after the requesting context is gone, so the run is the
   * unit of authorisation for a secret. See secrets/secretStore.ts.
   *
   * Returns null rather than throwing when there is no value: an agent that declares the postgres
   * connector and has no connection string configured is an agent that will report exactly that
   * at its first `pg_query`, with the variable named, which is a better error than a run refusing
   * to start. A value that IS configured and is now dangerous throws, because silently dropping
   * the rule would produce a run whose egress policy is missing the host it needs and whose
   * failure names nothing.
   */
  async postgresEgress(runId: string): Promise<ValidatedDatabaseUrl | null> {
    const env = await this.opts.secrets.getForRun(runId, [DATABASE_URL_NAME]);
    const value = env[DATABASE_URL_NAME];
    if (!value) return null;
    return validateDatabaseUrl(value, this.resolver);
  }
}
