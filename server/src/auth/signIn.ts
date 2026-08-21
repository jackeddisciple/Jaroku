// The values three round trips are built out of, and the rules all of them obey.
//
// WHAT THIS FILE IS AND IS NOT. It is the vocabulary — what a state is, what a ticket is, how
// long each is worth anything, what shape each has to be before it reaches a database, and the
// storage interface both drivers implement. It is NOT the flows: what Google is asked, what a
// magic-link email says, and which route redirects where are `oauthSignIn.ts` and `magicLink.ts`.
// The split is `tickets.ts`'s and for the same reason — the rules are the valuable part, they are
// pure, and a rule that can only be exercised by completing a real OAuth round trip against a
// real Google project is a rule nobody exercises.
//
// THREE SECRETS, THREE LIFETIMES, AND THE NUMBERS ARE THE DESIGN:
//
//   A MAGIC LINK IS FIFTEEN MINUTES. §3.3: "small enough that a stolen email → account takeover
//   window is tight" and large enough that somebody who went to find their phone still gets in.
//
//   AN OAUTH STATE IS TEN MINUTES. Already `OAUTH_STATE_TTL_S` in `oauth/pkce.ts`, and this file
//   re-exports it rather than declaring a second one: that constant is the consent screen's
//   budget, and a person picking the wrong Google account and coming back is the same person
//   whichever flow they are in.
//
//   A SESSION TICKET IS SIXTY SECONDS. §3.2 step 5, and the number is the gap between a browser
//   being redirected and a desktop application waking up and asking. It is deliberately twice the
//   thirty seconds a `ws_ticket` gets, because a ws-ticket is spent by a page that already exists
//   and this one is spent by an application the operating system may still be launching.
//
// AND ALL THREE OBEY THE SAME FOUR RULES `tickets.ts` states, which are restated here because
// they are the whole of the security of this feature:
//
//   SINGLE USE. Consumption is atomic and a second attempt gets nothing.
//   SHORT. See above; none of them outlives the interaction it belongs to.
//   HASHED AT REST. The store holds a digest, so a copy of it is not a set of credentials.
//   SHAPE-CHECKED BEFORE THE QUERY. Every one of these arrives on an unauthenticated route that a
//   third party drives, so a value that could not possibly be ours is refused in-process rather
//   than spending an index probe on it.

import { createHash, randomBytes } from "node:crypto";

export { OAUTH_STATE_TTL_S } from "../oauth/pkce.ts";

/** §3.3. Fifteen minutes, and the reasoning is in the header. */
export const MAGIC_LINK_TTL_S = 15 * 60;

/** §3.2 step 5 and §3.3 step 7. Sixty seconds between the browser and the app. */
export const SESSION_TICKET_TTL_S = 60;

/**
 * §3.3 step 4's countdown, and the client renders exactly this number.
 *
 * FORTY-FIVE SECONDS, WHICH IS NOT A RATE LIMIT. The limit is three an hour and lives on the
 * server; this is the shorter interval that stops somebody hammering Resend the moment the first
 * mail is a few seconds slow, and its whole job is to be visible. A countdown a person can watch
 * is the difference between "it is coming" and "nothing happened".
 */
export const RESEND_COOLDOWN_S = 45;

/**
 * How a person got here. §6's `auth_provider`, as the closed set the schema deliberately does not
 * carry — see migration 053 on why the CHECK constraint is here in TypeScript instead.
 */
export const SIGN_IN_PROVIDERS = ["google", "magic_link"] as const;

export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

export function isSignInProvider(value: unknown): value is SignInProvider {
  return typeof value === "string" && (SIGN_IN_PROVIDERS as readonly string[]).includes(value);
}

/**
 * 256 bits of randomness, base64url. The same width and encoding every opaque value in this
 * codebase uses, so a shape check is one regular expression rather than three.
 */
export function mintSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The digest a row is keyed by.
 *
 * SHA-256 rather than a slow KDF, deliberately, and the reasoning is `ws_tickets`': the input is
 * 256 bits of `randomBytes`, so there is no dictionary to make expensive — and a KDF on a callback
 * a third party drives would be a self-inflicted rate limit on the busiest unauthenticated route
 * in the system. The property being bought is "a database dump does not enable use of unconsumed
 * tokens", not "a password survives an offline attack".
 */
