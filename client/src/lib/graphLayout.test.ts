// The Graph tab's layout rules, held without a browser.
//
// What it exists to stop coming back: a seven-step agent laid out 2,400px wide in a 630px column,
// cropped at both ends with four-pixel labels; every step drawn as an "Action"; a fork that was
// the one thing in the agent the canvas could not show; branch labels repeating the names of the
// cards right beside them; and a step renamed "Extract Jd" on the way to the screen.
//
//   npm run test:graph-layout

import {
  AGENT_FOOTER_H,
  CARD_H,
  MIN_ZOOM,
  READABLE_ZOOM,
  branchChip,
  buildFlow,
  decisionId,
  edgeEnds,
  fitZoom,
  frameFor,
  loopPath,
  matchesEdge,
  nodeAriaLabel,
  readingOrder,
  roleOf,
  routePath,
  titleOf,
  type FlowLayout,
  type Point,
} from "./graphLayout.ts";
import type { AgentGraph } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// THE PANEL THE GRAPH IS DRAWN IN, at a 1440-wide window with the sidebar open.
const PANEL = { width: 630, height: 790 };

const model = (id: string, doc: string | null = null) => ({ id, type: "agent", calls_model: true, doc });

// Liven v1, as the runtime now describes it.
const LIVEN: AgentGraph = {
  agent_id: "liven",
  schema: 2,
  nodes: [
    { id: "__start__", type: "start", calls_model: false, doc: null },
    model("extract_jd", "Split the job description into must-haves and nice-to-haves."),
    model("extract_resume"),
    model("score_candidate"),
    model("shortlist_note"),
    model("decline_note"),
    { id: "__end__", type: "end", calls_model: false, doc: null },
  ],
  edges: [
    { source: "__start__", target: "extract_jd", conditional: false, label: null },
    { source: "extract_jd", target: "extract_resume", conditional: false, label: null },
    { source: "extract_resume", target: "score_candidate", conditional: false, label: null },
    { source: "score_candidate", target: "shortlist_note", conditional: true, label: "shortlist_note" },
    { source: "score_candidate", target: "decline_note", conditional: true, label: "decline_note" },
    { source: "shortlist_note", target: "__end__", conditional: false, label: null },
    { source: "decline_note", target: "__end__", conditional: false, label: null },
  ],
  routers: [{ source: "score_candidate", name: "route", doc: "Shortlist only when every must-have is met." }],
};

// The reference ReAct agent, as a graph cached before schema 2: no calls_model, no docs, no routers.
const REACT_OLD: AgentGraph = {
  agent_id: "example_agent",
  nodes: [
    { id: "__start__", type: "start" },
    { id: "agent", type: "agent" },
    { id: "tools", type: "tool" },
    { id: "record_note", type: "agent" },
    { id: "__end__", type: "end" },
  ],
  edges: [
    { source: "__start__", target: "agent", conditional: false, label: null },
    { source: "agent", target: "__end__", conditional: true, label: "__end__" },
    { source: "agent", target: "tools", conditional: true, label: "tools" },
    { source: "tools", target: "record_note", conditional: false, label: null },
    { source: "record_note", target: "agent", conditional: false, label: null },
  ],
};

