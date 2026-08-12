// Keeping an access token alive, in one place, with one refresh in flight per connection.
//
// THE BUG THIS FILE EXISTS TO PREVENT, stated plainly because it is not obvious and it is
// expensive. A workspace fans out an eval: twelve runs start within a second, each needs a Gmail
// token, each finds the same connection with the same access token thirty seconds from expiry,
// and each refreshes it. With rotation enabled — Google's for some app configurations, and every
// provider that follows the OAuth 2.1 draft — the FIRST refresh invalidates the refresh token and
// returns a new one. The other eleven then present a refresh token the provider has already
// retired, and a provider seeing a retired refresh token does not answer "try again": it treats
// reuse as evidence the token was stolen and REVOKES THE WHOLE GRANT. Twelve concurrent runs
// therefore disconnect the integration and require a human to click Connect again.
//
// So there is one refresh per connection at a time, and everybody else waits for its answer. Not
// "checks again afterwards" — WAITS FOR THE SAME PROMISE, so the second caller cannot observe a
// window in which the first has retired the old token and not yet written the new one.
//
// THE MUTEX IS PER PROCESS, AND THAT IS HONEST RATHER THAN COMPLETE. Two API replicas can still
// refresh the same connection simultaneously, and closing that needs the distributed lock Session
// 5 already built for the queue. What makes the per-process version worth having on its own is
// the shape of the traffic: a fan-out is one workspace's dispatch, and a dispatcher hands its
// jobs to workers rather than scattering them, so the overwhelming majority of concurrent refresh
// attempts for one connection happen inside one process. The remainder is bounded by the
// proactive window below, which means a cross-replica race needs two replicas to touch the same
// connection inside the same five minutes AND the provider to rotate. Recorded here as a known
// edge rather than left to be discovered.
//
// PROACTIVE, NOT REACTIVE. A token is refreshed while it still works, not after a 401. Refreshing
// on failure means every expiry costs one failed provider call inside somebody's run — a red
// `tool_call` step in a trace that is supposed to mean something went wrong — and it means the
// retry happens in the least convenient place, mid-graph, with a model waiting.
//
// AND A REJECTED REFRESH IS TERMINAL. `invalid_grant` means the grant is gone: revoked in the
// provider's console, expired by policy, invalidated by a password change. Retrying it produces a
// loop against somebody's real account, which is how the account gets rate-limited and then
// locked. The connection is marked `reauth_required` and left alone until a human reconnects,
// which is the same fail-closed posture the MCP confirmation gate takes when it times out.

import type { OAuthRepository, OAuthConnectionRow } from "../db/repositories/oauth.ts";
import type { SecretStore } from "../secrets/secretStore.ts";
import type { TenantContext } from "../db/tenant.ts";
import type { OAuthClientConfig, OAuthProvider } from "./provider.ts";
import { unconfiguredReason } from "./provider.ts";
import { expiryFrom, OAuthError, type OAuthService } from "./service.ts";

/**
 * How long before expiry a token is considered due.
 *
 * Five minutes, and the number is chosen from what happens on either side of it. Too small and a
 * long-running graph is handed a token that expires mid-run — the sandbox has no way to ask for
 * another, by design, because the control plane is the only thing that holds a refresh token. Too
 * large and every connection is refreshed constantly, which for a rotating provider means
 * constantly retiring refresh tokens for no reason. Five minutes comfortably exceeds the wall
 * clock of a normal run's startup and is a rounding error against Google's hour.
 */
export const REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * The extra life a run is given beyond its own deadline.
 *
 * A token injected into a sandbox should outlast the run and not much more, so a value that leaks
 * — out of a log the agent wrote, out of an exception it printed, out of a request it made to
 * somewhere it should not have — expires fast. This is the slack on top of the run's wall-clock
 * limit, not the lifetime itself: the lifetime is whatever the provider grants, and nothing here
 * can shorten it.
 */
export const RUN_TOKEN_GRACE_MS = 10 * 60 * 1000;

