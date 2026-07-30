// Connecting an MCP server: handshake, classify, persist.
//
// This is the one place those three steps are joined, and the order is the trust model's
// first two points in code. A server is not "connected" because a user typed its URL; it is
// connected because it completed the standard handshake and told us what it can do. Nothing
// is assumed about its capabilities, and the discovered list is shown to the user before any
// agent is allowed to use any of it.
//
// What this module deliberately does NOT do:
//
//   * It never reads a credential VALUE into any structure that leaves it. Tokens are
//     fetched from the environment at the moment a request is made, handed to the client as
//     an argument, and never stored, logged, returned or serialised. The registry knows
//     only whether a key is set — `configured: true` — which is the most a UI ever needs.
//
//   * It never lets a failed refresh destroy a working tool list. See rediscover().
//
//   * It never grants anything. Discovering a tool makes it selectable; an agent gets it
//     only if a plan actually calls for it (see the manifest), and running a high-impact one
//     still stops for a confirmation.

import { discover, type DiscoveryResult } from "./mcpClient.ts";
import { classify } from "./mcpImpact.ts";
import {
  McpStore,
  SERVER_ID_RE,
  effectiveImpact,
  overrideVoided,
  type DiscoveredTool,
  type McpImpact,
  type McpServer,
  type McpTool,
} from "./mcpStore.ts";

// --- what the rest of the app sees -------------------------------------------

/** A tool as the UI and the prompt builder see it: effective impact, plus how it got there. */
export interface McpToolView {
  server_id: string;
  name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
  schema_hash: string;
  /** What the gate will actually use. */
  impact: McpImpact;
  /** What the classifier said, before any override. */
  computed_impact: McpImpact;
  impact_reason: string;
  /** True when a user override is in force. */
  overridden: boolean;
  /** True when an override exists but no longer applies, because the schema changed. */
  override_voided: boolean;
  annotations: Record<string, unknown> | null;
}

export interface McpServerView extends McpServer {
  /**
   * Whether this server's credential is present in the environment. NEVER the value — the
   * client is told that a key is set and nothing more.
   */
  configured: boolean;
  tools: McpToolView[];
}

export interface RegistrationResult {
  ok: boolean;
  server: McpServerView | null;
  /** Populated on failure, and on a partial success worth mentioning (e.g. truncation). */
  message: string | null;
}

// --- ids ---------------------------------------------------------------------

/** `"Linear Issues"` / `"https://mcp.linear.app/sse"` -> `"linear_issues"` / `"mcp_linear_app"`. */
export function slugifyServerId(input: string): string {
  let base = input.trim();
  try {
    // A bare URL makes a terrible label but a serviceable id.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) base = new URL(base).hostname;
  } catch {
    /* fall through and slugify the raw text */
  }
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  if (!slug || !/^[a-z]/.test(slug)) return `mcp_${slug}`.slice(0, 32);
  return slug;
}

