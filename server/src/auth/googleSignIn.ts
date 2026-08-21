// Signing in with Google: what is asked, what comes back, and what is checked before any of it
// becomes an account.
//
// THIS IS NOT `oauth/google.ts`, AND THE TWO MUST NOT BE MERGED. That one connects a WORKSPACE to
// a Gmail mailbox so an agent can read it — restricted scopes, a refresh token kept in the vault,
// a connection card somebody can revoke. This one establishes WHO SOMEBODY IS and then forgets
// Google entirely: no token is stored, no refresh is kept, nothing is ever called again. They
// share a provider and nothing else, and a single module would be one where widening the identity
// scopes silently widened what every agent can read.
//
// WHICH IS WHY THE SCOPE LIST HERE IS THREE WORDS AND WHY THAT IS ASSERTED. §12's acceptance
// criterion 8: "Scope requested is exactly `openid email profile` — no more." Google's consent
// screen escalates visibly the moment anything else appears, and a sign-in that shows the scary
// interstitial is a sign-in a proportion of people abandon. None of the three is sensitive, none
// requires verification, and together they are exactly enough to create an account: a stable
// subject, a verified address, and a name to put on it.
//
// THE FLOW, AND WHERE EACH DEFENCE SITS:
//
//   1. The app asks this server to start. It sends a NONCE it generated itself and keeps in
//      memory. We mint a `state` and a PKCE verifier, store all three, and hand back the
//      authorization URL.
//   2. The app opens that URL in the SYSTEM BROWSER — not a webview, which Google's own policy
//      refuses and which would be a browser the application can read the contents of.
//   3. Google redirects to `/oauth/google/callback` with a code and our state.
//   4. We spend the state (single use, atomic), exchange the code with the verifier, and VERIFY
//      the id_token properly — signature against Google's JWKS, `iss`, `aud`, `exp`, and the
//      `nonce` we put in the request.
//   5. We provision or find the user, mint a sixty-second session ticket bound to the app's nonce,
//      and redirect the browser to `jaroku://auth/complete?ticket=…`.
//
// THREE THINGS DEFEND THREE DIFFERENT ATTACKS AND NONE REPLACES ANOTHER — `oauth/pkce.ts` says
// this at length and it is worth restating for the flow that hands out SESSIONS rather than
// mailbox access:
//
//   `state` defends the callback. Without it anybody can send a victim's browser to our callback
//   carrying an authorization code for THEIR Google account, and the victim ends up signed into
//   the attacker's account — where they then type their API keys.
//   `code_verifier` defends the code. A code intercepted between Google and us cannot be redeemed
//   by whoever took it.
//   `nonce` defends the ID TOKEN, and it is the one people leave out. Without it an id_token
//   obtained for a different client, or replayed from an earlier flow, verifies perfectly.
//
// AND A FOURTH DEFENDS SOMETHING ONLY A DESKTOP APP HAS: the ticket is bound to the app instance's
// own nonce, because `jaroku://` is a scheme any program on the machine can register. See
// migration 053.

import { createHash, createVerify, randomBytes } from "node:crypto";
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL } from "../oauth/google.ts";
import { newPkce } from "../oauth/pkce.ts";
import { JwksClient } from "./jwks.ts";
import { mintSecret, type SignInStore } from "./signIn.ts";

/**
 * §3.2 step 2, and criterion 8. Exactly three, and the suite reads this constant rather than a
 * copy so that widening it is a change to a line somebody has to review.
 */
export const GOOGLE_SIGN_IN_SCOPES = ["openid", "email", "profile"] as const;

/** Where Google publishes the keys that sign its ID tokens. */
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/** What Google stamps as `iss`. Both spellings are real and Google uses them interchangeably. */
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;

/** Every environment variable this module reads, in one place — `auth/config.ts`'s pattern. */
export const GOOGLE_ENV = {
  clientId: "JAROKU_GOOGLE_CLIENT_ID",
  clientSecret: "JAROKU_GOOGLE_CLIENT_SECRET",
  /** The public origin the callback is served from. §3.2: a stable, Jaroku-owned HTTPS URL. */
  authOrigin: "JAROKU_AUTH_ORIGIN",
} as const;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** No trailing slash. Every URL below is built by appending a path to it. */
  authOrigin: string;
  redirectUri: string;
}

