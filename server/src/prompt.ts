// The generation system prompt — the product's core (doc §8: "the system prompt and project
// template are your product sense — own them").
//
// Every hard rule below exists because violating it breaks something specific in the trace
// pipeline:
//   rule 1 (no jaroku import)  -> keeps generated projects portable, and keeps trace wiring
//                                 in code we reviewed once rather than re-rolled per generation
//   rule 2 (no model construction) -> makes the provider dropdown work without regenerating
//   rule 3 (no stdout)         -> stdout IS the event transport (schema/events.md)
//   rule 5 (must terminate)    -> a non-terminating graph burns the recursion limit and money
//   rule 6 (templates verbatim)-> a reviewed connector must not be silently rewritten
//
// Rule 3 is additionally enforced at runtime by jaroku_runner.guard — the prompt asks, the
// runner guarantees. Prompts are requests, not invariants.
//
// CACHING: buildSystemPrompt() must be byte-identical across generations or the cache never
// hits. That is why ALL connector signatures are included here regardless of which the user
// selected — the selection is volatile and goes in the user message instead.
//
// MCP tools follow the same rule and land on the far side of it. Connector signatures CAN
// live in the system prompt because the catalogue is fixed at build time; discovered MCP
// tools cannot, because they differ per user, per server, and change whenever a third party
// redeploys. So the system prompt carries only the static RULE about them (rule 12) and
// every signature goes in the user message. Putting them in the prefix would silently cost
// a cache miss on every single generation.

import { authModeOf, connectionSuppliedEnv, userSuppliedEnv, type Connector } from "./connectors.ts";
import type { McpToolView } from "./mcpRegistry.ts";

export interface GenerationRequest {
  prompt: string;
  agentId: string;
  agentName: string;
  connectors: Connector[];
  /** MCP tools this agent is scoped to. Volatile, so they ride in the user message. */
  mcpTools?: McpToolView[];
  /** The plan the user confirmed, verbatim. Absent = an unplanned generation, whose prompt
   *  must stay byte-identical to what it was before the plan gate existed. */
  plan?: string;
}

const WORKED_EXAMPLE = `<<<FILE path="agent.py">>>
"""Notes agent."""
from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

from .prompts import SYSTEM_PROMPT
from .tools import TOOLS


class AgentState(MessagesState):
    notes: list[str]


def build_graph(llm):
    model = llm.bind_tools(TOOLS)

    def call_model(state: AgentState):
        messages = state["messages"]
        if not any(isinstance(m, SystemMessage) for m in messages):
            messages = [SystemMessage(SYSTEM_PROMPT), *messages]
        return {"messages": [model.invoke(messages)]}

    def record_note(state: AgentState):
        last = state["messages"][-1]
        notes = list(state.get("notes") or [])
        if isinstance(last, ToolMessage):
            notes.append(f"{last.name}: {last.content}")
        return {"notes": notes}

    def should_continue(state: AgentState) -> str:
        last = state["messages"][-1]
        return "tools" if getattr(last, "tool_calls", None) else END

    graph = StateGraph(AgentState)
    graph.add_node("agent", call_model)
    # handle_tool_errors=True is required (rule 7): a tool that raises is reported to the model
    # as an error-flagged result and traced as a failed step, instead of ending the run.
    graph.add_node("tools", ToolNode(TOOLS, handle_tool_errors=True))
    graph.add_node("record_note", record_note)
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    graph.add_edge("tools", "record_note")
    graph.add_edge("record_note", "agent")
    return graph.compile()


def build_initial_state(user_input: str) -> dict:
    return {"messages": [HumanMessage(user_input)], "notes": []}
<<<ENDFILE>>>
<<<FILE path="tools/__init__.py">>>
from .notes import current_time

TOOLS = [current_time]

__all__ = ["TOOLS", "current_time"]
<<<ENDFILE>>>
<<<FILE path="tools/notes.py">>>
from __future__ import annotations

from datetime import datetime, timezone

from langchain_core.tools import tool


@tool
def current_time(timezone_name: str = "UTC") -> str:
    """Return the current date and time. \`timezone_name\` is an IANA name."""
    if timezone_name.upper() == "UTC":
        return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(timezone_name)).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return f"Unknown timezone {timezone_name!r}. Try 'UTC' or e.g. 'Europe/Paris'."
<<<ENDFILE>>>
<<<FILE path="prompts/__init__.py">>>
from pathlib import Path

SYSTEM_PROMPT = (Path(__file__).parent / "system.md").read_text(encoding="utf-8").strip()

__all__ = ["SYSTEM_PROMPT"]
<<<ENDFILE>>>
<<<FILE path="prompts/system.md">>>
You are a concise assistant that can report the current time.

Use \`current_time\` when the user asks about the date or time. Otherwise answer directly.
Keep replies to a sentence or two.
<<<ENDFILE>>>`;

// Shared between the generation and edit prompts — one source of truth so the two can
// never drift. Interpolated byte-for-byte into buildSystemPrompt (cache stability).
const CONTRACT_SYMBOLS = `  TOOLS: list                            # every tool the graph can call
  def build_graph(llm): ...              # returns a COMPILED graph
  def build_initial_state(user_input: str) -> dict`;

