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
import { EgressPolicyError, realResolver, type Resolver } from "./sandbox/egressPolicy.ts";

/** The env name the Postgres connector reads, and the only `user_secret` there is today. */
export const DATABASE_URL_NAME = "DATABASE_URL";

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
