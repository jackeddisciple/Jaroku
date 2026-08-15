// What a workspace has configured, by name.
//
// The store-agnostic half of the secrets layer. Both implementations write here — the local one
// keeps its values in a file and the hosted one keeps ciphertext in a table, and both record
// the SAME facts about which names exist, what they are for, and when a run last received one.
// That is what lets `listNames` be one query on both, and what lets the conformance suite
// assert the two are indistinguishable rather than asserting a shape.
//
// THERE IS NO METHOD HERE THAT TOUCHES A VALUE, because there is no column one would fit in.
// See migration 016.

import { randomUUID } from "node:crypto";

import { asBool, type Db, type Queryable } from "../db.ts";
import type { TenantContext } from "../tenant.ts";

export type SecretScope = "workspace" | "agent";

/**
 * Where a secret came from, which decides what may be done to it.
 *
 * The three origins genuinely need different verbs, and that is the whole reason this column
 * exists rather than the UI guessing from the name. A user-pasted provider key can be rotated and
 * tested. A connector's OAuth token can only be RECONNECTED — offering "rotate" on it would be a
 * button that cannot work, because Jaroku does not own the credential's lifecycle at the far end.
 * A custom name can be rotated, revoked, and needs a blast-radius view before either.
 */
export type SecretKind = "provider_key" | "managed" | "custom";

/**
 * What is believed about a credential right now.
 *
 * `unknown` is the default and is not a synonym for `invalid`. A key nobody has probed yet is not
 * known to be broken, and rendering it as broken would send people rotating working credentials.
 */
export type SecretStatus = "valid" | "invalid" | "expiring" | "unknown";

export interface SecretRefRow {
  name: string;
  provider: string | null;
  scope: SecretScope;
  agent_id: string | null;
  configured: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  kind: SecretKind;
  /**
   * A display mask — `sk-ant-...4f2a`, or a row of dots.
   *
   * STORED, NEVER DERIVED. Computing it on read would mean decrypting on read, which is the one
   * thing the vault's shape exists to make impossible. It is written at the moment the value
   * passes through `set`, and a value whose mask could not be derived carries a generic one
   * rather than opening a decrypt path for cosmetics.
   */
  masked_hint: string | null;
  status: SecretStatus;
  expires_at: string | null;
  rotated_at: string | null;
  created_by: string | null;
  connector_id: string | null;
  rotate_every_days: number | null;
}

export interface DeclareInput {
  name: string;
  provider?: string | null;
  scope?: SecretScope;
  agentId?: string | null;
  kind?: SecretKind;
  maskedHint?: string | null;
  status?: SecretStatus;
  expiresAt?: string | null;
  createdBy?: string | null;
  connectorId?: string | null;
  rotateEveryDays?: number | null;
}

/** A partial update of the non-sensitive metadata. Absent fields are left alone. */
export interface MetadataPatch {
  kind?: SecretKind;
  maskedHint?: string | null;
  status?: SecretStatus;
  expiresAt?: string | null;
  connectorId?: string | null;
  rotateEveryDays?: number | null;
  rotatedAt?: string | null;
}

/**
 * The counts behind the tab's warning dot.
 *
 * COUNTS AND NOTHING ELSE, deliberately. Whether something is expiring is not sensitive — it is
 * the sort of thing an ops dashboard shows — but WHICH credential is expiring names what a
 * workspace integrates with, and this is the one secrets answer served without elevation. A
 * shape with no room for a name cannot grow one by accident.
 */
export interface SecretHealth {
  total: number;
  expiringSoon: number;
  invalid: number;
  rotationDue: number;
  unusedNinetyDays: number;
}

export interface RotationRow {
  name: string;
  rotated_by: string | null;
  masked_hint: string | null;
  reason: string | null;
  rotated_at: string;
}

/**
 * Every column a caller may read, named once.
 *
 * `SELECT *` would be shorter and is the thing to avoid here above anywhere else: this table is
 * one migration away from somebody adding a column that should not travel, and a star would carry
 * it to every caller on the day it landed. Naming them means a new column is invisible until
 * somebody decides it should not be.
 */
const COLUMNS =
  `name, provider, scope, agent_id, configured, created_at, updated_at, last_used_at, ` +
  `kind, masked_hint, status, expires_at, rotated_at, created_by, connector_id, rotate_every_days`;