export interface RefresherOptions {
  repo: OAuthRepository;
  secrets: SecretStore;
  providers: OAuthProvider[];
  config: (providerId: string) => OAuthClientConfig | null;
  /** The exchange, shared with the initial flow so client auth and the timeout cannot drift. */
  service: Pick<OAuthService, "exchange">;
  now?: () => number;
  /** Told when a connection needs a human. The relay's broadcast, in the app. */
  onReauthRequired?: (ctx: TenantContext, connection: OAuthConnectionRow, reason: string) => void;
}

/** What a caller gets back. Never the token itself unless it asked for one to inject. */
export interface FreshToken {
  connection: OAuthConnectionRow;
  /** The usable access token. The ONLY method here that returns one, for the one caller that must. */
  accessToken: string;
}

export class TokenRefresher {
  /**
   * One in-flight refresh per connection id.
   *
   * Keyed by the connection's uuid rather than by (workspace, connector), because the uuid is
   * what a row IS: a reconnect replaces the row and gets a new id, so an entry left over from
   * before a reconnect cannot be handed to a caller asking about the connection that replaced it.
   *
   * The promise is removed in a `finally`, so a rejected refresh does not wedge the connection
   * forever — the next caller retries rather than awaiting a promise that already failed. What it
   * does NOT do is retry automatically: see the header on why a rejection is usually terminal.
   */
  private inFlight = new Map<string, Promise<OAuthConnectionRow>>();

  private readonly now: () => number;

