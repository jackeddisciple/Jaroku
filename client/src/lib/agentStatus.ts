// Client-derived agent status. There's no deploy backend in the MVP, so "deployed" is a
// present-but-empty bucket; the rest is derived from the run history:
//   running — the agent has a live run right now
//   draft   — the agent has never been run
//   ran     — it has run at least once (neither draft nor deployed)

import type { RunSummary } from "../types.ts";

export type AgentStatus = "running" | "deployed" | "draft" | "ran";

export function agentStatus(agentId: string, runs: Record<string, RunSummary>): AgentStatus {
  let hasRun = false;
  for (const r of Object.values(runs)) {
    if (r.agent_id !== agentId) continue;
    if (r.status === "running") return "running";
    hasRun = true;
  }
  return hasRun ? "ran" : "draft";
}