console.log("§1 it fits the panel it is drawn in");
{
  const flow = buildFlow(LIVEN);
  const zoom = fitZoom(flow, PANEL);
  check("Liven's seven steps fit the panel at 75% or more", zoom >= 0.75, `zoom ${zoom.toFixed(2)} for ${flow.width}×${flow.height}`);
  check("...and readably, so no minimap is needed", zoom >= READABLE_ZOOM);
  const chain = ["__start__", "extract_jd", "extract_resume", "score_candidate"].map((id) => flow.nodes.find((n) => n.id === id)!);
  check("each step sits below the one before it", chain.every((n, i) => i === 0 || n.y > chain[i - 1]!.y));
  const shortlist = flow.nodes.find((n) => n.id === "shortlist_note")!;
  const decline = flow.nodes.find((n) => n.id === "decline_note")!;
  check("the two branches sit side by side", Math.abs(shortlist.y - decline.y) < 1 && shortlist.x !== decline.x);
  check("every node is inside the laid-out area",
    flow.nodes.every((n) => n.x >= 0 && n.y >= 0 && n.x + n.w <= flow.width + 0.5 && n.y + n.h <= flow.height + 0.5));

  const long: AgentGraph = {
    agent_id: "long",
    nodes: [{ id: "__start__", type: "start" }, ...Array.from({ length: 15 }, (_, i) => ({ id: `s${i}`, type: "agent" })), { id: "__end__", type: "end" }],
    edges: [
      { source: "__start__", target: "s0", conditional: false, label: null },
      ...Array.from({ length: 14 }, (_, i) => ({ source: `s${i}`, target: `s${i + 1}`, conditional: false, label: null })),
      { source: "s14", target: "__end__", conditional: false, label: null },
    ],
  };
  const longFlow = buildFlow(long);
  const whole = fitZoom(longFlow, PANEL);
  check("a fifteen-step agent fitted whole would be unreadable", whole < READABLE_ZOOM, whole.toFixed(2));
  const opens = frameFor(longFlow, PANEL);
  check("...so it opens from the top at a readable size instead",
    opens.kind === "top" && opens.zoom >= READABLE_ZOOM && opens.y === 0, JSON.stringify(opens));
  check("...centred across the column",
    opens.kind === "top" && Math.abs(opens.x * 2 + longFlow.width * opens.zoom - PANEL.width) < 1);
  check("Liven opens fitted whole", frameFor(flow, PANEL).kind === "fit");
  check("...unless an overlay hides so much of the panel it would not read",
    frameFor(flow, PANEL, 340).kind === (fitZoom(flow, { width: PANEL.width - 340, height: PANEL.height }) >= READABLE_ZOOM ? "fit" : "top"));
  check("a three-step agent is shown at real size, not blown up", fitZoom({ width: 300, height: 200 }, PANEL) === 1);
  check("no graph is framed below the canvas's minimum zoom", fitZoom({ width: 9000, height: 9000 }, PANEL) === MIN_ZOOM);
}

console.log("\n§2 each step says what it is");
{
  const flow = buildFlow(LIVEN);
  const role = (id: string) => flow.nodes.find((n) => n.id === id)?.role;
  check("a step the runtime says calls the model is a model call", role("extract_jd") === "model");
  check("Start and End are pills, not steps", role("__start__") === "start" && role("__end__") === "end");
  check("a step's description is its docstring",
    flow.nodes.find((n) => n.id === "extract_jd")?.doc === "Split the job description into must-haves and nice-to-haves.");

  const old = buildFlow(REACT_OLD);
  const oldRole = (id: string) => old.nodes.find((n) => n.id === id)?.role;
  check("on an older graph the ReAct agent node is still a model call", oldRole("agent") === "model");
  check("...a tool node is a tool node", oldRole("tools") === "tool");
  check("...and anything it cannot vouch for is a step, not a model call", oldRole("record_note") === "step");
  check("a step the runtime says calls no model is a step", roleOf({ id: "tidy", type: "agent", calls_model: false }) === "step");
}

console.log("\n§3 one name per thing");
{
  check("a node is shown under its id, as the code and the Trace tab write it", titleOf("extract_jd") === "extract_jd");
  check("Start and End are words", titleOf("__start__") === "Start" && titleOf("__end__") === "End");
  const flow = buildFlow(LIVEN);
  check("no card is title-cased", flow.nodes.every((n) => !/Extract Jd|Score Candidate/.test(n.title)));
}

