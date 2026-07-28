// Regression guard for the pre-generation plan parser.
//
// Unlike fileProtocol.test.ts there are no chunk-boundary cases: parsePlan() runs once over
// the complete text. What matters instead is TOLERANCE — the plan is prose a model writes at
// ~600 max_tokens, so markdown fences, heading variance, missing sections and truncation are
// all expected, not exotic. Every one of them must degrade to something displayable rather
// than throwing or silently losing content.
//
//   npm run test:plan

import type { Connector } from "./connectors.ts";
import { isDegraded, parsePlan, planProblem, reconcileWithSelection } from "./planProtocol.ts";

let fail = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const WELL_FORMED = [
  `<<<PLAN section="tools">>>`,
  `- gmail_search — reviewed connector template (gmail)`,
  `- order_lookup — bespoke; reads order status from Postgres by order id`,
  `<<<ENDPLAN>>>`,
  `<<<PLAN section="state">>>`,
  `- messages: MessagesState — the conversation`,
  `- order: dict | None — the order currently under discussion`,
  `<<<ENDPLAN>>>`,
  `<<<PLAN section="graph">>>`,
  `- agent (llm) → conditional → tools | END`,
  `- tools → record_order → agent`,
  `<<<ENDPLAN>>>`,
  `<<<PLAN section="notes">>>`,
  `- Drafts replies but never sends them.`,
  `<<<ENDPLAN>>>`,
].join("\n");

// 1 — the happy path, in full.
{
  const p = parsePlan(WELL_FORMED);
  check("well-formed: two tools", p.tools.length === 2, p.tools);
  check(
    "well-formed: connector tool labelled + id extracted",
    p.tools[0]?.name === "gmail_search" &&
      p.tools[0]?.origin === "connector" &&
      p.tools[0]?.connectorId === "gmail",
    p.tools[0],
  );
  check(
    "well-formed: bespoke tool labelled, summary kept",
    p.tools[1]?.name === "order_lookup" &&
      p.tools[1]?.origin === "bespoke" &&
      p.tools[1]!.summary.includes("order status"),
    p.tools[1],
  );
  check(
    "well-formed: state name/type/purpose split",
    p.state.length === 2 &&
      p.state[1]?.name === "order" &&
      p.state[1]?.type === "dict | None" &&
      p.state[1]?.purpose === "the order currently under discussion",
    p.state,
  );
  check("well-formed: graph lines verbatim", p.graph.length === 2 && p.graph[1] === "tools → record_order → agent", p.graph);
  check("well-formed: notes", p.notes.length === 1, p.notes);
  check("well-formed: complete", p.complete === true);
  check("well-formed: not degraded", isDegraded(p) === false);
  check("well-formed: no problem", planProblem(p) === null);
}

// 2 — CRLF must not leak into parsed values.
{
  const p = parsePlan(WELL_FORMED.replace(/\n/g, "\r\n"));
  check("CRLF: parses identically", p.tools.length === 2 && p.state.length === 2 && p.graph.length === 2, p.tools);
  check("CRLF: no stray \\r", !JSON.stringify(p.tools).includes("\\r"), p.tools);
}

// 3 — the whole response wrapped in a markdown fence.
{
  const p = parsePlan("```\n" + WELL_FORMED + "\n```");
  check("fenced response: sections still found", p.tools.length === 2 && p.graph.length === 2, p.tools);
}

// 4 — an individual section body fenced.
{
  const p = parsePlan(
    `<<<PLAN section="tools">>>\n\`\`\`\n- lookup — bespoke; does a thing\n\`\`\`\n<<<ENDPLAN>>>`,
  );
  check("fenced section body", p.tools.length === 1 && p.tools[0]?.name === "lookup", p.tools);
}

// 5 — bullet variance: -, *, •, 1., and no bullet at all.
{
  const p = parsePlan(
    `<<<PLAN section="graph">>>\n- one\n* two\n• three\n1. four\nfive\n<<<ENDPLAN>>>`,
  );
  check(
    "bullet variance stripped",
    p.graph.join("|") === "one|two|three|four|five",
    p.graph,
  );
}

// 6 — a missing section parses to empty and is still COMPLETE. A plan with no domain state
//     is a legitimate plan (MessagesState-only agents are the common case).
{
  const p = parsePlan(`<<<PLAN section="tools">>>\n- a — bespoke; x\n<<<ENDPLAN>>>`);
  check("missing sections: empty, not an error", p.state.length === 0 && p.graph.length === 0 && p.notes.length === 0);
  check("missing sections: still complete", p.complete === true);
  check("missing sections: no problem reported", planProblem(p) === null);
}

// 7 — truncation mid-section: keep what arrived, flag incomplete, stay displayable.
{
  const p = parsePlan(
    `<<<PLAN section="tools">>>\n- gmail_search — reviewed connector template (gmail)\n<<<ENDPLAN>>>\n` +
      `<<<PLAN section="state">>>\n- messages: MessagesState — the conv`,
  );
  check("truncation: earlier section intact", p.tools.length === 1, p.tools);
  check("truncation: partial section retained", p.state.length === 1 && p.state[0]?.name === "messages", p.state);
  check("truncation: complete === false", p.complete === false);
  check("truncation: still displayable", planProblem(p) === null && isDegraded(p) === false);
}

// 8 — an unclosed section followed by another block must not swallow it.
{
  const p = parsePlan(
    `<<<PLAN section="tools">>>\n- a — bespoke; x\n` + `<<<PLAN section="graph">>>\n- start → end\n<<<ENDPLAN>>>`,
  );
  check("unclosed section bounded by the next block", p.tools.length === 1 && p.graph.length === 1, {
    tools: p.tools,
    graph: p.graph,
  });
  check("unclosed section marks incomplete", p.complete === false);
}

