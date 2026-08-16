// Two trees in, and what changed about the AGENT rather than about the text.
//
// THE ORDERING RULE IS THE STRONGEST ASSERTION HERE, and §B.7.2 is why: whatever else a commit
// changes, if it widens what `mcp_tools.json` grants, that line renders FIRST and in the warning
// tone. A semantic diff that buried a widened grant under an alphabetically sorted list would be
// actively worse than the plain line-diff it replaces — because somebody skimming it has been told
// they are reading a summary, and would skim past the one fact that matters.
//
// AND THE CLASSIFICATION IS LOOKED UP, NEVER COMPUTED. §B.7.2 mirrors the McpImpact ratchet: a
// classification may only be raised by an untrusted signal, and here the untrusted signal is "an
// external commit changed the manifest". A newly granted tool nobody has classified reads as
// high-impact, which is `mcpImpact.classify`'s own step 4 — when the heuristic cannot read
// something it fails toward the expensive-but-safe answer.
//
// The AST half needs a Python interpreter and is skipped without one. The diffing half is pure and
// always runs, and it is where every ordering and null rule lives.
//
//   npm run test:semantic-diff

import { existsSync } from "node:fs";
import { join } from "node:path";
import { diffShapes, readShape, summariseChanges, type AgentShape } from "./semanticDiff.ts";
import type { McpImpact } from "./mcpStore.ts";
import type { StoredFile } from "./storage/projectStore.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const RUNTIME_DIR = join(process.cwd(), "..", "runtime");
const hasRuntime = existsSync(join(RUNTIME_DIR, "pyproject.toml"));

const shape = (patch: Partial<AgentShape> = {}): AgentShape => ({
  tools: [],
  stateFields: [],
  graphEdges: [],
  mcpTools: [],
  ...patch,
});

const kinds = (rows: { kind: string }[]): string => rows.map((r) => r.kind).join(",");

console.log("\nthe MCP grant line comes first, whatever else changed");
{
  const before = shape({ tools: ["get_weather"], mcpTools: ["linear/list_issues"] });
  const after = shape({
    // Deliberately arranged so that alphabetical ordering, arrival ordering and category ordering
    // would each put something else first.
    tools: ["a_tool", "get_weather"],
    stateFields: [{ name: "retry_count", type: "int" }],
    graphEdges: [{ from: "router", to: "END", conditional: false }],
    mcpTools: ["linear/list_issues", "slack/send_message"],
  });
  const rows = diffShapes(before, after, () => "high");

  check(rows[0]!.kind === "mcp_grant_widened", "first, ahead of a tool, a state field and an edge", kinds(rows));
  check(rows[0]!.warn === true, "and in the warning tone");
  check(rows[0]!.object.includes("send_message"), "naming what was granted", rows[0]!.object);
  check(rows[0]!.detail === "high-impact", "with the STORED classification beside it", rows[0]!.detail);
  check(rows.filter((r) => r.kind === "mcp_grant_widened").length === 1,
    "one row for the whole widening — three saying it three times is three chances to skim past the first");
}

console.log("\nthe classification is looked up, and an unknown one reads as high");
{
  const before = shape({ mcpTools: [] });
  const after = shape({ mcpTools: ["linear/list_issues"] });

  const low = diffShapes(before, after, () => "low")[0]!;
  check(low.detail === "low-impact", "a stored low classification is reported as low");

  // `mcpImpact.classify`'s own step 4, applied one level up: a tool nobody has discovered is one
  // whose impact nobody — including us — knows.
  const unknown = diffShapes(before, after, () => undefined)[0]!;
  check(unknown.detail === "high-impact", "and one nobody has classified reads as high, not as low");
  const noLookup = diffShapes(before, after)[0]!;
  check(noLookup.detail === "high-impact", "…as does one with no classifier available at all");

  // A grant with one low and one unknown tool is not a low-impact widening.
  const mixed = diffShapes(before, shape({ mcpTools: ["a/x", "b/y"] }), (ref) =>
    ref === "a/x" ? ("low" as McpImpact) : undefined,
  )[0]!;
  check(mixed.detail === "high-impact", "and the worst of a set decides, rather than the first");
}