const HARD_RULES = `HARD RULES:
1. NEVER import jaroku_interceptor, JarokuTracer, or anything named jaroku. The host handles
   tracing. Code that imports it will be rejected.
2. NEVER construct a model. Do not import ChatAnthropic/ChatOpenAI. \`llm\` is passed to
   build_graph already configured. Call llm.bind_tools(TOOLS) inside build_graph.
3. NEVER write to stdout. No print(). stdout is a reserved channel and any byte you write
   there corrupts it. Log to stderr only: print(..., file=sys.stderr).
4. Read secrets ONLY from os.environ. Never hardcode a credential, never invent a default
   value for one. Every key you read must appear in .env.example.
5. The graph MUST terminate. Every conditional edge needs a path to END.
6. Use the connector templates EXACTLY as given — import them, do not rewrite, re-implement,
   or "improve" them. Their files are placed into the project for you; do NOT emit them.
7. Tools return strings, and the string is an ANSWER. If the tool could not do its job — not
   configured, dependency missing, API error, request rejected — RAISE RuntimeError with an
   actionable message. Do NOT return the reason as if it were a result: a returned string is
   recorded as a SUCCESSFUL tool call, so the trace shows a green step whose content is an
   error and the model answers the user from it. Return normally only when the tool ran and the
   answer is genuinely empty ("no rows", "no messages matched"). Build the tool node as
   ToolNode(TOOLS, handle_tool_errors=True) so a raise is reported to the model as an error
   instead of ending the run.
8. Every @tool needs a typed signature and a docstring: the model reads the docstring to
   decide when to call it, and the host derives dry-run arguments from the type hints.
9. NEVER call one @tool from inside another. A decorated tool is a StructuredTool object,
   not a function — calling it raises "TypeError: 'StructuredTool' object is not callable".
   If two tools share logic, put that logic in a PLAIN function (no @tool) and have both
   call it. Prefer giving the agent both tools and letting it sequence them itself.
10. NEVER build SQL by interpolating values into the string (no f-strings, no .format, no
   concatenation). That is an injection vector even against a read-only connector, because
   it lets a crafted input widen a query to rows the user should not see. Write a static
   query, or pass a WHERE value the caller supplied as a separate documented argument.
11. Emit only final, working code. Never leave a false start, dead class, or exploratory
   construct in a file (e.g. deriving a base class from StateGraph.__bases__). If you
   change approach midway, rewrite the file cleanly instead of leaving the abandoned
   attempt. The project is imported during validation; code that fails at import is
   rejected.
12. MCP tools come READY-MADE. If the user scoped this agent to any, the host writes
   tools/mcp_bridge.py and mcp_tools.json into the project and you import the tools from
   there: \`from .tools.mcp_bridge import MCP_TOOLS\` and include MCP_TOOLS in TOOLS. Do NOT
   emit either file, do NOT write an MCP client, do NOT import the mcp package, and do NOT
   invent a tool name that is not in the list you were given. Those tools call a third-party
   server nobody has reviewed, so the wiring around them is host-owned and audited; a
   model-written version of it would be the one unreviewed thing in the path that nobody
   agreed to.`;

function renderConnectorReference(connectors: Connector[]): string {
  return connectors
    .map((c) => {
      const tools = c.tools
        .map((t) => `    ${t.signature}\n        ${t.summary}`)
        .join("\n");
      // WHERE the credential comes from, not only what it is called. A model told only that a
      // connector "requires env: GMAIL_REFRESH_TOKEN" writes a README telling the user to obtain
      // one by hand, which for an OAuth connector is advice to redo the thing the Connect button
      // already did — and it is the sort of instruction that ends up quoted in a support ticket.
      const supply =
        authModeOf(c) === "oauth"
          ? "supplied by the workspace's connection to this service; the user does not paste it"
          : authModeOf(c) === "none"
            ? "no credential needed"
            : "supplied by the user";
      return [
        `  ${c.id}  (file will exist at tools/${c.file})`,
        `    ${c.description}`,
        `    import like: from .${c.module} import ${c.tools.map((t) => t.name).join(", ")}`,
        `    requires env: ${c.required_env.join(", ")}  (${supply})`,
        tools,
      ].join("\n");
    })
    .join("\n\n");
}

/**
 * Discovered MCP tools, rendered for the USER message.
 *
 * Deliberately not shaped like renderConnectorReference. A connector reference tells the
 * model how to import a file; this tells it that a ready-made tool object already exists and
 * that its job is to wire it in and nothing else. The real JSON Schema goes in because it is
 * what the model must respect when calling the tool, and because it is what the validator
 * will check the call against — showing anything less would be setting the model up to fail
 * a check it was never given the information to pass.
 *
 * Impact is stated because it changes what the generated agent should do around the call: a
 * tool that stops for a human confirmation is not one to put in a retry loop.
 */
