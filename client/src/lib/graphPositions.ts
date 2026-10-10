// Where somebody has dragged an agent's graph nodes, remembered in this browser.
//
// A PER-VIEWER CONVENIENCE, NOT THE AGENT. Dragging a tile moves the drawing and nothing else — the
// agent is changed by talking, not by rearranging its picture — so the arrangement is kept the way a
// folded panel is: in localStorage, for this person on this computer, and lost without harm.
//
// KEYED BY WORKSPACE AND AGENT, because agent slugs are unique per workspace rather than globally:
// a `support_bot` in two workspaces must not share an arrangement (see `jaroku.github`, which is
// keyed the same way for the same reason, and store/reset.test.ts, which classifies the key).
//
// AND HELD TO A TOPOLOGY. An arrangement is saved with a fingerprint of the nodes and edges it was
// made for. A new version of the agent with a different shape has different nodes in different
// places, and laying the old positions over it would scatter it; so a fingerprint that no longer
// matches is ignored and the layout draws the graph afresh.

import type { Point } from "./graphLayout.ts";

const PREFIX = "jaroku.graph.";

export type Positions = Record<string, Point>;

export function graphPositionsKey(workspaceId: string | null, agentId: string): string {
  return `${PREFIX}${workspaceId ?? "_"}.${agentId}`;
}

/** A fingerprint of a graph's shape: its node ids and its edges, in a stable order. */
export function topologySig(nodes: ReadonlyArray<{ id: string }>, edges: ReadonlyArray<{ source: string; target: string }>): string {
  const n = nodes.map((x) => x.id).sort().join(",");
  const e = edges.map((x) => `${x.source}>${x.target}`).sort().join(",");
  return `${n}|${e}`;
}

/** The saved arrangement for this graph, or an empty one when there is none or it was made for another shape. */
export function readPositions(key: string, sig: string): Positions {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { sig?: unknown; positions?: unknown };
    if (parsed.sig !== sig || !parsed.positions || typeof parsed.positions !== "object") return {};
    const out: Positions = {};
    for (const [id, p] of Object.entries(parsed.positions as Record<string, unknown>)) {
      const q = p as { x?: unknown; y?: unknown };
      if (typeof q?.x === "number" && typeof q?.y === "number" && Number.isFinite(q.x) && Number.isFinite(q.y)) out[id] = { x: q.x, y: q.y };
    }
    return out;
  } catch {
    return {};
  }
}

export function writePositions(key: string, sig: string, positions: Positions): void {
  try {
    if (Object.keys(positions).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ sig, positions }));
  } catch {
    /* storage refused (private window, quota): the arrangement lasts until the tab closes */
  }
}
