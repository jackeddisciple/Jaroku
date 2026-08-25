// Users, workspaces, memberships and the audit log.
//
// The root of the tenancy tree, and the one group of repositories where not every method can
// take a TenantContext — see tenant.ts. Signing up produces the workspace that later scopes
// everything, so it cannot be scoped by it.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db, Queryable } from "../db.ts";
import { asBool, asInt, jsonFromColumn } from "../db.ts";
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
  /**
   * When this PERSON finished first-run onboarding, or null if they have not.
   *
   * On the user rather than on a membership because onboarding teaches somebody what the
   * product is, which is learned once by a person and not once per workspace they join. See
   * migration 013.
   */
  onboarded_at: string | null;
  /**
   * Whether the address on this row has been proved to reach this person.
   *
   * TRUE FOR EVERY ROW THAT EXISTS, and the column is here because the specification asks for it
   * to be recorded rather than assumed. `sessionHandler` has always refused a token carrying no
   * verified address, `verifyGoogleIdToken` refuses an `email_verified: false` claim, and a magic
   * link is itself a proof of delivery — so nothing in this system can currently write `false`.
   * The column exists so that the day something can (a provider that does not verify, an admin
   * creating an account by hand) it is a value rather than a schema change.
   */
  email_verified: boolean;
  /**
   * How this person most recently got in: `google`, `magic_link`, or null.
   *
   * NULL IS "BEFORE THIS WAS RECORDED", not "unknown provider". Every account provisioned before
   * migration 053 came through the local issuer or a configured OIDC provider, and stamping either
   * new value onto those rows would be inventing a fact.
   *
   * MOST RECENT, NOT FIRST. §10: somebody who signed up with Google and later used a magic link on
   * the same address is the SAME account — matched by verified email — and this column reflects
   * how they last arrived. It is a record, never a rule: nothing refuses a sign-in because this
   * says something else, and a column that did would be the "two accounts for one email" failure
   * wearing a different hat.
   */
  auth_provider: string | null;
  /** §3.4's checkbox. Unchecked by default, opt-in rather than opt-out. */
  marketing_emails_opt_in: boolean;
  /** When they first saw step 1 of account onboarding. See migration 053. */
  onboarding_started_at: string | null;
  /** §5.3's resume point, 1-5. Advances as steps complete, never as they are merely shown. */
  onboarding_step: number;
}

/**
 * Every column a `User` is read from, spelled once.
 *
 * IT WAS SPELLED FOUR TIMES BEFORE THIS, and the day migration 053 added five columns was the day
 * that stopped being harmless: four identical lists is four places to forget one, and the symptom
 * of forgetting is not a crash — it is a `User` with `undefined` where a boolean should be, which
 * reads as `false` at every call site and is wrong silently.
 */
const USER_COLUMNS = `id, external_id, email, display_name, created_at, deleted_at, onboarded_at,
       email_verified, auth_provider, marketing_emails_opt_in, onboarding_started_at, onboarding_step`;

/** The row as a driver hands it back, before the two columns that need normalising are. */
interface UserRow extends Omit<User, "email_verified" | "marketing_emails_opt_in" | "onboarding_step"> {
  email_verified: unknown;
  marketing_emails_opt_in: unknown;
  onboarding_step: unknown;
}

/**
 * A row, as the rest of this codebase should see it.
 *
 * THE TWO BOOLEANS ARE THE WHOLE REASON THIS FUNCTION EXISTS. SQLite stores them as `INTEGER` and
 * hands back `0` or `1`; Postgres stores them as `boolean` and hands back `true` or `false`. Both
 * are truthy-correct for `1`/`true` and both are falsy-correct for `0`/`false`, which is exactly
 * why leaving them alone is dangerous rather than merely untidy: `user.email_verified === true` is
 * a comparison that is right on one driver and wrong on the other, and it is the natural way to
 * write it. `asBool` is the same normalisation every other cross-driver boolean in this codebase
 * goes through.
 *
 * `onboarding_step` gets `asInt` for the sibling reason: it is `smallint` on Postgres, which the
 * driver may hand back as a string.
 */