// 9 — THE case that justifies delimiters over bare "STATE:" headings: a notes body whose
//     prose contains a line starting with a section word must not split the section.
{
  const p = parsePlan(
    `<<<PLAN section="notes">>>\n- The graph is deliberately flat.\nSTATE: this line is prose, not a heading.\n<<<ENDPLAN>>>`,
  );
  check("section word inside notes body is not a boundary", p.notes.length === 2 && p.state.length === 0, {
    notes: p.notes,
    state: p.state,
  });
}

// 10 — unknown section + preamble prose: preserved in raw, neighbours uncorrupted.
{
  const p = parsePlan(
    `Here is the plan.\n<<<PLAN section="risks">>>\n- might be slow\n<<<ENDPLAN>>>\n` +
      `<<<PLAN section="tools">>>\n- a — bespoke; x\n<<<ENDPLAN>>>`,
  );
  check("unknown section ignored structurally", p.tools.length === 1, p.tools);
  check("preamble + unknown section kept in raw", p.raw.includes("Here is the plan.") && p.raw.includes("might be slow"));
  check("unknown section doesn't break completeness", p.complete === true);
}

// 11 — degraded fallback: no delimiters at all, markdown headings instead.
{
  const p = parsePlan(
    `## Tools\n- gmail_search — reviewed connector template (gmail)\n\n**STATE:**\n- messages: MessagesState — chat\n\nNODES:\n- agent → END\n`,
  );
  check("heading fallback: tools", p.tools.length === 1 && p.tools[0]?.connectorId === "gmail", p.tools);
  check("heading fallback: state", p.state.length === 1 && p.state[0]?.name === "messages", p.state);
  check("heading fallback: NODES maps to graph", p.graph.length === 1 && p.graph[0] === "agent → END", p.graph);
  check("heading fallback: complete", p.complete === true);
}

// 12 — total garbage: no structure at all, but still shown rather than failed.
{
  const p = parsePlan("I think we should build a nice agent for you. It will be great.");
  check("prose-only: degraded", isDegraded(p) === true);
  check("prose-only: NOT an error (the card falls back to raw)", planProblem(p) === null);
  check("prose-only: raw preserved", p.raw.includes("nice agent"));
}

// 13 — whitespace-only IS an error, mirroring fileProtocol's "the model produced no files".
{
  const p = parsePlan("   \n\n  \t ");
  check("whitespace-only reports a problem", planProblem(p) !== null, planProblem(p));
}

// --- reconcileWithSelection: the connector cross-check ---------------------------------

const GMAIL: Connector = {
  id: "gmail", label: "Gmail", file: "gmail.py", module: "gmail",
  description: "", required_env: ["GMAIL_TOKEN"],
  tools: [{ name: "gmail_search", signature: "", summary: "" }],
};
const POSTGRES: Connector = {
  id: "postgres", label: "Postgres", file: "postgres.py", module: "postgres",
  description: "", required_env: ["DATABASE_URL"],
  tools: [{ name: "pg_query", signature: "", summary: "" }],
};

// 14 — the plan wants a connector the user didn't tick.
{
  const p = parsePlan(
    `<<<PLAN section="tools">>>\n- gmail_search — reviewed connector template (gmail)\n<<<ENDPLAN>>>`,
  );
  const w = reconcileWithSelection(p, []);
  check("warns: plan uses an unselected connector", w.length === 1 && w[0]!.includes("isn't selected"), w);
}

// 15 — the user ticked a connector the plan never uses.
{
  const p = parsePlan(`<<<PLAN section="tools">>>\n- own_thing — bespoke; does a thing\n<<<ENDPLAN>>>`);
  const w = reconcileWithSelection(p, [POSTGRES]);
  check("warns: selected connector goes unused", w.length === 1 && w[0]!.includes("doesn't use any"), w);
}

// 16 — the plan proposes writing a tool the reviewed template already provides.
{
  const p = parsePlan(`<<<PLAN section="tools">>>\n- gmail_search — bespoke; searches mail\n<<<ENDPLAN>>>`);
  const w = reconcileWithSelection(p, [GMAIL]);
  check("warns: bespoke duplicate of a reviewed tool", w.length === 1 && w[0]!.includes("reviewed template will be used"), w);
}

// 17 — everything lines up: no noise.
{
  const p = parsePlan(
    `<<<PLAN section="tools">>>\n- gmail_search — reviewed connector template (gmail)\n- summarize — bespoke; condenses a thread\n<<<ENDPLAN>>>`,
  );
  check("no warnings when plan and selection agree", reconcileWithSelection(p, [GMAIL]).length === 0, reconcileWithSelection(p, [GMAIL]));
}

// 18 — an unparsed tool list must not manufacture "unused connector" noise.
{
  const p = parsePlan("prose only, no sections");
  check("degraded plan produces no reconcile noise", reconcileWithSelection(p, [GMAIL, POSTGRES]).length === 0);
}

// 19 — connector identified by tool name alone (the model omitted the parenthetical).
{
  const p = parsePlan(`<<<PLAN section="tools">>>\n- gmail_search — reviewed connector template\n<<<ENDPLAN>>>`);
  check("connector resolved via tool name when id is absent", reconcileWithSelection(p, [GMAIL]).length === 0, reconcileWithSelection(p, [GMAIL]));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
