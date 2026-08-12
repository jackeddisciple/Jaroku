// The connections a workspace has made, and the flow rows that make one.
//
// Two responsibilities in one file because they are two ends of one operation, and splitting
// them would mean a caller holding both to do anything: `begin` writes a state row, the callback
// `consume`s it and `upsert`s the connection it produced.
//
// NOTHING HERE EVER HOLDS A TOKEN. The connection row records the NAMES its credentials are
// stored under in `SecretStore`, which is the same shape `mcp_servers.auth_env_key` has and the
// same one `deployments.env_keys` has. There is no column a value would fit in, so there is no
// query in this file that could return one.
//
// THE STATE ROW IS CONSUMED BY A DELETE, AND THE DELETE IS THE DECISION. Not "read it, check it,
// delete it" — three statements, and between the first and the third a second request on another
// replica reads the same row and is also admitted. The transaction deletes by primary key and
// reads how many rows it touched: the row is either there and now ours, or it is not. Lifted
// verbatim from `DbTicketStore.consume`, because it is the same problem and a second spelling of
// one solution is how the two eventually disagree.

import { randomUUID } from "node:crypto";
import { jsonFromColumn, type Db, type Queryable } from "../db.ts";
import type { SystemContext, TenantContext } from "../tenant.ts";
import { hashState, looksLikeState, OAUTH_STATE_TTL_S } from "../../oauth/pkce.ts";

export type ConnectionStatus = "active" | "reauth_required" | "revoked";

export interface OAuthConnectionRow {
  id: string;
  provider: string;
  connector_id: string;
  connected_by: string | null;
  external_account_id: string | null;
  external_account_label: string | null;
  /** WHAT WAS GRANTED. Never what was asked for — see migration 026. */
  scopes: string[];
  status: ConnectionStatus;
  /** The name `SecretStore` holds the access token under. Never the token. */
  access_secret_name: string;
  /** Null for a provider that issues none. Slack's bot tokens do not rotate. */
  refresh_secret_name: string | null;
  access_expires_at: string | null;
  last_refreshed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface UpsertConnectionInput {
  provider: string;
  connectorId: string;
  connectedBy?: string | null;
  externalAccountId?: string | null;
  externalAccountLabel?: string | null;
  scopes: string[];
  accessSecretName: string;
  refreshSecretName?: string | null;
  accessExpiresAt?: string | null;
}

export interface BeginFlowInput {
  provider: string;
  connectorId: string;
  /** Held until the exchange. See oauth/pkce.ts on why this is not a vault credential. */
  codeVerifier: string;
  redirectUri: string;
  /** What we ASKED for. The granted set lands on the connection. */
  scopes: string[];
  /** Already validated against the origin allowlist by the caller. */
  returnTo?: string | null;
  ttlS?: number;
}

/** What a consumed state row resolves to. The scope, which is why the callback needs no other. */
export interface ConsumedState {
  workspaceId: string;
  userId: string | null;
  provider: string;
  connectorId: string;
  codeVerifier: string;
  redirectUri: string;
  scopes: string[];
  returnTo: string | null;
}

const CONNECTION_COLUMNS = `id, provider, connector_id, connected_by, external_account_id,
                            external_account_label, scopes, status, access_secret_name,
                            refresh_secret_name, access_expires_at, last_refreshed_at,
                            last_error, created_at, updated_at, revoked_at`;

export class OAuthRepository {
  constructor(
    private db: Db,
    private now: () => number = () => Date.now(),
  ) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  private hydrate(row: Record<string, unknown>): OAuthConnectionRow {
    const scopes = jsonFromColumn(this.db.dialect, row["scopes"]);
    return {
      id: String(row["id"]),
      provider: String(row["provider"]),
      connector_id: String(row["connector_id"]),
      connected_by: (row["connected_by"] as string | null) ?? null,
      external_account_id: (row["external_account_id"] as string | null) ?? null,
      external_account_label: (row["external_account_label"] as string | null) ?? null,
      scopes: Array.isArray(scopes) ? (scopes as string[]) : [],
      status: (row["status"] as ConnectionStatus) ?? "active",
      access_secret_name: String(row["access_secret_name"]),
      refresh_secret_name: (row["refresh_secret_name"] as string | null) ?? null,
      access_expires_at: (row["access_expires_at"] as string | null) ?? null,
      last_refreshed_at: (row["last_refreshed_at"] as string | null) ?? null,
      last_error: (row["last_error"] as string | null) ?? null,
      created_at: String(row["created_at"]),
      updated_at: String(row["updated_at"]),
      revoked_at: (row["revoked_at"] as string | null) ?? null,
    };
  }

