// The graph store — holds each agent's static LangGraph topology for the Graph View.
// Kept separate from trace/build state on purpose: the graph is structure (derived from the
// agent's code), the trace is behavior (a run). The Graph View overlays one on the other, but
// they arrive on different channels and have different lifetimes.

import { create } from "zustand";
import type { AgentGraph } from "../types.ts";

interface GraphState {
  // agentId -> topology (or an error placeholder). Undefined = never requested / in flight.
  graphs: Record<string, AgentGraph>;
  // agentIds with a request in flight, so the view can show "loading" and we don't double-fetch.
  loading: Record<string, true>;

  markLoading: (agentId: string) => void;
  setGraph: (agentId: string, graph: AgentGraph | null) => void;
}

export const useGraphStore = create<GraphState>((set) => ({
  graphs: {},
  loading: {},

  markLoading: (agentId) =>
    set((s) => ({ loading: { ...s.loading, [agentId]: true } })),

  setGraph: (agentId, graph) =>
    set((s) => {
      const loading = { ...s.loading };
      delete loading[agentId];
      // A null payload means the server had nothing to say — record an error so the view
      // shows a definite state rather than an eternal spinner.
      const resolved: AgentGraph = graph ?? { agent_id: agentId, error: "no graph available" };
      return { graphs: { ...s.graphs, [agentId]: resolved }, loading };
    }),
}));