function readUser(row: UserRow): User {
  return {
    ...(row as unknown as User),
    email_verified: asBool(row.email_verified),
    marketing_emails_opt_in: asBool(row.marketing_emails_opt_in),
    onboarding_step: asInt(row.onboarding_step, 1),
  };
}

/**
 * How many steps §5.1 draws.
 *
 * FIVE, AND THE NUMBER LIVES HERE because two things need it and they must not disagree: the route
 * that advances the step bounds what a client may send, and `markOnboarded` writes it. A client
 * that could send 9 would put a row into a state no screen renders; a `markOnboarded` that wrote a
 * different number would leave `onboarded_at` and `onboarding_step` describing two different
 * states, which §5.4's restart then reads.
 */
export const ONBOARDING_STEPS = 5;

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
    const row = await this.db.get<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE external_id = ? AND deleted_at IS NULL`,
      [externalId],
    );
    return row ? readUser(row) : undefined;
  }

  async userById(_ctx: AnyContext, id: string): Promise<User | undefined> {
    const row = await this.db.get<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return row ? readUser(row) : undefined;
  }

  /**
   * Find somebody by the address they typed, case-insensitively.
   *
   * §10's FIRST TWO ROWS ARE THIS METHOD. "User signs in with Google, later signs in with magic
   * link on same email → same account, matched by verified email. Never two accounts for one
   * email." And: "normalize to lowercase before comparison; store as user entered but match as
   * lowercase."
   *
   * THE LOWERCASING IS EXPLICIT RATHER THAN LEFT TO THE COLUMN, and that is the whole point of it
   * being here. `users.email` is `citext` on Postgres and `COLLATE NOCASE` on SQLite, so a bare
   * comparison already matches case-insensitively on both — which means a caller that forgot to
   * normalise would work perfectly in every test and every deployment, right up until somebody
   * changed the column type. Normalising at the call site makes the property belong to the code
   * rather than to two dialect features that happen to agree.
   */
  async userByEmail(_ctx: SystemContext, email: string): Promise<User | undefined> {
    const row = await this.db.get<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE LOWER(email) = ? AND deleted_at IS NULL`,
      [email.trim().toLowerCase()],
    );
    return row ? readUser(row) : undefined;
  }

  /**
   * Record how somebody most recently signed in, and that their address is proved.
   *
   * NOT PART OF `provisionUser`, deliberately, even though the first sign-in does both. Somebody's
   * SECOND sign-in provisions nothing and still moves `auth_provider` — §10 says the column
   * "reflects most recent" — so folding it in would mean the fact only ever recorded the first
   * time and then went stale for the life of the account.
   */
  async recordSignIn(
    _ctx: SystemContext,
    userId: string,
    input: { provider: string; emailVerified?: boolean },
  ): Promise<void> {
    await this.db.run(`UPDATE users SET auth_provider = ? WHERE id = ? AND deleted_at IS NULL`, [
      input.provider,
      userId,
    ]);
    // `email_verified` ONLY EVER MOVES UP, and that is spelled as control flow rather than as a
    // `CASE` in the SQL. A provider that says nothing about verification must not un-prove an
    // address a magic link already delivered to — and a `CASE WHEN ? THEN ? ELSE email_verified`
    // would be a clever statement whose parameter types both drivers have to infer through a
    // conditional, which is exactly the shape `test:boolean-literals` exists because of.
    if (input.emailVerified) {
      // A BOUND `true`, never a literal. See db/booleanLiterals.test.ts: a bound value leaves the
      // driver untyped and Postgres resolves it against the column, while a literal in the
      // statement text is typed before the column is consulted and is refused.
      await this.db.run(`UPDATE users SET email_verified = ? WHERE id = ? AND deleted_at IS NULL`, [
        true,
        userId,
      ]);
    }
  }

  /**
   * §3.4's `PATCH /v1/users/me`. The name, and the one checkbox.
   *
   * BOTH FIELDS ARE OPTIONAL AND AN ABSENT ONE IS UNTOUCHED, which is what makes this a PATCH
   * rather than a PUT. A settings screen that changes only the marketing preference must not clear
   * a display name by omitting it.
   */
  async updateProfile(
    _ctx: AnyContext,
    userId: string,
    input: { displayName?: string; marketingEmailsOptIn?: boolean },
  ): Promise<User | undefined> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.displayName !== undefined) {
      sets.push("display_name = ?");
      params.push(input.displayName);
    }
    if (input.marketingEmailsOptIn !== undefined) {
      sets.push("marketing_emails_opt_in = ?");
      // A BOUND BOOLEAN, never a literal `0` in the statement text. See db/booleanLiterals.test.ts:
      // the two are indistinguishable on SQLite and only one of them is accepted by Postgres.
      params.push(input.marketingEmailsOptIn);
    }
    if (sets.length === 0) return this.userById(_ctx, userId);
    params.push(userId);
    await this.db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`, params);
    return this.userById(_ctx, userId);
  }

  /**
   * Record that this person has finished first-run onboarding.
   *
   * IDEMPOTENT VIA `onboarded_at IS NULL`, and that is the whole of the concurrency handling.
   * The client calls this from a `useEffect` that a second tab, a re-render or a reload can
   * each fire again, and the first time is the one that means anything — without the guard, a
   * reload a month later would rewrite the timestamp and the column would record the most
   * recent visit rather than the first, which is the opposite of what it is for.
   *
   * Takes a user id rather than a TenantContext: this is a fact about a PERSON, and the
   * workspace they happen to be in when they finish is not part of it. It is the one write in
   * this repository that is deliberately not workspace-scoped, which is why it is here beside
   * the other two user-level reads rather than among the membership mutations below.
   *
   * Returns the timestamp now in force — the caller's, or the one already there.
   */
  async markOnboarded(_ctx: AnyContext, userId: string): Promise<string | null> {
    const at = nowIso();
    await this.db.run(
      // THE STEP GOES TO THE LAST ONE IN THE SAME STATEMENT. §5.2 defines completion as reaching an
      // engagement action, and every path to that has passed every step — so a row with
      // `onboarded_at` set and `onboarding_step = 2` would be a row describing two different
      // states. It matters because §5.4's restart clears the flag and reads the step: leaving a
      // stale one behind would drop a returning user back into the middle of a tour.
      `UPDATE users SET onboarded_at = ?, onboarding_step = ?
        WHERE id = ? AND deleted_at IS NULL AND onboarded_at IS NULL`,
      [at, ONBOARDING_STEPS, userId],
    );
    const row = await this.db.get<{ onboarded_at: string | null }>(
      `SELECT onboarded_at FROM users WHERE id = ? AND deleted_at IS NULL`,
      [userId],
    );
    return row?.onboarded_at ?? null;
  }

  /**
   * §5.3 — how far through account onboarding somebody got.
   *
   * MONOTONIC, AND THAT IS THE WHOLE OF THE CONCURRENCY HANDLING. The step only ever moves FORWARD,
   * enforced by `onboarding_step < ?` in the WHERE clause rather than by reading and comparing —
   * so two tabs, a double-click, or a request that arrives out of order cannot walk somebody back
   * to a screen they have already finished. A client that advanced from 2 to 3 and then retried the
   * earlier request writes nothing.
   *
   * `onboarding_started_at` IS STAMPED HERE, ON THE FIRST ADVANCE, and never again — `IS NULL`
   * makes that idempotent. It is stamped on the first ADVANCE rather than at provisioning because
   * the question it answers is "when did they start setting up", and an account that was created
   * and never returned to has not started anything. The gap between this and `onboarded_at` is the
   * only thing that can say where people give up, and one timestamp cannot.
   *
   * IT REFUSES TO MOVE A COMPLETED ONBOARDING. Somebody who has finished and whose old tab fires a
   * stale step must not be walked back into the flow — §5.2's flag is the gate, and a step that
   * could move underneath it would be a second, disagreeing answer.
   */
  async advanceOnboarding(_ctx: AnyContext, userId: string, step: number): Promise<number> {
    await this.db.run(
      `UPDATE users
          SET onboarding_step = ?,
              onboarding_started_at = COALESCE(onboarding_started_at, ?)
        WHERE id = ? AND deleted_at IS NULL AND onboarded_at IS NULL AND onboarding_step < ?`,
      [step, nowIso(), userId, step],
    );
    const row = await this.db.get<{ onboarding_step: unknown }>(
      `SELECT onboarding_step FROM users WHERE id = ? AND deleted_at IS NULL`,
      [userId],
    );
    return asInt(row?.onboarding_step, 1);
  }

  /**
   * §5.4 — put somebody back at the start of the tour without touching anything they made.
   *
   * "Your workspace and settings won't change." So this clears exactly two columns and nothing
   * else: the completion flag and the step. The workspace, the provider key and every agent stay
   * where they are, which is what makes steps 2-4 read as "confirm or change" rather than "create"
   * when the flow runs again.
   *
   * `onboarding_started_at` IS DELIBERATELY NOT CLEARED. It records when this person first started
   * setting up, which is a fact about the past that a second walk-through does not change — and a
   * funnel that reset it would count one person as two.
   */
  async restartOnboarding(_ctx: AnyContext, userId: string): Promise<void> {
    await this.db.run(
      `UPDATE users SET onboarded_at = NULL, onboarding_step = 1 WHERE id = ? AND deleted_at IS NULL`,
      [userId],
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
    input: { externalId: string; email: string; displayName?: string | null; authProvider?: string | null },
  ): Promise<{ user: User; workspace: Workspace; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const existingRow = await tx.get<UserRow>(
        `SELECT ${USER_COLUMNS} FROM users WHERE external_id = ? AND deleted_at IS NULL`,
        [input.externalId],
      );
      if (existingRow) return this.withPersonalWorkspace(tx, readUser(existingRow), input);

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
        onboarded_at: null,
        // TRUE, AND EARNED RATHER THAN ASSUMED. Every path that reaches this function has already
        // proved the address: `sessionHandler` refuses a token with no verified email claim,
        // `verifyGoogleIdToken` refuses `email_verified: false`, and a magic link is itself a
        // delivery receipt. §12's criterion 7 asks for exactly this on a new Google user.
        email_verified: true,
        // NULL WHEN THE CALLER DID NOT SAY, rather than a guess. The two sign-in flows pass their
        // own name; a session established through a configured OIDC provider passes nothing,
        // because neither `google` nor `magic_link` would be true of it.
        auth_provider: input.authProvider ?? null,
        // §3.4: unchecked by default. Opt-in, never opt-out — CAN-SPAM compliant, GDPR compliant,
        // and the right thing to do.
        marketing_emails_opt_in: false,
        onboarding_started_at: null,
        onboarding_step: 1,
      };
      const inserted = await tx.run(
        `INSERT INTO users (id, external_id, email, display_name, created_at, email_verified, auth_provider)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (external_id) DO NOTHING`,
        [
          user.id,
          user.external_id,
          user.email,
          user.display_name,
          user.created_at,
          // A BOUND BOOLEAN. See db/booleanLiterals.test.ts — a literal `1` here is accepted by
          // SQLite and refused by Postgres, and the two are indistinguishable on a laptop.
          user.email_verified,
          user.auth_provider,
        ],
      );
      if (inserted.changes === 0) {
        // Somebody else provisioned this `sub` between the SELECT and here. Their row is the
        // real one; ours was never written.
        const winnerRow = await tx.get<UserRow>(
          `SELECT ${USER_COLUMNS} FROM users WHERE external_id = ? AND deleted_at IS NULL`,
          [input.externalId],
        );
        if (!winnerRow) throw new Error(`could not provision ${input.externalId}`);
        return this.withPersonalWorkspace(tx, readUser(winnerRow), input);
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

  /**
   * How hard this workspace gates its Secrets surface.
   *
   * `tab` — nothing renders without elevation. `mutations` — the metadata list is readable with
   * ordinary auth, and adding, rotating, revoking or revealing needs elevation.
   *
   * READ PER REQUEST rather than cached, because it is the kind of setting somebody changes
   * BECAUSE something is happening, and one that took effect at the next restart would be one
   * nobody could rely on during the incident that made them change it.
   *
   * A missing or deleted workspace answers `tab`, which is the stricter of the two. Failing open
   * on a lookup that returned nothing is how a gate becomes optional.
   */
  async secretsGate(ctx: TenantContext): Promise<"tab" | "mutations"> {
    const row = await this.db
      .forWorkspace(ctx.workspaceId)
      .get<{ secrets_gate: string }>(
        `SELECT secrets_gate FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
        [ctx.workspaceId],
      );
    return row?.secrets_gate === "mutations" ? "mutations" : "tab";
  }

  /**
   * Change it. Owner-gated at the route, audited here.
   *
   * Audited for the same reason a plan change is: "why could a member read our credential list
   * without unlocking" is a question asked long after the change, and the answer has to survive in
   * something other than a log that rotated.
   */
  async setSecretsGate(ctx: TenantContext, gate: "tab" | "mutations"): Promise<void> {
    await this.db.transaction(async (tx) => {
      const before = await tx.get<{ secrets_gate: string }>(
        `SELECT secrets_gate FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
        [ctx.workspaceId],
      );
      if (!before || before.secrets_gate === gate) return;
      await tx.run(`UPDATE workspaces SET secrets_gate = ? WHERE id = ? AND deleted_at IS NULL`, [
        gate,
        ctx.workspaceId,
      ]);
      await this.appendAuditIn(tx, ctx, {
        workspaceId: ctx.workspaceId,
        action: "secrets.policy_changed",
        targetType: "workspace",
        targetId: ctx.workspaceId,
        metadata: { from: before.secrets_gate, to: gate },
      });
    });
  }

  /**
   * Move a workspace onto a plan.
   *
   * THE ONLY WRITER OF `workspaces.plan`, and it takes a TenantContext even though `workspaces`
   * carries no RLS policy — a plan change is a change to what a workspace IS, and the scope is
   * what makes it auditable as one. Its caller is billing/subscriptions.ts, which is the only
   * place a provider's opinion is allowed to become this system's.
   *
   * The audit row is not decoration. "Why am I on the free plan" is a question somebody asks
   * weeks after a failed renewal, and the answer has to survive in something other than a log
   * that rotated.
   */
  async setWorkspacePlan(ctx: AnyContext, plan: string): Promise<void> {
    const workspaceId = "workspaceId" in ctx ? (ctx as TenantContext).workspaceId : null;
    if (!workspaceId) throw new Error("setWorkspacePlan needs a workspace");
    await this.db.transaction(async (tx) => {
      const before = await tx.get<{ plan: string }>(
        `SELECT plan FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
        [workspaceId],
      );
      if (!before || before.plan === plan) return;
      await tx.run(`UPDATE workspaces SET plan = ? WHERE id = ? AND deleted_at IS NULL`, [plan, workspaceId]);
      await this.appendAuditIn(tx, ctx, {
        workspaceId,
        action: "workspace.plan_changed",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: { from: before.plan, to: plan },
      });
    });
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
  /**
   * Rename the workspace this context is scoped to.
   *
   * THE CONTEXT NAMES THE WORKSPACE AND THE ARGUMENTS DO NOT, which is the boundary rule this
   * repository follows everywhere: a method taking a workspace id beside a context would be one
   * that could be pointed at a workspace the context did not resolve to. The caller has already
   * been through the resolver and has already had its role checked.
   *
   * THE SLUG DOES NOT MOVE. It is in URLs, it is what `workspaceBySlug` looks up, and it is UNIQUE
   * — so re-deriving it from a new name would break every link anybody has and would fail outright
   * the first time two workspaces chose the same name. A slug is an identifier that happened to
   * start as a name; the name is what people read.
   */
  async renameWorkspace(ctx: TenantContext, name: string): Promise<Workspace | undefined> {
    await this.db.run(`UPDATE workspaces SET name = ? WHERE id = ? AND deleted_at IS NULL`, [
      name,
      ctx.workspaceId,
    ]);
    return this.workspaceById(ctx, ctx.workspaceId);
  }

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
   * Leave a workspace under your own steam.
   *
   * THE SAME DELETE AS `removeMember` AND A DIFFERENT OPERATION, which is why it is a method
   * rather than a caller that passes `ctx.actorUserId` to that one. Three things differ, and each
   * of them is the reason somebody would reach for the wrong one:
   *
   *   WHO IT MAY TOUCH. Exactly one row — the caller's own — and it takes no user id at all, so
   *   there is no argument to get wrong and no shape in which a member could spell somebody
   *   else's departure. `removeMember` takes a target because it is an act performed ON a person
   *   by an owner; this is an act performed BY a person on themselves.
   *
   *   WHAT IT REFUSES. An OWNER cannot leave, and the refusal is unconditional rather than
   *   `removeMember`'s "not if you are the last one". The two guards look interchangeable and are
   *   not: a workspace with two owners would let one of them walk out under the last-owner rule,
   *   and §6.5 is explicit that ownership is handed over deliberately rather than dropped — the
   *   remaining owner would find out from the members list. Transfer first, leave second, and the
   *   act of transferring is the one that says who is now responsible for the bill.
   *
   *   WHAT THE AUDIT ROW SAYS. `member.left` rather than `member.removed`, because those are
   *   different events to whoever reads the log during an incident and collapsing them would make
   *   "who removed Riya" unanswerable — the answer would be "Riya", which reads as a bug.
   */
  async leaveWorkspace(ctx: TenantContext): Promise<{ ok: boolean; reason?: string }> {
    return this.db.transaction(async (tx) => {
      const userId = ctx.actorUserId;
      // A context with no actor is the server acting on its own behalf, which has no membership
      // to give up. Refused here rather than deleting zero rows and reporting success.
      if (!userId) return { ok: false, reason: "there is nobody here to leave" };

      const self = await tx.get<{ role: string }>(
        `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
        [ctx.workspaceId, userId],
      );
      // READ RATHER THAN TRUSTING `ctx.role`. The context's role was resolved when the socket
      // opened and is refreshed once a minute; a demotion in between would let somebody leave as
      // the owner they no longer are, or — the direction that actually bites — refuse an admin
      // who was promoted to owner and back while the tab stayed open.
      if (!self) return { ok: false, reason: "you are not a member of this workspace" };
      if (self.role === "owner") {
        return { ok: false, reason: "transfer ownership before leaving this workspace" };
      }

      await tx.run(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, [
        ctx.workspaceId,
        userId,
      ]);
      await this.appendAuditIn(tx, ctx, {
        workspaceId: ctx.workspaceId,
        actorUserId: userId,
        action: "member.left",
        targetType: "user",
        targetId: userId,
        metadata: { role: self.role },
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

    // SCOPED, not a bare transaction. `workspace_invites` is the one table in this module that
    // carries an RLS policy, and a policy reads `app.workspace_id` — which only `scoped` sets.
    // Run unscoped, as a deployment's application role, the INSERT below fails the policy's
    // WITH CHECK outright and every read returns nothing. That is invisible on SQLite, which
    // has no RLS, and invisible to a test connecting as the owner, which is exempt: the whole
    // invite flow worked everywhere except in production. The other tables touched here —
    // users, workspace_members, audit_log — are deliberately policy-free, so scoping the
    // transaction costs them nothing.
    return this.db.scoped(ctx.workspaceId, async (tx) => {
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
    // `forWorkspace`, for the reason createInvite is scoped: an unscoped read of a policied
    // table answers nothing as the application role.
    return this.db.forWorkspace(ctx.workspaceId).all<Invite>(
      `SELECT id, workspace_id, email, role, invited_by, expires_at, accepted_at, accepted_by,
              revoked_at, created_at
         FROM workspace_invites
        WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC`,
      [ctx.workspaceId],
    );
  }

  async revokeInvite(ctx: TenantContext, inviteId: string): Promise<boolean> {
    return this.db.scoped(ctx.workspaceId, async (tx) => {
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

    // The scope comes out of the TOKEN, which is what lets this table keep a policy at all —
    // see migration 012. It authorises nothing on its own: it chooses which rows the digest
    // below is compared against, and the digest is the whole of the proof.
    return this.db.scoped(workspaceId, async (tx) => {
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
