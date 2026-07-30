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

import type { Connector } from "./connectors.ts";

export interface GenerationRequest {
  prompt: string;
  agentId: string;
  agentName: string;
  connectors: Connector[];
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
   rejected.`;

function renderConnectorReference(connectors: Connector[]): string {
  return connectors
    .map((c) => {
      const tools = c.tools
        .map((t) => `    ${t.signature}\n        ${t.summary}`)
        .join("\n");
      return [
        `  ${c.id}  (file will exist at tools/${c.file})`,
        `    ${c.description}`,
        `    import like: from .${c.module} import ${c.tools.map((t) => t.name).join(", ")}`,
        `    requires env: ${c.required_env.join(", ")}`,
        tools,
      ].join("\n");
    })
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

EVERY TOOL MUST BE LABELLED. "reviewed connector template" means one of the connectors listed
below, which is audited code copied into the project verbatim and never written by you.
"bespoke" means code that will be generated for this agent. This distinction is the single
most decision-relevant fact in the plan: it tells the developer which parts are trusted and
which are about to be invented.

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

  return `Plan this agent:

${req.prompt}

Human-readable name: ${req.agentName}

Selected connectors:
${selected}
${revision}
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
E1. READ-ONLY FILES — never emit: jaroku.json, the top-level __init__.py, or any connector
    file (the tools/<file> paths listed under AVAILABLE CONNECTORS). Connectors are reviewed
    code. If the request requires different connector behavior, write a bespoke wrapper tool
    that uses the connector's tool and adapts the result — connector tools are StructuredTool
    objects, so invoke them: pg_query.invoke({"sql": "..."}), never pg_query(...) (rule 9).
    If the request cannot be satisfied without editing a read-only file, say so in the
    summary and emit no files. (tools/__init__.py and prompts/__init__.py are editable.)
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

  return `Edit this agent.

Agent package: ${req.agentId}
Installed connector files: ${connectorLine}

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

  const env = req.connectors.flatMap((c) => c.required_env);
  const envNote = env.length
    ? `\nThese connector env keys must appear in .env.example: ${env.join(", ")}`
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
${plan}
Emit the files now, starting with agent.py. Output files only — no commentary.`;
}
