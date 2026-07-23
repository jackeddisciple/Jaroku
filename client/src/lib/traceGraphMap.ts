// Trace ↔ graph mapping — the correctness-sensitive core of the Graph View sync (doc §6.2, 🟡).
//
// The frozen Step schema (schema/events.md) carries NO graph-node id. The only node identity is
// `Step.name`, and it equals a LangGraph node name for exactly ONE step type. So mapping a trace
// step to a graph node follows strict rules, NOT naive string-matching on `name`:
//
//   • state_update — the interceptor only classifies a chain as `state_update` when
//     metadata["langgraph_node"] is present, so `name` IS the node name. Direct.
//   • llm_call / tool_call — `name` is a MODEL or TOOL name, never a node. The step ran INSIDE a
//     node; walk `parent_step_id` up to the enclosing state_update and use ITS name.
//   • router — a conditional-edge decision, attributed to its SOURCE node (also reached by the
//     parent walk). `output` names the chosen branch (the edge target).
//
// A note on "active" during a live run: steps are emitted at END time (there is no in-progress
// step in the frozen schema), so the honest proxy for "currently executing" is the node of the
// highest-`seq` emitted step — i.e. the most recent activity. This glows only while the run is
// running and clears when it ends.

import type { Step } from "../types.ts";

type ById = Record<string, Step>;

/** Steps in true causal order (by seq), independent of arrival order. */
export function bySeq(byId: ById): Step[] {
  return Object.values(byId).sort((a, b) => a.seq - b.seq);
}

/** The graph node a step belongs to, or undefined if it can't be attributed to one.
 *  Walks `parent_step_id` for llm/tool/router steps; cycle- and depth-guarded. */
export function stepNodeId(step: Step, byId: ById): string | undefined {
  const seen = new Set<string>();
  let cur: Step | undefined = step;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.type === "state_update") return cur.name; // the authoritative node name
    cur = cur.parent_step_id ? byId[cur.parent_step_id] : undefined;
  }
  return undefined; // e.g. a top-level llm_call with no enclosing node
}

/** The node that most recently saw activity — the glow target while a run is running. */
export function activeNodeId(byId: ById | undefined): string | undefined {
  if (!byId) return undefined;
  const steps = bySeq(byId);
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (!s) continue;
    const node = stepNodeId(s, byId);
    if (node) return node;
  }
  return undefined;
}

// LangGraph's END sentinel serializes to this node id in get_graph().
const END_NODE = "__end__";

/** Normalize a router's chosen-branch output to a graph node id, best-effort. */
function branchToNode(output: unknown): string | undefined {
  if (typeof output !== "string") return undefined;
  const v = output.trim();
  if (!v) return undefined;
  // LangGraph's END can surface as "__end__", "END", or "" depending on version.
  if (v === "END" || v === "__end__") return END_NODE;
  return v;
}

/** If a step is a router, the edge it took (source node → chosen target), for edge highlighting. */
export function stepEdge(step: Step, byId: ById): { source: string; target: string } | undefined {
  if (step.type !== "router") return undefined;
  const source = stepNodeId(step, byId);
  const target = branchToNode(step.output);
  if (source && target) return { source, target };
  return undefined;
}

/** The most-recent router edge in a run, for lighting the taken branch during/after a run. */
export function activeEdge(byId: ById | undefined): { source: string; target: string } | undefined {
  if (!byId) return undefined;
  const steps = bySeq(byId);
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (!s) continue;
    const e = stepEdge(s, byId);
    if (e) return e;
  }
  return undefined;
}

/** The latest (highest-seq) step attributed to a given node — used when clicking a node to
 *  select its corresponding trace step. */
export function latestStepForNode(nodeId: string, byId: ById | undefined): Step | undefined {
  if (!byId) return undefined;
  const steps = bySeq(byId);
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s && stepNodeId(s, byId) === nodeId) return s;
  }
  return undefined;
}
