// A run, read back onto the graph: how long each node took and what it cost, and the run as a
// sequence of frames — one per node that finished — for stepping through it on the canvas.
//
// WHAT COUNTS AS A NODE'S TIME. A `state_update` step is a node finishing, and its latency is the
// whole node — the model calls and tools inside it included (schema/events.md). So a node's time is
// the sum of its own `state_update` steps (a node in a loop runs more than once), never the sum of
// everything under it, which would count each model call twice. Its cost is the sum of the costs of
// the steps that belong to it, which only `llm_call` steps carry.

import type { Step } from "../types.ts";
import { bySeq, stepNodeId } from "./traceGraphMap.ts";

type ById = Record<string, Step>;

export interface NodeTiming {
  /** Wall-clock milliseconds across every time the node ran. */
  ms: number;
  /** USD, or null when nothing it did had a cost (no model call, or a cost not yet known). */
  cost: number | null;
  /** How many times it ran. */
  runs: number;
}

export function nodeTimings(byId: ById | undefined): Map<string, NodeTiming> {
  const out = new Map<string, NodeTiming>();
  if (!byId) return out;
  for (const step of Object.values(byId)) {
    const node = stepNodeId(step, byId);
    if (!node) continue;
    const t = out.get(node) ?? { ms: 0, cost: null, runs: 0 };
    if (step.type === "state_update") {
      t.ms += step.latency_ms ?? 0;
      t.runs += 1;
    }
    if (typeof step.cost === "number") t.cost = (t.cost ?? 0) + step.cost;
    out.set(node, t);
  }
  return out;
}

export interface ReplayFrame {
  /** The step this frame shows: a node finishing. */
  step: Step;
  node: string;
  /** The edge the run took into this node — from the node before it — when there was one. */
  edge?: { source: string; target: string };
}

/** The run as frames, in the order it ran: one per node finishing, each with the edge it arrived by. */
export function replayFrames(byId: ById | undefined): ReplayFrame[] {
  if (!byId) return [];
  const frames: ReplayFrame[] = [];
  for (const step of bySeq(byId)) {
    if (step.type !== "state_update") continue;
    const prev = frames[frames.length - 1];
    frames.push({ step, node: step.name, edge: prev ? { source: prev.node, target: step.name } : undefined });
  }
  return frames;
}

/**
 * The steps of a run up to and including a frame — what the graph shows at that point: each node's
 * status, and its time and cost.
 *
 * A STEP INSIDE A NODE COUNTS WITH ITS NODE. A node's own step takes its seq as the node starts, so
 * the model call it makes comes AFTER it in seq order while having happened before it finished — cut
 * by seq alone, the frame where a node finishes showed its time and not its cost.
 */
export function stepsUpTo(byId: ById, frame: ReplayFrame): ById {
  const out: ById = {};
  for (const [id, step] of Object.entries(byId)) {
    const owner = nodeStepOf(step, byId) ?? step;
    if (owner.seq <= frame.step.seq) out[id] = step;
  }
  return out;
}

/** The node step a step was taken inside — itself, for a node step — walking its parents. */
function nodeStepOf(step: Step, byId: ById): Step | undefined {
  const seen = new Set<string>();
  let cur: Step | undefined = step;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.type === "state_update") return cur;
    cur = cur.parent_step_id ? byId[cur.parent_step_id] : undefined;
  }
  return undefined;
}