console.log("\n§4 a fork is drawn as a decision");
{
  const flow = buildFlow(LIVEN);
  const decisions = flow.nodes.filter((n) => n.role === "decision");
  check("one decision node, at the fork", decisions.length === 1 && decisions[0]!.id === decisionId("score_candidate"));
  check("...named after the function that decides", decisions[0]?.title === "route");
  check("...carrying what that function says it does", decisions[0]?.doc === "Shortlist only when every must-have is met.");
  check("...and knowing which branches it chooses between",
    decisions[0]?.decides?.targets.sort().join(",") === "decline_note,shortlist_note");
  const d = decisions[0]!;
  const score = flow.nodes.find((n) => n.id === "score_candidate")!;
  const shortlist = flow.nodes.find((n) => n.id === "shortlist_note")!;
  check("it sits between the step and its branches", d.y > score.y && d.y < shortlist.y);

  const old = buildFlow(REACT_OLD);
  const oldDecision = old.nodes.find((n) => n.role === "decision");
  check("a fork with no router named by the runtime is still drawn, as a Branch", oldDecision?.title === "Branch");

  const gate: AgentGraph = {
    agent_id: "gate",
    nodes: [{ id: "__start__", type: "start" }, { id: "check", type: "agent" }, { id: "__end__", type: "end" }],
    edges: [
      { source: "__start__", target: "check", conditional: false, label: null },
      { source: "check", target: "__end__", conditional: true, label: "done" },
    ],
  };
  const g = buildFlow(gate);
  check("a single conditional edge is a gate, not a fork — no decision node", !g.nodes.some((n) => n.role === "decision"));
  check("...and keeps its label", g.edges.find((e) => e.source === "check")?.branch === "done");
}

console.log("\n§5 a branch label is shown only when it says something");
{
  check("a label naming its own target is not shown", branchChip("shortlist_note", "shortlist_note") === undefined);
  check("an end label on an edge to End is not shown", branchChip("__end__", "__end__") === undefined);
  check("a label that differs from its target is shown", branchChip("yes", "notify") === "yes");
  check("END as a label elsewhere reads as end", branchChip("__end__", "cleanup") === "end");
  check("no label, no chip", branchChip(null, "x") === undefined);
  const flow = buildFlow(LIVEN);
  check("Liven's branches carry no chips", flow.edges.every((e) => e.branch === undefined));
}

console.log("\n§6 the trace overlay still finds its edges");
{
  const flow = buildFlow(LIVEN);
  const real = { source: "score_candidate", target: "decline_note" };
  const lit = flow.edges.filter((e) => matchesEdge(e, real));
  check("a taken branch lights the stem into the decision and its own branch",
    lit.length === 2 && lit.some((e) => e.target === decisionId("score_candidate")) && lit.some((e) => e.target === "decline_note"),
    lit.map((e) => e.id).join(" "));
  check("...and not the branch it did not take", !lit.some((e) => e.target === "shortlist_note"));
  check("an ordinary edge matches itself",
    flow.edges.filter((e) => matchesEdge(e, { source: "extract_jd", target: "extract_resume" })).length === 1);
  check("no edge matches when nothing is hot", flow.edges.every((e) => !matchesEdge(e, undefined)));
}

console.log("\n§7 loops go round the side");
{
  const flow = buildFlow(REACT_OLD);
  const back = flow.edges.filter((e) => e.back);
  check("the edge back up to the agent is a loop", back.length === 1 && back[0]!.source === "record_note" && back[0]!.target === "agent",
    back.map((e) => e.id).join(" "));
  check("no edge that runs down the column is", flow.edges.filter((e) => !e.back).length === flow.edges.length - 1);
  const loop = back[0]!;
  const agent = flow.nodes.find((n) => n.id === "agent")!;
  const note = flow.nodes.find((n) => n.id === "record_note")!;
  const beside = flow.nodes.filter((n) => n.y < note.y + note.h && n.y + n.h > agent.y);
  check("its lane runs right of every card beside it — End included",
    loop.lane !== undefined && beside.every((n) => loop.lane! > n.x + n.w), `lane ${loop.lane}`);
  check("...and the layout is wide enough to hold it", loop.lane !== undefined && flow.width >= loop.lane);
  check("the loop is kept out of the layout, so the column stays centred under Start",
    Math.abs(agent.x + agent.w / 2 - (flow.nodes.find((n) => n.id === "__start__")!.x + 44)) < 1);
  check("the agent card grows to hold its model and tools when it has them",
    buildFlow(REACT_OLD, { agentFooter: true }).nodes.find((n) => n.id === "agent")?.h === CARD_H + AGENT_FOOTER_H);
  check("...and no other card does",
    buildFlow(REACT_OLD, { agentFooter: true }).nodes.find((n) => n.id === "record_note")?.h === CARD_H);
}

