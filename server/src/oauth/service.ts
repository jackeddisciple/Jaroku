// The OAuth flow, once, for every provider.
//
// Two operations and a strict order between them: `begin` mints a flow and hands back a URL for
// the browser to visit; `complete` is what the provider's redirect lands on. Everything
// provider-specific — where the authorize endpoint is, how the token response is shaped, whether
// scopes are separated by spaces or commas — is data in `provider.ts`, so this file is the same
// nine steps whichever integration is being connected.
//
// THE TOKENS NEVER TOUCH A ROW, A LOG, OR A RESPONSE. They come back from the token endpoint,
// go into `SecretStore` under the names the connector spec declares, and the only thing that
// survives the call is those names on the connection row. `SecretStore` has no `get`, so there
// is no method anything above this could call to get one back out — a run's environment is the
// single exit, and it is `getForRun`. That is the same rule provider keys follow, applied to a
// credential that belongs to somebody's actual mailbox rather than to their API account.
//
// A FAILURE IS CLASSIFIED, NEVER SWALLOWED, and the classification decides behaviour rather than
// just wording. `denied` is a person clicking Cancel, which is not an error and must not be
// reported as one. `reauth_required` is the provider saying the grant is gone, which is terminal
// until a human reconnects — retrying it is how an account gets locked out. `transient` is worth
// another go. `config` is our own OAuth app being wrong, which is nobody's fault but ours and
// should say so rather than blaming the user's account. Same posture as
// `mcpClient.classifyDiscoveryFailure` and `evalRunner.isTransientFailure`: match known markers,
// and let the DEFAULT be the conservative answer.
//
// EVERY WAIT IS BOUNDED. A token endpoint that never answers is indistinguishable from a hostile
// one holding the connection open, and either way "connect Gmail" must not hang a request handler
// forever. The same reasoning, and roughly the same number, as the MCP client's per-request
// ceiling.

import type { OAuthRepository, OAuthConnectionRow } from "../db/repositories/oauth.ts";
import type { SecretStore } from "../secrets/secretStore.ts";
import type { TenantContext } from "../db/tenant.ts";
import { newRequestId } from "../db/tenant.ts";
import { hashState, newPkce, newState, OAUTH_STATE_TTL_S } from "./pkce.ts";
import {
  returnUrl,
  unconfiguredReason,
  type OAuthClientConfig,
  type OAuthConnectorSpec,
  type OAuthProvider,
} from "./provider.ts";

/** How long the token endpoint gets. See the header on why there is a number at all. */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/**
 * What every provider's token response is read into.
 *
 * `scopes` is what was GRANTED. A provider may return fewer than were asked for — Google's
 * incremental consent lets somebody tick one box and not the other — and recording the request
 * instead would have the panel claim an agent can create drafts when the user agreed only to
 * reading.
 */
export interface TokenGrant {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds, as the provider reports it. Null means "does not expire" — Slack's bot tokens. */
  expiresInS: number | null;
  scopes: string[];
  accountId: string | null;
  /** Something a person recognises: an email address, a Slack team name. Display only. */
  accountLabel: string | null;
}

export type OAuthFailureKind = "denied" | "reauth_required" | "transient" | "config" | "error";