console.log("\na narrowing grant is reported and is not a warning");
{
  const rows = diffShapes(shape({ mcpTools: ["a/x"] }), shape({ mcpTools: [] }));
  check(rows[0]!.kind === "mcp_grant_narrowed", "the agent can do less, and that is worth saying");
  // Marking it would train people to skim the tone, which costs the one row that needs it.
  check(rows[0]!.warn !== true, "…and is not marked, because nobody needs alerting that a capability went away");
}

console.log("\ntools, state and edges");
{
  const before = shape({
    tools: ["gmail_search", "get_weather"],
    stateFields: [{ name: "city", type: "str" }, { name: "tries", type: "int" }],
    graphEdges: [{ from: "router", to: "END", conditional: false }],
  });
  const after = shape({
    tools: ["order_lookup", "get_weather"],
    stateFields: [{ name: "city", type: "str" }, { name: "tries", type: "int | None" }, { name: "retry_count", type: "int" }],
    graphEdges: [
      { from: "router", to: "retry", conditional: true },
      { from: "retry", to: "END", conditional: false },
    ],
  });
  const rows = diffShapes(before, after);

  check(rows.some((r) => r.kind === "tool_added" && r.object === "order_lookup"), "an added tool");
  check(rows.some((r) => r.kind === "tool_removed" && r.object === "gmail_search"), "a removed one");
  check(!rows.some((r) => r.object === "get_weather"), "and one that did not change is not a row");

  check(rows.some((r) => r.kind === "state_field_added" && r.object === "retry_count: int"), "a new state field, with its type");

  // One thing happened, not two. And the old type is the useful half: `int` to `str` is a
  // migration and `int` to `int | None` is a nullability change, which two rows would say neither of.
  const retyped = rows.find((r) => r.kind === "state_field_retyped");
  check(retyped?.object === "tries: int | None" && retyped.detail === "was int",
    "a retyped field is ONE row carrying the old type", JSON.stringify(retyped));
  check(!rows.some((r) => r.kind === "state_field_removed" && r.object === "tries"),
    "…and not a removal plus an addition");

  check(rows.some((r) => r.kind === "graph_edge_added" && r.object === "router→retry" && r.detail === "conditional"),
    "an added conditional edge says it is conditional", kinds(rows));
  check(rows.some((r) => r.kind === "graph_edge_removed" && r.object === "router→END"), "and the edge it replaced is removed");

  check(diffShapes(before, before).length === 0, "an unchanged agent produces no rows at all");
}

console.log("\nthe one-line summary §B.7.3 hands to the Overlapping list");
{
  const widened = diffShapes(
    shape({ tools: ["a"] }),
    shape({ tools: ["a", "b"], mcpTools: ["s/send_message"] }),
    () => "high",
  );
  // The warning row leads the summary for the same reason it leads the list.
  check(summariseChanges(widened).startsWith("MCP grant widened"), "the widened grant leads", summariseChanges(widened));
  check(summariseChanges(widened).includes("and 1 more"), "with the rest accounted for rather than hidden");

  const one = diffShapes(shape(), shape({ tools: ["b"] }));
  check(summariseChanges(one) === "tool added b", "a single change is just itself", summariseChanges(one));

  // Two sides that both edited a docstring have overlapped in the TEXT and not in the agent, and
  // saying so is more useful than inventing a summary of a whitespace change.
  check(summariseChanges([]) === "", "and nothing structural is an empty summary, not a fabricated one");
}

const py = (path: string, content: string): StoredFile => ({ path, content });

// One `uv run` resolves the venv before anything is timed — the same warm-up the live-diagnostics
// suite explains at length.
if (hasRuntime) await readShape([py("warm.py", "x = 1\n")], { runtimeDir: RUNTIME_DIR });

/**
 * Whether the AST half can run AT ALL, asked by running it — the same probe `liveDiagnostics.test`
 * makes, for the same reason.
 *
 * `existsSync(runtime/pyproject.toml)` IS TRUE ON A MACHINE WITH NO PYTHON, because the file is in
 * the checkout everywhere. `readShape` reports its inability to run as an `error` rather than
 * throwing — correctly, since §B.7's Agent diff has to say "the analysis could not run" instead of
 * "nothing changed" — and this suite read that as six rules being broken.
 */