  // --- connections ----------------------------------------------------------------------------

  /** Every connection this workspace has, revoked ones included. The panel renders the lot. */
  async list(ctx: TenantContext): Promise<OAuthConnectionRow[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${CONNECTION_COLUMNS} FROM oauth_connections
        WHERE workspace_id = ? ORDER BY connector_id ASC`,
      [ctx.workspaceId],
    );
    return rows.map((r) => this.hydrate(r));
  }

  /**
   * This workspace's connection for one connector, in any state.
   *
   * Deliberately not filtered to `active`. A caller that needs a usable connection has to say so
   * — see `usable` — because "there is no connection" and "the connection needs reauthorising"
   * send a user to two different places, and a lookup that collapsed them would make the second
   * one unreportable.
   */
  async forConnector(ctx: TenantContext, connectorId: string): Promise<OAuthConnectionRow | null> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${CONNECTION_COLUMNS} FROM oauth_connections
        WHERE workspace_id = ? AND connector_id = ?`,
      [ctx.workspaceId, connectorId],
    );
    return row ? this.hydrate(row) : null;
  }

  /** The same lookup, narrowed to a connection a run could actually be given a token from. */
  async usable(ctx: TenantContext, connectorId: string): Promise<OAuthConnectionRow | null> {
    const row = await this.forConnector(ctx, connectorId);
    return row && row.status === "active" ? row : null;
  }

  /**
   * Record a completed flow, replacing whatever this workspace had for the connector.
   *
   * Replacing rather than adding, per `UNIQUE (workspace_id, connector_id)` — a reconnect is a
   * replacement, and the panel says so. `status` is reset to active on every upsert deliberately:
   * a workspace that has just finished a consent screen is connected, whatever the row said a
   * moment ago, and leaving a stale `reauth_required` would make a successful reconnect look
   * like a failed one.
   *
   * `created_at` survives, so a re-authorisation does not reshuffle the panel — the same courtesy
   * `McpStore.upsertServer` extends to a re-discovery.
   */
  async upsert(ctx: TenantContext, input: UpsertConnectionInput): Promise<OAuthConnectionRow> {
    const now = new Date(this.now()).toISOString();
    await this.q(ctx).run(
      `INSERT INTO oauth_connections
         (id, workspace_id, provider, connector_id, connected_by, external_account_id,
          external_account_label, scopes, status, access_secret_name, refresh_secret_name,
          access_expires_at, last_refreshed_at, last_error, created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, NULL, ?, ?, NULL)
       ON CONFLICT (workspace_id, connector_id) DO UPDATE SET
         provider               = excluded.provider,
         connected_by           = excluded.connected_by,
         external_account_id    = excluded.external_account_id,
         external_account_label = excluded.external_account_label,
         scopes                 = excluded.scopes,
         status                 = 'active',
         access_secret_name     = excluded.access_secret_name,
         refresh_secret_name    = excluded.refresh_secret_name,
         access_expires_at      = excluded.access_expires_at,
         -- NULL, not the current time. A fresh grant has never been REFRESHED: the field records
         -- when a refresh token was last exchanged for a new access token, and stamping it at
         -- connect time would make "last refreshed" mean "last touched" — a different and less
         -- useful fact. A reconnect is a new grant rather than a refresh, so it clears it too.
         last_refreshed_at      = NULL,
         last_error             = NULL,
         updated_at             = excluded.updated_at,
         revoked_at             = NULL`,
      [
        randomUUID(),
        ctx.workspaceId,
        input.provider,
        input.connectorId,
        input.connectedBy ?? null,
        input.externalAccountId ?? null,
        input.externalAccountLabel ?? null,
        JSON.stringify(input.scopes),
        input.accessSecretName,
        input.refreshSecretName ?? null,
        input.accessExpiresAt ?? null,
        now,
        now,
      ],
    );
    const row = await this.forConnector(ctx, input.connectorId);
    if (!row) throw new Error(`the ${input.connectorId} connection did not persist`);
    return row;
  }