console.log("\n§8 no edge is drawn through a card");
{
  // EVERY EDGE, IN EVERY FIXTURE, against every card it does not start or end at. An edge that
  // skipped a row used to be drawn straight from end to end, and the skipped row's card sat on it —
  // with the branch's label underneath.
  const YESNO: AgentGraph = {
    agent_id: "yesno",
    nodes: [{ id: "__start__", type: "start" }, { id: "classify", type: "agent" }, { id: "draft_reply", type: "agent" }, { id: "__end__", type: "end" }],
    edges: [
      { source: "__start__", target: "classify", conditional: false, label: null },
      { source: "classify", target: "draft_reply", conditional: true, label: "yes" },
      { source: "classify", target: "__end__", conditional: true, label: "no" },
      { source: "draft_reply", target: "__end__", conditional: false, label: null },
    ],
  };
  const crossings = (flow: FlowLayout): string[] => {
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    const out: string[] = [];
    for (const e of flow.edges) {
      const ends = edgeEnds(e, byId);
      if (!ends) continue;
      const pts: Point[] = e.lane !== undefined ? loopPath(ends.s, ends.t, e.lane).points : routePath(ends.s, ends.t, e.via).points;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        for (const n of flow.nodes) {
          if (n.id === e.source || n.id === e.target) continue;
          const inX = Math.max(a.x, b.x) > n.x + 1 && Math.min(a.x, b.x) < n.x + n.w - 1;
          const inY = Math.max(a.y, b.y) > n.y + 1 && Math.min(a.y, b.y) < n.y + n.h - 1;
          if (inX && inY) out.push(`${e.id} through ${n.id}`);
        }
      }
    }
    return out;
  };
  for (const [name, graph] of [["Liven", LIVEN], ["the ReAct agent", REACT_OLD], ["a yes/no fork that skips a row", YESNO]] as const) {
    const hits = crossings(buildFlow(graph, { agentFooter: true }));
    check(`no edge in ${name} crosses a card`, hits.length === 0, hits.join("; "));
  }
  const flow = buildFlow(YESNO);
  const no = flow.edges.find((e) => e.branch === "no")!;
  check("the edge that skips a row is routed round it", (no.via?.length ?? 0) >= 3, JSON.stringify(no.via));
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const yes = flow.edges.find((e) => e.branch === "yes")!;
  const yesLabel = routePath(edgeEnds(yes, byId)!.s, edgeEnds(yes, byId)!.t, yes.via).label;
  const noLabel = routePath(edgeEnds(no, byId)!.s, edgeEnds(no, byId)!.t, no.via).label;
  check("...and its label sits on its own branch, not the other's", Math.abs(yesLabel.x - noLabel.x) > 20,
    `yes ${yesLabel.x} no ${noLabel.x}`);
}

console.log("\n§9 a screen reader is told what a node is, not how to delete it");
{
  const flow = buildFlow(LIVEN);
  const order = readingOrder(flow.nodes);
  const label = (id: string) => nodeAriaLabel(flow.nodes.find((n) => n.id === id)!, order);
  check("a step is named, given its role and its place",
    label("extract_jd") === "extract_jd, model call, step 1 of 5. Split the job description into must-haves and nice-to-haves.",
    label("extract_jd"));
  check("Start says what it is", label("__start__") === "Start of the graph");
  check("a decision says what it chooses between",
    label(decisionId("score_candidate")).startsWith("Decision route, chooses "), label(decisionId("score_candidate")));
  check("the decision pill is not counted as a step", !order.some((n) => n.role === "decision"));
}

console.log("\n§10 an edge to a node the graph does not have is dropped, not drawn to nowhere");
{
  const broken: AgentGraph = {
    agent_id: "broken",
    nodes: [{ id: "__start__", type: "start" }, { id: "a", type: "agent" }],
    edges: [
      { source: "__start__", target: "a", conditional: false, label: null },
      { source: "a", target: "ghost", conditional: false, label: null },
    ],
  };
  const flow = buildFlow(broken);
  check("only the edge between real nodes survives", flow.edges.length === 1 && flow.edges[0]!.target === "a");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
