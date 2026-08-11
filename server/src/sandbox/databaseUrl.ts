// Validating a workspace's own DATABASE_URL before it is ever handed to a sandbox's egress
// policy — the SSRF vector the migration spec calls out by name. A connector's OTHER hosts
// (gmail.googleapis.com, slack.com) are fixed and reviewed; this one is whatever a user typed,
// and Jaroku's own infrastructure is what a crafted value would be probing. A URL pointing at
// 127.0.0.1:5432, at the Redis port on this box, or at the cloud metadata endpoint on 5432
// (nothing stops a TCP listener from squatting any port a firewall rule does not close) all
// look, syntactically, like a perfectly ordinary connection string.
//
// The same refusal DATABASE_URL needs is already exactly egressPolicy's isDeniedAddress and
// resolveAndPin — a private-range answer is a private-range answer regardless of which feature
// asked for the lookup — so this module is thin: parse, constrain the port, then delegate.

import { connect } from "node:net";
import { EgressPolicyError, resolveAndPin, type Resolver, realResolver } from "./egressPolicy.ts";

export class DatabaseUrlError extends Error {}

/**
 * Ports a Postgres connection is allowed to target. Not "anything" — an allowlist closes off
 * a scan of the workspace's own infrastructure through a URL that otherwise passes every other
 * check (resolves publicly, has valid syntax) by pointing at, say, port 6379 where Redis lives.
 * 5432 is Postgres' own default; 5433 is what this repo's own docker-compose uses locally so
 * it never collides with a developer's system Postgres; 6543 is Supabase's pooled (pgbouncer)
 * port, common enough among managed providers to be worth naming rather than refusing by default.
 */
const ALLOWED_PORTS = new Set([5432, 5433, 6543]);

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export interface ValidatedDatabaseUrl {
  host: string;
  port: number;
  ips: string[];
}

/**
 * Parse, constrain and resolve a workspace-supplied DATABASE_URL. Throws DatabaseUrlError (a
 * message safe to show the user — see the credential-in-URL rule this mirrors) or
 * EgressPolicyError (the private-range refusal, reused rather than duplicated) on anything
 * that should not reach a sandbox's egress policy.
 *
 * Does NOT open a Postgres connection or read a byte of the target's protocol — see
 * `probeReachable` for the separate, explicit "does anything answer" check, kept apart for the
 * same reason `testProviderKey` is its own command: validating shape and spending a network
 * round trip are different operations with different costs.
 */
export async function validateDatabaseUrl(
  raw: string,
  resolver: Resolver = realResolver,
): Promise<ValidatedDatabaseUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DatabaseUrlError("DATABASE_URL is not a valid URL");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DatabaseUrlError(
      `DATABASE_URL must use postgres:// or postgresql://, not ${JSON.stringify(url.protocol)}`,
    );
  }

  // Same rule the MCP registry already applies to a server URL: a credential embedded in the
  // URL itself is refused before anything is sent, rather than logged the moment something
  // fails. Postgres connection strings carry the password as userinfo, which is exactly this
  // shape — but here it is not merely inspected for the error path, it is the normal case
  // (postgres://user:pass@host/db), so it is read for the probe and never otherwise retained.
  if (!url.hostname) {
    throw new DatabaseUrlError("DATABASE_URL has no host");
  }

  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || !ALLOWED_PORTS.has(port)) {
    throw new DatabaseUrlError(
      `DATABASE_URL's port ${port} is not on the allowed list (${[...ALLOWED_PORTS].join(", ")}). ` +
        "A port outside Postgres' own conventions is refused rather than guessed at.",
    );
  }

  // Delegates to the exact private-range refusal every other egress host goes through —
  // resolved fresh, pinned, and refused whole on any denied answer. No separate copy of the
  // block list to drift from egressPolicy's.
  let ips: string[];
  try {
    ips = await resolveAndPin(url.hostname, resolver);
  } catch (err) {
    if (err instanceof EgressPolicyError) throw err;
    throw new DatabaseUrlError(`could not resolve DATABASE_URL's host: ${(err as Error).message}`);
  }

  return { host: url.hostname, port, ips };
}

/**
 * A bare TCP connect, bounded, to prove SOMETHING is listening — no Postgres handshake, no
 * credential sent. Separate from validation because a workspace saving its DATABASE_URL should
 * not pay a network round trip every time the value is merely re-checked for shape.
 */
export function probeReachable(host: string, port: number, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
