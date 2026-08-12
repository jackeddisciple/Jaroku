// What a provider is, as data — and the configuration that turns a description into a working
// integration.
//
// Same shape as `auth/capabilities.ts` and `queue/jobs.ts`: one declarative table per thing,
// read in one place. Google and Slack disagree about almost everything below the surface —
// where the token lands in the response, whether a refresh token exists at all, whether
// re-consenting returns a new refresh token or expects you to have kept the old one — and every
// one of those disagreements is a field here rather than a branch in the service.
//
// THE SCOPES ARE PART OF THE DESCRIPTION, NOT PART OF THE REQUEST. A connector asks for the least
// that makes its own tools work, and that set is written down beside the connector rather than
// assembled at the call site, because it is the thing a Google reviewer reads and the thing a
// user consents to. `gmail_create_draft` creates drafts and never sends, so the connector asks
// for `gmail.compose` and not `gmail.send`, and not `mail.google.com` — which grants everything
// including deletion. A scope list built from a request parameter would be one an attacker, or a
// careless caller, gets to widen.
//
// `consent` IS THE COPY, AND IT IS HERE FOR THE SAME REASON. A scope string is not a sentence a
// person can act on: "https://www.googleapis.com/auth/gmail.compose" tells somebody nothing about
// whether an agent can email their customers. The connections panel renders these lines, and
// keeping them next to the scopes they describe is what stops the two drifting the day a scope
// changes.

import type { TokenGrant } from "./service.ts";

/** One connector a provider can satisfy. `gmail` is Google's; `slack` is Slack's. */
export interface OAuthConnectorSpec {
  /** The catalog id in runtime/tool_templates/catalog.json. The join to everything else. */
  connectorId: string;
  label: string;
  /** The least that makes this connector's tools work. See the header. */
  scopes: string[];
  /**
   * What a run's environment holds the usable credential under.
   *
   * The connector's Python reads this name out of `os.environ` and knows nothing about OAuth,
   * which is the whole point of keeping the contract: `slack.py` reads `SLACK_BOT_TOKEN` whether
   * a human pasted one into `runtime/.env` or a workspace clicked Connect.
   */
  accessSecretName: string;
  /**
   * What the long-lived half is held under, or absent when there is none.
   *
   * Absent is a real answer rather than a gap: Slack's bot tokens do not expire and are not
   * refreshed, so a Slack connection has exactly one credential and inventing a second name for
   * it would make every reader handle a case that cannot happen.
   */
  refreshSecretName?: string;
  /** What the user is agreeing to, in words. Rendered in the connections panel. */
  consent: string[];
}

/** How to talk to one identity provider. */
export interface OAuthProvider {
  /** `google`, `slack`. The identity provider, which is not the same as the connector. */
  id: string;
  label: string;
  connectors: OAuthConnectorSpec[];
  authorizeUrl: string;
  tokenUrl: string;
  /**
   * Where a grant is handed back, or absent when the provider offers no endpoint.
   *
   * Absent is stated rather than implied, because "we could not revoke" and "we did not bother"
   * are different things to write in an audit row — see the disconnect path, which says which.
   */
  revokeUrl?: string;
  /**
   * Whether scopes travel space-separated (OAuth 2.0's own rule) or comma-separated.
   *
   * Slack uses commas, in defiance of RFC 6749 §3.3, and has since v2. A single flag beats a
   * provider-specific URL builder, and getting it wrong produces a consent screen asking for one
   * enormous scope with commas in its name rather than an error.
   */
  scopeSeparator?: " " | ",";
  /** Anything else the authorize URL needs. Google's offline access lives here. */
  authorizeParams?: Record<string, string>;
  /**
   * Read the provider's token response into one shape.
   *
   * Given the parsed JSON body, which is untrusted input like any other third-party payload:
   * every implementation coerces rather than casts, and returns null for a body it cannot read
   * rather than a half-populated grant that fails later somewhere less obvious.
   */
  readTokenResponse(body: unknown): TokenGrant | null;
  /**
   * Whether a 200 response is actually a failure.
   *
   * Slack answers errors with HTTP 200 and `{"ok": false, "error": "..."}`, so a service that
   * trusted the status code would store the string "undefined" as a bot token and report success.
   * Returns the error text, or null when the body is genuinely fine.
   */
  errorInBody?(body: unknown): string | null;
}

