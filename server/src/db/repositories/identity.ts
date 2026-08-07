// Users, workspaces, memberships and the audit log.
//
// The root of the tenancy tree, and the one group of repositories where not every method can
// take a TenantContext — see tenant.ts. Signing up produces the workspace that later scopes
// everything, so it cannot be scoped by it.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db, Queryable } from "../db.ts";
import { jsonFromColumn } from "../db.ts";
import {
  isMemberRole,
  type AnyContext,
  type MemberRole,
  type SystemContext,
  type TenantContext,
} from "../tenant.ts";

export interface User {
  id: string;
  external_id: string;
  email: string;
  display_name: string | null;
  created_at: string;
  deleted_at: string | null;
}

export type WorkspaceKind = "personal" | "team";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  kind: WorkspaceKind;
  plan: string;
  created_at: string;
  deleted_at: string | null;
}

export interface Membership {
  workspace_id: string;
  user_id: string;
  role: MemberRole;
  created_at: string;
}

/** A workspace plus what the asking user may do in it. What a workspace switcher renders. */
export type WorkspaceMembership = Workspace & { role: MemberRole };

/**
 * Which workspace a request with no stated preference acts in.
 *
 * ONE RULE, IN ONE PLACE, because there are two callers and they must not disagree.
 * `/v1/auth/session` tells a client what its default is and `/v1/ws-ticket` scopes a socket
 * when the client does not say — and when those two picked differently, the UI showed one
 * workspace's name above another workspace's runs. That is not a rendering bug; it is two
 * answers to the same question.
 *
 * Their personal workspace, which `adoptWorkspace` guarantees there is at most one of.
 * Otherwise the oldest they belong to, which is stable across calls in a way "the first row
 * the database happened to return" is not.
 */
export function defaultWorkspace<T extends { kind: WorkspaceKind; created_at: string }>(
  memberships: readonly T[],
): T | undefined {
  const personal = memberships.filter((w) => w.kind === "personal");
  const pool = personal.length > 0 ? personal : memberships;
  return [...pool].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
}

export interface Invite {
  id: string;
  workspace_id: string;
  email: string;
  role: MemberRole;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface AuditEntry {
  id: number;
  workspace_id: string | null;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  created_at: string;
}

const nowIso = (): string => new Date().toISOString();

/** An invite token's digest. SHA-256 for the reason a ws-ticket's is: the input is 256 bits
 *  of `randomBytes`, not a password, so there is no dictionary to make expensive. */
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Two identities want the same row, and only one may have it.
 *
 * Its own type because the caller's answer is a sentence to a person, not a retry: a unique
 * violation surfacing as a 500 tells somebody their sign-in is broken, when what happened is
 * that their address is already spoken for by a different provider account.
 */
export class IdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityConflictError";
  }
}

/**
 * A workspace slug from a display name.
 *
 * Slugs appear in URLs, so this is deliberately narrow: lowercase, digits, hyphens, starting
 * with a letter. Uniqueness is the caller's problem — see `createWorkspace`, which retries
 * rather than trusting a name to be unused.
 */
export function slugify(name: string, fallback = "workspace"): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    // Drop the combining marks NFKD just split off. Without this "ü" decomposes to "u" plus
    // a diaeresis, the diaeresis is not [a-z0-9], and the slug becomes "u-nicode" — an
    // accent turning into a word boundary.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return /^[a-z]/.test(base) ? base : `${fallback}-${base}`.replace(/-+$/g, "").slice(0, 48) || fallback;
}

export class IdentityRepository {
  constructor(private db: Db) {}

  // --- users -----------------------------------------------------------------
  //
  // SystemContext, not TenantContext: a user exists before any workspace does, and on first
  // sight there is nothing to scope the lookup by.

  async userByExternalId(_ctx: SystemContext, externalId: string): Promise<User | undefined> {
    return this.db.get<User>(
      `SELECT id, external_id, email, display_name, created_at, deleted_at
         FROM users WHERE external_id = ? AND deleted_at IS NULL`,
      [externalId],
    );
  }