  /**
   * Record a new access token's expiry after a refresh.
   *
   * Only the expiry and the timestamp, because the token itself went to the vault under a name
   * that has not changed — which is the point of storing names rather than values: a rotation
   * writes one row in one place, and every reader keeps reading the same name.
   */
  async recordRefresh(ctx: TenantContext, id: string, accessExpiresAt: string | null): Promise<void> {
    const now = new Date(this.now()).toISOString();
    await this.q(ctx).run(
      `UPDATE oauth_connections
          SET access_expires_at = ?, last_refreshed_at = ?, last_error = NULL,
              status = 'active', updated_at = ?
        WHERE workspace_id = ? AND id = ?`,
      [accessExpiresAt, now, now, ctx.workspaceId, id],
    );
  }

  /**
   * Mark a connection unusable until a human reconnects.
   *
   * NOT AN ERROR TO RETRY OUT OF. A provider that rejected our refresh has told us the grant is
   * gone — revoked in their console, expired by policy, invalidated by a password change — and
   * hammering it produces a lockout on the user's own account. The status is terminal by design;
   * the way out is the connections panel, which is why it renders a banner rather than a spinner.
   */
  async markReauthRequired(ctx: TenantContext, id: string, reason: string): Promise<void> {
    const now = new Date(this.now()).toISOString();
    await this.q(ctx).run(
      `UPDATE oauth_connections SET status = 'reauth_required', last_error = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ?`,
      [reason.slice(0, 500), now, ctx.workspaceId, id],
    );
  }

  /**
   * Mark a connection revoked, keeping the row.
   *
   * Kept rather than deleted so the audit trail has something to point at, and so the panel can
   * say "disconnected" rather than forgetting the integration ever existed. The credentials
   * themselves are deleted from the vault by the caller — this records that they were.
   */
  async markRevoked(ctx: TenantContext, id: string): Promise<void> {
    const now = new Date(this.now()).toISOString();
    await this.q(ctx).run(
      `UPDATE oauth_connections SET status = 'revoked', revoked_at = ?, access_expires_at = NULL,
              updated_at = ?
        WHERE workspace_id = ? AND id = ?`,
      [now, now, ctx.workspaceId, id],
    );
  }

  /**
   * The same, with a note about what happened at the far end.
   *
   * Separate from `markRevoked` rather than a parameter on it, because the common case has
   * nothing to say and a method whose last argument is usually null invites callers to pass one
   * they have not thought about. This is the exception: the provider could not be told, the
   * credential is gone from here anyway, and the user needs to know to check their own account's
   * connected apps. See oauth/revoke.ts.
   */
  async markRevokedWithNote(ctx: TenantContext, id: string, note: string): Promise<void> {
    await this.q(ctx).run(
      `UPDATE oauth_connections SET last_error = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ?`,
      [note.slice(0, 500), new Date(this.now()).toISOString(), ctx.workspaceId, id],
    );
  }

  // --- flows ----------------------------------------------------------------------------------