export class SecretRefRepository {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  private hydrate(row: Record<string, unknown>): SecretRefRow {
    return {
      name: String(row["name"]),
      provider: (row["provider"] as string | null) ?? null,
      scope: (row["scope"] as SecretScope) ?? "workspace",
      agent_id: (row["agent_id"] as string | null) ?? null,
      configured: asBool(row["configured"]),
      created_at: String(row["created_at"]),
      updated_at: String(row["updated_at"]),
      last_used_at: (row["last_used_at"] as string | null) ?? null,
      kind: (row["kind"] as SecretKind) ?? "custom",
      masked_hint: (row["masked_hint"] as string | null) ?? null,
      status: (row["status"] as SecretStatus) ?? "unknown",
      expires_at: (row["expires_at"] as string | null) ?? null,
      rotated_at: (row["rotated_at"] as string | null) ?? null,
      created_by: (row["created_by"] as string | null) ?? null,
      connector_id: (row["connector_id"] as string | null) ?? null,
      rotate_every_days:
        row["rotate_every_days"] === null || row["rotate_every_days"] === undefined
          ? null
          : Number(row["rotate_every_days"]),
    };
  }

  /**
   * Refuse an agent scope naming an agent this workspace does not have.
   *
   * Migration 018 makes the database refuse it too, and that key is the one that counts. This is
   * here for the message: a composite foreign key failing says "FOREIGN KEY constraint failed",
   * which tells whoever hit it nothing about which of the two columns was wrong.
   *
   * A soft-deleted agent counts as absent, deliberately — it is gone from every listing the user
   * sees, so a credential cannot newly be scoped to it. Rows declared before the delete keep
   * pointing at it; the foreign key is about existence and this is about a fresh declaration.
   */
  private async assertAgentIsOurs(ctx: TenantContext, agentId: string | null | undefined): Promise<void> {
    if (!agentId) return;
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT id FROM agents WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`,
      [ctx.workspaceId, agentId],
    );
    if (!row) throw new Error(`no such agent in this workspace: ${agentId}`);
  }

  /** Everything this workspace knows about, configured or merely declared. Sorted by name. */
  async list(ctx: TenantContext): Promise<SecretRefRow[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${COLUMNS}
         FROM secret_refs WHERE workspace_id = ? ORDER BY name`,
      [ctx.workspaceId],
    );
    return rows.map((r) => this.hydrate(r));
  }

  async get(ctx: TenantContext, name: string): Promise<SecretRefRow | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${COLUMNS}
         FROM secret_refs WHERE workspace_id = ? AND name = ?`,
      [ctx.workspaceId, name],
    );
    return row ? this.hydrate(row) : undefined;
  }

  /**
   * Say a name EXISTS without saying it is set.
   *
   * What an agent's `required_env` produces: the panel asking a user to fill something in needs
   * to render the name with an empty state beside it, and a design where absence meant "not
   * configured" could not tell "this agent needs it and you have not set it" from "nobody has
   * ever mentioned that name".
   *
   * Never clears `configured`. Declaring a name that is already set must not un-set it — the
   * two facts arrive from different places (an agent's manifest, and a user typing a value) and
   * either order has to be safe.
   */
  async declare(ctx: TenantContext, input: DeclareInput): Promise<void> {
    await this.assertAgentIsOurs(ctx, input.agentId);
    const now = new Date().toISOString();
    // THE METADATA COLUMNS ARE ABSENT FROM THIS STATEMENT ON PURPOSE, and the omission is the
    // careful part. `kind` and `status` are NOT NULL with defaults, so an upsert naming them would
    // have to supply a value on every call — and `COALESCE(excluded.kind, ...)` cannot rescue that,
    // because the supplied value is never null. The result would be a re-declaration silently
    // resetting a classified provider key back to 'custom' every time an agent's manifest
    // mentioned its name. Creation-time defaults fill them on INSERT; `setMetadata` is how they
    // change afterwards, and it only ever writes the fields it was actually given.
    await this.q(ctx).run(
      `INSERT INTO secret_refs (workspace_id, name, provider, scope, agent_id, configured,
         created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, name) DO UPDATE SET
         provider   = COALESCE(excluded.provider, secret_refs.provider),
         scope      = excluded.scope,
         agent_id   = excluded.agent_id,
         updated_at = excluded.updated_at`,
      [
        ctx.workspaceId,
        input.name,
        input.provider ?? null,
        input.scope ?? "workspace",
        input.agentId ?? null,
        0,
        now,
        now,
        input.createdBy ?? null,
      ],
    );
    await this.setMetadata(ctx, input.name, input);
  }

  /** Record that a value is now set under this name. Called by every store's `set`. */
  async markConfigured(ctx: TenantContext, input: DeclareInput): Promise<void> {
    await this.assertAgentIsOurs(ctx, input.agentId);
    const now = new Date().toISOString();
    await this.q(ctx).run(
      `INSERT INTO secret_refs (workspace_id, name, provider, scope, agent_id, configured,
         created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, name) DO UPDATE SET
         provider   = COALESCE(excluded.provider, secret_refs.provider),
         configured = ?,
         updated_at = excluded.updated_at`,
      [
        ctx.workspaceId,
        input.name,
        input.provider ?? null,
        input.scope ?? "workspace",
        input.agentId ?? null,
        1,
        now,
        now,
        input.createdBy ?? null,
        1,
      ],
    );
    // Same reasoning as `declare`: the metadata is a separate write that touches only what it was
    // told about, so the two stores can keep calling this with the four fields they always have.
    await this.setMetadata(ctx, input.name, input);
  }

  /**
   * Update the non-sensitive metadata, writing only the fields actually supplied.
   *
   * A partial update rather than a whole-row write, because the callers know different halves: the
   * store's `set` knows the mask and the kind, a provider probe knows only the status, and a
   * rotation knows only that it happened. A method taking a full row would make each of them
   * read-modify-write, and two of those racing is how a status overwrites a mask.
   *
   * NOTHING HERE CAN WRITE A VALUE. Every field is a classification, a timestamp or a mask, and
   * the table has no column a credential would fit in — see migration 016.
   */
  async setMetadata(ctx: TenantContext, name: string, patch: MetadataPatch): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      args.push(value);
    };
    // `in` rather than a truthiness check, so an explicit null — "this no longer expires", "this
    // has no mask" — is a value somebody meant rather than a field that gets skipped.
    if (patch.kind !== undefined) put("kind", patch.kind);
    if (patch.maskedHint !== undefined) put("masked_hint", patch.maskedHint);
    if (patch.status !== undefined) put("status", patch.status);
    if (patch.expiresAt !== undefined) put("expires_at", patch.expiresAt);
    if (patch.connectorId !== undefined) put("connector_id", patch.connectorId);
    if (patch.rotateEveryDays !== undefined) put("rotate_every_days", patch.rotateEveryDays);
    if (patch.rotatedAt !== undefined) put("rotated_at", patch.rotatedAt);
    if (!sets.length) return;
    put("updated_at", new Date().toISOString());
    await this.q(ctx).run(
      `UPDATE secret_refs SET ${sets.join(", ")} WHERE workspace_id = ? AND name = ?`,
      [...args, ctx.workspaceId, name],
    );
  }

  /**
   * The counts behind the tab's warning dot.
   *
   * SERVED WITHOUT ELEVATION, which is why it counts rather than lists. "Something needs attention"
   * is not a secret; "your STRIPE_SECRET_KEY expires on Thursday" names what a workspace
   * integrates with, and the gate exists to hold that back. One query, five numbers, no room for
   * a name in the shape it returns.
   *
   * Computed in SQL rather than by reading every row and counting in Node, because this runs on
   * every tab render for every open client and the alternative is the whole table each time.
   */
  async health(ctx: TenantContext, now: Date = new Date()): Promise<SecretHealth> {
    const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const nowIso = now.toISOString();
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT
         COUNT(*)                                                                   AS total,
         SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expiring,
         SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END)                        AS invalid,
         SUM(CASE WHEN COALESCE(last_used_at, updated_at) <= ? THEN 1 ELSE 0 END)   AS unused
       FROM secret_refs
       WHERE workspace_id = ? AND configured = ?`,
      // A CREDENTIAL NOBODY HAS EVER READ IS THE MOST UNUSED ONE THERE IS, and `last_used_at IS NOT
      // NULL` used to exclude exactly those — the count answered only for credentials that had been
      // used and then stopped, which is the smaller half of the question. For a row that has never
      // been read the clock starts at `updated_at`, not `created_at`: a name an agent's manifest
      // declared a year ago and somebody filled in yesterday is a day old as a credential, and
      // warning about it would be a false alarm on the day it was added.
      [soon, ninetyDaysAgo, ctx.workspaceId, 1],
    );
    const n = (key: string): number => Number(row?.[key] ?? 0);
    return {
      total: n("total"),
      expiringSoon: n("expiring"),
      invalid: n("invalid"),
      rotationDue: await this.rotationDue(ctx, now),
      unusedNinetyDays: n("unused"),
    };
  }

  /**
   * How many credentials are past their own rotation schedule.
   *
   * ITS OWN QUERY, AND COUNTED IN NODE, because the comparison is per-row: a credential is due when
   * the last rotation is older than ITS `rotate_every_days`, and that is date arithmetic the two
   * dialects spell differently. The version this replaces sidestepped that by comparing every row
   * against a flat ninety days, which under-reported every schedule shorter than ninety — a
   * thirty-day key rotated forty-five days ago counted as fine, and thirty, sixty and ninety are
   * the schedules people actually pick. A badge that stays dark when something is overdue is the
   * one direction this must not be wrong in.
   *
   * Reading rows rather than aggregating is affordable here in a way it would not be for the four
   * counts above: the filter is `rotate_every_days IS NOT NULL`, which is the handful of credentials
   * somebody has deliberately put on a schedule, not the table.
   */
  private async rotationDue(ctx: TenantContext, now: Date): Promise<number> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT rotate_every_days, COALESCE(rotated_at, created_at) AS since
         FROM secret_refs
        WHERE workspace_id = ? AND configured = ? AND rotate_every_days IS NOT NULL`,
      [ctx.workspaceId, 1],
    );
    let due = 0;
    for (const r of rows) {
      const days = Number(r["rotate_every_days"]);
      // A schedule that is not a positive number is not a schedule. Skipped rather than treated as
      // "due immediately", which would light the badge permanently for a bad row nobody can fix
      // from the UI.
      if (!Number.isFinite(days) || days <= 0) continue;
      const since = Date.parse(String(r["since"]));
      if (!Number.isFinite(since)) continue;
      if (now.getTime() - since >= days * 24 * 60 * 60 * 1000) due++;
    }
    return due;
  }

  /**
   * Write down that a credential was replaced.
   *
   * METADATA ONLY — when, who, why, and the mask of what replaced it. There is no column the old
   * value would fit in, because rotation REPLACES rather than versions: keeping the superseded
   * credential readable is the opposite of what rotating one is for.
   */
  async recordRotation(
    ctx: TenantContext,
    entry: { name: string; rotatedBy?: string | null; maskedHint?: string | null; reason?: string | null },
  ): Promise<void> {
    const at = new Date().toISOString();
    await this.q(ctx).run(
      `INSERT INTO secret_rotations (id, workspace_id, name, rotated_by, masked_hint, reason, rotated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        ctx.workspaceId,
        entry.name,
        entry.rotatedBy ?? null,
        entry.maskedHint ?? null,
        entry.reason ?? null,
        at,
      ],
    );
    await this.setMetadata(ctx, entry.name, { rotatedAt: at });
  }

  /** A credential's rotation history, newest first. */
  async rotations(ctx: TenantContext, name: string, limit = 50): Promise<RotationRow[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT name, rotated_by, masked_hint, reason, rotated_at
         FROM secret_rotations WHERE workspace_id = ? AND name = ?
        ORDER BY rotated_at DESC LIMIT ?`,
      [ctx.workspaceId, name, limit],
    );
    return rows.map((r) => ({
      name: String(r["name"]),
      rotated_by: (r["rotated_by"] as string | null) ?? null,
      masked_hint: (r["masked_hint"] as string | null) ?? null,
      reason: (r["reason"] as string | null) ?? null,
      rotated_at: String(r["rotated_at"]),
    }));
  }

  /**
   * Record that a value is gone, keeping the name.
   *
   * The row survives a deletion on purpose. A name an agent still declares is still a name the
   * user needs to see, now with an empty state beside it — dropping the row would make the
   * panel forget what the agent asked for the moment somebody cleared a value.
   */
  async markCleared(ctx: TenantContext, name: string): Promise<void> {
    await this.q(ctx).run(
      `UPDATE secret_refs SET configured = ?, last_used_at = NULL, updated_at = ?
        WHERE workspace_id = ? AND name = ?`,
      [0, new Date().toISOString(), ctx.workspaceId, name],
    );
  }

  /** Forget the name entirely. For a declaration nothing needs any more. */
  async forget(ctx: TenantContext, name: string): Promise<void> {
    await this.q(ctx).run(`DELETE FROM secret_refs WHERE workspace_id = ? AND name = ?`, [
      ctx.workspaceId,
      name,
    ]);
  }

  /**
   * Record that a run received these values.
   *
   * Written by the READ path, which is the only one that knows. "When was this last set" tells
   * you nothing about whether anything still needs it; "when did a run last receive it" is the
   * question anybody asks before deleting a credential.
   *
   * Takes a workspace id rather than a context because its caller is `getForRun`, which has a
   * run and resolves a workspace from it — there is no requesting context at that point, by
   * design. See secrets/secretStore.ts.
   */
  async touch(workspaceId: string, names: string[]): Promise<void> {
    if (!names.length) return;
    await this.db.forWorkspace(workspaceId).run(
      `UPDATE secret_refs SET last_used_at = ?
        WHERE workspace_id = ? AND name IN (${names.map(() => "?").join(", ")})`,
      [new Date().toISOString(), workspaceId, ...names],
    );
  }
}