export function renderMcpReference(tools: McpToolView[]): string {
  if (!tools.length) return "  (none)";
  const byServer = new Map<string, McpToolView[]>();
  for (const t of tools) {
    const list = byServer.get(t.server_id) ?? [];
    list.push(t);
    byServer.set(t.server_id, list);
  }
  return [...byServer.entries()]
    .map(([server, group]) =>
      [
        `  ${server}  (third-party MCP server — NOT reviewed by Jaroku)`,
        ...group.map((t) =>
          [
            `    ${t.name}${t.impact === "high" ? "   [HIGH IMPACT — the user is asked to confirm before its first call]" : ""}`,
            `        ${t.description ?? "(the server gave no description)"}`,
            `        arguments (JSON Schema, exactly as the server declared them):`,
            `        ${JSON.stringify(t.input_schema)}`,
          ].join("\n"),
        ),
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * The stable, cacheable prefix. Must not vary between generations — no timestamps, no
 * request-specific content, connectors always rendered in full catalog order.
 */
export function buildSystemPrompt(allConnectors: Connector[]): string {
  return `You generate complete, runnable LangGraph agent projects. You output files and nothing else.

OUTPUT FORMAT — exact, no deviation:
<<<FILE path="agent.py">>>
...file contents...
<<<ENDFILE>>>
Repeat per file. No prose, no explanation, no markdown fences, before, between or after files.

THE CONTRACT — agent.py MUST define exactly these three, and nothing may replace them:
${CONTRACT_SYMBOLS}

${HARD_RULES}

STATE: use MessagesState when the agent is just chat + tools. When the task has real domain
state (fetched records, a draft, a counter), declare \`class AgentState(MessagesState)\` with
annotated fields and use it — the host renders before/after state diffs and empty diffs are
useless.

SHAPE: prefer one llm node + one ToolNode + one conditional edge. This is the shape the
tracer is verified against. Add nodes only when the task genuinely needs them.

FILES TO EMIT: agent.py, tools/__init__.py, one tools/<name>.py per bespoke tool,
prompts/__init__.py, prompts/system.md, .env.example, README.md.
Do NOT emit jaroku.json or pyproject.toml — the host writes those.
Do NOT emit any connector file listed below — the host copies those in.

AVAILABLE CONNECTORS (reviewed, copied in verbatim when selected):

${renderConnectorReference(allConnectors)}

WORKED EXAMPLE — a complete, valid response for "an agent that can tell me the time":

${WORKED_EXAMPLE}`;
}

// --- planning (the pre-generation gate) -------------------------------------------------
//
// An earlier phase of the same generation call, not a second LLM pathway: same model, same
// module, same shared CONTRACT_SYMBOLS and connector reference, same byte-stable-system /
// volatile-user split. The plan exists so the user can catch a wrong direction while it still
// costs ~600 output tokens instead of 16,000 and a project on disk.
//
// It is deliberately NOT a design document. Everything in it is a fact the user can disagree
// with — which tools exist, where each one comes from, what state is carried, how the graph is
// shaped. Rationale and prose are what make a plan unreadable and therefore unread.

export interface PlanRequest {
  prompt: string;
  agentName: string;
  connectors: Connector[];
  /** MCP tools the user scoped this agent to, so the plan can name the real ones. */
  mcpTools?: McpToolView[];
  /** Set when the user asked for a change to a plan they were shown. */
  previousPlan?: string;
  feedback?: string;
}

const PLAN_EXAMPLE = `<<<PLAN section="tools">>>
- gmail_search — reviewed connector template (gmail)
- order_lookup — bespoke; looks up an order's status by id
<<<ENDPLAN>>>
<<<PLAN section="state">>>
- messages: MessagesState — the conversation
- order: dict | None — the order currently under discussion
<<<ENDPLAN>>>
<<<PLAN section="graph">>>
- agent (llm) decides whether to call a tool, or answers and ends
- tools runs the requested tool, then record_order stores the result in state
- record_order returns to agent
<<<ENDPLAN>>>
<<<PLAN section="notes">>>
- Drafts replies but never sends — sending needs a Gmail scope the connector doesn't grant.
<<<ENDPLAN>>>`;

/**
 * The stable, cacheable prefix for planning. Like buildSystemPrompt it must not vary between
 * requests — all connectors always rendered, in catalog order, no request-specific content.
 */
export function buildPlanSystemPrompt(allConnectors: Connector[]): string {
  return `You plan LangGraph agent projects before they are generated. You output a short, concrete
plan for the developer to approve or correct. You write NO code.

OUTPUT FORMAT — exact, no deviation, these four sections in this order:
<<<PLAN section="tools">>>
- <tool_name> — reviewed connector template (<connector id>)
- <tool_name> — bespoke; <what it does, one clause>
- <tool_name> — mcp: <server id>/<tool_name>; <what it does, one clause>
<<<ENDPLAN>>>
<<<PLAN section="state">>>
- <field>: <type> — <what it holds>
<<<ENDPLAN>>>
<<<PLAN section="graph">>>
- <node> <what it does and where it goes next, in plain language>
<<<ENDPLAN>>>
<<<PLAN section="notes">>>
- <anything the developer should push back on: a limitation, an assumption, a missing credential>
<<<ENDPLAN>>>
No prose, no markdown fences, no commentary before, between, or after the sections.

LENGTH: about 200 words total. One line per tool, per state field, per node. This is a thing
to scan in fifteen seconds, not a design document. Omit rationale entirely.

EVERY TOOL MUST BE LABELLED, with one of exactly three labels:

  "reviewed connector template"  audited code, copied into the project verbatim, never
                                 written by you
  "bespoke"                      code that will be generated for this agent
  "mcp: <server>/<tool>"         a call into a third-party MCP server that NOBODY has
                                 reviewed — not you, not Jaroku, not the developer

This distinction is the single most decision-relevant fact in the plan: it tells the developer
which parts are trusted, which are about to be invented, and which reach into somebody else's
system. Never describe an MCP tool as reviewed or as a connector — that would tell the
developer the opposite of the truth about what is about to run for them.

Use ONLY the connectors the developer selected. If the agent would genuinely be better with
one they did not select, do not assume it — plan the bespoke alternative and say so in notes,
so they can enable it and re-plan.

THE CONTRACT the generated project will satisfy — plan within it:
${CONTRACT_SYMBOLS}

STATE: use MessagesState when the agent is just chat + tools, and say so. When the task has
real domain state (fetched records, a draft, a counter), name the fields and their types — the
host renders before/after state diffs and empty diffs are useless.

SHAPE: prefer one llm node + one ToolNode + one conditional edge. Add nodes only when the task
genuinely needs them. Every conditional path must reach END.

AVAILABLE CONNECTORS (reviewed, copied in verbatim when selected):

${renderConnectorReference(allConnectors)}

WORKED EXAMPLE — a complete, valid plan for "a support agent that reads Gmail and looks up
orders", with the gmail connector selected:

${PLAN_EXAMPLE}`;
}

/** The volatile half of a plan request, after the cache breakpoint. */
export function buildPlanUserPrompt(req: PlanRequest): string {
  const selected = req.connectors.length
    ? req.connectors
        .map((c) => `  - ${c.id}: provides ${c.tools.map((t) => t.name).join(", ")}`)
        .join("\n")
    : "  (none — every tool this agent needs will be bespoke)";

  // A revision shows the model what it said and what the developer objected to. The original
  // request stays in view: feedback is usually a correction to one part of the plan, not a
  // replacement for the whole brief.
  const revision = req.previousPlan
    ? `\nYOU PREVIOUSLY PLANNED:

${req.previousPlan.trim()}

THE DEVELOPER ASKED FOR THIS CHANGE:

${(req.feedback ?? "").trim()}

Re-plan the whole agent with that change applied. Keep everything they did not object to.
`
    : "";

  // Only what the developer scoped. A plan naming a tool outside this list is reconciled
  // into a warning (planProtocol.reconcileWithSelection) rather than silently honoured.
  const mcp = req.mcpTools?.length
    ? `
Selected MCP tools — third-party, UNREVIEWED. Use these exact names, and no others:
${req.mcpTools
  .map(
    (t) =>
      `  - ${t.server_id}/${t.name}${t.impact === "high" ? " [high impact — the developer is asked to confirm before its first call]" : ""}` +
      (t.description ? `: ${t.description}` : ""),
  )
  .join("\n")}
`
    : "";

  return `Plan this agent:

${req.prompt}

Human-readable name: ${req.agentName}

Selected connectors:
${selected}
${mcp}${revision}
Output the four plan sections now. No code, no commentary.`;
}

// --- editing (the fix loop, doc §8 Week 4) ----------------------------------------------
//
// Same discipline as generation: a byte-stable system prompt (own cache breakpoint, all
// connectors always rendered) + a volatile user message carrying the project's current
// files and the change request. The model re-emits ONLY changed/new files, complete —
// full-file rewrites are far more reliable than model-emitted patches, and the host
// computes the actual diff.

export interface EditRequest {
  agentId: string;
  instruction: string;
  /** Model-editable files with their current contents. Connector files are excluded —
   *  their signatures are already in the system prompt and they are read-only. */
  files: { path: string; content: string }[];
  /** Connectors installed in this project (their files exist and are read-only). */
  connectors: Connector[];
  /** MCP tools this project is scoped to. Its bridge and manifest are read-only. */
  mcpTools?: McpToolView[];
  /** Recent applied edits, oldest first, for follow-up context ("no, make it 50"). */
  history: { instruction: string; summary: string }[];
}

// Teaches the three things generation's example can't: the summary-line-first format, that
// a one-line change still means re-emitting the complete file, and the E1 wrapper pattern
// (with the .invoke idiom — rule 9) when a request brushes against a read-only connector.
const EDIT_WORKED_EXAMPLE = `WORKED EXAMPLE 1 — request: "current_time should default to Asia/Kolkata, not UTC":
Changed the current_time default timezone to Asia/Kolkata.
<<<FILE path="tools/notes.py">>>
from __future__ import annotations

from datetime import datetime, timezone

from langchain_core.tools import tool


@tool
def current_time(timezone_name: str = "Asia/Kolkata") -> str:
    """Return the current date and time. \`timezone_name\` is an IANA name."""
    if timezone_name.upper() == "UTC":
        return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(timezone_name)).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return f"Unknown timezone {timezone_name!r}. Try 'UTC' or e.g. 'Europe/Paris'."
<<<ENDFILE>>>

WORKED EXAMPLE 2 — request: "gmail search should only return unread mail". The gmail
connector is read-only (rule E1), so the fix is a bespoke wrapper tool plus the tools
registry update (rule E4). Note the .invoke call — connector tools are StructuredTool
objects, not plain functions (rule 9):
Added an unread-only search tool wrapping the gmail connector.
<<<FILE path="tools/unread_mail.py">>>
from __future__ import annotations

from langchain_core.tools import tool

from .gmail import gmail_search


@tool
def search_unread_mail(query: str = "", max_results: int = 10) -> str:
    """Search ONLY unread Gmail messages. \`query\` uses Gmail search syntax."""
    unread_query = f"is:unread {query}".strip()
    return gmail_search.invoke({"query": unread_query, "max_results": max_results})
<<<ENDFILE>>>
<<<FILE path="tools/__init__.py">>>
from .gmail import gmail_search, gmail_create_draft
from .unread_mail import search_unread_mail

TOOLS = [gmail_search, gmail_create_draft, search_unread_mail]

__all__ = ["TOOLS", "gmail_search", "gmail_create_draft", "search_unread_mail"]
<<<ENDFILE>>>`;

// Editing agent.py means the STATE/SHAPE guidance from generation still applies — an edit
// that adds domain state or nodes should land in the same verified shape.
const STATE_AND_SHAPE = `STATE: use MessagesState when the agent is just chat + tools. When an edit introduces real
domain state (fetched records, a draft, a counter), declare \`class AgentState(MessagesState)\`
with annotated fields and use it — the host renders before/after state diffs and empty
diffs are useless.

SHAPE: prefer one llm node + one ToolNode + one conditional edge. This is the shape the
tracer is verified against. Add nodes only when the change genuinely needs them.`;

/**
 * The stable, cacheable prefix for edits. Must not vary between edits — no request or
 * project content here; that all goes in the user message.
 */
export function buildEditSystemPrompt(allConnectors: Connector[]): string {
  return `You edit existing LangGraph agent projects. You receive the project's current files and a
change request. You respond with a one-line summary, then ONLY the files you change or add —
complete file contents, never fragments.

OUTPUT FORMAT — exact, no deviation:
First line: a plain-text summary of the change, under 100 characters. Example:
Added Redis conversation memory to the agent state.
Then, for each changed or NEW file:
<<<FILE path="agent.py">>>
...complete file contents...
<<<ENDFILE>>>
Emit ONLY files you changed or added. NEVER re-emit an unchanged file. No markdown fences,
no prose other than the summary line.

THE CONTRACT still holds — agent.py keeps exactly these three, and nothing may replace them:
${CONTRACT_SYMBOLS}

${HARD_RULES}

EDIT RULES:
E1. READ-ONLY FILES — never emit: jaroku.json, the top-level __init__.py, mcp_tools.json,
    tools/mcp_bridge.py, or any connector file (the tools/<file> paths listed under AVAILABLE
    CONNECTORS). Connectors are reviewed code; the MCP bridge and manifest are host-owned and
    are what keeps a third-party server's tools scoped to what was agreed. If the request
    requires different behavior from any of them, write a bespoke wrapper tool that uses the
    existing tool and adapts the result — these are StructuredTool objects, so invoke them:
    pg_query.invoke({"sql": "..."}), never pg_query(...) (rule 9). Never add an MCP tool
    name that is not already in the project's manifest; there is no way to reach one that
    was not granted. If the request cannot be satisfied without editing a read-only file, say
    so in the summary and emit no files. (tools/__init__.py and prompts/__init__.py are
    editable.)
E2. MINIMAL CHANGE. Touch the fewest files that correctly implement the request. Do not
    reformat, rename, or "improve" code the request does not concern.
E3. If you add or remove an os.environ key, emit the updated .env.example in this response.
E4. If you add or remove a tool, emit the updated tools/__init__.py so TOOLS stays accurate.
E5. If the request is unclear, already satisfied, or impossible under these rules, emit no
    files and explain why in the summary line.

${STATE_AND_SHAPE}

AVAILABLE CONNECTORS (reviewed; already present in the project when installed):

${renderConnectorReference(allConnectors)}

${EDIT_WORKED_EXAMPLE}`;
}

/** The volatile half of an edit: current files + the request, after the cache breakpoint. */
export function buildEditUserPrompt(req: EditRequest): string {
  const connectorLine = req.connectors.length
    ? req.connectors.map((c) => `tools/${c.file}`).join(", ") + " — read-only, do not emit"
    : "(none)";

  const files = req.files
    .map((f) => `<<<FILE path="${f.path}">>>\n${f.content.replace(/\n$/, "")}\n<<<ENDFILE>>>`)
    .join("\n\n");

  const history = req.history.length
    ? `\nRECENT EDITS (oldest first):\n${req.history
        .map((h) => `  - "${h.instruction}" -> ${h.summary}`)
        .join("\n")}\n`
    : "";

  // The scoped set, so an edit can wire an existing MCP tool into a new wrapper without
  // being able to reach for one the agent was never granted.
  const mcp = req.mcpTools?.length
    ? `
MCP TOOLS this agent already has — third-party, UNREVIEWED, available as MCP_TOOLS from
tools/mcp_bridge.py (read-only, do not emit). This is the complete set; no other tool on
those servers is reachable:

${renderMcpReference(req.mcpTools)}
`
    : "";

  return `Edit this agent.

Agent package: ${req.agentId}
Installed connector files: ${connectorLine}
${mcp}
CURRENT PROJECT FILES:

${files}
${history}
CHANGE REQUEST:

${req.instruction}

Respond with the summary line, then the complete contents of only the changed or new files.`;
}

/** The volatile half: everything specific to this request, after the cache breakpoint. */
export function buildUserPrompt(req: GenerationRequest): string {
  const selected = req.connectors.length
    ? req.connectors
        .map(
          (c) =>
            `  - ${c.id}: import from .${c.module} — ${c.tools
              .map((t) => t.name)
              .join(", ")} (file tools/${c.file} will exist; do not emit it)`,
        )
        .join("\n")
    : "  (none — write any tools this agent needs yourself)";

  // Split by where the value comes from, because the model writes the file's prose and a key a
  // connection fills in is not a key to instruct somebody to go and obtain. The host merges both
  // lists in afterwards either way (generator.hostFiles), so this shapes the wording rather than
  // deciding the contents.
  const supplied = userSuppliedEnv(req.connectors);
  const connected = connectionSuppliedEnv(req.connectors);
  const envNote = [
    supplied.length
      ? `\nThese connector env keys must appear in .env.example for the user to fill in: ${supplied.join(", ")}`
      : "",
    connected.length
      ? `\nThese are filled in by the workspace's connection when this agent runs in Jaroku — mention` +
        ` them in .env.example only as a note for running the project standalone, never as` +
        ` something to obtain by hand: ${connected.join(", ")}`
      : "",
  ].join("");

  // Every signature the model is allowed to call, and nothing else. The list IS the grant:
  // the host writes a manifest containing exactly these, so a tool invented here would not
  // exist at runtime — and the validator rejects the project before it gets that far.
  const mcp = req.mcpTools?.length
    ? `
MCP TOOLS this agent is scoped to — third-party, UNREVIEWED, already built for you:

${renderMcpReference(req.mcpTools)}

Import them and wire them in, exactly like this, and write no other MCP code:

  from .tools.mcp_bridge import MCP_TOOLS
  TOOLS = MCP_TOOLS + [your_own_tool]

Do NOT emit tools/mcp_bridge.py or mcp_tools.json — the host writes both. The list above is
the complete set this agent has; there is no way to reach any other tool on those servers.
`
    : "";

  // The user reviewed and confirmed this plan before any code existed. Following it is the
  // whole point of the gate — a generation that quietly builds something else makes the
  // confirmation a lie. Absent (an unplanned generation), this block contributes nothing and
  // the prompt is byte-identical to what it was before the gate existed.
  const plan = req.plan?.trim()
    ? `\nAPPROVED PLAN — the user reviewed and confirmed this before generation. Build exactly
this. If some detail is under-specified, choose the option most consistent with the plan;
never substitute a different set of tools, a different state shape, or a different graph
structure than the one described here.

${req.plan.trim()}
`
    : "";

  return `Build this agent:

${req.prompt}

Package name (already created): ${req.agentId}
Human-readable name: ${req.agentName}

Selected connectors:
${selected}${envNote}
${mcp}${plan}
Emit the files now, starting with agent.py. Output files only — no commentary.`;
}

// --- the operate conversation's answer (Part 3 §7.3) ------------------------------------------
//
// THE FOURTH PROMPT, AND IT IS HERE FOR THE REASON THE OTHER THREE ARE. This module exists so that
// every system and user prompt in the product sits in one file and cannot drift; a prompt written
// beside the code that calls it is one that stops matching the three it was meant to resemble the
// first time somebody edits one of them.
//
// WHAT MAKES THIS ONE DIFFERENT FROM `explainer.ts`'s OWN SYSTEM PROMPT. That one explains a trace
// step, a graph node or an agent's files to the developer who built it, and its grounding is code.
// This one answers "did that email go out?" and its grounding is a RECORD — rows in `work_items`
// with ids somebody can click. So the rules it has to state are different in kind: not "do not
// propose code changes" but "every claim about what happened cites the row it came from, and where
// there is no row the answer is that there is no row".
//
// §3 IS THE WHOLE OF WHY THE RULES BELOW ARE THIS BLUNT. A deployed agent remembers nothing —
// `build_initial_state(user_input) -> dict`, every run from nothing — so the agent cannot answer a
// question about itself and Jaroku has to. The record is the only memory there is. A model given
// this material and no instruction would happily reconstruct a plausible afternoon, and a plausible
// afternoon is the single worst thing this product could ship.

/**
 * The rules the answering model works under. Sent as the system prompt.
 *
 * WRITTEN AS PROHIBITIONS WHERE IT MATTERS, because the failure mode is fluency. "Ground your
 * answer in the context" is advice; "if the record does not contain it, say that the record does
 * not contain it, and do not say what you think probably happened" is a rule with a wrong answer
 * on the other side of it, which is what a model needs in order to refuse.
 *
 * IT NAMES NO AGENT AND CARRIES NO PERSONALITY (§8). The display name arrives in the user message
 * because it is data — a value from `agents.display_name` falling back to the slug — and a system
 * prompt that interpolated it would be a prompt that changes per agent, which costs the cache on
 * every question and, worse, invites somebody to add a sentence about what this agent is "like".
 */
export const CONVERSATION_SYSTEM = `You answer questions about what an automated agent has done, on behalf of the person who operates it.

WHAT YOU ARE WORKING FROM. You are given a RECORD: a list of jobs the agent was asked to do, each with an id, a status, what was asked, what came back, when, and what it cost. That record is the only source of truth available to you. The agent itself remembers nothing between jobs, so nothing can be recalled, inferred from habit, or reconstructed — if it is not in the record below, it did not reach you and you do not know it.

THE RULES, IN ORDER OF HOW MUCH DAMAGE BREAKING THEM DOES:

1. NEVER STATE ANYTHING THE RECORD DOES NOT SHOW. No inference about what "probably" happened, no filling a gap with what would be reasonable, no summarising an absence as if it were a finding. If the record does not answer the question, say plainly that there is no record of it. "I have no record of that" is a complete and correct answer and you should give it without apology or hedging.

2. EVERY CLAIM ABOUT WHAT HAPPENED CITES THE JOB IT CAME FROM, using the exact marker [work:<id>] with the id copied character for character from the record. Put the citation immediately after the claim it supports. A sentence that asserts something happened and carries no citation is a mistake. Framing — "here is what I found", "three of those failed" as a lead-in to cited detail — needs no citation, but anything a person could act on does.

3. NEVER INVENT AN ID. Cite only ids that appear in the record below. If you cannot support a sentence with one of them, remove the sentence.

4. SPEAK AS THE AGENT ONLY WHERE A RECORD BACKS IT. You may answer in the first person — "Yes, I sent it at 10:04 [work:...]" — when a job says so. Where the record is silent, say "I have no record of that", never "I don't think so" (an inference) and never "I didn't" (a claim). Where the record is ambiguous, say what is there and then what is missing, in that order.

5. UNKNOWN IS NOT ZERO. A job whose cost is unknown is unknown, never free. Do not add up costs that are marked unknown, and if a total is described as partial, say that it is a floor rather than a total.

6. DO NOT PROPOSE CODE CHANGES and do not offer to run anything. This conversation answers questions; a job is dispatched by the person, through a confirmation they see first.

HOW TO WRITE IT. A few sentences, plainly, answering the question that was asked. No preamble, no restating the question, no bullet list unless you are genuinely listing several jobs. You are talking to the person who runs this agent and is deciding what to do next.`;

/**
 * How much of a job's prose the rendered record shows.
 *
 * SEPARATE FROM THE FACT PACK'S OWN TRIM, and deliberately equal to it rather than derived from it:
 * the pack bounds what is READ out of the database and this bounds what is WRITTEN into a prompt,
 * and a future change to either has a reason of its own. The pack's cap is about memory and query
 * cost; this one is about a context window.
 */
const RECORD_FIELD_CHARS = 400;

/** A value that is genuinely unknown, spelled the way every other surface spells it. */
const UNKNOWN = "unknown";

function money(cost: number | null, complete: boolean): string {
  // §10 AND §11: unknown is `null` rendered as a word, never `$0.00`. A partial total says so
  // rather than presenting itself as a confident figure — the `+` the client renders, in words.
  if (cost === null) return UNKNOWN;
  return complete ? `$${cost.toFixed(4)}` : `at least $${cost.toFixed(4)} (some calls were unpriced)`;
}

function duration(ms: number | null): string {
  if (ms === null) return UNKNOWN;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function field(label: string, value: string | null): string {
  if (value === null) return "";
  const t = value.trim();
  if (!t) return "";
  const cut = t.length > RECORD_FIELD_CHARS ? `${t.slice(0, RECORD_FIELD_CHARS)}…(trimmed)` : t;
  // ONE LINE PER FIELD, and newlines inside a value flattened, so a job whose output is a
  // multi-line traceback cannot look like several jobs.
  return `\n  ${label}: ${cut.replace(/\s*\n\s*/g, " ⏎ ")}`;
}

/**
 * What a `FactPack` looks like when it is read rather than queried.
 *
 * THE SHAPE IS DECLARED HERE STRUCTURALLY RATHER THAN IMPORTED, which is the one thing in this file
 * that will look like an oversight and is not. `prompt.ts` has no imports outside `connectors.ts`
 * and `mcpRegistry.ts` — it is the module every prompt lives in, and making it depend on the work
 * subsystem would mean the generation prompt's module graph included the Cockpit's stores. A
 * structural parameter costs a duplicated field list and buys a file that still builds a system
 * prompt for an agent that has never been deployed.
 */
export interface RecordForPrompt {
  agents: readonly { id: string; name: string }[];
  items: readonly {
    id: string;
    agent_name: string;
    status: string;
    failure_kind: string | null;
    input: string;
    output: string | null;
    error: string | null;
    created_at: string;
    ended_at: string | null;
    duration_ms: number | null;
    cost_usd: number | null;
    cost_complete: boolean;
    run_id: string | null;
    trace_reviewed: boolean;
  }[];
  counts: Record<string, number>;
  truncation: { by_count: boolean; by_bytes: boolean; total: number };
}

/**
 * The record, rendered for a model to read.
 *
 * EXPORTED SEPARATELY FROM THE USER PROMPT because it is also what the no-key path streams. §7.2:
 * `streamExplain` "degrades to raw context when there is no API key", and that degradation is a
 * FEATURE here rather than a fallback — with no key the user gets the facts as facts instead of an
 * error, which is a strictly more honest answer than a synthesised one and is the only reason the
 * whole path is testable for free.
 *
 * THE EMPTY CASE IS A SENTENCE, NOT AN EMPTY LIST. §7.5's test is that an agent with an empty record
 * produces "nothing is recorded" rather than a plausible summary, and the surest way to get that is
 * for the material itself to say so in words a model cannot read as an invitation to fill a gap.
 */
export function renderRecord(rec: RecordForPrompt): string {
  const who = rec.agents.map((a) => a.name).join(", ") || "this agent";
  if (rec.items.length === 0) {
    return `RECORD FOR: ${who}

THE RECORD IS EMPTY. There are no jobs recorded for this agent at all — not none matching the question, none whatsoever. Nothing has been asked of it through Jaroku, or everything that was has been removed by data retention.

There is therefore nothing you can report about what this agent has or has not done. Say that there is no record, and stop. Do not describe what the agent might do, might have done, or is for.`;
  }

  const totals = Object.entries(rec.counts)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`)
    .join(", ");

  // WHAT IS MISSING IS STATED, because §7.5 only holds if "there is no more" and "there is more and
  // it did not fit" are different sentences. A model told nothing about the boundary will describe
  // the newest forty jobs as though they were all of them.
  const bound = rec.truncation.by_count || rec.truncation.by_bytes
    ? `\n\nTHIS IS THE MOST RECENT ${rec.items.length} OF ${rec.truncation.total} JOBS, newest first. Older jobs exist and are NOT shown. If the question is about something that is not here, say that it is not in the jobs you can see and that there are older ones — do not conclude it never happened.`
    : `\n\nTHIS IS THE COMPLETE RECORD — all ${rec.truncation.total} job(s), newest first. If something is not here, it did not happen through Jaroku.`;

  const jobs = rec.items.map((i) => {
    const head = `[work:${i.id}] ${i.status}${i.failure_kind ? ` (${i.failure_kind})` : ""} · ${i.created_at}`;
    return head
      + field("agent", i.agent_name)
      + field("asked", i.input)
      + field("result", i.output)
      + field("error", i.error)
      + `\n  took: ${duration(i.duration_ms)} · cost: ${money(i.cost_usd, i.cost_complete)}`
      + (i.status === "failed"
        ? `\n  trace: ${i.run_id ? (i.trace_reviewed ? "opened by somebody" : "NOT yet opened by anybody") : "none recorded"}`
        : "");
  }).join("\n\n");

  return `RECORD FOR: ${who}

TOTALS ACROSS THE WHOLE RECORD: ${totals || "none"}.${bound}

JOBS:

${jobs}`;
}

/**
 * The name the answer may speak as, and the two rules that need it in front of the question.
 *
 * A CLOSING PARAGRAPH RATHER THAN A WHOLE USER MESSAGE, because `streamExplain` owns the shape of
 * that message and there must be one shape: context, then who is asking, then what they asked. A
 * second assembly here would be a second answer to "what does a user message look like", and the
 * two would drift the first time either was edited.
 *
 * LAST RATHER THAN FIRST, which is the one thing about its placement that is a decision. The rules
 * that matter most — cite everything, invent nothing — are the ones a model is most likely to drop
 * on a long context, and the end of the message is the position it reads last.
 *
 * THE DISPLAY NAME IS DATA AND ARRIVES HERE (§8). `agents.display_name` falling back to `slug` —
 * the same COALESCE migration 044 uses when it snapshots a name — and where an agent has no display
 * name the conversation does not invent a personality for it, which is why this says only that the
 * name may be used and says nothing at all about what the agent is like.
 */
export function conversationClosing(agentName: string): string {
  return `You may answer as "${agentName}" in the first person where a job in the record supports it. Where no job in the record supports it, say you have no record of it. Cite every claim with [work:<id>].`;
}
