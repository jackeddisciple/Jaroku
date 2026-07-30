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


// --- MCP: a third provenance, and the ways a plan can misattribute it ------------------
//
// Mislabelling matters more here than anywhere else in this file. Calling an audited
// connector "bespoke" is untidy; calling unreviewed third-party code "reviewed" tells a user
// the opposite of the truth about what is about to run.

/** A scoped MCP tool, shaped as McpToolView (mcpRegistry.ts). */
const mcpTool = (server: string, name: string) => ({
  server_id: server,
  name,
  description: null,
  input_schema: {},
  schema_hash: "h",
  impact: "high" as const,
  computed_impact: "high" as const,
  impact_reason: "test",
  overridden: false,
  override_voided: false,
  annotations: null,
});
const CREATE_ISSUE = mcpTool("linear", "create_issue");
const SEARCH_DOCS = mcpTool("notion", "search_docs");

// 20 — the forms a model actually writes for an MCP tool.
{
  const lines = [
    "- create_issue — MCP tool from the linear MCP server",
    "- create_issue — mcp: linear/create_issue",
    "- create_issue — external server tool (mcp: linear)",
    "- create_issue — MCP server: linear; files an issue",
  ];
  for (const line of lines) {
    const p = parsePlan(`<<<PLAN section="tools">>>\n${line}\n<<<ENDPLAN>>>`);
    const t = p.tools[0]!;
    check(`parses as mcp: ${line.slice(17, 52)}`, t.origin === "mcp", t.origin);
    check(`...and names the server`, t.mcpServerId === "linear", t.mcpServerId);
  }
}

// 21 — "MCP connector" must be mcp, not connector. A model reaching for the wrong noun must
// not get unreviewed code labelled audited.
{
  const p = parsePlan(`<<<PLAN section="tools">>>\n- create_issue — MCP connector (linear)\n<<<ENDPLAN>>>`);
  check("'MCP connector' resolves to mcp, not connector", p.tools[0]!.origin === "mcp", p.tools[0]!.origin);
}

// 22 — adjectives are not server names.
{
  const p = parsePlan(`<<<PLAN section="tools">>>\n- do_thing — an external MCP server tool\n<<<ENDPLAN>>>`);
  check("'external' is not read as a server id", p.tools[0]!.mcpServerId === undefined, p.tools[0]!.mcpServerId);
}

// 23 — plan and selection agree: no noise.
{
  const p = parsePlan(`<<<PLAN section="tools">>>\n- create_issue — mcp: linear/create_issue\n<<<ENDPLAN>>>`);
  check("no warnings when the MCP plan matches the selection",
    reconcileWithSelection(p, [], [CREATE_ISSUE]).length === 0,
    reconcileWithSelection(p, [], [CREATE_ISSUE]));
}

// 24 — the plan claims an MCP tool nobody selected.
{
  const p = parsePlan(`<<<PLAN section="tools">>>\n- delete_all — mcp: linear/delete_all\n<<<ENDPLAN>>>`);
  const w = reconcileWithSelection(p, [], [CREATE_ISSUE]);
  check("warns: MCP tool not selected", w.some((x) => x.includes("isn't one of the MCP tools you")), w);
}

// 25 — the plan calls a scoped MCP tool something safer than it is. This is the important one.
{
  const asConnector = parsePlan(`<<<PLAN section="tools">>>\n- create_issue — reviewed connector template\n<<<ENDPLAN>>>`);
  const w1 = reconcileWithSelection(asConnector, [], [CREATE_ISSUE]);
  check("warns when unreviewed MCP code is described as a reviewed connector",
    w1.some((x) => x.includes("has not reviewed")), w1);

  const asBespoke = parsePlan(`<<<PLAN section="tools">>>\n- create_issue — bespoke; files an issue\n<<<ENDPLAN>>>`);
  const w2 = reconcileWithSelection(asBespoke, [], [CREATE_ISSUE]);
  check("warns when unreviewed MCP code is described as bespoke",
    w2.some((x) => x.includes("has not reviewed")), w2);
}

// 26 — the plan attributes a tool to the wrong server. Two servers can advertise one name.
{
  const p = parsePlan(`<<<PLAN section="tools">>>\n- create_issue — mcp: jira/create_issue\n<<<ENDPLAN>>>`);
  const w = reconcileWithSelection(p, [], [CREATE_ISSUE]);
  check("warns on a server mismatch", w.some((x) => x.includes("attributes create_issue to the jira")), w);
}

// 27 — a selected tool the plan never uses. The agent still gets it; the user is told.
{
  const p = parsePlan(`<<<PLAN section="tools">>>\n- create_issue — mcp: linear/create_issue\n<<<ENDPLAN>>>`);
  const w = reconcileWithSelection(p, [], [CREATE_ISSUE, SEARCH_DOCS]);
  check("warns about an unused MCP selection", w.some((x) => x.includes("notion/search_docs")), w);
  check("...and says the agent still gets it", w.some((x) => x.includes("will still be given it")), w);
}

// 28 — a degraded plan must not silently revoke a selection.
//
// The manifest is the user's explicit per-tool choice, never the intersection with what this
// parser managed to read. Hanging a grant off a parser documented as degrading would let a
// plan written in prose strip every tool the user ticked, and the generation would come out
// broken for reasons nobody could see.
{
  const p = parsePlan("prose only, no sections at all");
  check("degraded plan produces no MCP reconcile noise",
    reconcileWithSelection(p, [], [CREATE_ISSUE]).length === 0,
    reconcileWithSelection(p, [], [CREATE_ISSUE]));
}

// 29 — connectors and MCP tools coexist without interfering.
{
  const p = parsePlan(
    `<<<PLAN section="tools">>>\n- gmail_search — reviewed connector template (gmail)\n` +
      `- create_issue — mcp: linear/create_issue\n- summarize — bespoke; condenses a thread\n<<<ENDPLAN>>>`,
  );
  check("three provenances parse side by side",
    p.tools.map((t) => t.origin).join(",") === "connector,mcp,bespoke",
    p.tools.map((t) => t.origin).join(","));
  check("no warnings when all three line up",
    reconcileWithSelection(p, [GMAIL], [CREATE_ISSUE]).length === 0,
    reconcileWithSelection(p, [GMAIL], [CREATE_ISSUE]));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
