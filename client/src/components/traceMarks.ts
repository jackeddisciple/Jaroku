// What each step of a run is drawn as in the trace: a Hugeicons mark and a colour of its own.
//
// THE PRODUCT OWNER'S CALL, 2026-10-12: one mark per KIND ("every state is having same icon and bg")
// left a run of four node steps as four identical database tiles. Now every distinct step is drawn
// apart from the others:
//
//   THE MARK IS THE GRAPH'S, from `marksFor` — read off the step's name (`extract_jd` a document
//   search, `score_candidate` a chart, `shortlist_note` a pen), unique within the run, and a
//   connector's own logo where the agent has that connector. So a step and its node on the Graph
//   tab wear the same mark.
//
//   THE COLOUR IS THE NEXT OF `STEP_HUE` — green, yellow, pink, blue, brown, turquoise… — in the
//   order the steps first ran, drawn as a pastel tile with the mark in the colour itself.
//
// AND A NODE THE GRAPH KNOWS IS DRAWN AS THE GRAPH DRAWS IT (the product owner's call, 2026-10-14).
// The two tabs disagreed about the same node — extract_jd was "Model call" in one colour on the
// Graph and "State update" in another in the trace — because each worked its marks out on its own.
// With the agent's graph at hand, a node step takes that node's own mark, its hue and its role
// (`graphLook`); only a name the graph does not have (a tool, a router, a node from another version)
// falls back to the rules above.
//
// A STEP THAT RUNS AGAIN KEEPS ITS LOOK: the key is the step's name, so the third `agent` turn is the
// same tile as the first. Model calls are not in here — they wear their provider's logo (StepTile).

import type { ReactElement } from "react";

import { ROLE_LABEL, buildFlow, type FlowRole } from "../lib/graphLayout.ts";
import { CATEGORY_LABEL, stepCategory } from "../lib/traceView.ts";
import { STEP_HUE } from "../lib/tokens.ts";
import type { AgentGraph, Step } from "../types.ts";
import { marksFor, type NodeMark } from "./graphNodeIcons.ts";

export interface StepMark {
  Icon: (p: { size?: number }) => ReactElement;
  /** The step's colour: its tile is a pastel of it, and a glyph is drawn in it. */
  colour: string;
  /** A connector's logo, which brings its own colours. */
  brand: boolean;
  /** What the Graph calls this node — "Model call", "Step", "Tool node" — when the graph has it. */
  role?: FlowRole;
}

/** The Graph tab's own marks and roles for an agent's nodes, worked out exactly as GraphView does. */
export interface GraphLook {
  marks: Map<string, NodeMark>;
  roles: Map<string, FlowRole>;
}

export function graphLook(graph: AgentGraph | undefined, connectors: readonly string[] = []): GraphLook | null {
  if (!graph?.nodes?.length) return null;
  const nodes = buildFlow(graph).nodes.filter((n) => n.role !== "resource");
  return { marks: marksFor(nodes, { connectors }), roles: new Map(nodes.map((n) => [n.id, n.role])) };
}

/** Every distinct step name of a run, mapped to its mark and colour. Stable for a given run. */
export function traceMarks(
  steps: readonly Step[],
  connectors: readonly string[] = [],
  look: GraphLook | null = null,
): Map<string, StepMark> {
  const ordered = [...steps].sort((a, b) => a.seq - b.seq).filter((s) => s.type !== "llm_call");
  const names: { id: string; role: "step" | "tool"; node: boolean }[] = [];
  const seen = new Set<string>();
  for (const s of ordered) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    names.push({ id: s.name, role: s.type === "tool_call" ? "tool" : "step", node: s.type === "state_update" });
  }
  const fromGraph = (n: (typeof names)[number]): NodeMark | undefined => (n.node ? look?.marks.get(n.id) : undefined);
  const marks = marksFor(names.filter((n) => !fromGraph(n)), { connectors });
  const out = new Map<string, StepMark>();
  let hue = 0;
  for (const n of names) {
    const g = fromGraph(n);
    if (g) {
      out.set(n.id, {
        Icon: g.Icon,
        // A brand's logo brings its own colours; its tile still takes the next pastel.
        colour: g.kind === "glyph" ? g.hue : STEP_HUE[hue++ % STEP_HUE.length]!,
        brand: g.kind === "brand",
        role: look?.roles.get(n.id),
      });
      continue;
    }
    const m = marks.get(n.id);
    if (!m) continue;
    out.set(n.id, { Icon: m.Icon, colour: STEP_HUE[hue++ % STEP_HUE.length]!, brand: m.kind === "brand" });
  }
  return out;
}

/**
 * The words under a step's name: the Graph's word for a node it knows ("Model call", "Step", "Tool
 * node"), and otherwise the trace's own kind ("State update", "LLM call"). A node step is the node
 * finishing, so it is called what the node is called.
 */
export function kindWord(step: Pick<Step, "type">, mark?: StepMark): string {
  if (step.type === "state_update" && mark?.role) return ROLE_LABEL[mark.role];
  return CATEGORY_LABEL[stepCategory(step)];
}
