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
  /**
   * Opt in to being a real first-party issuer in production.
   *
   * WHY THIS EXISTS AT ALL. Everything below `mode: "local"` is a genuine OIDC issuer — RS256, a
   * published JWKS, tokens that go through the same verifier and the same `iss`/`aud`/`exp` checks
   * a provider's do. What made it development-only was never the signing; it was the PASSWORDLESS
   * ROUTE mounted beside it, `POST /v1/auth/dev-login`, which hands out a token for any address
   * anybody types. Those are two different things and were one flag.
   *
   * AND SEPARATING THEM IS WHAT MAKES GOOGLE AND MAGIC LINK POSSIBLE IN PRODUCTION AT ALL. Both
   * flows end by minting a session for an identity this server has just proven — a verified Google
   * ID token, or a single-use link delivered to an address somebody controls. There is nothing
   * developmental about that, and yet neither could run under NODE_ENV=production, because the only
   * thing able to mint the token refused to exist there. A deployment pointed at Clerk or Auth0
   * signs people in through Clerk or Auth0; a deployment that IS the identity provider needs this.
   */
  selfIssuer: "JAROKU_AUTH_SELF_ISSUER",
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
  /**
   * Whether `POST /v1/auth/dev-login` is mounted — the passwordless route, not the signing.
   *
   * A FIELD RATHER THAN `mode === "local"`, which is what it used to be inferred from and is the
   * conflation this exists to end. Minting a token for an identity the server has PROVEN — a
   * verified Google ID token, a link delivered to a real mailbox — is production behaviour.
   * Minting one for whatever address somebody typed is not, and only the second should ever have
   * been gated on the environment.
   */
  devLogin: boolean;
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
    // A configured provider never gets the passwordless route, in any environment. Somebody who
    // has pointed this at Clerk has said who signs people in, and it is not this process.
    return { mode: "provider", issuer, audience, jwksUrl, devLogin: false };
  }

  // No issuer configured. Two very different things can mean that, and the difference is whether
  // somebody said out loud that THIS server is the identity provider.
  const self = truthy(env[AUTH_ENV.selfIssuer]);

  if (production && self) {
    // JAROKU IS THE IDENTITY PROVIDER. Real tokens, real JWKS, verified through the same path — and
    // no passwordless route, which is the whole of what made this development-only. What proves an
    // identity here is Google's ID token or a link delivered to a real mailbox, and both of those
    // are checked before anything is minted.
    log(
      `[auth] FIRST-PARTY ISSUER (${LOCAL_ISSUER}) for audience "${audience}". This server signs ` +
        `its own sessions; Google and magic link are what prove an identity, and ${AUTH_ENV.devAuth}-` +
        `style passwordless sign-in is NOT mounted.`,
    );
    return {
      mode: "local",
      issuer: LOCAL_ISSUER,
      audience,
      jwksUrl: `http://127.0.0.1:${port}/v1/auth/jwks.json`,
      devLogin: false,
    };
  }

  // In production, without that opt-in, this is a missing decision rather than a mode — a server
  // that quietly authenticates against itself is one that authenticates nobody.
  if (production) {
    throw new AuthConfigError(
      `${AUTH_ENV.issuer} is not set. The local issuer's PASSWORDLESS sign-in refuses to run ` +
        `under NODE_ENV=production — either set ${AUTH_ENV.issuer}, ${AUTH_ENV.audience} and ` +
        `${AUTH_ENV.jwksUrl} to your auth provider, or set ${AUTH_ENV.selfIssuer}=1 to have Jaroku ` +
        `issue its own sessions from Google and magic link (which mounts no passwordless route).`,
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
    // The development facility, and the only configuration that has it.
    devLogin: true,
  };
}

/**
 * What counts as switching something on.
 *
 * `"0"` AND `"false"` ARE OFF, which a bare truthiness check gets wrong in the one direction that
 * matters here: `JAROKU_AUTH_SELF_ISSUER=0` is somebody turning this off, and a check that read it
 * as a non-empty string would turn it on and mount a production issuer they had just declined.
 */
function truthy(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** The OIDC convention, and what every provider in the D3 list actually serves. */
export function defaultJwksUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
}
