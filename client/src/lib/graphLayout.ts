// The Graph tab's layout, as pure functions: what each node is, where it goes, which edges carry
// which branch, and how far the canvas has to zoom out to show all of it.
//
// TOP TO BOTTOM, BECAUSE OF WHERE IT IS DRAWN. The graph lives in the right-hand panel, which is a
// tall column — about 630 × 790 at a 1440 window — and it was laid out left to right with 250px
// between columns. A seven-step agent came out 2,400px wide, so Fit View could not fit it above the
// minimum zoom: both ends were cut off and the labels were four pixels tall. Run down the column,
// the same agent fits at full size.
//
// n8n'S CANVAS, TURNED A QUARTER. A step is a square tile with one large coloured mark and its name
// under it; Start is the trigger, rounded on the side the flow leaves from; a fork is a tile of its
// own; the ReAct agent is n8n's wide card, with its model and tools as a column of circles to its
// right, each on its own port — where n8n hangs them in a row below, because there the flow runs
// right and here it runs down.
//
// A FORK IS DRAWN AS A DECISION. LangGraph's compiled topology has edges for a conditional fork but
// no node, so the one place an agent chooses was the one thing the canvas could not show. Each fork
// gets a small decision node between the step it leaves and the branches, named after the function
// that decides (the runtime reads it off the graph builder; see runtime/jaroku_runner/graph.py).
//
// Nothing here touches React or the DOM, so `test:graph-layout` can hold every rule of it.

import Dagre from "@dagrejs/dagre";

import type { AgentGraph, GraphNode, GraphRouter, SourceLocation } from "../types.ts";

// ── sizes ─────────────────────────────────────────────────────────────────────
/** A step's tile: square, one mark on it. Start and a fork are tiles too. */
export const TILE = 64;
/** The gap between a tile and the name under it, and the two lines of that name. */
export const LABEL_GAP = 8;
export const LABEL_H = 34;
/** A tiled node's box: as wide as its label may run, as tall as tile and label together. */
export const NODE_W = 168;
export const NODE_H = TILE + LABEL_GAP + LABEL_H;
/** End: a circle, with one line under it. */
export const END_D = 44;
export const END_H = END_D + LABEL_GAP + 16;
/** The ReAct agent: n8n's wide card, its name inside it. */
export const AGENT_W = 240;
export const AGENT_H = TILE;
/** The agent's model and tools: a column of circles to its right, each with its name under it. */
export const SUB_D = 48;
export const SUB_W = 96;
export const SUB_H = SUB_D + 6 + 16;
const SUB_GAP = 56;
const SUB_VGAP = 10;
/** At most this many circles beside an agent; past it, the last one says how many more. */
export const MAX_SUBS = 3;

const RANKSEP = 30;
const NODESEP = 24;
const MARGIN = 24;
/** How far right of the cards it passes a loop's lane runs, and how far apart two loops' lanes sit. */
const LOOP_GAP = 28;
const LOOP_STEP = 14;
/** The corner radius of a loop's turns. */
export const EDGE_RADIUS = 12;
/** How far above and below the middle of a gap an edge's S-curve runs. Under half the gap, so it never leaves it. */
const CURVE_K = 13;

// ── fitting ───────────────────────────────────────────────────────────────────
/** Fit View's padding: a number, the way React Flow reads it (the frame is shrunk by 1 + this). */
export const FIT_PADDING = 0.12;
/** The most Fit View may zoom IN: a three-step agent is shown at its real size, not at 175%. */
export const MAX_FIT_ZOOM = 1;
/** Low enough that any graph can be framed whole. Below READABLE_ZOOM the minimap takes over. */
export const MIN_ZOOM = 0.25;
/** Under this, a card's 11px meta line is under 8px on screen, and the minimap is worth its space. */
export const READABLE_ZOOM = 0.7;

export type FlowRole = "start" | "end" | "model" | "step" | "tool" | "decision" | "resource";

