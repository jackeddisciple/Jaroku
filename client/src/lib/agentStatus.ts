// Client-derived agent status:
//   running  — the agent has a live run right now
//   deploying— a deploy of it is in flight
//   deployed — it is serving somewhere, right now
//   draft    — it has never been run
//   ran      — it has run at least once
//
// The order matters, and it is not arbitrary. A local run is what the user is looking at and
// what the trace panel is about, so it outranks everything. A deploy in flight outranks a
// finished one because it is the thing that is changing. And "deployed" outranks "ran"
// because an agent that is live somewhere is a different kind of object from one that was
// executed here once — that distinction is the whole reason the Deployed filter exists.
//
// A FAILED deploy deliberately does not show here. It is history, not state: the agent is not
// deployed, and colouring its sidebar row red forever would make a tab of working agents look
// broken. The Deploy panel is where a failure is read.

import type { AgentSummary, RunSummary } from "../types.ts";

export type AgentStatus = "running" | "deploying" | "deployed" | "draft" | "ran";

/**
 * `deployment` comes off the agent list, which the server decorates from the deployments
 * table — so this stays a pure function of data the client already has, and the sidebar never
 * makes a request per row.
 */
export function agentStatus(
  agentId: string,
  runs: Record<string, RunSummary>,
  deployment?: AgentSummary["deployment"],
): AgentStatus {
  let hasRun = false;
  for (const r of Object.values(runs)) {
    if (r.agent_id !== agentId) continue;
    if (r.status === "running") return "running";
    hasRun = true;
  }
  if (deployment) {
    if (deployment.status === "live") return "deployed";
    // Every non-terminal status is "deploying" — the six phases are the panel's business, and
    // a sidebar row that renamed itself five times during one deploy would be noise.
    if (
      deployment.status === "queued" || deployment.status === "packaging" ||
      deployment.status === "uploading" || deployment.status === "building" ||
      deployment.status === "deploying"
    ) {
      return "deploying";
    }
  }
  return hasRun ? "ran" : "draft";
}