export function hashSecret(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Whether a presented value could be one of ours, before it becomes a query.
 *
 * A cheap shape check in front of the lookup, exactly as `looksLikeTicket` and `looksLikeState`
 * are. It refuses the kilobyte of junk somebody points at a callback without spending an index
 * probe on it, and it bounds what reaches `createHash` from a route anybody on the internet can
 * reach.
 */
export function looksLikeSecret(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(value);
}

// --- email, which is the one input a person actually types ---------------------------------------

/**
 * The longest address this will look at. RFC 5321 bounds a path at 256 octets including the angle
 * brackets, which makes 254 the practical maximum for the address itself — the same number
 * `devLoginHandler` already uses.
 */
export const EMAIL_MAX = 254;

/**
 * Whether this is an email address, for the purpose of sending exactly one message to it.
 *
 * §3.3: "Validates email format (a real regex, or a library — do not roll your own weakly)."
 * What follows is neither a weak roll-your-own nor RFC 5322, and the choice is worth stating,
 * because "validate an email address" is the classic problem where the correct answer is the
 * wrong one.
 *
 * A FULL RFC 5322 PARSER ACCEPTS THINGS NO PROVIDER WILL DELIVER TO — quoted local parts with
 * spaces, comments in parentheses, bare IP literals — and rejecting a real address is a person
 * who cannot sign in at all. So this is the deliberately boring subset every transactional mail
 * provider actually accepts: a local part of printable non-whitespace with no angle brackets,
 * quotes, commas or semicolons; an `@`; and a dotted domain with a final label of at least two
 * letters.
 *
 * THE REAL VALIDATION IS THE ROUND TRIP. An address that passes this and does not exist bounces,
 * §8.4 blocks it, and the next attempt says so. That is the only check that can distinguish a
 * typo from a mailbox, and no regular expression can.
 *
 * IT IS DELIBERATELY NOT CATASTROPHIC. Every quantifier below is over a disjoint character class,
 * so there is no nested repetition to backtrack through — this runs on an unauthenticated route
 * against input somebody chooses, and a pattern that can be made to take a second is a denial of
 * service spelled as a validation.
 */
const EMAIL_PATTERN = /^[^\s@<>(),;:\\"[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= EMAIL_MAX && EMAIL_PATTERN.test(value);
}

/**
 * The form an address is COMPARED in. §10: "Emails are case-insensitive per RFC — normalize to
 * lowercase before comparison; store as user entered but match as lowercase."
 *
 * NOTHING ELSE IS NORMALISED, and the omissions are deliberate. Gmail treats `a.b@gmail.com` and
 * `ab@gmail.com` as one mailbox and ignores everything after a `+`; almost no other provider does
 * either. A product that stripped dots would merge two genuinely different accounts at any host
 * that does not — which is an account takeover dressed as a convenience — and one that stripped
 * `+` suffixes would break the single most common way technical users file their mail.
 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// --- what the store has to be able to do -----------------------------------------------------

/** A magic link that has been minted and not yet spent. */
export interface MagicLinkRecord {
  email: string;
  expiresAt: number;
}

/** A state that has been minted and not yet spent, with the secrets the exchange needs. */
export interface OAuthStateRecord {
  provider: SignInProvider;
  codeVerifier: string;
  nonceHash: string;
  redirectTo: string | null;
  expiresAt: number;
}

/** A session ticket that has been minted and not yet spent. */
export interface SessionTicketRecord {
  userId: string;
  provider: SignInProvider;
  /**
   * The digest of the nonce the app instance generated, or null.
   *
   * NULL IS NOT "UNBOUND BY ACCIDENT". It means this ticket was minted by a flow that has no app
   * instance to bind to — the magic link, which §10 is explicit may be clicked on a different
   * device than it was requested from. See migration 053.
   */
  nonceHash: string | null;
  expiresAt: number;
}

/** How many attempts a key has made in the current window, and when that window began. */
export interface RateWindow {
  count: number;
  windowStart: number;
}

/**
 * Everything the sign-in flows need to keep, behind one interface.
 *
 * ONE INTERFACE RATHER THAN THREE, because the three tables are one feature and a caller that had
 * to assemble three stores would be a caller that could be handed two of them from one database
 * and one from another. Two implementations, as everywhere else here: a `Map`-backed one that
 * needs nothing running, and a database-backed one that works when there is more than one server
 * process. See `db/repositories/signIn.ts`.
 */
export interface SignInStore {
  /** Record a minted magic link. Returns the RAW token; only its digest is stored. */
  issueMagicLink(input: {
    email: string;
    ip: string | null;
    userAgent: string | null;
    ttlS?: number;
  }): Promise<{ token: string; expiresAt: number }>;

  /**
   * Spend a magic link, exactly once.
   *
   * §3.3 step 7: "Marks the token consumed atomically (an UPDATE … WHERE consumed_at IS NULL
   * RETURNING * in one query) — prevents double-use if the user clicks the link twice quickly."
   * The email is checked here rather than by the caller, because §10's last property — "a token
   * for alice@example.com cannot sign someone in as bob@example.com even if leaked" — is only true
   * if the binding is enforced in the same statement that spends the token.
   */
  consumeMagicLink(token: string, email: string): Promise<MagicLinkRecord | null>;

  /** Record a started OAuth flow. Returns the RAW state; only its digest is stored. */
  issueOAuthState(input: {
    provider: SignInProvider;
    codeVerifier: string;
    nonce: string;
    redirectTo?: string | null;
    ttlS?: number;
  }): Promise<{ state: string; expiresAt: number }>;

  /** Spend a state, exactly once. */
  consumeOAuthState(state: string): Promise<OAuthStateRecord | null>;

  /** Mint a session ticket for a user who has just proved who they are. */
  issueSessionTicket(input: {
    userId: string;
    provider: SignInProvider;
    /**
     * The DIGEST of the nonce the app instance generated, or null.
     *
     * ALREADY HASHED, WHICH IS DELIBERATE AND IS THE OPPOSITE OF EVERY OTHER SECRET HERE. The one
     * caller that sets it is the OAuth callback, and by the time it runs the raw nonce is long
     * gone: the app sent it when the flow STARTED, `issueOAuthState` hashed it then, and the raw
     * value never left that request. Taking a raw nonce here would mean either carrying it through
     * the state row in the clear — which is the thing hashing it prevented — or hashing a value
     * this side does not have.
     */
    nonceHash?: string | null;
    ttlS?: number;
  }): Promise<{ ticket: string; expiresAt: number }>;

  /** Spend a session ticket, exactly once. */
  consumeSessionTicket(ticket: string): Promise<SessionTicketRecord | null>;

  /**
   * Count one attempt against a key, and say what the window now holds.
   *
   * THE COUNT INCLUDES THIS ATTEMPT, so a caller compares against the limit with `>` and there is
   * no off-by-one to get right at two call sites. Counting the attempt even when it is about to be
   * refused is deliberate: §3.3's limits exist to stop somebody spamming a target's inbox, and a
   * limiter that only counted successes would let a refused attempt cost nothing.
   */
  countAttempt(key: string, windowS: number): Promise<RateWindow>;

  /** Whether this address must not be sent anything. §8.4. */
  isBlocked(email: string): Promise<boolean>;

  /** Stop sending to an address. §8.4's bounce and complaint handling. */
  block(email: string, reason: "bounce" | "complaint", detail?: string | null): Promise<void>;

  /**
   * Delete what has expired or been spent. §6: "Cleaned up by a scheduled job that deletes
   * expired-or-consumed rows daily."
   *
   * Returns how many rows went, which is what makes the job's log line worth reading.
   */
  sweep(): Promise<number>;
}

/**
 * The rate-limit key for an address, and for an address's origin.
 *
 * TWO KEYS AND BOTH APPLY. §7's rule 3: "Rate-limit POST /v1/auth/magic-link at the IP and email
 * level; both must apply." They protect different people — the email limit protects the person
 * whose inbox would be filled, and the IP limit protects everybody from one machine enumerating —
 * so a request that passes one and fails the other is refused.
 */
export const rateKeyForEmail = (email: string): string => `email:${normaliseEmail(email)}`;
export const rateKeyForIp = (ip: string): string => `ip:${ip}`;

/** §3.3: three per address per hour, ten per IP per hour, over a one-hour window. */
export const MAGIC_LINK_LIMITS = {
  windowS: 60 * 60,
  perEmail: 3,
  perIp: 10,
} as const;
