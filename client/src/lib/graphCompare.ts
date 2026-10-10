// Two versions of an agent's graph, drawn as one: what the current version added, and what the older
// one had that is gone now.
//
// ONE PICTURE, NOT TWO SIDE BY SIDE. The graph is a column already; two columns in one panel would
// each be half as readable, and the eye would do the diff. So the union is laid out once — every
// node either version had — and each node and edge says whether it is new, gone, or the same.
//
// BY NAME. A node is the same node in both versions when it has the same id, which is what the code
// calls it; an edge is the same edge when it joins the same two names. A step renamed reads as one
// removed and one added, which is what a rename is to anybody reading the code.

import type { AgentGraph, GraphEdge, GraphNode, GraphRouter } from "../types.ts";

export type DiffMark = "added" | "removed";

export interface GraphDiff {
  /** Every node and edge either version had, for the layout to draw once. */
  union: AgentGraph;
  /** Node id → added (only in the current version) or removed (only in the older one). */
  nodes: Map<string, DiffMark>;
  /** `source>target` → added or removed. */
  edges: Map<string, DiffMark>;
}

export const edgeKey = (source: string, target: string): string => `${source}>${target}`;

export function compareGraphs(current: AgentGraph, older: AgentGraph): GraphDiff {
  const nowNodes = current.nodes ?? [];
  const thenNodes = older.nodes ?? [];
  const nowIds = new Set(nowNodes.map((n) => n.id));
  const thenIds = new Set(thenNodes.map((n) => n.id));
  const nodes = new Map<string, DiffMark>();
  for (const n of nowNodes) if (!thenIds.has(n.id)) nodes.set(n.id, "added");
  for (const n of thenNodes) if (!nowIds.has(n.id)) nodes.set(n.id, "removed");

  const nowEdges = current.edges ?? [];
  const thenEdges = older.edges ?? [];
  const nowKeys = new Set(nowEdges.map((e) => edgeKey(e.source, e.target)));
  const thenKeys = new Set(thenEdges.map((e) => edgeKey(e.source, e.target)));
  const edges = new Map<string, DiffMark>();
  for (const e of nowEdges) if (!thenKeys.has(edgeKey(e.source, e.target))) edges.set(edgeKey(e.source, e.target), "added");
  for (const e of thenEdges) if (!nowKeys.has(edgeKey(e.source, e.target))) edges.set(edgeKey(e.source, e.target), "removed");

  const unionNodes: GraphNode[] = [...nowNodes, ...thenNodes.filter((n) => !nowIds.has(n.id))];
  const unionEdges: GraphEdge[] = [...nowEdges, ...thenEdges.filter((e) => !nowKeys.has(edgeKey(e.source, e.target)))];
  const nowRouters = current.routers ?? [];
  const unionRouters: GraphRouter[] = [
    ...nowRouters,
    ...(older.routers ?? []).filter((r) => !nowRouters.some((x) => x.source === r.source)),
  ];

  return {
    union: { ...current, nodes: unionNodes, edges: unionEdges, routers: unionRouters },
    nodes,
    edges,
  };
}

/**
 * What a drawn edge is, in a comparison: a segment stands for real edges (`from` → each of `to`, see
 * graphLayout's FlowEdgeSpec), and it is added or removed only when every edge it stands for is.
 */
export function segmentMark(diff: GraphDiff, from: string, to: readonly string[]): DiffMark | undefined {
  if (!from || to.length === 0) return undefined;
  const marks = to.map((t) => diff.edges.get(edgeKey(from, t)));
  if (marks.every((m) => m === "added")) return "added";
  if (marks.every((m) => m === "removed")) return "removed";
  return undefined;
}
