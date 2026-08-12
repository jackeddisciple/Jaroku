// PKCE, and the value that rides the redirect.
//
// Two separate defences that are constantly confused for each other, so they are named apart
// here and the difference is written down once:
//
//   `state` DEFENDS THE CALLBACK. It is an unguessable value we mint, hand to the provider, and
//   recognise when the browser comes back. Without it, anybody can send a victim's browser to
//   our callback with an authorization code for THEIR account and quietly connect their mailbox
//   to the victim's workspace — a login-CSRF that ends with a workspace's agents reading an
//   attacker's inbox and, worse, writing into it. The row it resolves to is what carries the
//   workspace and the user, so a state that is not ours resolves to nothing at all.
//
//   `code_verifier` DEFENDS THE CODE. A high-entropy value whose SHA-256 goes to the provider at
//   the start of the flow and whose plaintext goes to the token endpoint at the end. An
//   authorization code intercepted in between — from a log, a Referer, a shared machine's
//   history — cannot be redeemed by whoever took it, because they cannot produce the verifier.
//
// Neither replaces the other and a flow needs both. RFC 7636 was written for public clients that
// cannot hold a secret, and it is routinely skipped by confidential ones on the grounds that the
// client secret already proves who is exchanging. That reasoning is about the CLIENT and says
// nothing about the CODE, which travels through a user agent either way.
//
// EVERY VALUE HERE IS `randomBytes`, NEVER `Math.random`. The obvious sentence, and it is written
// down because the failure is silent: a predictable state is a state an attacker can pre-empt,
// and nothing about the flow looks different when it happens.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * How long a half-finished flow is worth completing.
 *
 * Ten minutes, which is the consent screen's budget rather than the network's. A user who opens
 * the Google dialog, goes to find their password manager, picks the wrong account, and comes back
 * is well inside it; a state sitting in somebody's address bar an hour later is not a flow, it is
 * a credential nobody is watching. RFC 6749 recommends "short"; this is what short means here.
 */
export const OAUTH_STATE_TTL_S = 600;

/** 32 bytes, base64url. The same width and the same encoding as a ws-ticket, for the same reason. */
function randomValue(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The digest a state row is keyed by.
 *
 * SHA-256 rather than a slow KDF, deliberately, and the reasoning is `ws_tickets`': the input is
 * 256 bits of `randomBytes`, so there is no dictionary to make expensive — and a KDF on the
 * callback path would be a self-inflicted rate limit on a route a third party drives.
 */
export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/**
 * Whether a presented string could be one of ours, before it becomes a query.
 *
 * A cheap shape check in front of the lookup, exactly as `looksLikeTicket` is. It refuses the
 * kilobyte of junk somebody points at the callback without spending an index probe on it, and it
 * bounds what reaches `createHash` from an unauthenticated route.
 */
export function looksLikeState(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(v);
}

export interface Pkce {
  /** Held server-side until the exchange. Never sent anywhere but the token endpoint. */
  verifier: string;
  /** What goes to the authorize endpoint, in the clear, in the URL. */
  challenge: string;
  /** Always "S256". Named rather than assumed — see below. */
  method: "S256";
}

/**
 * A fresh verifier and its challenge.
 *
 * ALWAYS S256, NEVER `plain`. The spec permits `code_challenge_method=plain`, in which the
 * challenge IS the verifier, which makes the whole exercise decorative: anyone who can see the
 * authorize request can redeem the code. It exists for clients with no SHA-256, which is not a
 * category Node belongs to. A provider that does not advertise S256 support is one we do not
 * integrate, and the constant is written here rather than at each call site so that decision is
 * in one place.
 */
export function newPkce(): Pkce {
  const verifier = randomValue();
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    method: "S256",
  };
}

/** A fresh state value. Returned raw to the caller; only its digest is ever stored. */
export function newState(): string {
  return randomValue();
}

/**
 * Compare two opaque values without letting the comparison time say how much of one is right.
 *
 * Used where a state is checked against something already in hand rather than looked up by
 * digest — the state row's own consumption is a DELETE and needs no comparison at all, which is
 * the better shape. Length is compared first and separately because `timingSafeEqual` throws on
 * a mismatch rather than returning false, and that throw is itself the leak it exists to prevent.
 */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