  /**
   * Open a flow. Returns the digest that was stored; the raw state is the caller's to hand out.
   *
   * The raw value never reaches this method, which is why it takes a hash: a repository that
   * minted the credential would be a repository that could log it, and the row is supposed to be
   * worthless to whoever reads the table.
   */
  async beginFlow(ctx: TenantContext, stateHash: string, input: BeginFlowInput): Promise<void> {
    const now = this.now();
    await this.db.run(
      `INSERT INTO oauth_states
         (state_hash, workspace_id, user_id, provider, connector_id, code_verifier, redirect_uri,
          scopes, return_to, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stateHash,
        ctx.workspaceId,
        ctx.actorUserId,
        input.provider,
        input.connectorId,
        input.codeVerifier,
        input.redirectUri,
        JSON.stringify(input.scopes),
        input.returnTo ?? null,
        new Date(now).toISOString(),
        new Date(now + (input.ttlS ?? OAUTH_STATE_TTL_S) * 1000).toISOString(),
      ],
    );
    // Opportunistic, exactly as the ticket store sweeps: rows are tiny, few, and live ten
    // minutes, and a cron job for this would be a moving part with nothing to do. A failed sweep
    // costs some dead rows and must never fail a flow.
    void this.sweepStates().catch(() => {});
  }

  /**
   * Redeem a state exactly once.
   *
   * `_ctx` is a SystemContext and unused, and the parameter is here rather than absent because of
   * the boundary rule: every repository method takes a context first, and the type is what says
   * out loud that this one legitimately PRECEDES a workspace. The callback arrives from a third
   * party carrying nothing but the state, and the row is what produces the scope.
   */
  async consumeState(raw: string, _ctx?: SystemContext): Promise<ConsumedState | null> {
    if (!looksLikeState(raw)) return null;
    const hash = hashState(raw);
    return this.db.transaction(async (tx) => {
      const row = await tx.get<Record<string, unknown>>(
        `SELECT workspace_id, user_id, provider, connector_id, code_verifier, redirect_uri,
                scopes, return_to, expires_at
           FROM oauth_states WHERE state_hash = ?`,
        [hash],
      );
      if (!row) return null;
      // The delete is the decision, not the read above it. A second consumer that got here first
      // leaves this at zero rows, and the loser is refused rather than admitted.
      const deleted = await tx.run(`DELETE FROM oauth_states WHERE state_hash = ?`, [hash]);
      if (deleted.changes === 0) return null;

      // Checked AFTER the delete, so an expired state is still burnt rather than left for a
      // retry to find. Expiry is a refusal either way; the difference is whether the row is
      // still there afterwards to be probed.
      const expiresAt = Date.parse(String(row["expires_at"]));
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) return null;

      const scopes = jsonFromColumn(this.db.dialect, row["scopes"]);
      return {
        workspaceId: String(row["workspace_id"]),
        userId: (row["user_id"] as string | null) ?? null,
        provider: String(row["provider"]),
        connectorId: String(row["connector_id"]),
        codeVerifier: String(row["code_verifier"]),
        redirectUri: String(row["redirect_uri"]),
        scopes: Array.isArray(scopes) ? (scopes as string[]) : [],
        returnTo: (row["return_to"] as string | null) ?? null,
      };
    });
  }

  /** Expired flows. Unscoped by design, exactly as the ticket sweep is: this is maintenance. */
  async sweepStates(): Promise<number> {
    const res = await this.db.run(`DELETE FROM oauth_states WHERE expires_at <= ?`, [
      new Date(this.now()).toISOString(),
    ]);
    return res.changes;
  }

  /** How many flows a workspace has open. For the tenancy suite, and for a rate limit later. */
  async openFlowCount(ctx: TenantContext): Promise<number> {
    const row = await this.db.get<{ n: unknown }>(
      `SELECT COUNT(*) AS n FROM oauth_states WHERE workspace_id = ? AND expires_at > ?`,
      [ctx.workspaceId, new Date(this.now()).toISOString()],
    );
    return Number(row?.n ?? 0);
  }
}

/** Whether a hydrated row says a run may be handed a credential from it. */
export function isUsable(row: OAuthConnectionRow | null | undefined): boolean {
  return row?.status === "active";
}