  constructor(private readonly opts: RefresherOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Whether this row's access token is close enough to expiry to be worth replacing. */
  isDue(connection: OAuthConnectionRow, horizonMs = REFRESH_WINDOW_MS): boolean {
    // No expiry means it does not expire — Slack's bot tokens. Never due, and treating a null as
    // "expired long ago" would refresh a live token on every single call.
    if (!connection.access_expires_at) return false;
    const at = Date.parse(connection.access_expires_at);
    if (!Number.isFinite(at)) return false;
    return at - this.now() <= horizonMs;
  }

  /**
   * A usable token for this connector, refreshing first if one is due.
   *
   * THE ONE PLACE A CONNECTOR CREDENTIAL LEAVES THE VAULT, and its caller is the thing that
   * assembles a run's environment. Everything else asks `connectionFor` and gets a row.
   *
   * `horizonMs` lets the run path ask for more life than the background sweep does: a run wants a
   * token that outlasts it, and a token with four minutes left is fine for a dashboard and not
   * for a graph that will still be running in twenty.
   */
  async tokenForRun(
    ctx: TenantContext,
    connectorId: string,
    opts: { horizonMs?: number } = {},
  ): Promise<FreshToken | null> {
    let connection = await this.opts.repo.usable(ctx, connectorId);
    if (!connection) return null;

    if (this.isDue(connection, opts.horizonMs ?? REFRESH_WINDOW_MS)) {
      try {
        connection = await this.refresh(ctx, connection);
      } catch (err) {
        // A refresh that failed does not have to mean no token. A `transient` failure leaves the
        // CURRENT token in place and it may well still be valid for the few minutes that remain,
        // which is a better outcome for a run than refusing to start. A `reauth_required` failure
        // has already marked the row, and `usable` below is what turns that into a refusal.
        if ((err as OAuthError).kind === "reauth_required") return null;
        connection = (await this.opts.repo.usable(ctx, connectorId)) ?? connection;
      }
    }

    const env = await this.opts.secrets.getForPlatformCall(ctx, [connection.access_secret_name]);
    const accessToken = env[connection.access_secret_name];
    if (!accessToken) {
      // The row says connected and the vault has nothing. Recoverable only by reconnecting, and
      // saying so beats handing a run an empty string that becomes a 401 from Google.
      await this.opts.repo.markReauthRequired(ctx, connection.id, "the stored credential is missing");
      this.opts.onReauthRequired?.(ctx, connection, "the stored credential is missing");
      return null;
    }
    return { connection, accessToken };
  }

  /**
   * Refresh one connection, coalescing concurrent callers onto a single exchange.
   *
   * The map is read and written synchronously around the `async` body, so two callers arriving in
   * the same tick cannot both miss. That is the whole mutex: JavaScript's single thread does the
   * locking, and the only thing this has to get right is not awaiting anything between the lookup
   * and the insert.
   */
  async refresh(ctx: TenantContext, connection: OAuthConnectionRow): Promise<OAuthConnectionRow> {
    const existing = this.inFlight.get(connection.id);
    if (existing) return existing;

    const attempt = this.doRefresh(ctx, connection).finally(() => {
      this.inFlight.delete(connection.id);
    });
    this.inFlight.set(connection.id, attempt);
    return attempt;
  }

  /** How many refreshes this process currently has in flight. For the suite, and for a metric. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  private async doRefresh(ctx: TenantContext, connection: OAuthConnectionRow): Promise<OAuthConnectionRow> {
    const provider = this.opts.providers.find((p) => p.id === connection.provider);
    if (!provider) throw new OAuthError("config", `this server no longer knows the ${connection.provider} provider`);
    if (!connection.refresh_secret_name) {
      // Nothing to refresh WITH, which for Slack is the normal case rather than a fault: a bot
      // token has no expiry and no refresh token, so the correct behaviour is to hand the row
      // back unchanged rather than to invent a failure.
      return connection;
    }
    const config = this.opts.config(provider.id);
    if (!config) throw new OAuthError("config", unconfiguredReason(provider.id));

    const stored = await this.opts.secrets.getForPlatformCall(ctx, [connection.refresh_secret_name]);
    const refreshToken = stored[connection.refresh_secret_name];
    if (!refreshToken) {
      const reason = "there is no stored refresh token for this connection";
      await this.opts.repo.markReauthRequired(ctx, connection.id, reason);
      this.opts.onReauthRequired?.(ctx, connection, reason);
      throw new OAuthError("reauth_required", reason);
    }

    let grant;
    try {
      grant = await this.opts.service.exchange(provider, config, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
    } catch (err) {
      const failure = err instanceof OAuthError ? err : new OAuthError("error", String(err));
      if (failure.kind === "reauth_required") {
        // TERMINAL. See the header: retrying a rejected grant is how an account gets locked.
        await this.opts.repo.markReauthRequired(ctx, connection.id, failure.message);
        this.opts.onReauthRequired?.(ctx, connection, failure.message);
      }
      throw failure;
    }

    // THE ORDER HERE IS THE WHOLE OF THE CRASH SAFETY. The new access token is written first, then
    // the rotated refresh token if there is one, then the row. A crash after the first leaves a
    // fresh token the row understates the life of — harmless, it is refreshed again. A crash
    // between the second and the row leaves a rotated refresh token stored and an expiry that is
    // merely stale. The order that would hurt is writing the row first, which would claim a life
    // for a token that was never stored.
    const wrote = await this.opts.secrets.set(ctx, connection.access_secret_name, grant.accessToken);
    if (!wrote.ok) throw new OAuthError("error", wrote.warning ?? "the refreshed credential could not be stored");

    // ROTATION. A provider that hands back a NEW refresh token has retired the old one, and the
    // new one must land under the same name — a second name would be a credential nothing reads
    // while the thing everything reads is already dead. A provider that hands back nothing has
    // rotated nothing, and overwriting the stored one with a null would destroy a working
    // connection: Google's ordinary refresh response has no `refresh_token` field at all.
    if (grant.refreshToken && grant.refreshToken !== refreshToken) {
      const rotated = await this.opts.secrets.set(ctx, connection.refresh_secret_name, grant.refreshToken);
      if (!rotated.ok) {
        throw new OAuthError("error", rotated.warning ?? "the rotated refresh token could not be stored");
      }
    }

    await this.opts.repo.recordRefresh(ctx, connection.id, expiryFrom(grant.expiresInS, this.now()));
    const updated = await this.opts.repo.forConnector(ctx, connection.connector_id);
    return updated ?? connection;
  }
}
