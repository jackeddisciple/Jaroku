// MCP server registry — additive control-plane tables only.
//
// THE FROZEN SCHEMA IS UNTOUCHED. schema/events.md v1 stays exactly as it is, and an MCP
// tool call is not a new event type: it is an ORDINARY tool_call Step, emitted by the same
// JarokuTracer callback as any other tool. Nothing in this file is ever read by the trace
// pipeline. It is the same discipline as pause/resume/branch (store.ts:56-62) and the eval
// engine (evalStore.ts:1-25): data the event schema doesn't carry goes into new tables
// BESIDE it, never into the event shape.
//
// The reason MCP gets its own registry rather than a row in tool_templates/catalog.json is
// that the two are opposites in every respect that matters:
//
//                     reviewed connector            MCP server
//   provenance        hand-audited by us            third-party, unread
//   tool list         declared in a catalog         DISCOVERED at runtime, can change
//   parameters        a display-only signature      a machine-readable JSON Schema
//   output            trusted (we wrote it)         untrusted input
//
// Modelling the second as the first would launder unreviewed code through a type whose
// entire meaning is "audited". So: separate tables, separate vocabulary, separate badge.
//
// Three decisions worth stating up front, because each is load-bearing for the trust model:
//
//   * NO CREDENTIAL IS EVER STORED HERE. `mcp_servers.auth_env_key` holds the NAME of an
//     environment variable and nothing else. The value lives in runtime/.env, read by the
//     same loader as every other key, and never travels back to a client. See envWriter.ts.
//
//   * `impact` is computed at DISCOVERY and stored WITH ITS REASON, not recomputed at call
//     time. A gate that can silently change its mind between the plan and the run is not a
//     gate. The reason is stored because a user asked to approve something deserves to know
//     why they are being asked — see mcpImpact.ts.
//
//   * `schema_hash` exists to void a stale override. A user may lower a tool from high to
//     low, but that judgement was made against a specific schema. If the server later
//     changes the tool's parameters, the judgement no longer applies to the thing it was
//     made about, and the tool silently reverts to its computed classification. A
//     third-party server quietly widening a tool it already talked you into trusting is
//     exactly the rug-pull this defends against.

import { createHash, randomUUID } from "node:crypto";
import { jsonFromColumn, type Db, type Queryable } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";

// --- row shapes --------------------------------------------------------------

/** Only remote HTTP transport is supported. stdio would mean running third-party binaries. */
export type McpTransport = "http";

export type McpServerStatus =
  /** Handshake succeeded; `tools` below are what it advertised. */
  | "connected"
  /** Could not be reached — DNS, refused, reset, timeout. Usually transient. */
  | "unreachable"
  /** Reached, but it wants credentials we don't have (or ours were rejected). */
  | "auth_required"
  /** Reached and answered, but the answer wasn't a usable MCP handshake. */
  | "error";

export interface McpServer {
  /** Slug, `^[a-z][a-z0-9_]{0,31}$`. Appears in env key names and in the agent manifest. */
  id: string;
  label: string;
  endpoint: string;
  transport: McpTransport;
  /**
   * The NAME of the env var holding this server's credential, or null when it needs none.
   * Never the value. Nothing in this process ever puts a secret in this column.
   */
  auth_env_key: string | null;
  /** From the handshake's serverInfo — the server's own claim about its identity. */
  server_name: string | null;
  server_version: string | null;
  protocol_version: string | null;
  status: McpServerStatus;
  /** The real failure text, kept so the UI can show something actionable. */
  last_error: string | null;
  /** When the tool list below was last refreshed. Null until a handshake has succeeded. */
  discovered_at: string | null;
  created_at: string;
}

export type McpImpact = "high" | "low";

export interface McpTool {
  id: string;
  server_id: string;
  name: string;
  description: string | null;
  /** The tool's declared JSON Schema, exactly as advertised. Drives args + validation. */
  input_schema: Record<string, unknown>;
  /** sha256 over the canonicalised input_schema. Voids a stale impact override. */
  schema_hash: string;
  /** Computed by mcpImpact.classify(). Never trusted to the server alone. */
  impact: McpImpact;
  /** Why `impact` came out the way it did, in words, for the UI and the confirm modal. */
  impact_reason: string;
  /** A user's explicit override, or null. Only honoured while the schema is unchanged. */
  impact_override: McpImpact | null;
  /** The schema_hash the override was made against. */
  override_schema_hash: string | null;
  /** The server's own ToolAnnotations, kept verbatim for display. May only RAISE impact. */
  annotations: Record<string, unknown> | null;
  discovered_at: string;
}

