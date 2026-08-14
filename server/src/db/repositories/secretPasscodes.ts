// The passcode that gates the Secrets surface, and the counters that slow an attack on it.
//
// THIS IS NOT IN THE SECRET STORE, and the distinction is the reason this file exists rather than
// a name in the vault. `SecretStore` holds credentials the SYSTEM must retrieve — it injects them
// into runs and into platform-side model calls, with no user present. A passcode must never be
// retrievable by anything: it is only ever COMPARED against. So it is a hash in a table with no
// method that returns it, and the shape says so.
//
// PER USER, NOT PER WORKSPACE. A shared workspace passcode destroys accountability — `audit_log`
// has to be able to name a person, and it cannot when six people know one string. The primary key
// is the pair rather than the user alone because the same person may hold two workspaces to
// different standards, and because every other table here is scoped that way.
//
// NO METHOD HERE APPLIES A POLICY. The ladder — how many failures before a backoff, how long a
// lockout lasts — lives in `secrets/passcode.ts`, because it is a decision rather than a storage
// concern, and because a repository that decided when to lock somebody out would be a repository
// nobody could test the ladder of without a database.

import { asBool, jsonFromColumn, type Db, type Queryable } from "../db.ts";
import type { TenantContext } from "../tenant.ts";

export interface PasscodeRow {
  user_id: string;
  hash: string;
  salt: string;
  /** `scrypt` today. Stored so a hash made under one algorithm stays verifiable under another. */
  algo: string;
  /**
   * The cost parameters this hash was made with.
   *
   * Beside the hash rather than compiled into the application, so the cost can be raised later
   * without invalidating everybody's passcode: a verify that succeeds against the STORED
   * parameters is re-hashed under the current ones. Parameters held only in code would make every
   * historical hash unverifiable the day somebody tuned them.
   */
  params: Record<string, unknown>;
  failed_attempts: number;
  locked_until: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PasscodeInput {
  hash: string;
  salt: string;
  algo: string;
  params: Record<string, unknown>;
}

export class SecretPasscodeRepository {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  /**
   * This user's passcode record, or undefined when they have never set one.
   *
   * Returning the hash is not a leak of the passcode — that is what a hash is for — but nothing
   * above this layer may serialise the row, and the route layer never does: it hands the row to
   * the verifier and returns a boolean. The one caller that touches `params` is the re-hash path.
   */
  async get(ctx: TenantContext, userId: string): Promise<PasscodeRow | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT user_id, hash, salt, algo, params, failed_attempts, locked_until, last_verified_at,
              created_at, updated_at
         FROM user_secret_passcodes WHERE workspace_id = ? AND user_id = ?`,
      [ctx.workspaceId, userId],
    );
    if (!row) return undefined;
    const params = jsonFromColumn(this.db.dialect, row["params"]);
    return {
      user_id: String(row["user_id"]),
      hash: String(row["hash"]),
      salt: String(row["salt"]),
      algo: String(row["algo"]),
      params: params && typeof params === "object" ? (params as Record<string, unknown>) : {},
      failed_attempts: Number(row["failed_attempts"] ?? 0),
      locked_until: (row["locked_until"] as string | null) ?? null,
      last_verified_at: (row["last_verified_at"] as string | null) ?? null,
      created_at: String(row["created_at"]),
      updated_at: String(row["updated_at"]),
    };
  }

  /** Whether this user has one at all, without reading the hash to find out. */
  async exists(ctx: TenantContext, userId: string): Promise<boolean> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT 1 AS present FROM user_secret_passcodes WHERE workspace_id = ? AND user_id = ?`,
      [ctx.workspaceId, userId],
    );
    return asBool(row?.["present"] ?? false);
  }

  /**
   * Set or replace it, clearing the lockout.
   *
   * CLEARING THE COUNTERS IS PART OF SETTING ONE, not a separate step somebody could forget.
   * Reaching this method means an identity was proved to a higher standard than a passcode — a
   * fresh IdP login — so leaving a lockout from before that in place would lock somebody out of
   * a credential they just re-proved they own.
   */
  async put(ctx: TenantContext, userId: string, input: PasscodeInput): Promise<void> {
    const now = new Date().toISOString();
    await this.q(ctx).run(
      `INSERT INTO user_secret_passcodes
         (workspace_id, user_id, hash, salt, algo, params, failed_attempts, locked_until,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET
         hash            = excluded.hash,
         salt            = excluded.salt,
         algo            = excluded.algo,
         params          = excluded.params,
         failed_attempts = 0,
         locked_until    = NULL,
         updated_at      = excluded.updated_at`,
      [
        ctx.workspaceId,
        userId,
        input.hash,
        input.salt,
        input.algo,
        JSON.stringify(input.params),
        0,
        null,
        now,
        now,
      ],
    );
  }

  /**
   * Count one failure and report the new total.
   *
   * SERVER-SIDE, AND THAT IS THE ENTIRE POINT. A client-side attempt counter is advice to an
   * attacker, who is not running the client. This survives a page reload, a new tab, and a
   * different browser, because it is a column rather than a variable.
   *
   * Returns the total AFTER the increment so the caller can decide what the ladder says without a
   * second read — two round trips would also be two chances for concurrent attempts to read the
   * same number and each think they were the sixth.
   */
  async recordFailure(ctx: TenantContext, userId: string): Promise<number> {
    const now = new Date().toISOString();
    await this.q(ctx).run(
      `UPDATE user_secret_passcodes
          SET failed_attempts = failed_attempts + 1, updated_at = ?
        WHERE workspace_id = ? AND user_id = ?`,
      [now, ctx.workspaceId, userId],
    );
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT failed_attempts FROM user_secret_passcodes WHERE workspace_id = ? AND user_id = ?`,
      [ctx.workspaceId, userId],
    );
    return Number(row?.["failed_attempts"] ?? 0);
  }

  /** Hold this user out until the given moment. The ladder decides when; this records it. */
  async lock(ctx: TenantContext, userId: string, until: string): Promise<void> {
    await this.q(ctx).run(
      `UPDATE user_secret_passcodes SET locked_until = ?, updated_at = ?
        WHERE workspace_id = ? AND user_id = ?`,
      [until, new Date().toISOString(), ctx.workspaceId, userId],
    );
  }

  /** A correct passcode ends the run of failures and the lockout with it. */
  async recordSuccess(ctx: TenantContext, userId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.q(ctx).run(
      `UPDATE user_secret_passcodes
          SET failed_attempts = 0, locked_until = NULL, last_verified_at = ?, updated_at = ?
        WHERE workspace_id = ? AND user_id = ?`,
      [now, now, ctx.workspaceId, userId],
    );
  }
}