export const ROLE_LABEL: Record<FlowRole, string> = {
  start: "Start",
  end: "End",
  model: "Model call",
  step: "Step",
  tool: "Tool node",
  decision: "Decision",
  resource: "Resource",
};

/** A node one introspection has, plus the fields schemas 2 and 3 added. Absent on a graph cached before then. */
type GraphNodeIn = GraphNode & { calls_model?: boolean | null; doc?: string | null; source?: SourceLocation | null };

export const START_ID = "__start__";
export const END_ID = "__end__";

/** The ReAct shape's model node, which gets the wide card with its model and tools under it. */
export function isReactAgent(id: string): boolean {
  return id === "agent" || id === "assistant";
}

/**
 * What a node is, in the terms somebody debugging it needs: where the model is called, where a
 * tool runs, and everything else.
 *
 * `calls_model` is the runtime's answer (schema 2). A graph from an older introspection has no
 * such field, and then the only model call that can be named is the ReAct agent node; the rest are
 * steps, which is true of them whether or not they call a model — it just says less.
 */
export function roleOf(n: GraphNodeIn): FlowRole {
  if (n.type === "start" || n.id === START_ID) return "start";
  if (n.type === "end" || n.id === END_ID) return "end";
  if (n.type === "tool") return "tool";
  if (n.calls_model === true || isReactAgent(n.id)) return "model";
  return "step";
}

/**
 * The name a node is shown under: its id, exactly as the code, the plan and the Trace tab write it.
 * It was title-cased — `extract_jd` became "Extract Jd" — which made it a second name for the same
 * step, and a wrong one wherever the id held an acronym.
 */
export function titleOf(id: string): string {
  if (id === START_ID) return "Start";
  if (id === END_ID) return "End";
  return id;
}

/** The id of the synthetic decision node at `source`'s fork. Cannot collide with a LangGraph node id. */
export function decisionId(source: string): string {
  return `decide:${source}`;
}

export interface FlowNodeSpec {
  id: string;
  role: FlowRole;
  title: string;
  /** The first line of the node's docstring, or of the deciding function's for a decision. */
  doc: string | null;
  /** Top-left, as React Flow places a node. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** For a decision: the node it decides for, and the branches it chooses between. */
  decides?: { source: string; targets: string[] };
  /** Where the node's function (or a decision's deciding function) is written, when the runtime said. */
  source?: SourceLocation | null;
}

export interface FlowEdgeSpec {
  id: string;
  source: string;
  target: string;
  /**
   * The real edge (or edges) this segment draws. A fork's edges are split in two — step → decision,
   * decision → branch — and the trace overlay names real edges, so each segment says which ones it
   * stands for: the stem stands for every branch, a branch for its own.
   */
  from: string;
  to: string[];
  /** The branch's own label, only where it says something the target's name does not. */
  branch?: string;
  /** Goes back up the column — a loop — so it is drawn round the side, not through the cards. */
  back: boolean;
  /**
   * For an edge down the column, the points dagre routed it through, between its ends: alternately
   * the middle of a gap between rows and, where it skips a row, the slot dagre kept free in that row.
   * Drawing straight from end to end instead put a skipped row's card on top of the edge.
   */
  via?: Point[];
  /** For a loop, the x of the lane it runs up — right of every card beside it. */
  lane?: number;
  /** For the dashed line from the ReAct agent to one of its circles: what that port is. */
  port?: "Model" | "Tools";
  /** ...and how far down the agent's right edge it leaves, as a fraction of the card's height. */
  portAt?: number;
  /** Which side of the column a loop runs up: right, unless the agent's circles are there. */
  side?: "left" | "right";
}

export interface Point {
  x: number;
  y: number;
}

export interface FlowLayout {
  nodes: FlowNodeSpec[];
  edges: FlowEdgeSpec[];
  width: number;
  height: number;
}