/** A discovered tool before it has a row — what mcpClient hands the registration pipeline. */
export interface DiscoveredTool {
  name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
  annotations: Record<string, unknown> | null;
  impact: McpImpact;
  impact_reason: string;
}

// --- helpers -----------------------------------------------------------------

const nowIso = (): string => new Date().toISOString();

/** Slug rule, deliberately tighter than the agent-id rule: this becomes part of an env key. */
export const SERVER_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Stable stringify: object keys sorted at every depth, so two schemas that differ only in
 * key order hash the same. Without this, a server re-serialising its own schema would void
 * every override it has — a false alarm that trains people to ignore real ones.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashSchema(schema: unknown): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}

/**
 * The impact that actually governs the gate.
 *
 * An override applies only while it still describes the tool it was made about. Once the
 * schema moves, the override is inert and the computed classification governs again — it is
 * not deleted, so the UI can say "your override no longer applies" rather than silently
 * losing it.
 */
export function effectiveImpact(tool: McpTool): McpImpact {
  if (tool.impact_override && tool.override_schema_hash === tool.schema_hash) {
    return tool.impact_override;
  }
  return tool.impact;
}

/** True when a stored override has been voided by a schema change — a UI-worthy state. */
export function overrideVoided(tool: McpTool): boolean {
  return tool.impact_override !== null && tool.override_schema_hash !== tool.schema_hash;
}

/** `"linear/create_issue"` — how a scoped tool is named on the wire and in the manifest. */
export function toolRef(serverId: string, toolName: string): string {
  return `${serverId}/${toolName}`;
}

export function parseToolRef(ref: string): { serverId: string; toolName: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { serverId: ref.slice(0, slash), toolName: ref.slice(slash + 1) };
}

// --- store -------------------------------------------------------------------

// Explicit column lists — `SELECT *` would put workspace_id on the registry snapshot every
// connected client receives.
const SERVER_COLUMNS = `id, label, endpoint, transport, auth_env_key, server_name,
                        server_version, protocol_version, status, last_error, discovered_at,
                        created_at`;
const TOOL_COLUMNS = `id, server_id, name, description, input_schema, schema_hash, impact,
                      impact_reason, impact_override, override_schema_hash, annotations,
                      discovered_at`;

export class McpStore {
  // Shares the trace store's database: same file, single writer. See TraceStore.database().
  //
  // A server id is a slug — "linear", "github", "mock" — so it is per workspace, not global.
  // Before that was true, the second workspace to connect the same service would not collide
  // but UPDATE: `upsertServer` would repoint somebody else's server at your endpoint and hand
  // your agents their tools.
  constructor(private db: Db) {}

  // No `init()`, because there is nothing to do. These tables come from migration 002 on
  // both drivers and no column has ever been added to them after the fact. When one is,
  // copy the `ensureColumn` helper from store.ts or evalStore.ts — an existing database has
  // no migration row saying it is missing a column, so a migration cannot know to add it.

  /**
   * The database, scoped to a request's workspace.
   *
   * Every read and write in this class goes through it, so on Postgres each statement carries
   * the SET LOCAL the RLS policies read. On SQLite it is the connection itself — no RLS to
   * scope — which is why the substitution is uniform and costs that driver nothing.
   */
  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  /** Dialect-aware, for the reason jsonFromColumn documents. */
  private parseJson<T>(v: unknown, fallback: T): T {
    const parsed = jsonFromColumn(this.db.dialect, v);
    return parsed === null || typeof parsed === "string" ? fallback : (parsed as T);
  }

  private static hydrateServer(row: Record<string, unknown>): McpServer {
    return row as unknown as McpServer;
  }

  private hydrateTool(row: Record<string, unknown>): McpTool {
    return {
      ...row,
      input_schema: this.parseJson<Record<string, unknown>>(row["input_schema"], {}),
      annotations: this.parseJson<Record<string, unknown> | null>(row["annotations"], null),
    } as McpTool;
  }

