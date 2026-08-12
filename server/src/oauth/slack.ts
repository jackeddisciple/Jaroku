// Slack, as a descriptor — and three places where Slack is not an ordinary OAuth 2.0 provider.
//
// FIRST: SLACK ANSWERS ERRORS WITH HTTP 200. `oauth.v2.access` returns `{"ok": false, "error":
// "invalid_code"}` with a 200 status, every time, for every failure. A service that trusted the
// status code would read that body, find no `access_token`, and — depending on how carefully it
// was written — either store the string "undefined" as a bot token or report a successful
// connection with nothing behind it. `errorInBody` is the hook that exists for exactly this, and
// Slack is why it is on the interface at all.
//
// SECOND: SCOPES ARE COMMA-SEPARATED. RFC 6749 §3.3 says space-delimited; Slack has used commas
// since v2 and is not going to change. Sending spaces produces a consent screen asking for one
// enormous scope with spaces in its name, which Slack then rejects with a message about an
// invalid scope rather than about a separator.
//
// THIRD: THE TOKEN IS NOT WHERE YOU EXPECT IT. The v2 response is nested — the bot token lives at
// `authed_user` for a user token and at the TOP LEVEL under `access_token` for a bot token, with
// the granted scopes beside it and the team on its own object. An integration that read
// `access_token` without checking `token_type` can end up storing a USER token (`xoxp-`) where a
// BOT token (`xoxb-`) was meant, which works for reads and fails confusingly on `chat.postMessage`
// — and, worse, acts as the installing human rather than as the app.
//
// WHAT SLACK DOES NOT DO IS EXPIRE. A bot token is valid until somebody uninstalls the app or
// rotates it deliberately, so `refreshSecretName` is absent and `expiresInS` comes back null.
// That is a real answer rather than a gap: the refresher must not invent an expiry for a token
// that has none, and the connection row's nullable `access_expires_at` is what carries it.
//
// THE SCOPES ARE THE CONNECTOR'S, and the third one is the one to think about. `chat:write` lets
// an agent post, and posting is immediate, externally visible and cannot be undone — the catalog
// says so, the generation prompt says so, and the consent copy below says so, because a user
// ticking a box deserves the same sentence the model is given.

import type { OAuthProvider } from "./provider.ts";
import type { TokenGrant } from "./service.ts";

export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
export const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
export const SLACK_REVOKE_URL = "https://slack.com/api/auth.revoke";

/** Exactly what the three tools in `slack.py` need. Exported so the docs quote this list. */
export const SLACK_BOT_SCOPES = ["channels:read", "channels:history", "chat:write"];

/** `{"ok": false, "error": "..."}` on a 200. See the header — this is Slack's whole error channel. */
function slackError(body: unknown): string | null {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!b) return "slack returned a body that is not an object";
  if (b["ok"] === true) return null;
  const error = typeof b["error"] === "string" ? b["error"] : "unknown_error";
  return error;
}

export const SLACK: OAuthProvider = {
  id: "slack",
  label: "Slack",
  authorizeUrl: SLACK_AUTHORIZE_URL,
  tokenUrl: SLACK_TOKEN_URL,
  revokeUrl: SLACK_REVOKE_URL,
  // See the header. Commas, not spaces.
  scopeSeparator: ",",
  connectors: [
    {
      connectorId: "slack",
      label: "Slack",
      scopes: SLACK_BOT_SCOPES,
      // The name `slack.py` already reads, unchanged. A bot token obtained by clicking Connect
      // and one pasted into `runtime/.env` by hand are the same string under the same name, which
      // is the whole point of keeping the connector contract: the template does not learn that
      // OAuth exists.
      accessSecretName: "SLACK_BOT_TOKEN",
      // Deliberately absent. Bot tokens do not expire and are not refreshed.
      consent: [
        "See the public channels in your Slack workspace, and read their recent messages",
        "Post messages as the Jaroku app",
        "Posting is immediate and cannot be undone — point an agent at a test channel first",
      ],
    },
  ],
  errorInBody: slackError,
  readTokenResponse(body): TokenGrant | null {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const accessToken = b["access_token"];
    if (typeof accessToken !== "string" || !accessToken) return null;

    // THE BOT TOKEN, PROVED RATHER THAN ASSUMED. `token_type: "bot"` is Slack saying which kind
    // this is; a response for a user-token installation carries the same field name with a
    // different meaning, and storing that as `SLACK_BOT_TOKEN` would give an agent the installing
    // human's own permissions in every channel they can see. Refused rather than stored under a
    // name that would misdescribe it.
    if (b["token_type"] !== undefined && b["token_type"] !== "bot") return null;

    const team = b["team"] && typeof b["team"] === "object" ? (b["team"] as Record<string, unknown>) : {};
    return {
      accessToken,
      refreshToken: null,
      // Null, not zero. Slack's bot tokens do not expire, and an expiry of 0 would have the
      // refresher treat a perfectly live token as already dead.
      expiresInS: null,
      // Comma-separated coming back too, matching what went out.
      scopes: typeof b["scope"] === "string" ? b["scope"].split(",").filter(Boolean) : [],
      accountId: typeof team["id"] === "string" ? team["id"] : null,
      // The team name, so the panel can say WHICH Slack an agent posts into. Bounded for the same
      // reason every third-party string here is: it is stored, rendered and logged.
      accountLabel: typeof team["name"] === "string" ? team["name"].slice(0, 200) : null,
    };
  },
};