function uniqueServerId(store: McpStore, base: string): string {
  if (!store.getServer(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 28)}_${n}`;
    if (!store.getServer(candidate)) return candidate;
  }
  return `${base.slice(0, 24)}_${Date.now() % 100000}`;
}

// --- registry ----------------------------------------------------------------

export interface AddServerOptions {
  endpoint: string;
  label?: string;
  /** Explicit id, or derived from the label/endpoint when absent. */
  id?: string;
  /** The NAME of the env var holding this server's credential. Never a value. */
  authEnvKey?: string | null;
}

export class McpRegistry {
  constructor(private store: McpStore) {}

  // --- reads -----------------------------------------------------------------

  /**
   * Credential presence, by name only.
   *
   * runtime/.env is loaded into process.env at startup by the same loader every other key
   * goes through (env.ts), so this is a presence check and never a file read.
   */
  private configured(server: McpServer): boolean {
    if (!server.auth_env_key) return true; // needs none
    return Boolean(process.env[server.auth_env_key]);
  }

  /** Read the credential at the moment of use. The value never leaves this call. */
  private token(server: McpServer): string | null {
    if (!server.auth_env_key) return null;
    return process.env[server.auth_env_key] ?? null;
  }

  private viewTool(tool: McpTool): McpToolView {
    return {
      server_id: tool.server_id,
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      schema_hash: tool.schema_hash,
      impact: effectiveImpact(tool),
      computed_impact: tool.impact,
      impact_reason: tool.impact_reason,
      overridden: tool.impact_override !== null && !overrideVoided(tool),
      override_voided: overrideVoided(tool),
      annotations: tool.annotations,
    };
  }

  view(server: McpServer): McpServerView {
    return {
      ...server,
      configured: this.configured(server),
      tools: this.store.listTools(server.id).map((t) => this.viewTool(t)),
    };
  }

  list(): McpServerView[] {
    return this.store.listServers().map((s) => this.view(s));
  }

  get(id: string): McpServerView | null {
    const server = this.store.getServer(id);
    return server ? this.view(server) : null;
  }

  /** Every discovered tool across every server, for the selection UI and the prompt. */
  allTools(): McpToolView[] {
    return this.store.listTools().map((t) => this.viewTool(t));
  }

  /** Resolve `"server/tool"` refs, dropping any that no longer exist. Least privilege. */
  resolve(refs: string[]): McpToolView[] {
    return this.store.resolveTools(refs).map((t) => this.viewTool(t));
  }

  // --- writes ----------------------------------------------------------------

  /**
   * Register a server: handshake first, persist second.
   *
   * A row is written even when the handshake fails, because "I added this and it did not
   * work" is a state the user needs to see and retry from — losing the endpoint they typed
   * and making them type it again would be worse than an honest error row.
   */
  async addServer(opts: AddServerOptions): Promise<RegistrationResult> {
    const endpoint = opts.endpoint.trim();
    if (!endpoint) return { ok: false, server: null, message: "an endpoint is required" };

    const requested = opts.id?.trim() || slugifyServerId(opts.label?.trim() || endpoint);
    if (!SERVER_ID_RE.test(requested)) {
      return {
        ok: false,
        server: null,
        message: `"${requested}" is not a usable server id — lowercase letters, digits and underscores, starting with a letter`,
      };
    }
    if (opts.id && this.store.getServer(opts.id)) {
      return { ok: false, server: null, message: `a server called "${opts.id}" is already connected` };
    }
    const id = opts.id ?? uniqueServerId(this.store, requested);
    const label = opts.label?.trim() || id;
    const authEnvKey = opts.authEnvKey ?? null;

    const result = await discover({
      endpoint,
      token: authEnvKey ? (process.env[authEnvKey] ?? null) : null,
    });

    const base = {
      id,
      label,
      endpoint,
      transport: "http" as const,
      auth_env_key: authEnvKey,
    };

    if (!result.ok) {
      this.store.upsertServer({
        ...base,
        server_name: null,
        server_version: null,
        protocol_version: null,
        status: result.status,
        last_error: result.error,
        discovered_at: null,
      });
      return { ok: false, server: this.get(id), message: result.error };
    }

    this.store.upsertServer({
      ...base,
      server_name: result.server_name,
      server_version: result.server_version,
      protocol_version: result.protocol_version,
      status: "connected",
      last_error: null,
      discovered_at: null, // set by replaceTools, so the timestamp matches the list it stamps
    });
    this.store.replaceTools(id, this.classifyAll(result));

    return { ok: true, server: this.get(id), message: truncationNote(result) };
  }

  /**
   * Re-run discovery against an already-registered server.
   *
   * On failure the status and error are updated and THE TOOL LIST IS LEFT ALONE. A server
   * that is briefly unreachable must not silently strip every agent scoped to it; "the
   * tools vanished" is a much worse failure than a status line saying unreachable.
   */
  async rediscover(id: string): Promise<RegistrationResult> {
    const server = this.store.getServer(id);
    if (!server) return { ok: false, server: null, message: `no server called "${id}"` };

    const result = await discover({ endpoint: server.endpoint, token: this.token(server) });

    if (!result.ok) {
      this.store.setServerStatus(id, result.status, result.error);
      return { ok: false, server: this.get(id), message: result.error };
    }

    this.store.upsertServer({
      ...server,
      server_name: result.server_name,
      server_version: result.server_version,
      protocol_version: result.protocol_version,
      status: "connected",
      last_error: null,
    });
    this.store.replaceTools(id, this.classifyAll(result));
    return { ok: true, server: this.get(id), message: truncationNote(result) };
  }

  removeServer(id: string): boolean {
    if (!this.store.getServer(id)) return false;
    this.store.deleteServer(id);
    return true;
  }

  /** Record (or clear) a user's impact override. Stamped against the current schema. */
  setToolImpact(serverId: string, toolName: string, override: McpImpact | null): McpToolView | null {
    const updated = this.store.setToolImpactOverride(serverId, toolName, override);
    return updated ? this.viewTool(updated) : null;
  }

  /** Records the env var NAME for a server. See envWriter.ts for the value. */
  setAuthEnvKey(id: string, envKey: string | null): McpServerView | null {
    if (!this.store.getServer(id)) return null;
    this.store.setServerAuthEnvKey(id, envKey);
    return this.get(id);
  }

  private classifyAll(result: Extract<DiscoveryResult, { ok: true }>): DiscoveredTool[] {
    return result.tools.map((t) => {
      const verdict = classify({
        name: t.name,
        description: t.description,
        annotations: t.annotations,
      });
      return {
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
        annotations: t.annotations,
        impact: verdict.impact,
        impact_reason: verdict.reason,
      };
    });
  }
}

/** A successful discovery that lost tools to a cap is still worth saying out loud. */
function truncationNote(result: Extract<DiscoveryResult, { ok: true }>): string | null {
  return result.truncated
    ? "this server advertises more tools than Jaroku will accept; the list was truncated"
    : null;
}
