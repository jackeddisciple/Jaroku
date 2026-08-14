// Elevation: a short-lived, server-issued authorisation to work with secrets.
//
// The user is already authenticated. Elevation proves they are still PRESENT and still them — the
// "sudo mode" pattern — and it is checked in middleware on every secrets route, because a gate
// that only hides a React component is theatre: anyone holding a session token can call the API
// directly.
//
// ONE ROW PER ISSUED TOKEN, GROUPED BY SESSION, and the grouping is what makes the brief's tab
// behaviour fall out rather than be special-cased. A second tab of the same session asks for its
// own token and gets one carrying the FIRST row's `expires_at`; locking revokes every unrevoked
// row for that session at once, so one tab locking is reflected in the other.
//
// INHERITING THE EXPIRY RATHER THAN GETTING A FRESH TEN MINUTES IS LOAD-BEARING. The TTL is
// absolute, never sliding — a sliding window means an idle open tab stays elevated all day, which
// is the exact property the gate exists to deny. If a second tab reset the clock, opening one
// every nine minutes would be indefinite elevation with nobody present.
//
// A SESSION HERE IS A DIGEST OF THE BEARER TOKEN, not an id of our own invention. This server has
// no cookie to hang a session on — it authenticates with a bearer token in a header, deliberately
// — and the digest gets sign-out correct for free: signing out mints a new token, which is a new
// session, which shares nothing with the elevation the old one held.
//
// THE TOKEN IS HASHED AT REST, exactly as `ws_tickets` are. A database dump is not a drawer of
// live authorisations.

import { randomUUID } from "node:crypto";

import type { Db, Queryable } from "../db.ts";
import type { TenantContext } from "../tenant.ts";

export type ElevationMethod = "passcode" | "webauthn" | "oidc";

export interface ElevationRow {
  id: string;
  workspace_id: string;
  user_id: string;
  session_id: string;
  method: ElevationMethod;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface IssueInput {
  userId: string;
  sessionId: string;
  tokenHash: string;
  method: ElevationMethod;
  /** Absolute, and supplied by the caller so a second tab can inherit the first one's. */
  expiresAt: string;
  ip?: string | null;
  userAgent?: string | null;
}

const COLUMNS = `id, workspace_id, user_id, session_id, method, issued_at, expires_at, revoked_at, revoke_reason`;

function hydrate(row: Record<string, unknown>): ElevationRow {
  return {
    id: String(row["id"]),
    workspace_id: String(row["workspace_id"]),
    user_id: String(row["user_id"]),
    session_id: String(row["session_id"]),
    method: row["method"] as ElevationMethod,
    issued_at: String(row["issued_at"]),
    expires_at: String(row["expires_at"]),
    revoked_at: (row["revoked_at"] as string | null) ?? null,
    revoke_reason: (row["revoke_reason"] as string | null) ?? null,
  };
}

export class SecretElevationRepository {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  /** Record a granted elevation. The caller has already verified whatever `method` names. */
  async issue(ctx: TenantContext, input: IssueInput): Promise<ElevationRow> {
    const id = randomUUID();
    const issuedAt = new Date().toISOString();
    await this.q(ctx).run(
      `INSERT INTO secret_elevations
         (id, workspace_id, user_id, session_id, token_hash, method, issued_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        ctx.workspaceId,
        input.userId,
        input.sessionId,
        input.tokenHash,
        input.method,
        issuedAt,
        input.expiresAt,
        input.ip ?? null,
        input.userAgent ?? null,
      ],
    );
    return {
      id,
      workspace_id: ctx.workspaceId,
      user_id: input.userId,
      session_id: input.sessionId,
      method: input.method,
      issued_at: issuedAt,
      expires_at: input.expiresAt,
      revoked_at: null,
      revoke_reason: null,
    };
  }

  /**
   * The live elevation a token names, within a workspace that has already been resolved.
   *
   * SCOPED, UNLIKE `TicketStore.consume`, and the difference is worth stating because the two look
   * alike. Consuming a ticket is the operation that PRODUCES a workspace scope — there is no
   * context yet, which is why `ws_tickets` carries no RLS policy at all. An elevation is the
   * opposite: by the time it is checked, the request's bearer token has already been through
   * `ContextResolver` and the workspace is known. So this runs inside that scope, and under RLS it
   * has to — a policy-covered table read with no `app.workspace_id` set matches no rows, silently.
   *
   * Matching on user and session as well as the token is not redundancy. It means a token is only
   * ever usable by the person and the session it was issued to, so a token that somehow escaped
   * its tab is not a portable authorisation.
   */
  async liveByToken(
    ctx: TenantContext,
    input: { userId: string; sessionId: string; tokenHash: string },
    now: string = new Date().toISOString(),
  ): Promise<ElevationRow | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM secret_elevations
        WHERE workspace_id = ? AND user_id = ? AND session_id = ? AND token_hash = ?
          AND revoked_at IS NULL AND expires_at > ?`,
      [ctx.workspaceId, input.userId, input.sessionId, input.tokenHash, now],
    );
    return row ? hydrate(row) : undefined;
  }