/**
 * Read Google's configuration, or answer `null`.
 *
 * NULL RATHER THAN A THROW, and the caller mounts no Google routes when it gets one. A deployment
 * that has not configured Google is not broken — magic link is a complete sign-in path on its own,
 * and §3.1 is explicit that neither is a second-class citizen. What must not happen is a "Continue
 * with Google" button that produces a 500, which is what a partially-configured server would give.
 *
 * THE ORIGIN MUST BE HTTPS, and this refuses rather than warns. Google will not accept a plain-http
 * redirect URI for anything but `localhost`, so a misconfiguration here fails at Google's end with
 * an error page nobody reading our logs can see. `http://localhost` is admitted because it is the
 * one exception Google itself makes, and it is how this is developed against a real Google project.
 */
export function googleConfigFrom(env: NodeJS.ProcessEnv = process.env): GoogleConfig | null {
  const clientId = (env[GOOGLE_ENV.clientId] ?? "").trim();
  const clientSecret = (env[GOOGLE_ENV.clientSecret] ?? "").trim();
  const authOrigin = (env[GOOGLE_ENV.authOrigin] ?? "").trim().replace(/\/+$/, "");
  if (!clientId || !clientSecret || !authOrigin) return null;
  if (!/^https:\/\//.test(authOrigin) && !/^http:\/\/localhost(:\d+)?$/.test(authOrigin)) return null;
  return {
    clientId,
    clientSecret,
    authOrigin,
    redirectUri: `${authOrigin}${GOOGLE_CALLBACK_PATH}`,
  };
}

/**
 * The callback's path, spelled once.
 *
 * NOT UNDER `/v1/`, deliberately, and it is the only route in this server that is not. `/v1` is
 * the client API and is versioned because clients are; this is a URL registered in a Google Cloud
 * console by a human, and changing it means editing a configuration in somebody else's dashboard
 * and waiting for it to propagate. A path that can never move is a path that should not carry a
 * version number implying it might.
 */
export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";

/** Where the browser is sent when everything worked. Read by `authLink.ts` on the other side. */
export function completeDeepLink(ticket: string): string {
  return `jaroku://auth/complete?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * Build the authorization URL for one sign-in attempt, and record what completing it will need.
 *
 * `nonce` IS THE APP'S, NOT OURS. §3.2 asks for the state to be "bound to the Tauri app instance
 * via a locally-generated nonce", so the value is generated in the app, kept in its memory, sent
 * here, and presented again at the exchange. We store only its digest — a database dump must not
 * contain the thing that proves an app instance is the right one.
 *
 * AND A SECOND NONCE GOES TO GOOGLE, which is a different value for a different job. This one is
 * ours, it goes in the authorization request, it comes back inside the ID token, and checking it
 * is what stops an id_token from another flow verifying here. Two nonces is not duplication: one
 * binds the callback to an APP, the other binds the ID token to a REQUEST.
 */
export async function startGoogleSignIn(
  store: SignInStore,
  config: GoogleConfig,
  input: { appNonce: string },
): Promise<{ authorizeUrl: string; state: string; expiresAt: number }> {
  const pkce = newPkce();
  // Ours, for the ID token. Held as a digest inside the state's `code_verifier`-adjacent secret
  // rather than in a column of its own, because it is spent in the same statement the verifier is:
  // see `packVerifier` below on why the two travel together.
  const idTokenNonce = mintSecret();
  const issued = await store.issueOAuthState({
    provider: "google",
    codeVerifier: packVerifier(pkce.verifier, idTokenNonce),
    nonce: input.appNonce,
  });

  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SIGN_IN_SCOPES.join(" "));
  url.searchParams.set("state", issued.state);
  url.searchParams.set("nonce", idTokenNonce);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);
  // `select_account`, and deliberately NOT `consent`. `oauth/google.ts` forces consent because it
  // needs a refresh token and Google issues one only on a first consent — this flow needs no
  // refresh token at all, and forcing the consent screen on every sign-in would make returning
  // users re-approve an application they have already approved. `select_account` is the one that
  // helps: somebody with a personal and a work Google account is asked which, every time, instead
  // of being silently signed into whichever the browser used last.
  url.searchParams.set("prompt", "select_account");
  return { authorizeUrl: url.toString(), state: issued.state, expiresAt: issued.expiresAt };
}

/**
 * The two secrets a callback needs, in the one column the schema has for them.
 *
 * A DELIMITED PAIR RATHER THAN A SECOND COLUMN, and the reason is that they have identical
 * lifetimes and identical spend: both are written when the flow starts, both are read exactly once
 * in the same statement, and neither is ever meaningful without the other. A column apiece would be
 * two things a future writer could read separately.
 *
 * The delimiter is `.` and both halves are base64url, which has no `.` in its alphabet — so the
 * split is unambiguous by construction rather than by hoping neither value contains it.
 */
function packVerifier(codeVerifier: string, idTokenNonce: string): string {
  return `${codeVerifier}.${idTokenNonce}`;
}

function unpackVerifier(packed: string): { codeVerifier: string; idTokenNonce: string } | null {
  const parts = packed.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { codeVerifier: parts[0], idTokenNonce: parts[1] };
}

/** Who Google says this is. Every field has been verified by the time one of these exists. */
export interface GoogleIdentity {
  /** The `sub` claim. Opaque, stable, and the only thing that identifies the account. */
  subject: string;
  email: string;
  /** Google's `name` claim, or the two halves joined. Null when the profile has none. */
  displayName: string | null;
}

export class GoogleSignInError extends Error {
  constructor(
    message: string,
    /** What the audit row should say. Never shown to a person; see `oauthCallback` in routes. */
    readonly reason: string,
  ) {
    super(message);
    this.name = "GoogleSignInError";
  }
}

export interface GoogleExchangeDeps {
  config: GoogleConfig;
  /** Pointed at Google`s key set. One per process; see `googleJwks()` below. */
  jwks: JwksClient;
  /** Injected so the suite can run the whole exchange without reaching Google. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Turn an authorization code into a verified identity, or refuse.
 *
 * EVERY REFUSAL IS A `GoogleSignInError` WITH A REASON, and the reason never reaches the browser.
 * §7's rule 4 — never log the raw code — and §4.5's rule that a used ticket and an invalid one say
 * the same thing to a person, are the same rule in two places: a callback that told a stranger
 * WHICH check failed would be a callback that helps them fix it.
 */
export async function exchangeGoogleCode(
  deps: GoogleExchangeDeps,
  input: { code: string; codeVerifier: string; expectedNonce: string },
): Promise<GoogleIdentity> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: deps.config.clientId,
    client_secret: deps.config.clientSecret,
    redirect_uri: deps.config.redirectUri,
    code_verifier: input.codeVerifier,
  });

  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      // A bound, because this is on the path of a request a browser is waiting on and Google is
      // somebody else's availability. Ten seconds is far longer than the endpoint's real latency.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new GoogleSignInError("could not reach Google", `token_endpoint_unreachable: ${(err as Error).message}`);
  }
  if (!response.ok) {
    // The body is read for the LOG and never for the browser. Google's error bodies name the
    // client id and sometimes echo the redirect URI.
    const detail = await response.text().catch(() => "");
    throw new GoogleSignInError("Google refused this sign-in", `token_endpoint_${response.status}: ${detail.slice(0, 300)}`);
  }

  const payload = (await response.json().catch(() => null)) as { id_token?: unknown } | null;
  const idToken = payload?.id_token;
  if (typeof idToken !== "string" || idToken === "") {
    throw new GoogleSignInError("Google did not identify this account", "no_id_token");
  }

  return verifyGoogleIdToken({ jwks: deps.jwks, clientId: deps.config.clientId, now }, idToken, input.expectedNonce);
}

