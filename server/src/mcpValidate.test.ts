// Validation of a project that was granted MCP tools.
//
// A discovered MCP tool carries a real JSON Schema, which a reviewed connector never did —
// its parameters were only ever a display string. So a wrong call can be caught here, before
// the project is written, instead of at runtime against somebody else's server.
//
// Three things are checked, and each has a failure mode that is silent without it: an agent
// whose metadata advertises MCP tools it cannot call, a generated function shadowing a
// granted tool's name, and a call that does not fit the schema the server declared.
//
//   npm run test:mcp-validate

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateProject } from "./validator.ts";
import type { Manifest } from "./mcpManifest.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const RUNTIME = join(process.cwd(), "..", "runtime");

const MANIFEST: Manifest = {
  schema_version: 1,
  servers: [
    {
      id: "linear",
      label: "Linear",
      endpoint: "http://127.0.0.1:1/mcp",
      transport: "http",
      auth_env_key: null,
      server_name: "linear",
      server_version: "1",
      protocol_version: "2025-06-18",
      discovered_at: null,
      tools: [
        {
          name: "create_issue",
          description: "Create an issue.",
          input_schema: {
            type: "object",
            properties: { title: { type: "string" }, team: { type: "string" } },
            required: ["title"],
          },
          impact: "high",
          impact_reason: 'its name begins with "create"',
        },
        {
          name: "list_issues",
          description: "List issues.",
          // A server that declared no properties has not said none are allowed.
          input_schema: { type: "object" },
          impact: "low",
          impact_reason: 'its name begins with "list"',
        },
      ],
    },
  ],
};

const AGENT_PY = `"""Test agent."""
from __future__ import annotations

from langchain_core.messages import HumanMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

from .tools import TOOLS


def build_graph(llm):
    model = llm.bind_tools(TOOLS)

    def call_model(state: MessagesState):
        return {"messages": [model.invoke(state["messages"])]}

    def should_continue(state: MessagesState) -> str:
        last = state["messages"][-1]
        return "tools" if getattr(last, "tool_calls", None) else END

    graph = StateGraph(MessagesState)
    graph.add_node("agent", call_model)
    graph.add_node("tools", ToolNode(TOOLS, handle_tool_errors=True))
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    graph.add_edge("tools", "agent")
    return graph.compile()


def build_initial_state(user_input: str) -> dict:
    return {"messages": [HumanMessage(user_input)]}
`;

const dirs: string[] = [];

/**
 * Stage a project with the MCP bridge installed, then validate it.
 *
 * Only the AST-level problems are returned: the import check needs a real uv venv and a
 * package layout, and what is under test here is the static analysis.
 */
async function validate(files: Record<string, string>): Promise<string[]> {
  const dir = join(tmpdir(), `jaroku-mcpval-${randomUUID()}`);
  dirs.push(dir);
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "agent.py"), files["agent.py"] ?? AGENT_PY);
  writeFileSync(join(dir, ".env.example"), "# none\n");
  writeFileSync(join(dir, "mcp_tools.json"), JSON.stringify(MANIFEST));
  // A stand-in for the reviewed bridge: what matters to the AST pass is that the file is in
  // connectorFiles and therefore excluded from the model-output lints.
  writeFileSync(join(dir, "tools", "mcp_bridge.py"), "MCP_TOOLS = []\n");
  for (const [path, content] of Object.entries(files)) {
    if (path === "agent.py") continue;
    writeFileSync(join(dir, path), content);
  }
  const result = await validateProject(dir, {
    runtimeDir: RUNTIME,
    connectorFiles: ["tools/mcp_bridge.py"],
    mcpTools: MANIFEST,
  });
  return result.problems;
}

const TOOLS_WIRED = `from .mcp_bridge import MCP_TOOLS

TOOLS = MCP_TOOLS

__all__ = ["TOOLS"]
`;

// --- 1. a correctly wired project has nothing to say about it ---------------------------
{
  const problems = await validate({ "tools/__init__.py": TOOLS_WIRED });
  check("a correctly wired MCP project passes", problems.length === 0, problems.join(" | "));
}

// --- 2. wiring: advertised but not callable ---------------------------------------------
{
  // The failure this catches: jaroku.json says the agent has create_issue, the plan card
  // says so, the sidebar says so — and TOOLS does not contain it, so it silently cannot.
  const problems = await validate({
    "tools/__init__.py": `from .mcp_bridge import MCP_TOOLS

TOOLS = []

__all__ = ["TOOLS"]
`,
  });
  check("MCP_TOOLS missing from TOOLS is rejected",
    problems.some((p) => p.includes("MCP_TOOLS is not in TOOLS")), problems.join(" | "));
  check("...and the message names the tools it would lose",
    problems.some((p) => p.includes("create_issue")), problems.join(" | "));
}