  // --- servers ---------------------------------------------------------------

  async listServers(ctx: TenantContext): Promise<McpServer[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${SERVER_COLUMNS} FROM mcp_servers WHERE workspace_id = ? ORDER BY created_at ASC`,
      [ctx.workspaceId],
    );
    return rows.map(McpStore.hydrateServer);
  }

  async getServer(ctx: TenantContext, id: string): Promise<McpServer | null> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${SERVER_COLUMNS} FROM mcp_servers WHERE id = ? AND workspace_id = ?`,
      [id, ctx.workspaceId],
    );
    return row ? McpStore.hydrateServer(row) : null;
  }

  /**
   * Create or replace a server row. Re-registering an existing id keeps `created_at` so the
   * list doesn't reshuffle under a re-discovery.
   */
  async upsertServer(
    ctx: TenantContext,
    input: Omit<McpServer, "created_at"> & { created_at?: string },
  ): Promise<McpServer> {
    const existing = await this.getServer(ctx, input.id);
    const row: McpServer = {
      ...input,
      created_at: input.created_at ?? existing?.created_at ?? nowIso(),
    };
    await this.q(ctx).run(
      `INSERT INTO mcp_servers
         (workspace_id, id, label, endpoint, transport, auth_env_key, server_name,
          server_version, protocol_version, status, last_error, discovered_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, id) DO UPDATE SET
         label            = excluded.label,
         endpoint         = excluded.endpoint,
         transport        = excluded.transport,
         auth_env_key     = excluded.auth_env_key,
         server_name      = excluded.server_name,
         server_version   = excluded.server_version,
         protocol_version = excluded.protocol_version,
         status           = excluded.status,
         last_error       = excluded.last_error,
         discovered_at    = excluded.discovered_at`,
      [
        ctx.workspaceId,
        row.id,
        row.label,
        row.endpoint,
        row.transport,
        row.auth_env_key,
        row.server_name,
        row.server_version,
        row.protocol_version,
        row.status,
        row.last_error,
        row.discovered_at,
        row.created_at,
      ],
    );
    return row;
  }

  /**
   * Record the outcome of a handshake attempt WITHOUT touching the tool list.
   *
   * Deliberate: a server that is briefly unreachable must not lose its discovered tools.
   * Wiping them would break every agent scoped to them on a transient network blip, and
   * "the tools vanished" is a far worse failure than "the status says unreachable".
   */
  async setServerStatus(
    ctx: TenantContext,
    id: string,
    status: McpServerStatus,
    lastError: string | null,
  ): Promise<void> {
    await this.q(ctx).run(
      `UPDATE mcp_servers SET status = ?, last_error = ? WHERE id = ? AND workspace_id = ?`,
      [status, lastError, id, ctx.workspaceId],
    );
  }

  /** Records the env var NAME. The value never passes through this module. */
  async setServerAuthEnvKey(ctx: TenantContext, id: string, envKey: string | null): Promise<void> {
    await this.q(ctx).run(`UPDATE mcp_servers SET auth_env_key = ? WHERE id = ? AND workspace_id = ?`, [
      envKey,
      id,
      ctx.workspaceId,
    ]);
  }

  async deleteServer(ctx: TenantContext, id: string): Promise<void> {
    await this.db.scoped(ctx.workspaceId, async (tx: Queryable) => {
      await tx.run(`DELETE FROM mcp_tools WHERE server_id = ? AND workspace_id = ?`, [id, ctx.workspaceId]);
      await tx.run(`DELETE FROM mcp_servers WHERE id = ? AND workspace_id = ?`, [id, ctx.workspaceId]);
    });
  }

  // --- tools -----------------------------------------------------------------

  async listTools(ctx: TenantContext, serverId?: string): Promise<McpTool[]> {
    const rows = serverId
      ? await this.q(ctx).all<Record<string, unknown>>(
          `SELECT ${TOOL_COLUMNS} FROM mcp_tools
            WHERE server_id = ? AND workspace_id = ? ORDER BY name ASC`,
          [serverId, ctx.workspaceId],
        )
      : await this.q(ctx).all<Record<string, unknown>>(
          `SELECT ${TOOL_COLUMNS} FROM mcp_tools
            WHERE workspace_id = ? ORDER BY server_id ASC, name ASC`,
          [ctx.workspaceId],
        );
    return rows.map((r) => this.hydrateTool(r));
  }

  async getTool(ctx: TenantContext, serverId: string, name: string): Promise<McpTool | null> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${TOOL_COLUMNS} FROM mcp_tools WHERE server_id = ? AND name = ? AND workspace_id = ?`,
      [serverId, name, ctx.workspaceId],
    );
    return row ? this.hydrateTool(row) : null;
  }

  /**
   * Resolve `"server/tool"` refs to rows, silently dropping any that no longer exist.
   *
   * The same posture as connectors.resolveSelected(): never trust a caller's list verbatim.
   * A ref naming a removed server or a tool the server stopped advertising resolves to
   * nothing rather than to a guess.
   */
  async resolveTools(ctx: TenantContext, refs: string[]): Promise<McpTool[]> {
    const out: McpTool[] = [];
    for (const ref of refs) {
      const parsed = parseToolRef(ref);
      if (!parsed) continue;
      const tool = await this.getTool(ctx, parsed.serverId, parsed.toolName);
      if (tool) out.push(tool);
    }
    return out;
  }

  /**
   * Replace a server's advertised tool list with a freshly discovered one, in one
   * transaction. Only ever called after a SUCCESSFUL handshake.
   *
   * User overrides survive across re-discovery, carried forward by tool NAME along with the
   * schema_hash they were made against. effectiveImpact() then decides whether that
   * judgement still applies — see the header note on schema_hash.
   */
  async replaceTools(
    ctx: TenantContext,
    serverId: string,
    discovered: DiscoveredTool[],
  ): Promise<McpTool[]> {
    const previous = new Map((await this.listTools(ctx, serverId)).map((t) => [t.name, t]));
    const at = nowIso();
    const rows: McpTool[] = discovered.map((d) => {
      const prior = previous.get(d.name);
      return {
        id: prior?.id ?? randomUUID(),
        server_id: serverId,
        name: d.name,
        description: d.description,
        input_schema: d.input_schema,
        schema_hash: hashSchema(d.input_schema),
        impact: d.impact,
        impact_reason: d.impact_reason,
        impact_override: prior?.impact_override ?? null,
        override_schema_hash: prior?.override_schema_hash ?? null,
        annotations: d.annotations,
        discovered_at: at,
      };
    });

    await this.db.scoped(ctx.workspaceId, async (tx: Queryable) => {
      await tx.run(`DELETE FROM mcp_tools WHERE server_id = ? AND workspace_id = ?`, [
        serverId,
        ctx.workspaceId,
      ]);
      for (const r of rows) {
        await tx.run(
          `INSERT INTO mcp_tools
             (workspace_id, id, server_id, name, description, input_schema, schema_hash,
              impact, impact_reason, impact_override, override_schema_hash, annotations,
              discovered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ctx.workspaceId,
            r.id,
            r.server_id,
            r.name,
            r.description,
            JSON.stringify(r.input_schema),
            r.schema_hash,
            r.impact,
            r.impact_reason,
            r.impact_override,
            r.override_schema_hash,
            r.annotations === null ? null : JSON.stringify(r.annotations),
            r.discovered_at,
          ],
        );
      }
      await tx.run(`UPDATE mcp_servers SET discovered_at = ? WHERE id = ? AND workspace_id = ?`, [
        at,
        serverId,
        ctx.workspaceId,
      ]);
    });
    return rows;
  }

  /**
   * Set or clear a user's impact override.
   *
   * Stamped with the schema it was judged against. Passing null clears it outright — the
   * way back to "just use the classifier" is always one click, in both directions.
   */
  async setToolImpactOverride(
    ctx: TenantContext,
    serverId: string,
    name: string,
    override: McpImpact | null,
  ): Promise<McpTool | null> {
    const tool = await this.getTool(ctx, serverId, name);
    if (!tool) return null;
    await this.q(ctx).run(
      `UPDATE mcp_tools SET impact_override = ?, override_schema_hash = ?
         WHERE server_id = ? AND name = ? AND workspace_id = ?`,
      [override, override === null ? null : tool.schema_hash, serverId, name, ctx.workspaceId],
    );
    return this.getTool(ctx, serverId, name);
  }
}
