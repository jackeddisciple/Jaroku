// The rows behind per-agent access. One table, and nothing here decides anything.
//
// THE SPLIT THIS FILE EXISTS TO KEEP. `auth/capabilities.ts` holds the matrix and the one resolver
// that reads it; this holds the SQL. The resolver asks this for a grant and gets a row or nothing —
// it never asks "may they", because the moment a repository could answer that there would be two
// places that answer it, and the second one is the one that goes stale. Every method here is a
// read or a write of rows, and the only judgement in the file is what a malformed `capabilities`
// column means (nothing, rather than everything).
//
// `capabilities` IS text[] ON POSTGRES AND JSON TEXT ON SQLITE, which is the one thing in this file
// that has to know which driver it is on. It is the same translation `turn_feedback.reasons` makes,
// with the same rule attached: NOTHING QUERIES INTO IT. `= ANY(capabilities)` exists on one driver
// and not the other, so a filter written that way is green in every local suite and a runtime error
// in production — one of the four dialect bugs that cost four red CI runs in a row. The set is
// always loaded whole and intersected in TypeScript, over a list at most seven long, which is what
// the resolver has to do anyway because the intersection with the role's ceiling is not expressible
// in SQL on either driver.
//
// EVERY METHOD TAKES A CONTEXT FIRST and reaches the database through `forWorkspace`, which is
// `test:db-boundary`'s two rules. On this table the second one is not a style preference: RLS is
// what stops a grant being read across a tenant boundary on Postgres, and an unscoped connection is
// one where the policy has nothing to compare against.

import { jsonFromColumn, type Db, type Queryable } from "../db.ts";
import type { TenantContext } from "../tenant.ts";
import { isAgentCapability, type AgentCapability } from "../../auth/capabilities.ts";

/** One row, hydrated. `capabilities` is the stored set, NOT the effective one — see the resolver. */
export interface AgentGrant {
  workspace_id: string;
  agent_id: string;
  user_id: string;
  capabilities: AgentCapability[];
  granted_by: string;
  granted_at: string;
  /** ISO-8601, or null for "never". Compared at resolution time; nothing sweeps it. */
  expires_at: string | null;
  note: string | null;
}

export interface WriteGrant {
  agentId: string;
  userId: string;
  capabilities: readonly AgentCapability[];
  grantedBy: string;
  expiresAt?: string | null;
  note?: string | null;
}

export class AgentGrantRepository {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  /**
   * The stored set, or a JSON/array column that could not be read as one.
   *
   * A MALFORMED COLUMN RESOLVES TO THE EMPTY SET, never to the full one. It is the only judgement
   * in this file and it is the safe direction: a row nobody can parse is a row nobody should be
   * trusted by, and the effective access falls back to whatever the workspace role gives — which
   * is where somebody's access was before anybody wrote a grant. The opposite reading would turn
   * one bad row into seven capabilities on an agent.
   *
   * Unknown strings are dropped rather than kept, for the same reason: a capability this build
   * does not recognise is one it cannot enforce, so carrying it forward would put a word in a chip
   * on the Access tab that nothing in the server acts on.
   */
  private capabilitiesFrom(raw: unknown): AgentCapability[] {
    const value = this.db.dialect === "postgres" ? raw : jsonFromColumn("sqlite", raw);
    return Array.isArray(value) ? value.filter(isAgentCapability) : [];
  }

  private hydrate(row: Record<string, unknown>): AgentGrant {
    return {
      workspace_id: String(row["workspace_id"]),
      agent_id: String(row["agent_id"]),
      user_id: String(row["user_id"]),
      capabilities: this.capabilitiesFrom(row["capabilities"]),
      granted_by: String(row["granted_by"]),
      granted_at: String(row["granted_at"]),
      expires_at: (row["expires_at"] as string | null) ?? null,
      note: (row["note"] as string | null) ?? null,
    };
  }

  private stored(capabilities: readonly AgentCapability[]): unknown {
    return this.db.dialect === "postgres" ? [...capabilities] : JSON.stringify([...capabilities]);
  }

  /** One person's grant on one agent, or undefined. The read the resolver makes on every command. */
  async find(ctx: TenantContext, agentId: string, userId: string): Promise<AgentGrant | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT workspace_id, agent_id, user_id, capabilities, granted_by, granted_at, expires_at, note
         FROM agent_grants
        WHERE workspace_id = ? AND agent_id = ? AND user_id = ?`,
      [ctx.workspaceId, agentId, userId],
    );
    return row ? this.hydrate(row) : undefined;
  }

  /** Every grant on one agent. The People section's read. */
  async listForAgent(ctx: TenantContext, agentId: string): Promise<AgentGrant[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT workspace_id, agent_id, user_id, capabilities, granted_by, granted_at, expires_at, note
         FROM agent_grants
        WHERE workspace_id = ? AND agent_id = ?
        ORDER BY granted_at ASC`,
      [ctx.workspaceId, agentId],
    );
    return rows.map((r) => this.hydrate(r));
  }

  /**
   * Write a grant, replacing whatever was there.
   *
   * AN UPSERT RATHER THAN INSERT-OR-UPDATE, which is §16's "two admins edit the same grant
   * concurrently: last write wins on a single row; history makes it visible". A read-then-write
   * would lose one of two concurrent edits with no row anywhere saying it happened; this loses one
   * of them with an `audit_log` entry for each, which is the difference between a race and an
   * unexplained permission.
   *
   * IT WRITES NO AUDIT ROW OF ITS OWN. The caller does, in the same transaction as everything else
   * it is doing — the `access.granted` / `access.modified` distinction is a fact about the command
   * that was sent, not about whether a row existed, and a repository that guessed which one to
   * write from the upsert's outcome would be guessing.
   */
  async upsert(ctx: TenantContext, grant: WriteGrant): Promise<void> {
    await this.q(ctx).run(
      `INSERT INTO agent_grants
         (workspace_id, agent_id, user_id, capabilities, granted_by, granted_at, expires_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, agent_id, user_id) DO UPDATE SET
         capabilities = excluded.capabilities,
         granted_by   = excluded.granted_by,
         granted_at   = excluded.granted_at,
         expires_at   = excluded.expires_at,
         note         = excluded.note`,
      [
        ctx.workspaceId,
        grant.agentId,
        grant.userId,
        this.stored(grant.capabilities),
        grant.grantedBy,
        new Date().toISOString(),
        grant.expiresAt ?? null,
        grant.note ?? null,
      ],
    );
  }

  /** Remove a grant. `false` when there was none, which is what makes a double-revoke sayable. */
  async remove(ctx: TenantContext, agentId: string, userId: string): Promise<boolean> {
    const res = await this.q(ctx).run(
      `DELETE FROM agent_grants WHERE workspace_id = ? AND agent_id = ? AND user_id = ?`,
      [ctx.workspaceId, agentId, userId],
    );
    return res.changes > 0;
  }
}