/**
 * The label on a branch, or nothing when it would only repeat where the branch goes. A path map
 * written `{"shortlist_note": "shortlist_note"}` labelled both of Liven's branches with their own
 * targets' names, right beside the cards carrying those names. `{"yes": "notify"}` says something.
 */
export function branchChip(label: string | null | undefined, target: string): string | undefined {
  if (!label) return undefined;
  if (label === target) return undefined;
  if ((label === END_ID || label === "END") && target === END_ID) return undefined;
  if (label === END_ID || label === "END") return "end";
  return label;
}

function sizeOf(role: FlowRole, id: string): { w: number; h: number } {
  if (role === "end") return { w: NODE_W, h: END_H };
  if (role === "resource") return { w: SUB_W, h: SUB_H };
  if (role === "model" && isReactAgent(id)) return { w: AGENT_W, h: AGENT_H };
  return { w: NODE_W, h: NODE_H };
}

/** The id of the n-th circle beside the ReAct agent. */
export function resourceId(i: number): string {
  return `res:${i}`;
}

/**
 * Lay the graph out top to bottom.
 *
 * `resources` names the circles beside a ReAct agent — its model first, then its tools — which come
 * from the agent's files and provider, never from the compiled graph. At most MAX_SUBS are drawn.
 */
export function buildFlow(graph: AgentGraph, opts: { resources?: string[] } = {}): FlowLayout {
  const nodesIn = (graph.nodes ?? []) as GraphNodeIn[];
  const edgesIn = graph.edges ?? [];
  const routers: GraphRouter[] = graph.routers ?? [];
  const known = new Set(nodesIn.map((n) => n.id));

  // Forks: a source with two or more conditional edges out of it. One conditional edge is a gate
  // rather than a choice, and is drawn as an edge with its label.
  const forkTargets = new Map<string, string[]>();
  for (const e of edgesIn) {
    if (!e.conditional) continue;
    forkTargets.set(e.source, [...(forkTargets.get(e.source) ?? []), e.target]);
  }
  for (const [source, targets] of forkTargets) if (targets.length < 2) forkTargets.delete(source);

  const specs: FlowNodeSpec[] = nodesIn.map((n) => {
    const role = roleOf(n);
    return { id: n.id, role, title: titleOf(n.id), doc: n.doc ?? null, source: n.source ?? null, x: 0, y: 0, ...sizeOf(role, n.id) };
  });
  for (const [source, targets] of forkTargets) {
    const router = routers.find((r) => r.source === source);
    specs.push({
      id: decisionId(source),
      role: "decision",
      title: router?.name || "Branch",
      doc: router?.doc ?? null,
      source: router?.location ?? null,
      x: 0,
      y: 0,
      ...sizeOf("decision", ""),
      decides: { source, targets },
    });
  }

  const edges: FlowEdgeSpec[] = [];
  const stems = new Set<string>();
  edgesIn.forEach((e, i) => {
    if (!known.has(e.source) || !known.has(e.target)) return;
    const fork = forkTargets.get(e.source);
    if (e.conditional && fork) {
      const d = decisionId(e.source);
      if (!stems.has(e.source)) {
        stems.add(e.source);
        edges.push({ id: `${e.source}->${d}`, source: e.source, target: d, from: e.source, to: fork, back: false });
      }
      edges.push({
        id: `${d}->${e.target}-${i}`,
        source: d,
        target: e.target,
        from: e.source,
        to: [e.target],
        branch: branchChip(e.label, e.target),
        back: false,
      });
      return;
    }
    edges.push({
      id: `${e.source}->${e.target}-${i}`,
      source: e.source,
      target: e.target,
      from: e.source,
      to: [e.target],
      branch: e.conditional ? branchChip(e.label, e.target) : undefined,
      back: false,
    });
  });

  // LOOPS ARE FOUND BEFORE LAYOUT AND KEPT OUT OF IT. Given a cycle, dagre reverses an edge and
  // keeps a whole column free for it beside the cards, which pushed the rest of a ReAct agent off
  // centre; and drawn from where dagre left it, the loop ran straight through the End pill. So the
  // edges that close a cycle — found walking down from Start — are laid out as if absent, and each
  // is drawn up a lane of its own on the right.
  const closesCycle = cycleClosers(edges, specs.map((n) => n.id));
  for (const e of edges) e.back = closesCycle.has(e);

  // THE AGENT'S CIRCLES SIT IN ITS OWN ROW. Laid out as dagre nodes of their own they would be a
  // row below it, in the flow's way; so the agent is laid out as one box wide enough to hold its card
  // and the circles beside it, and the circles are placed in that box afterwards.
  const agent = specs.find((n) => n.role === "model" && isReactAgent(n.id));
  const subs = agent ? (opts.resources ?? []).slice(0, MAX_SUBS) : [];
  const agentBox = agent && subs.length
    ? { w: AGENT_W + SUB_GAP + SUB_W, h: Math.max(AGENT_H, subs.length * SUB_H + (subs.length - 1) * SUB_VGAP) }
    : undefined;

  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", ranksep: RANKSEP, nodesep: NODESEP, marginx: MARGIN, marginy: MARGIN });
  for (const s of specs) g.setNode(s.id, s === agent && agentBox ? { width: agentBox.w, height: agentBox.h } : { width: s.w, height: s.h });
  for (const e of edges) if (!e.back) g.setEdge(e.source, e.target);
  Dagre.layout(g);

  const byId = new Map<string, FlowNodeSpec>();
  for (const s of specs) {
    const p = g.node(s.id);
    if (s === agent && agentBox) {
      // The card at the box's left, half way down the column of circles beside it.
      s.x = p.x - agentBox.w / 2;
      s.y = p.y - AGENT_H / 2;
    } else {
      s.x = p.x - s.w / 2;
      s.y = p.y - s.h / 2;
    }
    byId.set(s.id, s);
  }
  if (agent && agentBox) {
    const top = agent.y + AGENT_H / 2 - agentBox.h / 2;
    subs.forEach((title, i) => {
      const id = resourceId(i);
      const sub: FlowNodeSpec = {
        id, role: "resource", title, doc: null, x: agent.x + AGENT_W + SUB_GAP, y: top + i * (SUB_H + SUB_VGAP), w: SUB_W, h: SUB_H,
      };
      specs.push(sub);
      byId.set(id, sub);
      edges.push({
        id: `${agent.id}=>${id}`, source: agent.id, target: id, from: "", to: [], back: false,
        port: i === 0 ? "Model" : "Tools", portAt: (i + 1) / (subs.length + 1),
      });
    });
  }
  for (const e of edges) {
    if (e.back || e.port) continue;
    const points = (g.edge(e.source, e.target)?.points ?? []) as Point[];
    e.via = points.slice(1, -1).map((p) => ({ x: p.x, y: p.y }));
  }

  let width = g.graph().width ?? 0;
  const lanes: Array<{ top: number; bottom: number; x: number; side: "left" | "right" }> = [];
  for (const e of edges) {
    if (!e.back) continue;
    const from = byId.get(e.source);
    const to = byId.get(e.target);
    if (!from || !to) continue;
    const top = Math.min(to.y, from.y);
    const bottom = Math.max(to.y + to.h, from.y + from.h);
    const beside = specs.filter((n) => n.y < bottom && n.y + n.h > top);
    // ON THE LEFT WHEN THE AGENT'S CIRCLES ARE ON THE RIGHT. A loop into the agent arrives at its
    // tile's side, and on the right that is through the column of circles standing there.
    const side = beside.some((n) => n.role === "resource") ? "left" : "right";
    const stacked = lanes.filter((l) => l.side === side && l.top < bottom && l.bottom > top).length;
    e.side = side;
    e.lane = side === "right"
      ? Math.max(...beside.map((n) => n.x + n.w)) + LOOP_GAP + stacked * LOOP_STEP
      : Math.min(...beside.map((n) => n.x)) - LOOP_GAP - stacked * LOOP_STEP;
    lanes.push({ top, bottom, x: e.lane, side });
    if (side === "right") width = Math.max(width, e.lane + MARGIN);
  }

  // A left lane may run off the canvas's left edge; move everything right until it does not.
  const leftmost = Math.min(...lanes.filter((l) => l.side === "left").map((l) => l.x));
  if (leftmost < MARGIN) {
    const dx = MARGIN - leftmost;
    for (const n of specs) n.x += dx;
    for (const e of edges) {
      if (e.lane !== undefined) e.lane += dx;
      e.via = e.via?.map((p) => ({ x: p.x + dx, y: p.y }));
    }
    width += dx;
  }

  return { nodes: specs, edges, width, height: g.graph().height ?? 0 };
}