/** The credentials for one provider's OAuth app, plus where its callback lands. */
export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  /** Absolute, and identical at authorize time and exchange time or the provider refuses. */
  redirectUri: string;
}

export const OAUTH_REDIRECT_BASE_ENV = "JAROKU_OAUTH_REDIRECT_BASE";
export const OAUTH_APP_URL_ENV = "JAROKU_APP_URL";

/** `JAROKU_OAUTH_GOOGLE_CLIENT_ID`, `JAROKU_OAUTH_SLACK_CLIENT_SECRET`, and so on. */
export function clientEnvKeys(providerId: string): { id: string; secret: string } {
  const slug = providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return { id: `JAROKU_OAUTH_${slug}_CLIENT_ID`, secret: `JAROKU_OAUTH_${slug}_CLIENT_SECRET` };
}

/** The one callback path, for every provider. The provider is a segment, not a separate route. */
export function callbackPath(providerId: string): string {
  return `/v1/oauth/${providerId}/callback`;
}

/**
 * Resolve one provider's configuration, or null when this deployment has not set it up.
 *
 * NULL RATHER THAN A THROW, because an unconfigured provider is the ordinary local case and not
 * an error: `npm run dev` has no Google OAuth app and must not fail to start over it. What it
 * does mean is that the connector reports itself unavailable with a sentence saying which two
 * variables are missing, rather than producing a redirect to a consent screen that 400s.
 *
 * READ PER CALL, NOT CAPTURED AT IMPORT — the same rule the billing rates and the platform-key
 * switch follow. A deployment that adds an OAuth app should not need a restart, and three env
 * readers frozen at import time is a bug this repository has already fixed once.
 */
export function resolveClientConfig(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
  port = 4317,
): OAuthClientConfig | null {
  const keys = clientEnvKeys(providerId);
  const clientId = (env[keys.id] ?? "").trim();
  const clientSecret = (env[keys.secret] ?? "").trim();
  if (!clientId || !clientSecret) return null;
  const base = (env[OAUTH_REDIRECT_BASE_ENV] ?? `http://localhost:${port}`).replace(/\/+$/, "");
  return { clientId, clientSecret, redirectUri: `${base}${callbackPath(providerId)}` };
}

/** Why a provider cannot be connected on this deployment, in a sentence somebody can act on. */
export function unconfiguredReason(providerId: string): string {
  const keys = clientEnvKeys(providerId);
  return (
    `${providerId} is not configured on this deployment — set ${keys.id} and ${keys.secret}, ` +
    `and register ${callbackPath(providerId)} as an authorised redirect URI on the OAuth app.`
  );
}

/**
 * Where the browser is sent when a flow finishes.
 *
 * A BASE PLUS A PATH, NEVER A URL THE CALLER SUPPLIED. `return_to` is the classic open-redirect
 * parameter: a callback that redirects to whatever it is handed is a phishing primitive hosted on
 * our own domain and wearing our own TLS certificate. So the caller may choose a PATH and nothing
 * else — anything not starting with a single `/` is discarded rather than sanitised, because
 * `//evil.example` and `/\evil.example` are both absolute in a browser and a cleanup pass is a
 * thing to get subtly wrong.
 */
export function returnUrl(
  path: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = (env[OAUTH_APP_URL_ENV] ?? "http://localhost:5173").replace(/\/+$/, "");
  const safe = typeof path === "string" && /^\/(?![/\\])[^\s?#]*$/.test(path) ? path : "/";
  return `${base}${safe}`;
}
