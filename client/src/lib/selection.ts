// What "selected" means across the two stores that hold half of it each.
//
// The agent lives in buildStore, the run and step live in traceStore, and nothing tied them
// together: selecting an agent left whatever run and step were already on screen, and selecting
// a run left whatever agent was already in the header. So the app could sit there showing
// "mcp_demo" above a trace of the packing agent's run, with a `generate_packing_list` step open
// in the detail panel — a tool mcp_demo does not have.
//
// That is not just cosmetic. Everything that acts on "the selection" joins the two halves back
// together and gets a chimera: `explain` and `fix` send the header's agent id with the other
// agent's step, and the composer offers "why did this fail?" about a step from a run this agent
// never made.
//
// One invariant fixes all of it: THE RUN ON SCREEN BELONGS TO THE AGENT IN THE HEADER. These two
// functions are the only places selection changes, and each one restores it — picking an agent
// drops a run belonging to someone else, and picking a run follows it to its own agent, which is
// what keeps the runs list global and useful.
//
// It lives here rather than inside either store because both stores would have to import the
// other to enforce it, and neither should have to know the other exists.

import { useBuildStore } from "../store/buildStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";

/**
 * Select an agent, dropping a run/step selection that belongs to a different one.
 *
 * AND CLOSE ANY FULL-SCREEN VIEW, which is §2's "going back without picking anything": you click the
 * currently-active agent in the sidebar and land back on the three panes exactly where you left them.
 * That is why the close happens BEFORE the early return below — clicking the agent that is already
 * selected changes no selection at all, and it is precisely the click the spec names.
 *
 * Here rather than in the sidebar's own handler because this function is the one place selection
 * changes, and §2 says the sidebar is the single source of navigation. A view that closed itself from
 * its own row would be a second one.
 */
export function selectAgent(agentId: string | null): void {
  useUiStore.getState().closeNav();
  const build = useBuildStore.getState();
  if (build.activeAgentId === agentId) return;
  build.selectAgent(agentId);

  const trace = useTraceStore.getState();
  const activeRun = trace.activeRunId ? trace.runs[trace.activeRunId] : undefined;
  // No run on screen, or one this agent made: nothing to drop.
  if (!activeRun || activeRun.agent_id === agentId) return;
  trace.clearRunSelection();
}

/** Select a run, following it to the agent that made it — and back out of a full-screen view. */
export function selectRun(runId: string): void {
  useUiStore.getState().closeNav();
  const trace = useTraceStore.getState();
  trace.selectRun(runId);

  const agentId = trace.runs[runId]?.agent_id;
  // A run whose agent is not in the sidebar (deleted since) leaves the header alone rather
  // than blanking it — the trace is still worth reading.
  if (!agentId) return;
  const build = useBuildStore.getState();
  if (build.activeAgentId !== agentId && build.agents.some((a) => a.agent_id === agentId)) {
    build.selectAgent(agentId);
  }
}