/**
 * Verify an ID token properly, which is the whole of the authentication.
 *
 * NOT `oauth/google.ts`'s `readIdToken`. That one parses without verifying, and says so at length:
 * it takes an address off a token that arrived over TLS in response to a request carrying our
 * client secret, and renders it on a card so somebody can tell which mailbox an agent reads. It
 * decides nothing. This one decides WHO IS SIGNING IN, so every check is made — and the reason
 * both exist is precisely that the difference between them is invisible at the call site.
 *
 * The signature check is `jwks.ts`'s, which is the same code path §3.2 says to reuse: "the exact
 * same verification path already established in v0.2.6".
 */
export async function verifyGoogleIdToken(
  deps: { jwks: JwksClient; clientId: string; now: () => number },
  idToken: string,
  expectedNonce: string,
): Promise<GoogleIdentity> {
  const claims = await verifySignature(deps.jwks, idToken);

  if (!GOOGLE_ISSUERS.includes(claims.iss as (typeof GOOGLE_ISSUERS)[number])) {
    throw new GoogleSignInError("Google did not issue this", `bad_iss: ${String(claims.iss).slice(0, 80)}`);
  }
  // `aud` is OUR client id. Without this check any Google application's ID token verifies here,
  // and "sign in with Google" becomes "sign in with any Google app the attacker also uses".
  if (claims.aud !== deps.clientId) {
    throw new GoogleSignInError("this sign-in was not for Jaroku", "bad_aud");
  }
  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  if (exp * 1000 <= deps.now()) {
    throw new GoogleSignInError("this sign-in took too long", "expired");
  }
  // THE CHECK PEOPLE LEAVE OUT. Without it, an id_token captured from an earlier flow — or one
  // obtained by an attacker for their own session — verifies perfectly on every other count.
  if (typeof claims.nonce !== "string" || !timingSafeStringEquals(claims.nonce, expectedNonce)) {
    throw new GoogleSignInError("this sign-in could not be matched to a request", "nonce_mismatch");
  }

  const subject = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  if (!subject || !email) {
    throw new GoogleSignInError("Google did not supply an email address", "no_email");
  }
  // §12 criterion 7 provisions Google users with `email_verified: true`, and this is where that is
  // earned rather than assumed. Google sets the claim false for a Workspace address that has not
  // completed verification, and an unverified address is one somebody else may still prove.
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    throw new GoogleSignInError("this Google account's email address is not verified", "email_unverified");
  }

  return {
    subject,
    email,
    displayName: readName(claims),
  };
}

