// The agent's MCP manifest: mcp_tools.json.
//
// This file IS the grant. It sits beside jaroku.json in the project root, is written only by
// the host, and is read-only to the edit loop — and tools/mcp_bridge.py builds exactly the
// tools it lists and offers no way to reach anything else. Least privilege in this feature is
// not a policy the runtime consults; it is the absence of any code path to a tool that is not
// written here.
//
// What goes in is the user's explicit per-tool selection, carried through the approved plan
// record. Deliberately NOT the intersection of that selection with whatever the plan text
// mentioned: the plan parser degrades rather than failing (planProtocol.ts), so a plan the
// model wrote in prose would silently strip every tool the user ticked and produce a broken
// agent for reasons nobody could see. Warnings live in the plan card; revocation is never
// silent.
//
// The schema each tool carries is the one the server advertised at discovery time, stored
// verbatim. It is what the bridge checks arguments against and what the validator checks
// generated call sites against — one recorded fact, two consumers, no drift.
//
// NO CREDENTIAL IS EVER WRITTEN HERE. A server records the NAME of the environment variable
// holding its token. The manifest ships inside a project directory a user may well commit.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpToolView } from "./mcpRegistry.ts";
import type { McpServerView } from "./mcpRegistry.ts";

export const MANIFEST_FILE = "mcp_tools.json";
export const BRIDGE_FILE = "tools/mcp_bridge.py";
/** The template's filename in runtime/tool_templates/, copied in verbatim. */
export const BRIDGE_TEMPLATE = "mcp_bridge.py";

export interface ManifestServer {
  id: string;
  label: string;
  endpoint: string;
  transport: string;
  /** The NAME of the env var holding the credential. Never a value. */
  auth_env_key: string | null;
  /** The server's own claim about itself, recorded at discovery. */
  server_name: string | null;
  server_version: string | null;
  protocol_version: string | null;
  discovered_at: string | null;
  tools: ManifestTool[];
}

export interface ManifestTool {
  name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
  /** Governs the confirmation gate: "high" stops for the user before its first call. */
  impact: "high" | "low";
  /** Why it was classified that way, so the confirmation prompt can say. */
  impact_reason: string;
}

export interface Manifest {
  schema_version: 1;
  servers: ManifestServer[];
}

/**
 * Build the manifest for a set of scoped tools.
 *
 * `servers` supplies each tool's server identity; a tool whose server is not in the list is
 * dropped rather than guessed at, because a manifest entry with an invented endpoint is a
 * call to somewhere nobody chose.
 */
export function buildManifest(tools: McpToolView[], servers: McpServerView[]): Manifest {
  const byId = new Map(servers.map((s) => [s.id, s]));
  const grouped = new Map<string, ManifestTool[]>();

  for (const t of tools) {
    if (!byId.has(t.server_id)) continue;
    const list = grouped.get(t.server_id) ?? [];
    list.push({
      name: t.name,
      description: t.description,
      // Stored verbatim: this is what the bridge validates against at runtime and what the
      // validator checks generated call sites against.
      input_schema: t.input_schema,
      // The EFFECTIVE impact, so a user's override travels with the agent. Recomputing at
      // call time would let a gate change its mind between approval and execution.
      impact: t.impact,
      impact_reason: t.impact_reason,
    });
    grouped.set(t.server_id, list);
  }

  const out: ManifestServer[] = [];
  for (const [serverId, list] of grouped) {
    const s = byId.get(serverId)!;
    out.push({
      id: s.id,
      label: s.label,
      endpoint: s.endpoint,
      transport: s.transport,
      auth_env_key: s.auth_env_key,
      server_name: s.server_name,
      server_version: s.server_version,
      protocol_version: s.protocol_version,
      discovered_at: s.discovered_at,
      tools: list.sort((a, b) => (a.name < b.name ? -1 : 1)),
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { schema_version: 1, servers: out };
}

/** Write the manifest into a staged project. */
export function writeManifest(projectDir: string, manifest: Manifest): void {
  writeFileSync(join(projectDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** The env keys this manifest's servers need, for .env.example and jaroku.json. */
export function manifestEnv(manifest: Manifest): string[] {
  const keys = manifest.servers
    .map((s) => s.auth_env_key)
    .filter((k): k is string => Boolean(k));
  return [...new Set(keys)];
}

/** `"server/tool"` refs for everything in the manifest — what jaroku.json records. */
export function manifestRefs(manifest: Manifest): string[] {
  return manifest.servers.flatMap((s) => s.tools.map((t) => `${s.id}/${t.name}`));
}

/** Just the tool names, for the validator's wiring and shadow checks. */
export function manifestToolNames(manifest: Manifest): string[] {
  return manifest.servers.flatMap((s) => s.tools.map((t) => t.name));
}

/**
 * Tool names granted by more than one server. Empty is the only workable answer.
 *
 * An agent has ONE tool list and one name per tool: the model picks a tool by name, LangChain
 * binds by name, and every consumer of this manifest keys by name. Two servers advertising
 * `create_issue` is ordinary — plenty of issue trackers do — but there is no way to honour
 * both, and the failure when nobody checks is not a missing tool. It is a SILENT SUBSTITUTION:
 * the bridge builds whichever entry it reads first, the validator checks arguments against
 * whichever it reads last, and if the two differ in impact, a high-impact tool's confirmation
 * gate is simply gone — replaced by a same-named low-impact one pointing at another company's
 * server.
 *
 * So the collision is surfaced where it can still be acted on: before generation, while it is
 * still a selection the user can change. Nothing downstream tries to guess.
 */
export function manifestCollisions(manifest: Manifest): string[] {
  const owners = new Map<string, Set<string>>();
  for (const server of manifest.servers) {
    for (const tool of server.tools) {
      const set = owners.get(tool.name) ?? new Set<string>();
      set.add(server.id);
      owners.set(tool.name, set);
    }
  }
  // Keyed by server rather than by count: one server listing a tool twice is a duplicate, not
  // an ambiguity, and the bridge collapsing those two into one is the correct outcome.
  return [...owners.entries()].filter(([, servers]) => servers.size > 1).map(([name]) => name).sort();
}
