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

import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";

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

export class McpStore {
  // Shares TraceStore's handle: same file, single writer. See TraceStore.connection().
  constructor(private db: DatabaseSync) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id               TEXT PRIMARY KEY,
        label            TEXT NOT NULL,
        endpoint         TEXT NOT NULL,
        transport        TEXT NOT NULL,
        auth_env_key     TEXT,
        server_name      TEXT,
        server_version   TEXT,
        protocol_version TEXT,
        status           TEXT NOT NULL,
        last_error       TEXT,
        discovered_at    TEXT,
        created_at       TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_tools (
        id                   TEXT PRIMARY KEY,
        server_id            TEXT NOT NULL,
        name                 TEXT NOT NULL,
        description          TEXT,
        input_schema         TEXT NOT NULL,
        schema_hash          TEXT NOT NULL,
        impact               TEXT NOT NULL,
        impact_reason        TEXT NOT NULL,
        impact_override      TEXT,
        override_schema_hash TEXT,
        annotations          TEXT,
        discovered_at        TEXT NOT NULL,
        UNIQUE (server_id, name),
        FOREIGN KEY (server_id) REFERENCES mcp_servers(id)
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_tools_server ON mcp_tools(server_id, name);
    `);
  }

  // No additive migrations yet — these tables are new. When one is needed, copy the
  // `ensureColumn` helper from store.ts:65 / evalStore.ts:257: CREATE TABLE IF NOT EXISTS
  // never alters an existing table.

  private static parseJson<T>(v: unknown, fallback: T): T {
    if (typeof v !== "string") return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }

  private static hydrateServer(row: Record<string, unknown>): McpServer {
    return row as unknown as McpServer;
  }

  private static hydrateTool(row: Record<string, unknown>): McpTool {
    return {
      ...row,
      input_schema: McpStore.parseJson<Record<string, unknown>>(row["input_schema"], {}),
      annotations: McpStore.parseJson<Record<string, unknown> | null>(row["annotations"], null),
    } as McpTool;
  }

  // --- servers ---------------------------------------------------------------

  listServers(): McpServer[] {
    const rows = this.db
      .prepare(`SELECT * FROM mcp_servers ORDER BY created_at ASC`)
      .all() as Record<string, unknown>[];
    return rows.map(McpStore.hydrateServer);
  }

  getServer(id: string): McpServer | null {
    const row = this.db.prepare(`SELECT * FROM mcp_servers WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? McpStore.hydrateServer(row) : null;
  }

  /**
   * Create or replace a server row. Re-registering an existing id keeps `created_at` so the
   * list doesn't reshuffle under a re-discovery.
   */
  upsertServer(
    input: Omit<McpServer, "created_at"> & { created_at?: string },
  ): McpServer {
    const existing = this.getServer(input.id);
    const row: McpServer = {
      ...input,
      created_at: input.created_at ?? existing?.created_at ?? nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO mcp_servers
           (id, label, endpoint, transport, auth_env_key, server_name, server_version,
            protocol_version, status, last_error, discovered_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
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
      )
      .run(
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
  setServerStatus(id: string, status: McpServerStatus, lastError: string | null): void {
    this.db
      .prepare(`UPDATE mcp_servers SET status = ?, last_error = ? WHERE id = ?`)
      .run(status, lastError, id);
  }

  /** Records the env var NAME. The value never passes through this module. */
  setServerAuthEnvKey(id: string, envKey: string | null): void {
    this.db.prepare(`UPDATE mcp_servers SET auth_env_key = ? WHERE id = ?`).run(envKey, id);
  }

  deleteServer(id: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM mcp_tools WHERE server_id = ?`).run(id);
      this.db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).run(id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // --- tools -----------------------------------------------------------------

  listTools(serverId?: string): McpTool[] {
    const rows = serverId
      ? (this.db
          .prepare(`SELECT * FROM mcp_tools WHERE server_id = ? ORDER BY name ASC`)
          .all(serverId) as Record<string, unknown>[])
      : (this.db
          .prepare(`SELECT * FROM mcp_tools ORDER BY server_id ASC, name ASC`)
          .all() as Record<string, unknown>[]);
    return rows.map(McpStore.hydrateTool);
  }

  getTool(serverId: string, name: string): McpTool | null {
    const row = this.db
      .prepare(`SELECT * FROM mcp_tools WHERE server_id = ? AND name = ?`)
      .get(serverId, name) as Record<string, unknown> | undefined;
    return row ? McpStore.hydrateTool(row) : null;
  }

  /**
   * Resolve `"server/tool"` refs to rows, silently dropping any that no longer exist.
   *
   * The same posture as connectors.resolveSelected(): never trust a caller's list verbatim.
   * A ref naming a removed server or a tool the server stopped advertising resolves to
   * nothing rather than to a guess.
   */
  resolveTools(refs: string[]): McpTool[] {
    const out: McpTool[] = [];
    for (const ref of refs) {
      const parsed = parseToolRef(ref);
      if (!parsed) continue;
      const tool = this.getTool(parsed.serverId, parsed.toolName);
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
  replaceTools(serverId: string, discovered: DiscoveredTool[]): McpTool[] {
    const previous = new Map(this.listTools(serverId).map((t) => [t.name, t]));
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

    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM mcp_tools WHERE server_id = ?`).run(serverId);
      const insert = this.db.prepare(
        `INSERT INTO mcp_tools
           (id, server_id, name, description, input_schema, schema_hash, impact,
            impact_reason, impact_override, override_schema_hash, annotations, discovered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        insert.run(
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
        );
      }
      this.db
        .prepare(`UPDATE mcp_servers SET discovered_at = ? WHERE id = ?`)
        .run(at, serverId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return rows;
  }

  /**
   * Set or clear a user's impact override.
   *
   * Stamped with the schema it was judged against. Passing null clears it outright — the
   * way back to "just use the classifier" is always one click, in both directions.
   */
  setToolImpactOverride(serverId: string, name: string, override: McpImpact | null): McpTool | null {
    const tool = this.getTool(serverId, name);
    if (!tool) return null;
    this.db
      .prepare(
        `UPDATE mcp_tools SET impact_override = ?, override_schema_hash = ?
           WHERE server_id = ? AND name = ?`,
      )
      .run(override, override === null ? null : tool.schema_hash, serverId, name);
    return this.getTool(serverId, name);
  }
}
