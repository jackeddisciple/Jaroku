// Which issuer this server trusts, and what to do when nobody has named one.
//
// Auth is deliberately spelled as OIDC rather than as a vendor. The server verifies a JWT
// against a JWKS URL, checks `iss` and `aud`, and maps `sub` to a user — which is what Clerk,
// Auth0, Okta, Cognito and Supabase Auth all issue. Pointing this at any of them is three
// environment variables, and none of the code below or downstream of it changes. There is no
// SDK in the request path, so there is nothing to swap when the answer to D3 changes.
//
// AND WHEN NOTHING IS CONFIGURED, THERE IS STILL AUTHENTICATION.
//
// The obvious shape for local development is a flag that skips verification. It is also the
// worst one: the path that runs on every developer's machine every day would then be a
// different path from the one that runs in production, so the code that actually matters is
// the code nobody exercises — and the day it breaks is the day it is in front of users.
//
// So local development gets a real ISSUER instead of a bypass. The server generates an RS256
// key pair, publishes it at its own `/v1/auth/jwks.json`, and mints real tokens that go
// through the same verifier, the same JWKS fetch, the same `iss`/`aud`/`exp` checks. What is
// missing locally is a password, not a signature. `npm run dev` still needs nothing installed
// and no cloud account, which is the property hard rule 5 protects.
//
// It says so at boot, every time, and it refuses to start under NODE_ENV=production.

/** Every environment variable this module reads, in one place. */
export const AUTH_ENV = {
  issuer: "JAROKU_AUTH_ISSUER",
  audience: "JAROKU_AUTH_AUDIENCE",
  jwksUrl: "JAROKU_AUTH_JWKS_URL",
  devAuth: "JAROKU_DEV_AUTH",
  devKeyPath: "JAROKU_DEV_AUTH_KEY",
} as const;

export const DEFAULT_AUDIENCE = "jaroku";
/** The `iss` the local issuer stamps. Not a URL: nothing resolves it, and it never will. */
export const LOCAL_ISSUER = "urn:jaroku:local";

export interface AuthConfig {
  /** `provider` verifies against a third party; `local` against this process's own key. */
  mode: "provider" | "local";
  issuer: string;
  audience: string;
  jwksUrl: string;
}

export class AuthConfigError extends Error {}

/**
 * Resolve the auth configuration, or refuse to start.
 *
 * `port` is only used to build the local issuer's own JWKS URL, so that the verifier fetches
 * it over HTTP exactly as it would fetch a provider's — same code, same failure modes, same
 * cache. A loopback request on the first sign-in is a cheap price for not having a second
 * implementation of the most security-relevant path in the server.
 */
export function resolveAuthConfig(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
  log: (m: string) => void = console.log,
): AuthConfig {
  const issuer = (env[AUTH_ENV.issuer] ?? "").trim();
  const audience = (env[AUTH_ENV.audience] ?? "").trim() || DEFAULT_AUDIENCE;
  const production = env["NODE_ENV"] === "production";

  if (issuer) {
    if (!/^https:\/\//.test(issuer) && production) {
      throw new AuthConfigError(
        `${AUTH_ENV.issuer} must be an https URL in production (got ${JSON.stringify(issuer)})`,
      );
    }
    const jwksUrl = (env[AUTH_ENV.jwksUrl] ?? "").trim() || defaultJwksUrl(issuer);
    log(`[auth] verifying tokens from ${issuer} for audience "${audience}" (keys: ${jwksUrl})`);
    return { mode: "provider", issuer, audience, jwksUrl };
  }

  // No issuer configured. In production that is not a mode, it is a missing decision — a
  // server that quietly authenticates against itself is one that authenticates nobody.
  if (production) {
    throw new AuthConfigError(
      `${AUTH_ENV.issuer} is not set. The local issuer is a development facility and refuses ` +
        `to run under NODE_ENV=production — set ${AUTH_ENV.issuer}, ${AUTH_ENV.audience} and ` +
        `${AUTH_ENV.jwksUrl} to your auth provider.`,
    );
  }

  log(
    `[auth] no ${AUTH_ENV.issuer} set — running the LOCAL ISSUER (${LOCAL_ISSUER}). ` +
      `Tokens are real and verified the same way a provider's are, but anyone who can reach ` +
      `this port can mint one. Development only; it refuses to start under NODE_ENV=production.`,
  );
  return {
    mode: "local",
    issuer: LOCAL_ISSUER,
    audience,
    jwksUrl: `http://127.0.0.1:${port}/v1/auth/jwks.json`,
  };
}

/** The OIDC convention, and what every provider in the D3 list actually serves. */
export function defaultJwksUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
}
