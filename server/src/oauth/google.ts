// Google, as a descriptor.
//
// THE SCOPES ARE THE PRODUCT PROMISE, WRITTEN AS CONFIGURATION. `gmail.py` searches mail and
// creates drafts, and it deliberately cannot send: "an agent that can email the world unattended
// is a different risk class, and that decision should be explicit rather than a side effect of
// picking a connector". That sentence has been in the template since it was written, and until
// now the only thing enforcing it was that the template has no send call in it. Hosted, WE ask
// for the scopes, so the promise becomes something Google enforces on our behalf — a token
// carrying `gmail.compose` and not `gmail.send` cannot send even if every other line of defence
// failed at once.
//
// So: `gmail.readonly` and `gmail.compose`. NOT `gmail.send`, and emphatically not
// `https://mail.google.com/`, which is full access including permanent deletion and is what a
// lazy integration asks for. The narrow pair is also what makes the verification submission
// arguable — see below.
//
// GOOGLE VERIFICATION IS THE LONG POLE OF THIS SESSION AND IT IS NOT A CODE PROBLEM. Both scopes
// above are RESTRICTED, which means an OAuth app requesting them must pass Google's verification
// AND a third-party security assessment before it may serve more than a hundred users. That has
// a lead time measured in weeks and, for the assessment, a real invoice. Until it completes, the
// app runs in testing mode: it works, for a list of test users entered by hand, with an
// unmissable "Google hasn't verified this app" interstitial. Nothing in this file changes that,
// and nothing in this file should pretend to — the honest thing is to say so where somebody
// reading the integration will see it.
//
// REFRESH TOKENS ARRIVE EXACTLY ONCE, AND THAT IS THE TRAP. Google issues a refresh token on the
// FIRST consent for a given (user, client) pair and then never again — a second authorisation
// returns an access token with no `refresh_token` field at all. An integration that stored the
// response verbatim would therefore work perfectly for a new user, and silently lose the ability
// to refresh for anybody who reconnected. `prompt=consent` forces the consent screen and makes
// Google issue a fresh one every time, which is why it is on the authorize URL below and why it
// is not merely a nicety. `access_type=offline` is the other half: without it there is no
// refresh token on the first consent either, and the integration works for exactly one hour.
//
// And when a refresh DOES return a new refresh token — Google rotates them for apps in some
// configurations — the new one must replace the old. `refreshSecretName` is a fixed name in the
// vault, so a rotation is an overwrite at one key rather than a second row nothing reads.

import type { OAuthProvider } from "./provider.ts";
import type { TokenGrant } from "./service.ts";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** The two Gmail scopes, and no third. Exported so the docs and the panel quote the same list. */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

/**
 * Calendar's two, and the same discipline applied to a different API.
 *
 * `calendar.events` RATHER THAN `calendar`, and the difference is not a nuance. The wide scope
 * grants management of the calendar LIST — creating calendars, deleting them, changing who they
 * are shared with — and no tool in `google_calendar.py` does any of those. `calendar.events` is
 * read and write on the events of calendars the user already has, which is exactly the four
 * tools' blast radius. It is also what the consent screen renders, so the narrower one is the
 * difference between a person reading "manage your calendars" and "manage events".
 *
 * `calendar.readonly` sits beside it because Google's consent screen lets somebody grant one box
 * and not another. A user who agrees to reading and declines writing should get the two read
 * tools working rather than a connection that fails at every call — and `service.missingScopes`
 * is what tells the panel to say which half they withheld.
 *
 * NOT `calendar.settings.readonly`, NOT `calendar.acls`, and emphatically not
 * `https://www.googleapis.com/auth/calendar` — the same list of near-misses the Gmail scopes have
 * a suite refusing by name.
 */
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

/**
 * The two that buy the panel an account label, and nothing else.
 *
 * `openid` is what makes Google return an `id_token` at all; `email` is what puts an address in
 * it. Both are non-sensitive — Google renders them as "see your primary email address" and
 * neither counts towards the restricted-scope assessment — and they are asked for because a
 * connections panel that cannot say WHICH mailbox an agent is reading is a panel nobody can audit.
 * A workspace with two Google accounts and no labels is one where "disconnect the wrong one" is a
 * coin flip.
 */
export const IDENTITY_SCOPES = ["openid", "email"];

/**
 * The `id_token` payload, read without verifying it.
 *
 * NOT AUTHENTICATION, AND THAT IS WHY NO SIGNATURE IS CHECKED. The token came back over TLS from
 * the token endpoint, in response to a request carrying our client secret — the channel is what
 * establishes it is Google's, exactly as it does for the access token in the same body. Nothing
 * here decides access: the fields taken are an email address and a subject id, both of which are
 * rendered on a card so a person can tell which mailbox their agents are reading.
 *
 * A malformed or absent id_token yields nulls rather than throwing. A connection whose account
 * label is unknown is a cosmetic problem; a connection that failed to complete because a display
 * string would not parse is a real one.
 */