// --- 3. wiring through an alias is understood -------------------------------------------
{
  const problems = await validate({
    "tools/__init__.py": `from .mcp_bridge import MCP_TOOLS

EXTRA = []
TOOLS = MCP_TOOLS + EXTRA

__all__ = ["TOOLS"]
`,
  });
  check("TOOLS = MCP_TOOLS + EXTRA is accepted", problems.length === 0, problems.join(" | "));
}

// --- 4. shadowing a granted tool ---------------------------------------------------------
{
  const problems = await validate({
    "tools/__init__.py": TOOLS_WIRED,
    "tools/mine.py": `from langchain_core.tools import tool


@tool
def create_issue(title: str) -> str:
    """Not the real one."""
    return "nope"
`,
  });
  // Bound instead of the real one, silently, while everything still claims the agent has
  // the MCP tool it was scoped to.
  check("a function shadowing a granted MCP tool is rejected",
    problems.some((p) => p.includes("name of an MCP tool")), problems.join(" | "));
}

// --- 5. arguments checked against the schema the server declared --------------------------
{
  const missing = await validate({
    "tools/__init__.py": TOOLS_WIRED,
    "tools/wrap.py": `from langchain_core.tools import tool

from .mcp_bridge import MCP_TOOLS

create_issue = MCP_TOOLS[0]


@tool
def file_bug(summary: str) -> str:
    """File a bug."""
    return create_issue.invoke({"team": "ENG"})
`,
  });
  check("a call missing a required argument is rejected",
    missing.some((p) => p.includes("required argument") && p.includes("title")), missing.join(" | "));
  check("...and says which server declared it required",
    missing.some((p) => p.includes("linear")), missing.join(" | "));

  const unknown = await validate({
    "tools/__init__.py": TOOLS_WIRED,
    "tools/wrap.py": `from langchain_core.tools import tool

from .mcp_bridge import MCP_TOOLS

create_issue = MCP_TOOLS[0]


@tool
def file_bug(summary: str) -> str:
    """File a bug."""
    return create_issue.invoke({"title": summary, "priority": 1, "assignee": "me"})
`,
  });
  check("a call with arguments the tool does not accept is rejected",
    unknown.some((p) => p.includes("priority") && p.includes("assignee")), unknown.join(" | "));
  check("...and lists what it does accept",
    unknown.some((p) => p.includes("It accepts: team, title")), unknown.join(" | "));

  const good = await validate({
    "tools/__init__.py": TOOLS_WIRED,
    "tools/wrap.py": `from langchain_core.tools import tool

from .mcp_bridge import MCP_TOOLS

create_issue = MCP_TOOLS[0]


@tool
def file_bug(summary: str) -> str:
    """File a bug."""
    return create_issue.invoke({"title": summary, "team": "ENG"})
`,
  });
  check("a correct call passes", good.length === 0, good.join(" | "));
}

// --- 6. what the static check must NOT claim ---------------------------------------------
{
  // A schema that declared no properties has not said none are allowed. Inventing a
  // restriction from silence would reject calls the server would have accepted.
  const silent = await validate({
    "tools/__init__.py": TOOLS_WIRED,
    "tools/wrap.py": `from langchain_core.tools import tool

from .mcp_bridge import MCP_TOOLS

list_issues = MCP_TOOLS[1]


@tool
def recent(limit: int) -> str:
    """Recent issues."""
    return list_issues.invoke({"anything": limit})
`,
  });
  check("a tool whose schema declares no properties accepts anything",
    !silent.some((p) => p.includes("does not accept")), silent.join(" | "));

  // A dict assembled at runtime cannot be read statically. The bridge checks it on every
  // call; this pass catches the mistake early rather than claiming to catch all of them.
  const dynamic = await validate({
    "tools/__init__.py": TOOLS_WIRED,
    "tools/wrap.py": `from langchain_core.tools import tool

from .mcp_bridge import MCP_TOOLS

create_issue = MCP_TOOLS[0]


@tool
def file_bug(summary: str) -> str:
    """File a bug."""
    args = {"nonsense": summary}
    return create_issue.invoke(args)
`,
  });
  check("a computed argument dict is left to the runtime check, not guessed at",
    dynamic.length === 0, dynamic.join(" | "));
}

// --- 7. an agent with no MCP grant is unaffected -------------------------------------------
{
  const dir = join(tmpdir(), `jaroku-mcpval-${randomUUID()}`);
  dirs.push(dir);
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "agent.py"), AGENT_PY);
  writeFileSync(join(dir, ".env.example"), "# none\n");
  writeFileSync(
    join(dir, "tools", "__init__.py"),
    `from langchain_core.tools import tool


@tool
def hello(name: str) -> str:
    """Say hello."""
    return f"hi {name}"


TOOLS = [hello]
`,
  );
  const result = await validateProject(dir, { runtimeDir: RUNTIME, connectorFiles: [] });
  check("a project with no MCP tools is untouched by any of this",
    result.problems.length === 0, result.problems.join(" | "));
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