/** Google's `name`, or the two halves, or nothing. Trimmed and bounded like every display name. */
function readName(claims: Record<string, unknown>): string | null {
  const full = typeof claims.name === "string" ? claims.name.trim() : "";
  if (full) return full.slice(0, 100);
  const given = typeof claims.given_name === "string" ? claims.given_name.trim() : "";
  const family = typeof claims.family_name === "string" ? claims.family_name.trim() : "";
  const joined = [given, family].filter(Boolean).join(" ");
  return joined ? joined.slice(0, 100) : null;
}

/**
 * The signature half, against Google's published keys.
 *
 * Reuses `JwksClient` rather than fetching the key set here, which buys the cache, the
 * rotation handling and the timeout that module already got right — and means Google's keys are
 * fetched on the same policy as any other issuer's.
 */
async function verifySignature(jwks: JwksClient, idToken: string): Promise<Record<string, unknown>> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new GoogleSignInError("Google's answer was malformed", "malformed_id_token");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<string, unknown>;
    claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new GoogleSignInError("Google's answer was malformed", "unparseable_id_token");
  }

  const kid = typeof header.kid === "string" ? header.kid : null;
  const alg = typeof header.alg === "string" ? header.alg : "";
  // `alg` IS CHECKED AGAINST WHAT WE EXPECT rather than used to pick a verifier. Trusting the
  // token's own header to say how to verify it is the `alg: none` family of bugs, and `HS256`
  // against a public key is the other half of it.
  if (alg !== "RS256") throw new GoogleSignInError("Google's answer was signed unexpectedly", `bad_alg: ${alg}`);
  if (!kid) throw new GoogleSignInError("Google's answer named no key", "no_kid");

  // `keyFor` rather than a fetch here, and RS256 is passed rather than read off the header — the
  // client checks the key's own published algorithm against what we claim to expect, which is the
  // algorithm-confusion guard `jwks.ts` was built with. The header's `alg` was already checked
  // above; this makes the KEY agree too.
  const key = await jwks.keyFor(kid, "RS256").catch((err: Error) => {
    throw new GoogleSignInError("could not check Google's signature", `jwks: ${err.message}`);
  });
  const ok = createVerify("RSA-SHA256")
    .update(`${encodedHeader}.${encodedPayload}`)
    .verify(key, Buffer.from(encodedSignature, "base64url"));
  if (!ok) throw new GoogleSignInError("Google's signature did not check out", "bad_signature");
  return claims;
}

/**
 * Compare two nonces without letting the comparison time say how much of one is right.
 *
 * Overkill against a 256-bit random value an attacker has nothing to steer with, and it is here
 * for the reason `digestsMatch` is: a short-circuiting comparison in a credential path is a habit
 * worth not having, and the next value compared this way may not have 256 bits behind it.
 */
function timingSafeStringEquals(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return left.equals(right);
}

/** A nonce for an app instance to keep. Exported so the client's own generator has one shape. */
export function mintAppNonce(): string {
  return randomBytes(32).toString("base64url");
}

export { unpackVerifier };

/**
 * The key set for Google's ID tokens, as one client for the whole process.
 *
 * ONE INSTANCE, NOT ONE PER REQUEST, and `JwksClient` is why: it caches keys for ten minutes,
 * shares a single in-flight fetch across simultaneous sign-ins, and remembers a failure so an
 * issuer having a bad minute costs one request rather than one per attempt. A client constructed
 * per callback would throw all three away and turn ten people signing in at once into ten fetches
 * of the same document.
 */
export function googleJwks(fetchImpl?: typeof fetch): JwksClient {
  return new JwksClient({ url: GOOGLE_JWKS_URL, ...(fetchImpl ? { fetchImpl } : {}) });
}
