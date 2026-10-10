// A run read back onto the graph: each node's time and cost, and the run as frames to step through.
//
// What it exists to stop: a node's time counting its model calls twice (the node's own step already
// spans them), a loop's second pass going uncounted, and a replay that shows a node finishing before
// the one it came from.
//
//   npm run test:graph-replay

import { nodeTimings, replayFrames, stepsUpTo } from "./graphReplay.ts";
import type { Step } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

let seq = 0;
const step = (id: string, type: Step["type"], name: string, extra: Partial<Step> = {}): Step => ({
  id, run_id: "r", seq: seq++, type, name, input: null, output: null, state_before: null, state_after: null,
  tokens: null, cost: null, latency_ms: 0, error: null, parent_step_id: null, started_at: "", ...extra,
});

// Liven's run, roughly: three nodes, a model call inside the first and the third, and the scorer
// running twice (a retry loop), with a router between.
const steps = [
  step("n1", "state_update", "extract_jd", { latency_ms: 1200 }),
  step("l1", "llm_call", "claude", { latency_ms: 1100, cost: 0.004, parent_step_id: "n1" }),
  step("n2", "state_update", "extract_resume", { latency_ms: 800 }),
  step("n3", "state_update", "score_candidate", { latency_ms: 900 }),
  step("l3", "llm_call", "claude", { latency_ms: 850, cost: 0.006, parent_step_id: "n3" }),
  step("n3b", "state_update", "score_candidate", { latency_ms: 700 }),
  step("r1", "router", "route", { output: "decline_note", parent_step_id: "n3b" }),
  step("n4", "state_update", "decline_note", { latency_ms: 500, error: "boom" }),
];
const byId = Object.fromEntries(steps.map((s) => [s.id, s]));

console.log("§1 a node's time is its own, every time it ran");
{
  const t = nodeTimings(byId);
  check("extract_jd's time is its node step, not that plus its model call", t.get("extract_jd")?.ms === 1200, String(t.get("extract_jd")?.ms));
  check("...and its cost is its model call's", t.get("extract_jd")?.cost === 0.004);
  check("a node that ran twice counts both passes", t.get("score_candidate")?.ms === 1600 && t.get("score_candidate")?.runs === 2);
  check("a node with no model call has no cost, not a zero one", t.get("extract_resume")?.cost === null);
  check("no run, no timings", nodeTimings(undefined).size === 0);
}

console.log("\n§2 a run replays in the order it ran");
{
  const frames = replayFrames(byId);
  check("one frame per node finishing", frames.map((f) => f.node).join(" ") === "extract_jd extract_resume score_candidate score_candidate decline_note",
    frames.map((f) => f.node).join(" "));
  check("the first frame arrives by no edge", frames[0]!.edge === undefined);
  check("each later one by the edge from the node before it",
    frames[1]!.edge?.source === "extract_jd" && frames[1]!.edge?.target === "extract_resume");
  check("a loop's second pass arrives from its first", frames[3]!.edge?.source === "score_candidate" && frames[3]!.edge?.target === "score_candidate");
  const upTo = stepsUpTo(byId, frames[1]!);
  check("the statuses at a frame know nothing of what came after it",
    !!upTo.n2 && !upTo.n3 && !upTo.n4 && !!upTo.l1, Object.keys(upTo).join(" "));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
