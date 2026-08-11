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

import { asBool, type Db, type Queryable } from "../db.ts";
import type { TenantContext } from "../tenant.ts";

export type SecretScope = "workspace" | "agent";

export interface SecretRefRow {
  name: string;
  provider: string | null;
  scope: SecretScope;
  agent_id: string | null;
  configured: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface DeclareInput {
  name: string;
  provider?: string | null;
  scope?: SecretScope;
  agentId?: string | null;
}

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
      `SELECT name, provider, scope, agent_id, configured, created_at, updated_at, last_used_at
         FROM secret_refs WHERE workspace_id = ? ORDER BY name`,
      [ctx.workspaceId],
    );
    return rows.map((r) => this.hydrate(r));
  }

  async get(ctx: TenantContext, name: string): Promise<SecretRefRow | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT name, provider, scope, agent_id, configured, created_at, updated_at, last_used_at
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
    await this.q(ctx).run(
      `INSERT INTO secret_refs (workspace_id, name, provider, scope, agent_id, configured,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
      ],
    );
  }

  /** Record that a value is now set under this name. Called by every store's `set`. */
  async markConfigured(ctx: TenantContext, input: DeclareInput): Promise<void> {
    await this.assertAgentIsOurs(ctx, input.agentId);
    const now = new Date().toISOString();
    await this.q(ctx).run(
      `INSERT INTO secret_refs (workspace_id, name, provider, scope, agent_id, configured,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
        1,
      ],
    );
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
