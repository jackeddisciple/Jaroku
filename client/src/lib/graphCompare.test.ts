// Two versions of a graph, drawn as one: added, removed, and the same.
//
// What it exists to stop: a removed step vanishing from the comparison (it must be drawn, as gone);
// a fork marked changed when only one of its branches is; and a version compared with itself
// showing anything at all.
//
//   npm run test:graph-compare

import { compareGraphs, edgeKey, segmentMark } from "./graphCompare.ts";
import { buildFlow, decisionId } from "./graphLayout.ts";
import type { AgentGraph } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const e = (source: string, target: string, conditional = false, label: string | null = null) => ({ source, target, conditional, label });
const n = (id: string, type = "agent") => ({ id, type });

// v1: start → extract → score → (shortlist | decline) → end
const V1: AgentGraph = {
  agent_id: "liven",
  nodes: [n("__start__", "start"), n("extract"), n("score"), n("shortlist"), n("decline"), n("__end__", "end")],
  edges: [e("__start__", "extract"), e("extract", "score"), e("score", "shortlist", true, "shortlist"), e("score", "decline", true, "decline"),
    e("shortlist", "__end__"), e("decline", "__end__")],
  routers: [{ source: "score", name: "route", doc: null }],
};
// v2: a tidy step between extract and score; decline replaced by a polite_decline
const V2: AgentGraph = {
  agent_id: "liven",
  nodes: [n("__start__", "start"), n("extract"), n("tidy"), n("score"), n("shortlist"), n("polite_decline"), n("__end__", "end")],
  edges: [e("__start__", "extract"), e("extract", "tidy"), e("tidy", "score"), e("score", "shortlist", true, "shortlist"),
    e("score", "polite_decline", true, "polite_decline"), e("shortlist", "__end__"), e("polite_decline", "__end__")],
  routers: [{ source: "score", name: "route", doc: null }],
};

console.log("§1 nodes are added, removed or the same, by name");
{
  const d = compareGraphs(V2, V1);
  check("a step only the current version has is added", d.nodes.get("tidy") === "added" && d.nodes.get("polite_decline") === "added");
  check("a step only the older one had is removed", d.nodes.get("decline") === "removed");
  check("a step both have is neither", !d.nodes.has("extract") && !d.nodes.has("score"));
  check("the removed step is still drawn, in the union", d.union.nodes!.some((x) => x.id === "decline"));
  check("...along with every current one", V2.nodes!.every((x) => d.union.nodes!.some((u) => u.id === x.id)));
}

console.log("\n§2 edges likewise");
{
  const d = compareGraphs(V2, V1);
  check("an edge only now is added", d.edges.get(edgeKey("extract", "tidy")) === "added");
  check("an edge only then is removed", d.edges.get(edgeKey("extract", "score")) === "removed");
  check("an edge in both is neither", !d.edges.has(edgeKey("__start__", "extract")));
  check("the removed edge is drawn too", d.union.edges!.some((x) => x.source === "extract" && x.target === "score"));
}

console.log("\n§3 a fork's stem is marked only when every branch it carries is");
{
  const d = compareGraphs(V2, V1);
  check("one branch new and one gone: the stem is neither", segmentMark(d, "score", ["shortlist", "polite_decline", "decline"]) === undefined);
  check("a branch drawn on its own carries its own mark", segmentMark(d, "score", ["polite_decline"]) === "added");
  check("a port line or Start's nothing is never marked", segmentMark(d, "", []) === undefined);
  const flow = buildFlow(d.union);
  check("the union lays out, with one decision at the fork", flow.nodes.filter((x) => x.id === decisionId("score")).length === 1);
}

console.log("\n§4 a version compared with itself shows nothing");
{
  const d = compareGraphs(V1, V1);
  check("no node marked", d.nodes.size === 0);
  check("no edge marked", d.edges.size === 0);
  check("the union is the graph", d.union.nodes!.length === V1.nodes!.length && d.union.edges!.length === V1.edges!.length);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