/**
 * The edges that close a cycle: walking depth-first down from Start (then from anything Start does
 * not reach), an edge into a node still on the walk's own path is one that goes back up it.
 */
function cycleClosers(edges: FlowEdgeSpec[], ids: string[]): Set<FlowEdgeSpec> {
  const out = new Map<string, FlowEdgeSpec[]>();
  for (const e of edges) out.set(e.source, [...(out.get(e.source) ?? []), e]);
  const state = new Map<string, "open" | "done">();
  const closers = new Set<FlowEdgeSpec>();
  const walk = (id: string) => {
    state.set(id, "open");
    for (const e of out.get(id) ?? []) {
      const seen = state.get(e.target);
      if (seen === "open") closers.add(e);
      else if (!seen) walk(e.target);
    }
    state.set(id, "done");
  };
  for (const id of [START_ID, ...ids]) if (ids.includes(id) && !state.has(id)) walk(id);
  return closers;
}

/** A path through points, turning each corner on an arc of up to `r` rather than a sharp angle. */
function rounded(points: Point[], r = EDGE_RADIUS): string {
  const pts = points.filter((p, i) => i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y);
  if (pts.length < 2) return "";
  let d = `M ${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const p = pts[i]!;
    const b = pts[i + 1]!;
    const inLen = Math.hypot(p.x - a.x, p.y - a.y);
    const outLen = Math.hypot(b.x - p.x, b.y - p.y);
    const k = Math.min(r, inLen / 2, outLen / 2);
    const p1 = { x: p.x - ((p.x - a.x) / inLen) * k, y: p.y - ((p.y - a.y) / inLen) * k };
    const p2 = { x: p.x + ((b.x - p.x) / outLen) * k, y: p.y + ((b.y - p.y) / outLen) * k };
    d += ` L ${p1.x},${p1.y} Q ${p.x},${p.y} ${p2.x},${p2.y}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L ${last.x},${last.y}`;
}

/**
 * A path down the column with every sideways step drawn as an S-curve — n8n's soft edges — kept
 * inside the gap between rows: the curve starts CURVE_K above the gap's middle and ends CURVE_K
 * below it, so it never reaches a card. Loops keep `rounded`'s corners.
 */
function curved(points: Point[]): string {
  const pts = points.filter((p, i) => i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y);
  if (pts.length < 2) return "";
  let d = `M ${pts[0]!.x},${pts[0]!.y}`;
  let i = 1;
  while (i < pts.length) {
    const a = pts[i - 1]!;
    const p = pts[i]!;
    const q = pts[i + 1];
    if (q && p.y === q.y && p.x !== q.x && a.x === p.x) {
      const r = pts[i + 2];
      const sign = Math.sign(p.y - a.y) || 1;
      const k = Math.min(CURVE_K, Math.abs(p.y - a.y), r ? Math.abs(r.y - q.y) : CURVE_K);
      d += ` L ${p.x},${p.y - k * sign} C ${p.x},${p.y} ${q.x},${q.y} ${q.x},${q.y + k * sign}`;
      i += 2;
      continue;
    }
    d += ` L ${p.x},${p.y}`;
    i++;
  }
  return d;
}

/**
 * An edge down the column: down to the middle of each gap between rows, across there and only
 * there, and straight down through any row it skips, in the slot dagre kept free. Crossing at a
 * row's height would cross that row's cards. `points` is that route in right angles, for checking;
 * `d` draws it with each crossing as an S-curve. Also where its label goes: half way down the first
 * drop after it turns, so two branches leaving one decision each carry their own.
 */
export function routePath(s: Point, t: Point, via: Point[] = []): { d: string; label: Point; points: Point[] } {
  const gaps = via.filter((_, i) => i % 2 === 0).map((p) => p.y);
  const slots = via.filter((_, i) => i % 2 === 1).map((p) => p.x);
  if (gaps.length === 0) gaps.push((s.y + t.y) / 2);
  const pts: Point[] = [s];
  let x = s.x;
  gaps.forEach((y, k) => {
    pts.push({ x, y });
    x = k < slots.length ? slots[k]! : t.x;
    pts.push({ x, y });
  });
  pts.push(t);
  const label = { x: slots[0] ?? t.x, y: (gaps[0]! + (gaps[1] ?? t.y)) / 2 };
  return { d: curved(pts), label, points: pts };
}

/** The dashed line from one of the agent's ports to its circle: out, and a soft bend into the circle's side. */
export function portPath(s: Point, t: Point): { d: string; points: Point[] } {
  const mx = (s.x + t.x) / 2;
  return { d: `M ${s.x},${s.y} C ${mx},${s.y} ${mx},${t.y} ${t.x},${t.y}`, points: [s, { x: mx, y: s.y }, { x: mx, y: t.y }, t] };
}

/** A loop: out of the source's right side, up its lane, and into the target's right side. */
export function loopPath(s: Point, t: Point, lane: number): { d: string; label: Point; points: Point[] } {
  const points = [s, { x: lane, y: s.y }, { x: lane, y: t.y }, t];
  return { d: rounded(points), label: { x: lane, y: (s.y + t.y) / 2 }, points };
}

/**
 * Where an edge leaves and meets a node: under its label and the top of its tile down the column,
 * the right side of the tile for a loop, and the agent's right edge into a circle's left for a port.
 */
export function edgeEnds(e: FlowEdgeSpec, nodes: Map<string, FlowNodeSpec>): { s: Point; t: Point } | undefined {
  const a = nodes.get(e.source);
  const b = nodes.get(e.target);
  if (!a || !b) return undefined;
  if (e.port) return { s: { x: a.x + a.w, y: a.y + AGENT_H * (e.portAt ?? 0.5) }, t: { x: b.x + (b.w - SUB_D) / 2, y: b.y + SUB_D / 2 } };
  if (e.back) {
    const dir = e.side === "left" ? -1 : 1;
    return {
      s: { x: a.x + a.w / 2 + dir * tileHalf(a), y: a.y + tileMid(a) },
      t: { x: b.x + b.w / 2 + dir * tileHalf(b), y: b.y + tileMid(b) },
    };
  }
  return { s: { x: a.x + a.w / 2, y: a.y + a.h }, t: { x: b.x + b.w / 2, y: b.y } };
}

/** How far down a node its tile's middle is — where a loop leaves and arrives. */
export function tileMid(n: FlowNodeSpec): number {
  if (n.role === "end") return END_D / 2;
  if (n.role === "model" && isReactAgent(n.id)) return AGENT_H / 2;
  if (n.role === "resource") return SUB_D / 2;
  return TILE / 2;
}

/** Half the drawn tile's width: a loop leaves from the tile's side, not from the label's box. */
export function tileHalf(n: FlowNodeSpec): number {
  if (n.role === "end") return END_D / 2;
  if (n.role === "model" && isReactAgent(n.id)) return AGENT_W / 2;
  if (n.role === "resource") return SUB_D / 2;
  return TILE / 2;
}

/** Whether a drawn segment stands for the real edge the trace overlay names. */
export function matchesEdge(e: Pick<FlowEdgeSpec, "from" | "to">, real: { source: string; target: string } | undefined): boolean {
  return !!real && e.from === real.source && e.to.includes(real.target);
}

/** The zoom Fit View lands on for a layout in a frame — React Flow's own arithmetic, clamped. */
export function fitZoom(
  layout: { width: number; height: number },
  frame: { width: number; height: number },
  padding = FIT_PADDING,
): number {
  if (layout.width <= 0 || layout.height <= 0) return MAX_FIT_ZOOM;
  const zoom = Math.min(frame.width / (layout.width * (1 + padding)), frame.height / (layout.height * (1 + padding)));
  return Math.min(MAX_FIT_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Where the canvas opens, as a viewport: the whole graph, fitted and centred, when that leaves it
 * readable — or, for an agent too long for the column, at a readable size from the top, the way a
 * document opens.
 *
 * FITTING EVERYTHING WAS THE WRONG ANSWER FOR A LONG AGENT. Fifteen steps fitted whole come out at
 * 45%, every label under six pixels: all of it on screen and none of it legible. A column is read
 * downwards, so a long agent starts at Start and scrolls, with the minimap to say where you are.
 *
 * AND IT IS COMPUTED FROM THE LAYOUT, NOT LEFT TO REACT FLOW'S FIT VIEW, which measures the nodes
 * alone: a loop's lane runs to the right of every card, so a fit that ignored it put the lane under
 * the inspector. `covered` is how much of the frame's right side an overlay hides.
 */
export type Framing = { kind: "fit" | "top"; x: number; y: number; zoom: number };

export function frameFor(
  layout: { width: number; height: number },
  frame: { width: number; height: number },
  covered = 0,
): Framing {
  const avail = { width: Math.max(1, frame.width - covered), height: frame.height };
  const whole = fitZoom(layout, avail);
  if (whole >= READABLE_ZOOM) {
    return {
      kind: "fit",
      x: (avail.width - layout.width * whole) / 2,
      y: (avail.height - layout.height * whole) / 2,
      zoom: whole,
    };
  }
  const acrossWhole = avail.width / (layout.width * (1 + FIT_PADDING));
  const zoom = Math.max(MIN_ZOOM, Math.min(READABLE_ZOOM, acrossWhole));
  return { kind: "top", x: Math.max(0, (avail.width - layout.width * zoom) / 2), y: 0, zoom };
}

/**
 * The nodes in reading order — down the column, then across — without the decision pills, which
 * are not steps. What "step 2 of 7" counts.
 */
export function readingOrder(nodes: FlowNodeSpec[]): FlowNodeSpec[] {
  return nodes
    .filter((n) => n.role !== "decision" && n.role !== "resource")
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** What a screen reader says for a node. React Flow's own default offers to drag or delete it. */
export function nodeAriaLabel(n: FlowNodeSpec, order: FlowNodeSpec[]): string {
  if (n.role === "start") return "Start of the graph";
  if (n.role === "resource") return n.title;
  if (n.role === "end") return "End of the graph";
  if (n.role === "decision") {
    const between = n.decides?.targets.map(titleOf).join(" or ") ?? "";
    return `Decision ${n.title}${between ? `, chooses ${between}` : ""}${n.doc ? `. ${n.doc}` : ""}`;
  }
  const steps = order.filter((s) => s.role !== "start" && s.role !== "end");
  const i = steps.findIndex((s) => s.id === n.id);
  const where = i >= 0 ? `, step ${i + 1} of ${steps.length}` : "";
  return `${n.title}, ${ROLE_LABEL[n.role].toLowerCase()}${where}${n.doc ? `. ${n.doc}` : ""}`;
}
