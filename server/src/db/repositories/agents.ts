// The agent list, as a table.
//
// It used to be a directory listing: `readdir(runtime/agents/)` plus a parse of each
// project's jaroku.json. That is a fine source of truth for one machine and no source of
// truth at all for several — object storage has no directory to list, and stateless replicas
// have no shared disk to list from.
//
// So the table is authoritative and the directory is a cache it describes. The
// reconciliation runs disk → table, because on this side the disk is still where a project
// actually lives and a user may still drop one in by hand. Session 3 reverses that: files
// move to the object store, `agent_versions` gets a manifest per version, and the directory
// becomes a materialisation of the row rather than the other way round.

import { randomUUID } from "node:crypto";
import { asInt, asBool, jsonFromColumn, type Db } from "../db.ts";
import type { TenantContext } from "../tenant.ts";

/** Same pattern the runner enforces on the Python side. A slug is a directory name. */
export const SAFE_SLUG = /^[a-z][a-z0-9_]{0,63}$/;

export interface Agent {
  id: string;
  slug: string;
  display_name: string | null;
  description: string | null;
  connectors: string[];
  mcp_tools: string[];
  required_env: string[];
  default_provider: string;
  hand_written: boolean;
  current_version: number;
  creation_cost: number | null;
  created_at: string;
}

/** What the disk scan produces — the shape jaroku.json plus the directory can describe. */
export interface AgentOnDisk {
  slug: string;
  display_name?: string | null;
  description?: string | null;
  connectors?: string[];
  mcp_tools?: string[];
  required_env?: string[];
  default_provider?: string;
  hand_written?: boolean;
  creation_cost?: number | null;
  created_at?: string | null;
}

const COLUMNS = `id, slug, display_name, description, connectors, mcp_tools, required_env,
                 default_provider, hand_written, current_version, creation_cost, created_at`;

export class AgentRepository {
  constructor(private db: Db) {}

  private hydrate(row: Record<string, unknown>): Agent {
    const d = this.db.dialect;
    const arr = (v: unknown): string[] => {
      const parsed = jsonFromColumn(d, v);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    };
    return {
      ...(row as unknown as Agent),
      connectors: arr(row["connectors"]),
      mcp_tools: arr(row["mcp_tools"]),
      required_env: arr(row["required_env"]),
      hand_written: asBool(row["hand_written"]),
      current_version: asInt(row["current_version"], 1),
    };
  }

  /** Newest first, hand-written reference agents last — the order the sidebar renders. */
  async list(ctx: TenantContext): Promise<Agent[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM agents
        WHERE workspace_id = ? AND deleted_at IS NULL
        ORDER BY hand_written ASC, created_at DESC`,
      [ctx.workspaceId],
    );
    return rows.map((r) => this.hydrate(r));
  }

  async bySlug(ctx: TenantContext, slug: string): Promise<Agent | undefined> {
    const row = await this.db.get<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM agents WHERE workspace_id = ? AND slug = ? AND deleted_at IS NULL`,
      [ctx.workspaceId, slug],
    );
    return row ? this.hydrate(row) : undefined;
  }

  async byId(ctx: TenantContext, id: string): Promise<Agent | undefined> {
    const row = await this.db.get<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM agents WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`,
      [ctx.workspaceId, id],
    );
    return row ? this.hydrate(row) : undefined;
  }

  /**
   * Record what is on disk, keeping the row's identity.
   *
   * Upsert on (workspace_id, slug) rather than on id, because the disk has no uuid to offer —
   * a directory knows its name and nothing else. `created_at` is only set on insert, so a
   * re-sync does not keep reshuffling the sidebar.
   */
  async upsertFromDisk(ctx: TenantContext, a: AgentOnDisk): Promise<Agent> {
    if (!SAFE_SLUG.test(a.slug)) throw new Error(`not a usable agent id: ${a.slug}`);
    await this.db.run(
      `INSERT INTO agents (id, workspace_id, slug, display_name, description, connectors,
         mcp_tools, required_env, default_provider, hand_written, creation_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, slug) DO UPDATE SET
         display_name = excluded.display_name,
         description = excluded.description,
         connectors = excluded.connectors,
         mcp_tools = excluded.mcp_tools,
         required_env = excluded.required_env,
         default_provider = excluded.default_provider,
         hand_written = excluded.hand_written,
         creation_cost = excluded.creation_cost,
         deleted_at = NULL`,
      [
        randomUUID(),
        ctx.workspaceId,
        a.slug,
        a.display_name ?? null,
        a.description ?? null,
        JSON.stringify(a.connectors ?? []),
        JSON.stringify(a.mcp_tools ?? []),
        JSON.stringify(a.required_env ?? []),
        a.default_provider ?? "fake",
        a.hand_written ? 1 : 0,
        a.creation_cost ?? null,
        a.created_at ?? new Date().toISOString(),
      ],
    );
    return (await this.bySlug(ctx, a.slug))!;
  }

  /**
   * Reconcile the table against what is on disk.
   *
   * Soft-deletes rows whose directory has gone rather than deleting them, because runs, evals
   * and deployments still point at that agent by slug and a past comparison has to stay
   * readable after its agent is removed — the same reasoning `deleteDataset` follows.
   */
  async syncFromDisk(ctx: TenantContext, onDisk: AgentOnDisk[]): Promise<Agent[]> {
    for (const a of onDisk) {
      if (SAFE_SLUG.test(a.slug)) await this.upsertFromDisk(ctx, a);
    }
    const seen = new Set(onDisk.map((a) => a.slug));
    for (const existing of await this.list(ctx)) {
      if (!seen.has(existing.slug)) {
        await this.db.run(
          `UPDATE agents SET deleted_at = ? WHERE workspace_id = ? AND slug = ?`,
          [new Date().toISOString(), ctx.workspaceId, existing.slug],
        );
      }
    }
    return this.list(ctx);
  }

  /**
   * Record a new version of an agent's files and make it current, in one transaction.
   *
   * Unused by the write path today — `projectFs.atomicSwap` still moves a staging directory
   * into place — and here now because Session 3 replaces that swap with exactly this, at
   * which point undo becomes a pointer move instead of a snapshot copy and both work across
   * replicas. The manifest is {path: {sha256, bytes}}, so a version can be verified without
   * fetching it.
   */
  async addVersion(
    ctx: TenantContext,
    agentId: string,
    manifest: Record<string, { sha256: string; bytes: number }>,
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      const row = await tx.get<{ current_version: unknown }>(
        `SELECT current_version FROM agents WHERE id = ? AND workspace_id = ?`,
        [agentId, ctx.workspaceId],
      );
      if (!row) throw new Error(`no such agent in this workspace: ${agentId}`);
      const next = asInt(row.current_version, 0) + 1;
      await tx.run(
        `INSERT INTO agent_versions (id, agent_id, version, manifest, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), agentId, next, JSON.stringify(manifest), ctx.actorUserId, new Date().toISOString()],
      );
      await tx.run(`UPDATE agents SET current_version = ? WHERE id = ? AND workspace_id = ?`, [
        next,
        agentId,
        ctx.workspaceId,
      ]);
      return next;
    });
  }
}