  /**
   * The live elevation for this session, if there is one.
   *
   * "Live" means unrevoked and not yet expired. Ordered by `expires_at` descending and limited to
   * one so a session that somehow holds two picks up the one that lasts longer — which cannot
   * extend anything, because a second tab copies this row's expiry rather than setting its own.
   */
  async liveForSession(
    ctx: TenantContext,
    userId: string,
    sessionId: string,
    now: string = new Date().toISOString(),
  ): Promise<ElevationRow | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM secret_elevations
        WHERE workspace_id = ? AND user_id = ? AND session_id = ?
          AND revoked_at IS NULL AND expires_at > ?
        ORDER BY expires_at DESC LIMIT ?`,
      [ctx.workspaceId, userId, sessionId, now, 1],
    );
    return row ? hydrate(row) : undefined;
  }

  /** Lock now: end every unrevoked elevation this session holds, in every tab at once. */
  async revokeSession(
    ctx: TenantContext,
    userId: string,
    sessionId: string,
    reason: string,
  ): Promise<number> {
    const res = await this.q(ctx).run(
      `UPDATE secret_elevations SET revoked_at = ?, revoke_reason = ?
        WHERE workspace_id = ? AND user_id = ? AND session_id = ? AND revoked_at IS NULL`,
      [new Date().toISOString(), reason, ctx.workspaceId, userId, sessionId],
    );
    return res.changes;
  }

  /**
   * End every elevation this user holds in this workspace, on every device.
   *
   * For the events that invalidate the proof itself rather than one session of it: the passcode
   * was changed or reset, or the person was removed from the workspace. Leaving an elevation
   * standing through a passcode reset would mean a stolen session outliving the recovery
   * performed to end it.
   */
  async revokeAllForUser(ctx: TenantContext, userId: string, reason: string): Promise<number> {
    const res = await this.q(ctx).run(
      `UPDATE secret_elevations SET revoked_at = ?, revoke_reason = ?
        WHERE workspace_id = ? AND user_id = ? AND revoked_at IS NULL`,
      [new Date().toISOString(), reason, ctx.workspaceId, userId],
    );
    return res.changes;
  }

  /**
   * Delete rows that can no longer authorise anything.
   *
   * ACROSS EVERY WORKSPACE, which is why it takes no context — this is maintenance, and asserting
   * that it "cannot reach another workspace" would be asserting the opposite of what it is for.
   * Same shape and same reasoning as `TicketStore.sweep`.
   *
   * A grace period rather than `expires_at < now`, so a just-expired row is still readable long
   * enough to tell a client "your elevation expired" instead of "no such elevation" — the first
   * re-prompts, the second looks like a bug.
   *
   * THROUGH `asPlatform`, NOT A BARE STATEMENT. With no `app.workspace_id` set, `tenant_isolation`
   * is false for every row: an unscoped DELETE here would remove nothing, report nothing, and pass
   * every test, because a test connects as a superuser and a superuser has no policies. Migration
   * 033 grants this one policy, named, for this one statement.
   */
  async sweep(graceMs = 60 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - graceMs).toISOString();
    return this.db.asPlatform(async (tx) => {
      const res = await tx.run(`DELETE FROM secret_elevations WHERE expires_at < ?`, [cutoff]);
      return res.changes;
    });
  }
}
