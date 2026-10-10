"""Static graph introspection — the Graph View's data source.

    uv run python -m jaroku_runner.graph <agent_id>     (cwd: runtime/)

This is deliberately NOT part of the trace pipeline. The trace stream (schema/events.md) is
frozen and carries no topology; the Graph View needs the agent's node/edge structure, which
exists only as the compiled LangGraph object. So this entrypoint builds that object with the
free dry-run model (no API key, no cost, no execution) and prints its topology — via LangGraph's
own ``app.get_graph()`` — as a SINGLE JSON object on stdout.

Contract with the caller (the TS server):
  * Exactly one JSON line on stdout, then exit.
  * Success: ``{"agent_id", "schema", "nodes": [{"id","type","calls_model","doc"}],
    "edges": [{"source","target","conditional","label"}], "routers": [{"source","name","doc"}]}``.
  * Failure: ``{"agent_id", "error": "<message>"}`` with a non-zero exit code.

``schema`` is GRAPH_SCHEMA. The server caches a version's graph forever, so a result written
before a field existed is recognised by its lower number and introspected again.
  * All human logging goes to stderr; the agent's own import/build output is redirected to
    stderr too, so stdout stays clean even if generated code prints.

It never runs the graph (no ``.invoke``), so it is safe and instant regardless of what the
agent's tools would do against real APIs.
"""

from __future__ import annotations

import functools
import inspect
import json
import sys
from contextlib import redirect_stdout

from .contract import ContractError, load_agent, tools_of
from .models import DEFAULT_MODELS, build_model

START_ID = "__start__"
END_ID = "__end__"

# Bumped whenever the payload gains a field the Graph view reads. Kept in step with
# GRAPH_SCHEMA in server/src/graphIntrospect.ts.
GRAPH_SCHEMA = 2

# How long a node's description may be. The Graph view shows one line of it on the card and
# the rest on hover, so a docstring's later paragraphs are left in the code where they belong.
DOC_MAX = 160


def log(*args) -> None:
    print(*args, file=sys.stderr, flush=True)


def _node_type(name: str, builder) -> str:
    """Best-effort classification for the node inspector. Topology comes from get_graph();
    this only labels a node so the UI can pick an icon. Never raises."""
    if name == START_ID:
        return "start"
    if name == END_ID:
        return "end"
    try:
        from langgraph.prebuilt import ToolNode

        spec = (getattr(builder, "nodes", {}) or {}).get(name)
        runnable = getattr(spec, "runnable", None) or getattr(spec, "node", None)
        if isinstance(runnable, ToolNode) or type(runnable).__name__ == "ToolNode":
            return "tool"
    except Exception:  # noqa: BLE001 — classification is cosmetic, topology is authoritative
        pass
    return "agent"


def _function_of(runnable):
    """The Python callable behind a node or a router, or None. LangGraph wraps both in a
    RunnableCallable whose sync body is ``func`` and async body is ``afunc``."""
    for attr in ("func", "afunc"):
        fn = getattr(runnable, attr, None)
        if callable(fn):
            return fn
    return None


def _first_line(fn) -> str | None:
    """The first line of a callable's docstring, or None. What the Graph view shows a node doing."""
    # A partial's own docstring is functools' description of partials, not of the node.
    while isinstance(fn, functools.partial):
        fn = fn.func
    try:
        doc = inspect.getdoc(fn) if fn is not None else None
    except Exception:  # noqa: BLE001
        return None
    if not doc:
        return None
    line = doc.strip().splitlines()[0].strip()
    return line[:DOC_MAX] if line else None


def _reaches(value, llm, depth: int, seen: set[int]) -> bool:
    """Whether ``value`` is, wraps, or (through a helper's closure) can reach the model.

    The contract hands the model to build_graph and forbids constructing another, so a node
    that calls one holds it in its closure: as ``llm`` itself, as ``llm.bind_tools(...)`` (a
    binding whose ``bound`` is the model), as ``llm.with_structured_output(...)`` (a sequence
    with the model among its steps), or through a helper that does one of those."""
    if value is llm:
        return True
    if id(value) in seen or depth < 0:
        return False
    seen.add(id(value))
    try:
        from langchain_core.language_models import BaseLanguageModel

        if isinstance(value, BaseLanguageModel):
            return True
    except Exception:  # noqa: BLE001
        pass
    bound = getattr(value, "bound", None)
    if bound is not None and _reaches(bound, llm, depth, seen):
        return True
    for step in getattr(value, "steps", None) or []:
        if _reaches(step, llm, depth, seen):
            return True
    if isinstance(value, functools.partial):
        parts = [value.func, *value.args, *value.keywords.values()]
        return any(_reaches(p, llm, depth, seen) for p in parts)
    if inspect.isfunction(value) or inspect.ismethod(value):
        try:
            names = inspect.getclosurevars(value)
        except Exception:  # noqa: BLE001
            return False
        for held in (*names.nonlocals.values(), *names.globals.values()):
            if _reaches(held, llm, depth - 1, seen):
                return True
    return False