function readIdToken(idToken: unknown): { sub: string | null; email: string | null } {
  if (typeof idToken !== "string") return { sub: null, email: null };
  const parts = idToken.split(".");
  if (parts.length !== 3) return { sub: null, email: null };
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as unknown;
    const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    return {
      sub: typeof p["sub"] === "string" ? p["sub"] : null,
      // Bounded for the same reason every third-party string in this codebase is: it is stored,
      // rendered in the panel, and put in a log line.
      email: typeof p["email"] === "string" ? p["email"].slice(0, 254) : null,
    };
  } catch {
    return { sub: null, email: null };
  }
}

export const GOOGLE: OAuthProvider = {
  id: "google",
  label: "Google",
  authorizeUrl: GOOGLE_AUTHORIZE_URL,
  tokenUrl: GOOGLE_TOKEN_URL,
  revokeUrl: GOOGLE_REVOKE_URL,
  authorizeParams: {
    // Without this there is no refresh token at all and the connection dies in an hour.
    access_type: "offline",
    // See the header. Forces a refresh token on EVERY consent, not only the first one this
    // Google account ever gave us — which is what makes reconnecting work.
    prompt: "consent",
    // INCREMENTAL AUTHORISATION. Google's own flag for "keep what this user already granted us
    // and add what I am asking for now". Without it, a second flow for a narrower scope set
    // silently REPLACES the wider grant, and the tools that depended on the dropped scope start
    // failing with a 403 that names nothing.
    include_granted_scopes: "true",
  },
  connectors: [
    {
      connectorId: "gmail",
      label: "Gmail",
      scopes: [...IDENTITY_SCOPES, ...GMAIL_SCOPES],
      // The names `gmail.py` reads. `GMAIL_ACCESS_TOKEN` is new and additive — see the connector
      // itself for why a hosted run gets a short-lived access token rather than the refresh-token
      // triple a hand-configured local install still uses.
      accessSecretName: "GMAIL_ACCESS_TOKEN",
      refreshSecretName: "GMAIL_REFRESH_TOKEN",
      consent: [
        "Read the messages in your mailbox, so an agent can search it",
        "Create draft replies in your mailbox",
        "It cannot send mail, delete anything, or change your settings",
      ],
    },
    {
      // A SECOND CONNECTION UNDER THE SAME OAUTH APP, NOT A WIDER GMAIL ONE.
      //
      // Google would happily put both scope sets behind one grant — `include_granted_scopes` is
      // already on, and merging them would save a click. The click is worth paying for, because
      // one grant is one revocation: a person who decides an agent should stop reading their
      // mail would, under a merged connection, also lose the scheduling assistant, and the panel
      // would have no way to offer them anything else. Two connections make "disconnect Gmail,
      // keep Calendar" expressible, which is the state somebody actually wants to be in.
      //
      // It also keeps the exported-project story honest. `required_env` for this connector is
      // the GCAL_ triple; a project generated with Calendar and not Gmail asks for Calendar
      // credentials and nothing else, which a shared connection could not have produced.
      connectorId: "google_calendar",
      label: "Google Calendar",
      scopes: [...IDENTITY_SCOPES, ...CALENDAR_SCOPES],
      // The names `google_calendar.py` reads — its own, not Gmail's, for the reason above.
      accessSecretName: "GCAL_ACCESS_TOKEN",
      refreshSecretName: "GCAL_REFRESH_TOKEN",
      consent: [
        "See the events on your calendars, so an agent can answer questions about your week",
        "Create and change events, which sends invitations to the people on them",
        "It cannot delete an event, and it cannot create, delete or share a calendar",
      ],
    },
  ],
  readTokenResponse(body): TokenGrant | null {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const accessToken = b["access_token"];
    if (typeof accessToken !== "string" || !accessToken) return null;
    const identity = readIdToken(b["id_token"]);
    return {
      accessToken,
      // ABSENT ON A REFRESH, AND ABSENT ON A RE-CONSENT WITHOUT prompt=consent. Null here means
      // "Google did not issue a new one", which the refresher reads as "keep the one you have"
      // rather than as "there is no refresh token" — see refresh.ts.
      refreshToken: typeof b["refresh_token"] === "string" ? b["refresh_token"] : null,
      expiresInS: typeof b["expires_in"] === "number" ? b["expires_in"] : null,
      // Space-separated, per RFC 6749. What Google actually granted, which with
      // include_granted_scopes is a superset of what this flow asked for.
      scopes: typeof b["scope"] === "string" ? b["scope"].split(" ").filter(Boolean) : [],
      accountId: identity.sub,
      accountLabel: identity.email,
    };
  },
};
