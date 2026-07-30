// The MCP store — connected MCP servers and the tools they advertise.
//
// Separate from buildStore for the reason the others are separate: a different invariant.
// Everything here describes UNREVIEWED THIRD-PARTY CODE, and the store's job is to never let
// that fact get lost on the way to a component. Reviewed connectors are a hardcoded list
// that cannot change at runtime; MCP servers appear, go unreachable, and rewrite their own
// tool lists between one snapshot and the next.
//
// Every server message on this channel is a FULL SNAPSHOT, so every reducer below is a
// replace, never a merge — the same discipline as evalStore. Merging deltas would let the
// client hold a view assembled from two different moments of what a third party said, which
// is exactly the state a confirmation prompt must never be rendered from.

import { create } from "zustand";
import type { McpImpact, McpServer, McpTool } from "../types.ts";

/** A tool plus the server it came from, for the flat lists the selection UI needs. */
export interface McpToolRef extends McpTool {
  serverLabel: string;
  /** `"linear/create_issue"` — how a scoped tool is named on the wire and in a manifest. */
  ref: string;
}

interface McpState {
  servers: McpServer[];
  /** Server ids with a handshake in flight, plus null for an add that has no id yet. */
  discovering: Record<string, true>;
  addingEndpoint: string | null;
  /** The last error, shown as a dismissible strip rather than swallowed. */
  error: string | null;
  notice: string | null;

  setServers: (servers: McpServer[]) => void;
  setDiscovering: (serverId: string | null, endpoint: string) => void;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}

export const useMcpStore = create<McpState>((set) => ({
  servers: [],
  discovering: {},
  addingEndpoint: null,
  error: null,
  notice: null,

  setServers: (servers) =>
    // A snapshot ends every in-flight handshake it could possibly describe. Clearing the
    // whole map rather than one key means a discovery that failed in a way we did not
    // anticipate cannot leave a spinner running forever.
    set({ servers, discovering: {}, addingEndpoint: null }),

  setDiscovering: (serverId, endpoint) =>
    set((s) =>
      serverId === null
        ? { addingEndpoint: endpoint }
        : { discovering: { ...s.discovering, [serverId]: true } },
    ),

  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),
}));

// --- selectors ---------------------------------------------------------------
// Exported as pure functions so no component re-derives them differently.

/** Every discovered tool across every connected server, flattened for selection. */
export function allMcpTools(servers: McpServer[]): McpToolRef[] {
  return servers.flatMap((s) =>
    s.tools.map((t) => ({ ...t, serverLabel: s.label, ref: `${s.id}/${t.name}` })),
  );
}

/** Resolve `"server/tool"` refs to tools, dropping any that no longer exist. */
export function resolveMcpRefs(servers: McpServer[], refs: string[]): McpToolRef[] {
  const byRef = new Map(allMcpTools(servers).map((t) => [t.ref, t]));
  return refs.map((r) => byRef.get(r)).filter((t): t is McpToolRef => t !== undefined);
}

/**
 * The tool names an agent could be calling through MCP, for the trace and graph badges.
 *
 * Keyed by NAME rather than ref because that is all a trace step carries: the frozen Step
 * schema has no provenance field and must not grow one, so MCP-ness is derived from agent
 * metadata joined on the tool name. Collisions across servers are possible in principle and
 * would only ever over-mark, never under-mark, which is the safe direction for a badge that
 * says "this came from unreviewed code".
 */
export function mcpToolNames(servers: McpServer[]): Set<string> {
  return new Set(allMcpTools(servers).map((t) => t.name));
}

export const IMPACT_LABEL: Record<McpImpact, string> = {
  high: "high impact",
  low: "read-only",
};
