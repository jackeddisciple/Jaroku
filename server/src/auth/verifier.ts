// Bearer token in, AuthContext out.
//
// This is the seam the rest of the server is written against. Above it: the JWKS fetch, the
// signature, the claims — all of which are about proving the token was issued by somebody this
// server trusts. Below it: nothing knows what a JWT is.
//
// AuthContext IS NOT A TENANT CONTEXT, and keeping them separate is the point of having two
// types. An AuthContext says *who is asking*. A TenantContext says *which workspace they may
// act in*, and turning one into the other requires a membership lookup that can fail — see
// resolve.ts. Collapsing them would make "authenticated" and "authorised" the same word, and
// the whole class of bug this session exists to prevent is exactly that confusion.
//
// Nothing here reads a workspace id off the token. A client controls what it sends; a
// membership row is what decides.

import { JwksClient, JwksError } from "./jwks.ts";
import { JwtError, readUnverifiedHeader, verifyJwt, type JwtClaims } from "./jwt.ts";
import type { AuthConfig } from "./config.ts";

/** Who is asking. Provider-shaped, pre-provisioning: no internal ids yet. */
export interface AuthContext {
  /** The provider's `sub`. Opaque, stored as `users.external_id`, never parsed. */
  subject: string;
  email: string | null;
  displayName: string | null;
  /** Unix seconds. What the session revalidation timer watches. */
  expiresAt: number;
  issuer: string;
  /**
   * Unix seconds: when this person last actually authenticated, or null when the issuer will not
   * say.
   *
   * `auth_time` when the issuer emits it, falling back to `iat`. The step-up gate on the secrets
   * passcode routes is the only reader, and the distinction is the point of it: a token refreshed
   * in the background carries a fresh `iat` and an `auth_time` from whenever somebody last proved
   * who they were. Reading `iat` alone would let a silent refresh satisfy a check that exists to
   * demand a deliberate one.
   *
   * NULL IS NOT FRESH. An issuer that says nothing cannot satisfy a step-up, because the
   * alternative — treating silence as "recently" — makes the gate a formality against exactly the
   * providers it cannot verify.
   */
  authenticatedAt: number | null;
}

export class AuthError extends Error {
  constructor(
    message: string,
    /** `unauthenticated` means "this token is not good"; `unavailable` means "ask again". */
    readonly kind: "unauthenticated" | "unavailable",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export class TokenVerifier {
  private jwks: JwksClient;

  constructor(
    private config: AuthConfig,
    jwks?: JwksClient,
  ) {
    this.jwks = jwks ?? new JwksClient({ url: config.jwksUrl });
  }

  /** `Authorization: Bearer <token>` → the token, or null if the header is absent/wrong. */
  static bearer(header: string | undefined): string | null {
    if (!header) return null;
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return m ? m[1]! : null;
  }

  async verify(token: string): Promise<AuthContext> {
    let claims: JwtClaims;
    try {
      const header = readUnverifiedHeader(token);
      const key = await this.jwks.keyFor(header.kid, header.alg);
      claims = verifyJwt(token, key, header, {
        issuer: this.config.issuer,
        audience: this.config.audience,
      });
    } catch (err) {
      throw classify(err);
    }
    return {
      subject: claims.sub,
      // An unverified email is not an identity claim, and this one becomes a user row's
      // email and a personal workspace's name. A provider that says nothing gives null,
      // which the provisioning path handles rather than inventing an address.
      // Trimmed as well as lowercased. `users.email` is unique, and " ada@x.com" and
      // "ada@x.com" are the same person to everyone except an index.
      email: claims.email_verified && claims.email ? claims.email.trim().toLowerCase() || null : null,
      displayName: claims.name?.trim() || null,
      expiresAt: claims.exp,
      issuer: claims.iss,
      authenticatedAt: claims.auth_time ?? claims.iat ?? null,
    };
  }

  /** For `/readyz` and the boot log. Never triggers a fetch. */
  keyStatus(): { keys: number; lastError: string | null } {
    const s = this.jwks.status();
    return { keys: s.keys, lastError: s.lastError };
  }
}

/**
 * Two outcomes, and they are genuinely different to the caller.
 *
 * A bad token is the client's problem and the answer is 401 — stop, sign in again. A JWKS
 * endpoint that is down is OUR problem, and answering 401 would sign every user out of a
 * working session because a third party had a bad minute. That is a 503, and the client's
 * socket layer retries it rather than showing a sign-in screen.
 */
function classify(err: unknown): AuthError {
  if (err instanceof JwksError) {
    if (err.kind === "unreachable") return new AuthError(`cannot reach the issuer's keys: ${err.message}`, "unavailable");
    return new AuthError(err.message, "unauthenticated");
  }
  if (err instanceof JwtError) return new AuthError(err.message, "unauthenticated");
  return new AuthError((err as Error)?.message ?? "token verification failed", "unauthenticated");
}