def _calls_model(name: str, builder, llm) -> bool | None:
    """Whether this node can call the model it was built with: True, False, or None when the
    node is not a plain function (a subgraph, say) and nothing can honestly be said. Never raises."""
    if name in (START_ID, END_ID):
        return False
    try:
        spec = (getattr(builder, "nodes", {}) or {}).get(name)
        runnable = getattr(spec, "runnable", None)
        if type(runnable).__name__ == "ToolNode":
            return False
        fn = _function_of(runnable)
        if fn is None:
            return None
        return _reaches(fn, llm, depth=2, seen=set())
    except Exception:  # noqa: BLE001 — classification is cosmetic, topology is authoritative
        return None


def _node_doc(name: str, builder) -> str | None:
    try:
        spec = (getattr(builder, "nodes", {}) or {}).get(name)
        return _first_line(_function_of(getattr(spec, "runnable", None)))
    except Exception:  # noqa: BLE001
        return None


def _routers(builder) -> list[dict]:
    """Each conditional fork's deciding function: where it sits, its name and what it says it
    does. The compiled topology has edges for a fork but no node, so without this the decision
    an agent makes is the one thing in it the Graph view cannot name. Never raises."""
    out: list[dict] = []
    try:
        branches = getattr(builder, "branches", {}) or {}
        for source, specs in branches.items():
            for key, spec in specs.items():
                fn = _function_of(getattr(spec, "path", None))
                name = getattr(fn, "__name__", None) or str(key)
                out.append({
                    "source": str(source),
                    "name": None if name == "<lambda>" else name,
                    "doc": _first_line(fn),
                })
    except Exception:  # noqa: BLE001
        pass
    return out


def _branch_labels(builder) -> dict[tuple[str, str], str]:
    """Map each conditional (source, target) edge to its branch condition, read from the graph
    builder's ``branches``. add_conditional_edges("agent", fn, {"tools": "tools", END: END})
    records ends = {cond: target}; we invert it so the edge can show the condition that took it.
    Never raises — labels are decoration, topology is authoritative."""
    out: dict[tuple[str, str], str] = {}
    try:
        branches = getattr(builder, "branches", {}) or {}
        for source, specs in branches.items():
            for spec in specs.values():
                ends = getattr(spec, "ends", None) or {}
                for cond, target in ends.items():
                    out[(str(source), str(target))] = str(cond)
    except Exception:  # noqa: BLE001
        pass
    return out


def introspect(agent_id: str) -> dict:
    """Build the agent's graph with the dry-run model and return its topology.

    The import + build are wrapped so any stray stdout from generated code lands on stderr and
    never corrupts the single JSON line this entrypoint owns.
    """
    with redirect_stdout(sys.stderr):
        module = load_agent(agent_id)
        tools = tools_of(module)
        llm, _, _ = build_model("fake", DEFAULT_MODELS["fake"], tools)
        app = module.build_graph(llm)
        drawable = app.get_graph()  # LangGraph's own topology view (public API)
        builder = getattr(app, "builder", None)

    nodes = [
        {
            "id": nid,
            "type": _node_type(nid, builder),
            "calls_model": _calls_model(nid, builder, llm),
            "doc": _node_doc(nid, builder),
        }
        for nid in drawable.nodes
    ]

    labels = _branch_labels(builder)
    edges = []
    for edge in drawable.edges:
        conditional = bool(getattr(edge, "conditional", False))
        # Prefer LangGraph's own edge label; fall back to the branch condition for conditionals.
        label = getattr(edge, "data", None)
        if label is None and conditional:
            label = labels.get((edge.source, edge.target))
        edges.append({
            "source": edge.source,
            "target": edge.target,
            "conditional": conditional,
            "label": str(label) if label is not None else None,
        })

    return {
        "agent_id": agent_id,
        "schema": GRAPH_SCHEMA,
        "nodes": nodes,
        "edges": edges,
        "routers": _routers(builder),
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        log("usage: python -m jaroku_runner.graph <agent_id>")
        return 2
    agent_id = argv[1]
    try:
        payload = introspect(agent_id)
    except ContractError as exc:
        print(json.dumps({"agent_id": agent_id, "error": f"ContractError: {exc}"}), flush=True)
        return 1
    except Exception as exc:  # noqa: BLE001 — any failure is reported as a graph error
        print(json.dumps({"agent_id": agent_id, "error": f"{type(exc).__name__}: {exc}"}),
              flush=True)
        return 1

    print(json.dumps(payload), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