export class OAuthError extends Error {
  constructor(
    readonly kind: OAuthFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

/** The one network call this module makes. Injected so a suite needs no provider and no network. */
export type TokenTransport = (
  url: string,
  body: URLSearchParams,
  headers: Record<string, string>,
) => Promise<{ status: number; body: unknown }>;

export interface OAuthServiceOptions {
  repo: OAuthRepository;
  secrets: SecretStore;
  providers: OAuthProvider[];
  /** Read per call rather than captured — see provider.ts's note on the same rule. */
  config: (providerId: string) => OAuthClientConfig | null;
  transport?: TokenTransport;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** For the audit row a completed or refused flow writes. Optional; absent means no audit. */
  audit?: (ctx: TenantContext, action: string, detail: Record<string, unknown>) => Promise<void>;
}

export interface BeginResult {
  /** Where the browser must go. Contains the state and the PKCE challenge, nothing secret. */
  url: string;
  expiresAt: number;
}

export interface CompleteResult {
  connection: OAuthConnectionRow;
  workspaceId: string;
  /** Where to send the browser afterwards. Always ours — see provider.returnUrl. */
  redirectTo: string;
  /**
   * Scopes we asked for and did not get.
   *
   * Not an error: a partial grant is a legitimate user choice, and refusing it would mean somebody
   * who is happy to let an agent READ their mail but not draft replies cannot connect at all. It
   * is surfaced so the panel can say which tools will fail before one does.
   */
  missingScopes: string[];
}

export class OAuthService {
  private readonly transport: TokenTransport;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly opts: OAuthServiceOptions) {
    this.transport = opts.transport ?? realTransport;
    this.now = opts.now ?? (() => Date.now());
    this.env = opts.env ?? process.env;
  }

  /** Every connector any registered provider can satisfy. What the connections panel lists. */
  connectors(): { provider: OAuthProvider; spec: OAuthConnectorSpec }[] {
    return this.opts.providers.flatMap((provider) =>
      provider.connectors.map((spec) => ({ provider, spec })),
    );
  }

  /** Which provider owns a connector, or null for one nothing offers over OAuth. */
  find(connectorId: string): { provider: OAuthProvider; spec: OAuthConnectorSpec } | null {
    return this.connectors().find((c) => c.spec.connectorId === connectorId) ?? null;
  }

  /** Whether this deployment could actually run the flow. False locally, and that is fine. */
  configured(connectorId: string): boolean {
    const found = this.find(connectorId);
    return found ? this.opts.config(found.provider.id) !== null : false;
  }

  /**
   * Open a flow and return the URL the browser must visit.
   *
   * The state row is written BEFORE the URL is handed out, and the ordering is the point: a
   * callback that arrives for a flow nothing recorded is refused, so a URL that escaped without
   * its row is a URL that cannot complete. The other order would leave a window in which a
   * genuine callback resolves to nothing and the user is told their consent failed.
   */
  async begin(
    ctx: TenantContext,
    connectorId: string,
    opts: { returnTo?: string | null } = {},
  ): Promise<BeginResult> {
    const found = this.find(connectorId);
    if (!found) throw new OAuthError("config", `${connectorId} is not a connector you connect with OAuth`);
    const { provider, spec } = found;

    const config = this.opts.config(provider.id);
    if (!config) throw new OAuthError("config", unconfiguredReason(provider.id));

    const pkce = newPkce();
    const state = newState();
    await this.opts.repo.beginFlow(ctx, hashState(state), {
      provider: provider.id,
      connectorId,
      codeVerifier: pkce.verifier,
      redirectUri: config.redirectUri,
      scopes: spec.scopes,
      returnTo: opts.returnTo ?? null,
    });

    const url = new URL(provider.authorizeUrl);
    const params = url.searchParams;
    params.set("response_type", "code");
    params.set("client_id", config.clientId);
    params.set("redirect_uri", config.redirectUri);
    params.set("scope", spec.scopes.join(provider.scopeSeparator ?? " "));
    params.set("state", state);
    params.set("code_challenge", pkce.challenge);
    params.set("code_challenge_method", pkce.method);
    for (const [k, v] of Object.entries(provider.authorizeParams ?? {})) params.set(k, v);

    return { url: url.toString(), expiresAt: this.now() + OAUTH_STATE_TTL_S * 1000 };
  }

  /**
   * Finish a flow the provider redirected back to us.
   *
   * The state is consumed FIRST, before the `error` parameter is even looked at, and that is
   * deliberate: a cancelled flow must burn its row too, or a state whose consent was declined
   * stays live for ten minutes waiting for somebody to present it with a code.
   */
  async complete(params: {
    state?: string | null;
    code?: string | null;
    error?: string | null;
    errorDescription?: string | null;
  }): Promise<CompleteResult> {
    const raw = typeof params.state === "string" ? params.state : "";
    const flow = await this.opts.repo.consumeState(raw);
    if (!flow) {
      // One message for expired, replayed, forged and unknown alike. Telling a caller which of
      // the four it was tells whoever is probing the callback how close they are.
      throw new OAuthError("error", "that authorisation link has expired or has already been used");
    }

    const redirectTo = returnUrl(flow.returnTo, this.env);
    // Attribution, not authorisation. The decision was made at `begin`, where a real member with
    // a real capability asked for it; this context exists so the connection row can name who,
    // and so the vault write is scoped to the workspace the STATE ROW named rather than to
    // anything the redirect claimed.
    const ctx: TenantContext = {
      workspaceId: flow.workspaceId,
      actorUserId: flow.userId,
      role: "system",
      requestId: newRequestId(),
    };

    if (params.error) {
      const denied = /access_denied|user_denied|consent_required|cancel/i.test(params.error);
      await this.opts.audit?.(ctx, "connector.oauth_refused", {
        connector: flow.connectorId,
        reason: params.error,
      });
      throw new OAuthError(
        denied ? "denied" : "error",
        denied
          ? "the authorisation was declined, so nothing was connected"
          : `${flow.provider} refused the authorisation: ${params.errorDescription ?? params.error}`,
      );
    }

    const code = typeof params.code === "string" ? params.code.trim() : "";
    if (!code) throw new OAuthError("error", "the provider redirected back without an authorization code");

    const provider = this.opts.providers.find((p) => p.id === flow.provider);
    const spec = provider?.connectors.find((c) => c.connectorId === flow.connectorId);
    if (!provider || !spec) {
      throw new OAuthError("config", `this server no longer offers the ${flow.connectorId} connector`);
    }
    const config = this.opts.config(provider.id);
    if (!config) throw new OAuthError("config", unconfiguredReason(provider.id));

    const grant = await this.exchange(provider, config, {
      grant_type: "authorization_code",
      code,
      // THE ONE FROM THE FLOW, not the one this process would compute now. A deployment whose
      // redirect base changed between the authorize and the exchange has to present the value
      // the provider saw, or the exchange fails with an error naming neither.
      redirect_uri: flow.redirectUri,
      code_verifier: flow.codeVerifier,
    });

    const connection = await this.store(ctx, spec, provider, grant);
    await this.opts.audit?.(ctx, "connector.connected", {
      connector: spec.connectorId,
      provider: provider.id,
      account: grant.accountLabel,
      scopes: grant.scopes,
    });

    // Compared case-sensitively and as whole strings. Google returns the full URL form it was
    // asked for, Slack returns its own short names, and either way a scope is an opaque
    // identifier rather than something to normalise — a "helpful" comparison is how
    // `gmail.readonly` would be reported as satisfying `gmail.compose`.
    const granted = new Set(grant.scopes);
    return {
      connection,
      workspaceId: flow.workspaceId,
      redirectTo,
      missingScopes: granted.size === 0 ? [] : spec.scopes.filter((s) => !granted.has(s)),
    };
  }

  /**
   * Put a grant's credentials in the vault and record the connection.
   *
   * The secrets are written BEFORE the row, so a crash in between leaves a credential nothing
   * points at rather than a row pointing at a credential that is not there. The first is invisible
   * and harmless — the next connect overwrites it under the same name; the second is a connection
   * that reports itself active and hands a run nothing.
   */
  private async store(
    ctx: TenantContext,
    spec: OAuthConnectorSpec,
    provider: OAuthProvider,
    grant: TokenGrant,
  ): Promise<OAuthConnectionRow> {
    const written = await this.opts.secrets.set(ctx, spec.accessSecretName, grant.accessToken);
    if (!written.ok) {
      throw new OAuthError("error", written.warning ?? "that credential could not be stored");
    }
    if (spec.refreshSecretName && grant.refreshToken) {
      const refresh = await this.opts.secrets.set(ctx, spec.refreshSecretName, grant.refreshToken);
      if (!refresh.ok) {
        throw new OAuthError("error", refresh.warning ?? "that refresh token could not be stored");
      }
    }
    return this.opts.repo.upsert(ctx, {
      provider: provider.id,
      connectorId: spec.connectorId,
      connectedBy: ctx.actorUserId,
      externalAccountId: grant.accountId,
      externalAccountLabel: grant.accountLabel,
      scopes: grant.scopes,
      accessSecretName: spec.accessSecretName,
      refreshSecretName: spec.refreshSecretName ?? null,
      accessExpiresAt: expiryFrom(grant.expiresInS, this.now()),
    });
  }

  /**
   * One call to a token endpoint, for both the initial exchange and every later refresh.
   *
   * Shared rather than duplicated because the two differ by exactly one form field, and the
   * things that are easy to get wrong — client authentication, the timeout, reading an error out
   * of a 200 body — are identical and must stay that way.
   */
  async exchange(
    provider: OAuthProvider,
    config: OAuthClientConfig,
    fields: Record<string, string>,
  ): Promise<TokenGrant> {
    const body = new URLSearchParams({
      ...fields,
      // In the BODY rather than as HTTP Basic. Both are permitted by RFC 6749 §2.3.1, providers
      // disagree about which they accept, and every provider integrated here takes the body form.
      // It is also the only one that cannot put a secret in a proxy's `Authorization` log line.
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

    let answer: { status: number; body: unknown };
    try {
      answer = await this.transport(provider.tokenUrl, body, {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      });
    } catch (err) {
      // A network failure, not a refusal. Worth retrying, and it must not be mistaken for the
      // provider having revoked anything.
      throw new OAuthError("transient", `could not reach ${provider.label}: ${(err as Error).message}`);
    }

    // A 200 that is really an error. See OAuthProvider.errorInBody — Slack's whole error channel.
    const inBody = provider.errorInBody?.(answer.body) ?? null;
    if (answer.status >= 400 || inBody) {
      throw classifyTokenFailure(provider, answer.status, answer.body, inBody);
    }

    const grant = provider.readTokenResponse(answer.body);
    if (!grant || !grant.accessToken) {
      // The body parsed and did not contain a token. Not transient: the same request will produce
      // the same nothing, and reporting it as a network blip sends somebody to check their wifi.
      throw new OAuthError("error", `${provider.label} answered without an access token`);
    }
    return grant;
  }
}

/**
 * Drop everything that should never be rendered, keeping the words.
 *
 * A provider's error text is stored on the connection row, shown in the connections panel, and
 * written to a log line — the same three destinations `mcpClient.clean` exists for, and the same
 * reasoning: an ANSI escape in that string repaints somebody's terminal, and a newline in it
 * turns one log line into two, the second of which reads like a message this codebase wrote.
 *
 * Built from character codes rather than a regex literal on purpose. A range like `\x00-\x1f`
 * written into source is one accidental paste away from being an actual control character IN the
 * source file, which is invisible in every diff view and matches nothing.
 */
export function stripControl(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    out += control ? " " : ch;
  }
  return out;
}

/** ISO-8601 for `expires_in` seconds from now, or null when the provider says it does not expire. */
export function expiryFrom(expiresInS: number | null, nowMs: number): string | null {
  if (expiresInS === null || !Number.isFinite(expiresInS) || expiresInS <= 0) return null;
  return new Date(nowMs + expiresInS * 1000).toISOString();
}

/**
 * Which of the four kinds a token-endpoint failure is.
 *
 * `invalid_grant` is the one that matters and the one that is easy to misread. It means the code
 * or refresh token is no longer valid — revoked in the provider's console, expired by policy,
 * invalidated by a password change — and it is the single signal that a connection needs a human.
 * Treating it as transient produces a refresh loop against somebody's account, which is how the
 * account gets rate-limited and then locked, and it is the specific failure this classification
 * exists to prevent.
 */
export function classifyTokenFailure(
  provider: OAuthProvider,
  status: number,
  body: unknown,
  inBody: string | null,
): OAuthError {
  const parsed = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = inBody ?? (typeof parsed["error"] === "string" ? parsed["error"] : "");
  const described =
    typeof parsed["error_description"] === "string" ? (parsed["error_description"] as string) : "";
  // Bounded and stripped, for the same reason mcpClient bounds `serverInfo`: this text is stored
  // on the connection row, rendered in the panel, and written to a log line.
  const detail = stripControl(`${code}${described ? `: ${described}` : ""}`).slice(0, 300);

  if (/invalid_grant|token_revoked|account_inactive|invalid_auth|expired/i.test(code)) {
    return new OAuthError("reauth_required", `${provider.label} says this authorisation is no longer valid (${detail})`);
  }
  if (/invalid_client|unauthorized_client|invalid_redirect_uri|bad_redirect_uri|invalid_scope/i.test(code)) {
    // OURS, not theirs. A misconfigured OAuth app is our problem and the message says so rather
    // than telling a user to check an account that is perfectly fine.
    return new OAuthError("config", `this deployment's ${provider.label} OAuth app is misconfigured (${detail})`);
  }
  if (status === 429 || status >= 500) {
    return new OAuthError("transient", `${provider.label} is not answering right now (${status})`);
  }
  return new OAuthError("error", `${provider.label} refused the exchange (${detail || status})`);
}

/**
 * The real network call. Bounded, and it never puts the request body anywhere it could be logged.
 *
 * A non-JSON answer is read as text and reported as one rather than throwing a parse error:
 * a token endpoint behind a captive portal or a broken gateway answers with HTML, and
 * "Unexpected token < in JSON" is a worse thing to show somebody than the status it came with.
 */
const realTransport: TokenTransport = async (url, body, headers) => {
  const signal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
  const res = await fetch(url, { method: "POST", body, headers, signal });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: res.status, body: { error: "non_json_response", error_description: text.slice(0, 200) } };
  }
};