  async userById(_ctx: AnyContext, id: string): Promise<User | undefined> {
    return this.db.get<User>(
      `SELECT id, external_id, email, display_name, created_at, deleted_at
         FROM users WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
  }

  /**
   * The whole of signing up, in one transaction: a user, their personal workspace, and the
   * membership that owns it.
   *
   * Atomic because a half-provisioned account is unusable in a way nothing detects — a user
   * row with no workspace signs in successfully and then has nowhere to go, and no later
   * request will notice, because "does this user exist" already answers yes.
   *
   * Idempotent because the first two requests of a session race, and they really do: the
   * client asks for a session and a ws-ticket in the same tick, and a browser with the app
   * open in two tabs doubles that again. The SELECT-then-INSERT below is not enough on its
   * own — on Postgres the two transactions run on different connections, both see no row and
   * both insert, and one dies on the unique index. So the insert is `ON CONFLICT DO NOTHING`
   * and the row is read back afterwards: the loser of the race finds the winner's user and
   * returns it, rather than failing a sign-in because it was simultaneous with itself.
   */
  async provisionUser(
    ctx: SystemContext,
    input: { externalId: string; email: string; displayName?: string | null },
  ): Promise<{ user: User; workspace: Workspace; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.get<User>(
        `SELECT id, external_id, email, display_name, created_at, deleted_at
           FROM users WHERE external_id = ? AND deleted_at IS NULL`,
        [input.externalId],
      );
      if (existing) return this.withPersonalWorkspace(tx, existing, input);

      // `users.email` is UNIQUE, so an address already held by a DIFFERENT `sub` cannot be
      // taken. That is not a race, it is a person whose provider changed (or two providers
      // configured at once), and it needs a sentence rather than a unique-violation stack
      // trace — nothing downstream can do anything useful with the latter.
      const emailTaken = await tx.get<{ external_id: string }>(
        `SELECT external_id FROM users WHERE email = ? AND deleted_at IS NULL`,
        [input.email],
      );
      if (emailTaken && emailTaken.external_id !== input.externalId) {
        throw new IdentityConflictError(
          `${input.email} already belongs to a different sign-in on this server`,
        );
      }

      const user: User = {
        id: randomUUID(),
        external_id: input.externalId,
        email: input.email,
        display_name: input.displayName?.trim() || null,
        created_at: nowIso(),
        deleted_at: null,
      };
      const inserted = await tx.run(
        `INSERT INTO users (id, external_id, email, display_name, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (external_id) DO NOTHING`,
        [user.id, user.external_id, user.email, user.display_name, user.created_at],
      );
      if (inserted.changes === 0) {
        // Somebody else provisioned this `sub` between the SELECT and here. Their row is the
        // real one; ours was never written.
        const winner = await tx.get<User>(
          `SELECT id, external_id, email, display_name, created_at, deleted_at
             FROM users WHERE external_id = ? AND deleted_at IS NULL`,
          [input.externalId],
        );
        if (!winner) throw new Error(`could not provision ${input.externalId}`);
        return this.withPersonalWorkspace(tx, winner, input);
      }

      const workspace = await this.insertWorkspaceIn(tx, {
        name: user.display_name || user.email,
        kind: "personal",
      });
      await this.insertMemberIn(tx, workspace.id, user.id, "owner");
      await this.appendAuditIn(tx, ctx, {
        workspaceId: workspace.id,
        actorUserId: user.id,
        action: "user.provisioned",
        targetType: "user",
        targetId: user.id,
        metadata: { kind: "personal" },
      });
      return { user, workspace, created: true };
    });
  }

  /**
   * Every workspace with no members at all.
   *
   * There is exactly one way to produce one: the importer, and the dev-tenancy resolver, both
   * of which create a workspace before anybody has signed in — see `createWorkspaceUnowned`,
   * which promises this adoption. A workspace nobody can administer is a dead end, so the
   * first sign-in on a local install claims them and the user's own data is where they left
   * it. It is never done in provider mode; see session.ts for why that would be an
   * escalation from "can sign up" to "owns the imported data".
   */
  async unownedWorkspaces(_ctx: SystemContext): Promise<Workspace[]> {
    return this.db.all<Workspace>(
      `SELECT w.id, w.slug, w.name, w.kind, w.plan, w.created_at, w.deleted_at
         FROM workspaces w
        WHERE w.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id)
        ORDER BY w.created_at ASC`,
    );
  }

  /**
   * Make `userId` the owner of a workspace that has none. A no-op if it already has one.
   *
   * IT ALSO STOPS BEING `personal`. Migration 004's `Local` workspace — the one every
   * pre-tenancy row was backfilled into — was created as `personal` because at the time there
   * was one user and the distinction did not bite. Adopting it as-is gives its new owner TWO
   * personal workspaces, and every rule that says "their personal one" then has two answers:
   * `/v1/auth/session` picked one, `/v1/ws-ticket` picked the other, and the client was told
   * its workspace was Ada's while its socket was scoped to Local.
   *
   * A workspace somebody inherits is not their personal workspace, so it becomes a team. That
   * makes "exactly one personal workspace per user" true, which is what lets there be a single
   * rule for which one is the default.
   */
  async adoptWorkspace(ctx: SystemContext, workspaceId: string, userId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const held = await tx.get(`SELECT 1 AS x FROM workspace_members WHERE workspace_id = ?`, [workspaceId]);
      if (held) return false;
      await tx.run(`UPDATE workspaces SET kind = 'team' WHERE id = ? AND kind = 'personal'`, [workspaceId]);
      await this.insertMemberIn(tx, workspaceId, userId, "owner");
      await this.appendAuditIn(tx, ctx, {
        workspaceId,
        actorUserId: userId,
        action: "workspace.adopted",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: { reason: "first sign-in on a local install" },
      });
      return true;
    });
  }

  /**
   * A user plus their personal workspace, creating the workspace if it is somehow missing.
   *
   * The missing case is the half-provisioned state the transaction exists to prevent — but an
   * account that predates this code, or one whose creation was interrupted, can be in it.
   * Finish the job rather than hand back a broken pair.
   */
  private async withPersonalWorkspace(
    tx: Queryable,
    user: User,
    input: { email: string; displayName?: string | null },
  ): Promise<{ user: User; workspace: Workspace; created: boolean }> {
    const ws = await this.personalWorkspaceIn(tx, user.id);
    if (ws) return { user, workspace: ws, created: false };
    const repaired = await this.insertWorkspaceIn(tx, {
      name: input.displayName?.trim() || input.email,
      kind: "personal",
    });
    await this.insertMemberIn(tx, repaired.id, user.id, "owner");
    return { user, workspace: repaired, created: false };
  }

  // --- workspaces ------------------------------------------------------------

  async workspaceById(_ctx: AnyContext, id: string): Promise<Workspace | undefined> {
    return this.db.get<Workspace>(
      `SELECT id, slug, name, kind, plan, created_at, deleted_at
         FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
  }

  async workspaceBySlug(_ctx: AnyContext, slug: string): Promise<Workspace | undefined> {
    return this.db.get<Workspace>(
      `SELECT id, slug, name, kind, plan, created_at, deleted_at
         FROM workspaces WHERE slug = ? AND deleted_at IS NULL`,
      [slug],
    );
  }

  /** Create a workspace and make `ownerUserId` its owner, in one transaction. */
  async createWorkspace(
    ctx: SystemContext | TenantContext,
    input: { name: string; kind?: WorkspaceKind; ownerUserId: string },
  ): Promise<Workspace> {
    return this.db.transaction(async (tx) => {
      const ws = await this.insertWorkspaceIn(tx, { name: input.name, kind: input.kind ?? "team" });
      await this.insertMemberIn(tx, ws.id, input.ownerUserId, "owner");
      await this.appendAuditIn(tx, ctx, {
        workspaceId: ws.id,
        actorUserId: input.ownerUserId,
        action: "workspace.created",
        targetType: "workspace",
        targetId: ws.id,
        metadata: { kind: ws.kind, slug: ws.slug },
      });
      return ws;
    });
  }

  /**
   * Every live workspace's id.
   *
   * For startup reconciliation, which has to visit all of them. `workspaces` deliberately
   * carries no RLS policy — it is the table policies point AT — so this read works as the
   * application role, which is the whole reason the sweeps go workspace-by-workspace rather
   * than issuing one unscoped query that returns nothing in production.
   */
  async listWorkspaceIds(_ctx: SystemContext): Promise<string[]> {
    const rows = await this.db.all<{ id: string }>(
      `SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at ASC`,
    );
    return rows.map((r) => r.id);
  }

  /**
   * A workspace with no members yet.
   *
   * For the importer, and only for it. Every other path creates a workspace with an owner,
   * because a workspace nobody can administer is a dead end — but an import happens before
   * anybody has signed in, and inventing a user to hold it would put a person in the members
   * list who does not exist. Session 2's first sign-in adopts it.
   */
  async createWorkspaceUnowned(
    ctx: SystemContext | TenantContext,
    input: { name: string; kind?: WorkspaceKind },
  ): Promise<Workspace> {
    return this.db.transaction(async (tx) => {
      const ws = await this.insertWorkspaceIn(tx, { name: input.name, kind: input.kind ?? "team" });
      await this.appendAuditIn(tx, ctx, {
        workspaceId: ws.id,
        action: "workspace.imported",
        targetType: "workspace",
        targetId: ws.id,
        metadata: { kind: ws.kind, slug: ws.slug, owner: null },
      });
      return ws;
    });
  }

  /**
   * The workspaces a user belongs to, with their role in each.
   *
   * SystemContext: this is what ANSWERS "which workspaces may you see", so it cannot be
   * scoped to one of them. It is scoped by user_id instead, which is the correct scope for
   * this one question and this one only.
   */
  async workspacesForUser(_ctx: AnyContext, userId: string): Promise<WorkspaceMembership[]> {
    return this.db.all<WorkspaceMembership>(
      `SELECT w.id, w.slug, w.name, w.kind, w.plan, w.created_at, w.deleted_at, m.role
         FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = ? AND w.deleted_at IS NULL
        ORDER BY w.created_at ASC`,
      [userId],
    );
  }

  // --- membership ------------------------------------------------------------

  /**
   * The membership row that authorises a request, or undefined.
   *
   * The single most security-relevant read in the system: it is what turns "the client says
   * it is in workspace X" into "this user is in workspace X". Nothing downstream may take
   * the client's word for a workspace id, so nothing downstream may skip this.
   */
  async membership(_ctx: AnyContext, workspaceId: string, userId: string): Promise<Membership | undefined> {
    return this.db.get<Membership>(
      `SELECT m.workspace_id, m.user_id, m.role, m.created_at
         FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.workspace_id = ? AND m.user_id = ? AND w.deleted_at IS NULL`,
      [workspaceId, userId],
    );
  }

  async listMembers(ctx: TenantContext): Promise<(Membership & { email: string; display_name: string | null })[]> {
    return this.db.all(
      `SELECT m.workspace_id, m.user_id, m.role, m.created_at, u.email, u.display_name
         FROM workspace_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND u.deleted_at IS NULL
        ORDER BY m.created_at ASC`,
      [ctx.workspaceId],
    );
  }

  async addMember(ctx: TenantContext, userId: string, role: MemberRole): Promise<Membership> {
    if (!isMemberRole(role)) throw new Error(`not a membership role: ${role}`);
    const row: Membership = {
      workspace_id: ctx.workspaceId,
      user_id: userId,
      role,
      created_at: nowIso(),
    };
    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role`,
        [row.workspace_id, row.user_id, row.role, row.created_at],
      );
      await this.appendAuditIn(tx, ctx, {
        workspaceId: ctx.workspaceId,
        actorUserId: ctx.actorUserId,
        action: "member.added",
        targetType: "user",
        targetId: userId,
        metadata: { role },
      });
    });
    return row;
  }

  /**
   * Remove a member. Refuses to remove the last owner.
   *
   * A workspace with no owner cannot be billed, renamed or deleted, and there is no way back
   * into that state from the UI — the last person able to fix it is the one who just left.
   */
  async removeMember(ctx: TenantContext, userId: string): Promise<{ ok: boolean; reason?: string }> {
    return this.db.transaction(async (tx) => {
      const target = await tx.get<{ role: string }>(
        `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
        [ctx.workspaceId, userId],
      );
      if (!target) return { ok: false, reason: "that user is not a member of this workspace" };
      if (target.role === "owner") {
        const owners = await tx.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'owner'`,
          [ctx.workspaceId],
        );
        if (Number(owners?.n ?? 0) <= 1) {
          return { ok: false, reason: "a workspace must keep at least one owner" };
        }
      }
      await tx.run(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, [
        ctx.workspaceId,
        userId,
      ]);
      await this.appendAuditIn(tx, ctx, {
        workspaceId: ctx.workspaceId,
        actorUserId: ctx.actorUserId,
        action: "member.removed",
        targetType: "user",
        targetId: userId,
        metadata: { role: target.role },
      });
      return { ok: true };
    });
  }

  /**
   * Change a member's role. Refuses to demote the last owner.
   *
   * Same guard as `removeMember`, and for the same reason: a workspace with no owner cannot be
   * billed, renamed or deleted, and the last person who could fix it is the one who just
   * demoted themselves. Demoting yourself while another owner exists is allowed — that is
   * somebody stepping back, not somebody locking the door.
   */
  async setMemberRole(
    ctx: TenantContext,
    userId: string,
    role: MemberRole,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!isMemberRole(role)) throw new Error(`not a membership role: ${role}`);
    return this.db.transaction(async (tx) => {
      const target = await tx.get<{ role: string }>(
        `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
        [ctx.workspaceId, userId],
      );
      if (!target) return { ok: false, reason: "that user is not a member of this workspace" };
      if (target.role === role) return { ok: true };
      if (target.role === "owner") {
        const owners = await tx.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'owner'`,
          [ctx.workspaceId],
        );
        if (Number(owners?.n ?? 0) <= 1) {
          return { ok: false, reason: "a workspace must keep at least one owner" };
        }
      }
      await tx.run(`UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?`, [
        role,
        ctx.workspaceId,
        userId,
      ]);
      await this.appendAuditIn(tx, ctx, {
        workspaceId: ctx.workspaceId,
        actorUserId: ctx.actorUserId,
        action: "member.role_changed",
        targetType: "user",
        targetId: userId,
        metadata: { from: target.role, to: role },
      });
      return { ok: true };
    });
  }

  // --- invites ---------------------------------------------------------------
  //
  // See migration 012. The token is `<workspace_id>.<secret>` and only the secret's digest is
  // stored, which is what lets this table keep an RLS policy while still being usable by
  // somebody who is not yet a member: the workspace id selects the scope, and the secret
  // proves the searcher was invited.

  async createInvite(
    ctx: TenantContext,
    input: { email: string; role: MemberRole; ttlHours?: number },
  ): Promise<{ invite: Invite; token: string } | { error: string }> {
    if (!isMemberRole(input.role)) throw new Error(`not a membership role: ${input.role}`);
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email) || email.length > 254) {
      return { error: `"${email.slice(0, 64)}" is not an email address` };
    }

    return this.db.transaction(async (tx) => {
      // Already in? Then this is not an invite, it is a role change — and saying so is more
      // useful than an invite that succeeds and then does nothing when it is accepted.
      const member = await tx.get<{ user_id: string }>(
        `SELECT m.user_id FROM workspace_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = ? AND u.email = ? AND u.deleted_at IS NULL`,
        [ctx.workspaceId, email],
      );
      if (member) return { error: `${email} is already a member of this workspace` };

      // A pending invite is replaced rather than duplicated: the partial unique index forbids
      // two, and "invite again" almost always means "the first link got lost".
      await tx.run(
        `UPDATE workspace_invites SET revoked_at = ?
          WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
        [nowIso(), ctx.workspaceId, email],
      );

      const secret = randomBytes(32).toString("base64url");
      const invite: Invite = {
        id: randomUUID(),
        workspace_id: ctx.workspaceId,
        email,
        role: input.role,
        invited_by: ctx.actorUserId,
        expires_at: new Date(Date.now() + (input.ttlHours ?? 24 * 7) * 3_600_000).toISOString(),
        accepted_at: null,
        accepted_by: null,
        revoked_at: null,
        created_at: nowIso(),
      };
      await tx.run(
        `INSERT INTO workspace_invites
           (id, workspace_id, email, role, token_hash, invited_by, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invite.id,
          invite.workspace_id,
          invite.email,
          invite.role,
          sha256(secret),
          invite.invited_by,
          invite.expires_at,
          invite.created_at,
        ],
      );
      await this.appendAuditIn(tx, ctx, {
        workspaceId: ctx.workspaceId,
        actorUserId: ctx.actorUserId,
        action: "invite.created",
        targetType: "invite",
        targetId: invite.id,
        metadata: { email, role: input.role },
      });
      // The only time the token exists. Shown to the inviter once and never stored — the same
      // shape as the deploy bearer token, because there is no email sender here to hand it to.
      return { invite, token: `${ctx.workspaceId}.${secret}` };
    });
  }

  async listInvites(ctx: TenantContext): Promise<Invite[]> {
    return this.db.all<Invite>(
      `SELECT id, workspace_id, email, role, invited_by, expires_at, accepted_at, accepted_by,
              revoked_at, created_at
         FROM workspace_invites
        WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC`,
      [ctx.workspaceId],
    );
  }

  async revokeInvite(ctx: TenantContext, inviteId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const res = await tx.run(
        `UPDATE workspace_invites SET revoked_at = ?
          WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
        [nowIso(), inviteId, ctx.workspaceId],
      );
      if (res.changes === 0) return false;
      await this.appendAuditIn(tx, ctx, {
        workspaceId: ctx.workspaceId,
        actorUserId: ctx.actorUserId,
        action: "invite.revoked",
        targetType: "invite",
        targetId: inviteId,
      });
      return true;
    });
  }

  /**
   * Redeem an invite, becoming a member.
   *
   * A SystemContext, because the accepter is by definition not a member of the workspace they
   * are joining — this is the operation that makes them one. It is still fully scoped: the
   * workspace id comes out of the token and every statement below filters on it, which is what
   * lets migration 012 keep a policy on this table.
   *
   * The workspace id in the token authorises NOTHING. It chooses which rows to search; the
   * 256-bit secret whose digest must match is the whole of the proof.
   */
  async acceptInvite(
    ctx: SystemContext,
    token: string,
    user: { id: string; email: string },
  ): Promise<{ ok: true; workspace: Workspace; role: MemberRole } | { ok: false; reason: string }> {
    const dot = token.indexOf(".");
    if (dot <= 0) return { ok: false, reason: "that invitation link is not valid" };
    const workspaceId = token.slice(0, dot);
    const secret = token.slice(dot + 1);
    if (secret.length < 40 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
      return { ok: false, reason: "that invitation link is not valid" };
    }

    return this.db.transaction(async (tx) => {
      const invite = await tx.get<Invite>(
        `SELECT id, workspace_id, email, role, invited_by, expires_at, accepted_at, accepted_by,
                revoked_at, created_at
           FROM workspace_invites WHERE workspace_id = ? AND token_hash = ?`,
        [workspaceId, sha256(secret)],
      );
      // One message for every way it can fail to exist. A link that is expired, withdrawn,
      // already used or invented are all "ask for a new one", and distinguishing them tells
      // somebody holding a stolen link whether it was ever real.
      const dead =
        !invite || invite.accepted_at || invite.revoked_at || Date.parse(invite.expires_at) <= Date.now();
      if (dead) return { ok: false, reason: "that invitation has expired or is no longer valid" };

      // The address is checked, and this is the one refusal that says what happened — because
      // a person who signed in with the wrong account can fix it, and "invalid link" would send
      // them hunting for a problem with the link instead.
      if (invite.email.toLowerCase() !== user.email.trim().toLowerCase()) {
        return { ok: false, reason: `that invitation was sent to ${invite.email}, not ${user.email}` };
      }

      const workspace = await tx.get<Workspace>(
        `SELECT id, slug, name, kind, plan, created_at, deleted_at
           FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
        [workspaceId],
      );
      if (!workspace) return { ok: false, reason: "that workspace no longer exists" };

      await this.insertMemberIn(tx, workspaceId, user.id, invite.role);
      await tx.run(
        `UPDATE workspace_invites SET accepted_at = ?, accepted_by = ? WHERE id = ? AND workspace_id = ?`,
        [nowIso(), user.id, invite.id, workspaceId],
      );
      await this.appendAuditIn(tx, ctx, {
        workspaceId,
        actorUserId: user.id,
        action: "invite.accepted",
        targetType: "invite",
        targetId: invite.id,
        metadata: { role: invite.role, email: invite.email },
      });
      return { ok: true, workspace, role: invite.role };
    });
  }

  // --- audit -----------------------------------------------------------------

  /**
   * Append an audit row.
   *
   * Takes either context. A denied cross-tenant attempt is the row this table most needs and
   * the one least likely to have a valid workspace to hang off — see the migration's note on
   * why workspace_id here is nullable and not a foreign key.
   */
  async appendAudit(
    ctx: AnyContext,
    entry: {
      workspaceId?: string | null;
      actorUserId?: string | null;
      action: string;
      targetType?: string | null;
      targetId?: string | null;
      metadata?: Record<string, unknown>;
      ip?: string | null;
    },
  ): Promise<void> {
    await this.appendAuditIn(this.db, ctx, entry);
  }

  async listAudit(ctx: TenantContext, limit = 100): Promise<AuditEntry[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT id, workspace_id, actor_user_id, action, target_type, target_id, metadata, ip, created_at
         FROM audit_log WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      [ctx.workspaceId, limit],
    );
    return rows.map((r) => ({
      ...r,
      id: Number(r["id"]),
      metadata: (jsonFromColumn(this.db.dialect, r["metadata"]) as Record<string, unknown>) ?? {},
    })) as AuditEntry[];
  }

  // --- shared internals ------------------------------------------------------

  private async appendAuditIn(
    q: Queryable,
    ctx: AnyContext,
    entry: {
      workspaceId?: string | null;
      actorUserId?: string | null;
      action: string;
      targetType?: string | null;
      targetId?: string | null;
      metadata?: Record<string, unknown>;
      ip?: string | null;
    },
  ): Promise<void> {
    const workspaceId =
      entry.workspaceId !== undefined
        ? entry.workspaceId
        : "workspaceId" in ctx
          ? (ctx as TenantContext).workspaceId
          : null;
    await q.run(
      `INSERT INTO audit_log
         (workspace_id, actor_user_id, action, target_type, target_id, metadata, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        workspaceId,
        entry.actorUserId !== undefined ? entry.actorUserId : ctx.actorUserId,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        JSON.stringify({ requestId: ctx.requestId, ...(entry.metadata ?? {}) }),
        entry.ip ?? null,
        nowIso(),
      ],
    );
  }

  private async personalWorkspaceIn(q: Queryable, userId: string): Promise<Workspace | undefined> {
    return q.get<Workspace>(
      `SELECT w.id, w.slug, w.name, w.kind, w.plan, w.created_at, w.deleted_at
         FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = ? AND w.kind = 'personal' AND w.deleted_at IS NULL
        ORDER BY w.created_at ASC LIMIT 1`,
      [userId],
    );
  }

  /**
   * Insert a workspace, finding a free slug.
   *
   * Retried rather than pre-checked: two signups with the same display name in the same
   * moment both see the slug as free, and only the unique index knows which one is wrong.
   */
  private async insertWorkspaceIn(
    q: Queryable,
    input: { name: string; kind: WorkspaceKind },
  ): Promise<Workspace> {
    const name = input.name.trim() || "Workspace";
    const base = slugify(name);
    for (let attempt = 0; attempt < 6; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
      const taken = await q.get(`SELECT 1 AS x FROM workspaces WHERE slug = ?`, [slug]);
      if (taken) continue;
      const ws: Workspace = {
        id: randomUUID(),
        slug,
        name,
        kind: input.kind,
        plan: "free",
        created_at: nowIso(),
        deleted_at: null,
      };
      await q.run(
        `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [ws.id, ws.slug, ws.name, ws.kind, ws.plan, ws.created_at],
      );
      return ws;
    }
    throw new Error(`could not find a free slug for "${name}"`);
  }

  private async insertMemberIn(
    q: Queryable,
    workspaceId: string,
    userId: string,
    role: MemberRole,
  ): Promise<void> {
    await q.run(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role`,
      [workspaceId, userId, role, nowIso()],
    );
  }
}
