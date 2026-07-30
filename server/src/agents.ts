// Agent registry — what the sidebar lists. Reads runtime/agents/<id>/jaroku.json.
//
// Directories are the source of truth (a user can drop a project in by hand); jaroku.json
// only supplies metadata. Anything hidden or non-package-shaped is skipped, which is what
// keeps the .staging/ working directory out of the UI.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AgentSummary {
  agent_id: string;
  name: string;
  description: string;
  connectors: string[];
  /**
   * `"server/tool"` refs this agent is scoped to, from its manifest.
   *
   * Carried to the client so an MCP-sourced tool can be marked in the plan card, the graph
   * and the trace. The frozen Step schema has no provenance field and must not grow one, so
   * a trace badge is derived by joining this against the step's tool name.
   */
  mcp_tools: string[];
  required_env: string[];
  default_provider: string;
  created_at: string | null;
  hand_written: boolean;
  runnable: boolean;
}

export function listAgents(runtimeDir: string): AgentSummary[] {
  const root = join(runtimeDir, "agents");
  if (!existsSync(root)) return [];

  const agents: AgentSummary[] = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".") || entry.startsWith("__")) continue; // .staging, __pycache__
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;

    const metaPath = join(dir, "jaroku.json");
    let meta: Partial<AgentSummary> = {};
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8"));
      } catch {
        /* unreadable metadata shouldn't hide the agent — fall back to defaults */
      }
    }

    agents.push({
      agent_id: entry,
      name: meta.name ?? entry,
      description: meta.description ?? "",
      connectors: meta.connectors ?? [],
      mcp_tools: meta.mcp_tools ?? [],
      required_env: meta.required_env ?? [],
      default_provider: meta.default_provider ?? "fake",
      created_at: meta.created_at ?? null,
      hand_written: Boolean((meta as { hand_written?: boolean }).hand_written),
      // Without agent.py the runner's contract check would fail — surface that in the UI
      // rather than at run time.
      runnable: existsSync(join(dir, "agent.py")),
    });
  }

  // Newest first; hand-written reference agents last so generated work leads.
  return agents.sort((a, b) => {
    if (a.hand_written !== b.hand_written) return a.hand_written ? 1 : -1;
    return (b.created_at ?? "").localeCompare(a.created_at ?? "");
  });
}
