// What `jaroku_runner.graph` says about each node, against a real uv/Python process.
//
// The Graph view draws a step as a model call or a plain step, writes the step's docstring on its
// card, and names the function that decides at a fork. None of that is in LangGraph's compiled
// topology: the runner reads it off the graph builder, and the only way to know it reads the
// right thing is to build real graphs. graphIntrospect.test.ts covers the caching decision with a
// fake sandbox; this covers what comes out of the real one.
//
// Two agents: the hand-written reference (`runtime/agents/example_agent`), and a project written
// here in the shapes generated code uses — a model reached through `with_structured_output`, one
// handed to a node through `functools.partial`, a lambda, a plain function, a documented router.
//
//   npm run test:graph-shape

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GRAPH_SCHEMA, introspectGraph, type GraphResult } from "./graphIntrospect.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const RUNTIME_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "runtime");

const node = (g: GraphResult, id: string) => g.nodes?.find((n) => n.id === id);
/** The 1-based line of the first line in `text` containing `needle` — what a source location must name. */
const lineOf = (text: string, needle: string) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

console.log("the reference agent");
{
  const g = await introspectGraph(RUNTIME_DIR, "example_agent");
  check("introspects without an error", !g.error, g.error ?? "");
  check("reports the schema the server caches by", g.schema === GRAPH_SCHEMA, String(g.schema));
  check("the agent node calls the model", node(g, "agent")?.calls_model === true);
  check("the tool node is a tool node and calls no model",
    node(g, "tools")?.type === "tool" && node(g, "tools")?.calls_model === false);
  check("record_note is a plain step", node(g, "record_note")?.calls_model === false);
  check("record_note's docstring is its description",
    node(g, "record_note")?.doc === "Fold the most recent tool output into `notes` — a visible state mutation.",
    String(node(g, "record_note")?.doc));
  check("start and end call no model",
    node(g, "__start__")?.calls_model === false && node(g, "__end__")?.calls_model === false);
  check("the fork names its deciding function",
    g.routers?.some((r) => r.source === "agent" && r.name === "should_continue") === true,
    JSON.stringify(g.routers));

  // WHERE EACH ONE IS WRITTEN, which double-clicking a node opens. Read off the reference file
  // itself rather than written down here, so an edit to the example cannot make this lie.
  const src = readFileSync(join(RUNTIME_DIR, "agents", "example_agent", "agent.py"), "utf8");
  check("the agent node points at its function's def line",
    node(g, "agent")?.source?.file === "agent.py" && node(g, "agent")?.source?.line === lineOf(src, "def call_model("),
    JSON.stringify(node(g, "agent")?.source));
  check("record_note points at its own",
    node(g, "record_note")?.source?.line === lineOf(src, "def record_note("), JSON.stringify(node(g, "record_note")?.source));
  check("the router points at its function too",
    g.routers?.find((r) => r.source === "agent")?.location?.line === lineOf(src, "def should_continue("),
    JSON.stringify(g.routers));
  check("Start, End and the library ToolNode point nowhere",
    node(g, "__start__")?.source === null && node(g, "__end__")?.source === null && node(g, "tools")?.source === null);
}

const SCREENER = `from functools import partial
from typing import TypedDict

from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel

TOOLS: list = []


class State(TypedDict, total=False):
    text: str
    score: int
    note: str


class Score(BaseModel):
    score: int


def _summarise(llm, state: State) -> dict:
    """Write the shortlist note."""
    return {"note": llm.invoke(state["text"]).content}


def build_graph(llm):
    scorer = llm.with_structured_output(Score)

    def extract(state: State) -> dict:
        """Pull the facts out of the text."""
        return {"text": llm.invoke(state["text"]).content}

    def tidy(state: State) -> dict:
        """Trim the extracted text; no model involved."""
        return {"text": state["text"].strip()}

    def score(state: State) -> dict:
        """Score the facts from 0 to 100.

        A second paragraph the card should not show.
        """
        return {"score": scorer.invoke(state["text"]).score}

    def route(state: State) -> str:
        """Shortlist at 70 or more, otherwise decline."""
        return "shortlist" if state["score"] >= 70 else "decline"

    graph = StateGraph(State)
    graph.add_node("extract", extract)
    graph.add_node("tidy", tidy)
    graph.add_node("score", score)
    graph.add_node("shortlist", partial(_summarise, llm))
    graph.add_node("decline", lambda state: {"note": "Thanks, but no."})
    graph.add_edge(START, "extract")
    graph.add_edge("extract", "tidy")
    graph.add_edge("tidy", "score")
    graph.add_conditional_edges("score", route, {"shortlist": "shortlist", "decline": "decline"})
    graph.add_edge("shortlist", END)
    graph.add_edge("decline", END)
    return graph.compile()


def build_initial_state(user_input: str) -> dict:
    return {"text": user_input}
`;

console.log("\nthe shapes generated code uses");
{
  const dir = mkdtempSync(join(tmpdir(), "jaroku-graph-shape-"));
  try {
    writeFileSync(join(dir, "agent.py"), SCREENER);
    const g = await introspectGraph(RUNTIME_DIR, "screener", dir);
    check("introspects without an error", !g.error, g.error ?? "");
    check("a node calling the model directly is a model call", node(g, "extract")?.calls_model === true);
    check("a node calling it through with_structured_output is a model call", node(g, "score")?.calls_model === true);
    check("a node handed it through functools.partial is a model call", node(g, "shortlist")?.calls_model === true);
    check("a function that never touches it is a plain step", node(g, "tidy")?.calls_model === false);
    check("a lambda that never touches it is a plain step", node(g, "decline")?.calls_model === false);
    check("only a docstring's first line is kept",
      node(g, "score")?.doc === "Score the facts from 0 to 100.", String(node(g, "score")?.doc));
    check("a partial's description is the wrapped function's, not functools'",
      node(g, "shortlist")?.doc === "Write the shortlist note.", String(node(g, "shortlist")?.doc));
    check("a node with no docstring has no description", node(g, "decline")?.doc === null);
    const route = g.routers?.find((r) => r.source === "score");
    check("the fork's router is named", route?.name === "route", JSON.stringify(g.routers));
    check("...and says what it decides", route?.doc === "Shortlist at 70 or more, otherwise decline.");
    check("the two branches are still conditional edges",
      (g.edges ?? []).filter((e) => e.source === "score" && e.conditional).length === 2);
    check("a nested function points at its def line", node(g, "score")?.source?.line === lineOf(SCREENER, "def score("),
      JSON.stringify(node(g, "score")?.source));
    check("a partial points at the function it wraps", node(g, "shortlist")?.source?.line === lineOf(SCREENER, "def _summarise("),
      JSON.stringify(node(g, "shortlist")?.source));
    check("a lambda points at the line it is written on",
      node(g, "decline")?.source?.line === lineOf(SCREENER, 'graph.add_node("decline", lambda'), JSON.stringify(node(g, "decline")?.source));
    check("...all relative to the project, not the machine", (g.nodes ?? []).every((n) => !n.source || n.source.file === "agent.py"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(fail ? `\n${fail} FAILURES` : "\nALL CORRECT");
process.exit(fail ? 1 : 0);