const canRunPython = hasRuntime && (await readShape([py("probe.py", "x = 1\n")], { runtimeDir: RUNTIME_DIR })).error === undefined;

if (!canRunPython) {
  console.log(
    hasRuntime
      ? "\n(skipping the AST half: runtime/ is here but no Python interpreter would run)"
      : "\n(skipping the AST half: no runtime/ with a Python project)",
  );
} else {

  console.log("\nreading a tree's shape, through the validator's own AST paths");
  {
    const files = [
      py(
        "tools/__init__.py",
        [
          "from langchain_core.tools import tool",
          "",
          "@tool",
          "def get_weather(city: str) -> str:",
          '    return "sunny"',
          "",
          "CONNECTOR_TOOLS = [pg_query]",
          "TOOLS = CONNECTOR_TOOLS + [get_weather]",
          "",
        ].join("\n"),
      ),
      py(
        "agent.py",
        [
          "from typing import TypedDict",
          "from langgraph.graph import StateGraph, END",
          "",
          "class AgentState(TypedDict):",
          "    city: str",
          "    retry_count: int",
          "",
          "def build_graph(llm):",
          "    g = StateGraph(AgentState)",
          '    g.add_edge("router", "tools")',
          '    g.add_conditional_edges("tools", route, {"more": "router", "done": END})',
          "    return g.compile()",
          "",
        ].join("\n"),
      ),
    ];
    const s = await readShape(files, { runtimeDir: RUNTIME_DIR });

    check(s.tools.includes("get_weather"), "a decorated @tool is a tool", JSON.stringify(s.tools));
    // v0.2.0's TOOLS tracing, following one level of local variable — reused rather than reinvented,
    // so a second reading of what TOOLS binds cannot disagree with the gate's.
    check(s.tools.includes("pg_query"), "and so is a name TOOLS binds through a local variable");

    check(s.stateFields.some((f) => f.name === "retry_count" && f.type === "int"),
      "state fields come back with their annotations", JSON.stringify(s.stateFields));

    check(s.graphEdges.some((e) => e.from === "router" && e.to === "tools" && !e.conditional), "a plain edge");
    check(s.graphEdges.some((e) => e.from === "tools" && e.to === "router" && e.conditional),
      "and a conditional edge's literal mapping, by its VALUES", JSON.stringify(s.graphEdges));
    check(s.error === undefined, "a tree that parses reports no problem");
  }

  console.log("\nthe manifest is the grant, and a half-written tree still produces a shape");
  {
    const manifest = {
      path: "mcp_tools.json",
      content: JSON.stringify({
        servers: [{ id: "linear", tools: [{ name: "list_issues" }, { name: "create_issue" }] }],
      }),
    };
    const s = await readShape([manifest], { runtimeDir: RUNTIME_DIR });
    check(s.mcpTools.join(",") === "linear/create_issue,linear/list_issues",
      "granted refs are server/tool, sorted", s.mcpTools.join(","));

    // A manifest that does not parse grants nothing NAMEABLE. Reporting the whole grant as removed
    // would be a claim; reporting none of it is silence, which is the safer of the two.
    const broken = await readShape([{ path: "mcp_tools.json", content: "{ not json" }], { runtimeDir: RUNTIME_DIR });
    check(broken.mcpTools.length === 0, "and an unparseable manifest grants nothing rather than revoking everything");

    // Somebody's branch is mid-edit. Losing four correct rows because a fifth file will not parse
    // would be the surface refusing to be useful at exactly the moment somebody is looking at it.
    const half = await readShape(
      [py("agent.py", "def build_graph(\n"), py("tools/__init__.py", "TOOLS = []\n@tool\ndef ok(): pass\n")],
      { runtimeDir: RUNTIME_DIR },
    );
    check(half.error !== undefined, "a tree that half-parses reports the problem");
    check(half.tools.includes("ok"), "…and still returns what the files that DID parse contain", JSON.stringify(half.tools));
  }
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
