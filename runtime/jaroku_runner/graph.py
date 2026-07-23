"""Static graph introspection — the Graph View's data source.

    uv run python -m jaroku_runner.graph <agent_id>     (cwd: runtime/)

This is deliberately NOT part of the trace pipeline. The trace stream (schema/events.md) is
frozen and carries no topology; the Graph View needs the agent's node/edge structure, which
exists only as the compiled LangGraph object. So this entrypoint builds that object with the
free dry-run model (no API key, no cost, no execution) and prints its topology — via LangGraph's
own ``app.get_graph()`` — as a SINGLE JSON object on stdout.

Contract with the caller (the TS server):
  * Exactly one JSON line on stdout, then exit.
  * Success: ``{"agent_id", "nodes": [{"id","type"}], "edges": [{"source","target",
    "conditional","label"}]}``.
  * Failure: ``{"agent_id", "error": "<message>"}`` with a non-zero exit code.
  * All human logging goes to stderr; the agent's own import/build output is redirected to
    stderr too, so stdout stays clean even if generated code prints.

It never runs the graph (no ``.invoke``), so it is safe and instant regardless of what the
agent's tools would do against real APIs.
"""

from __future__ import annotations

import json
import sys
from contextlib import redirect_stdout

from .contract import ContractError, load_agent, tools_of
from .models import DEFAULT_MODELS, build_model

START_ID = "__start__"
END_ID = "__end__"


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

    nodes = [{"id": nid, "type": _node_type(nid, builder)} for nid in drawable.nodes]

    edges = []
    for edge in drawable.edges:
        label = getattr(edge, "data", None)
        edges.append({
            "source": edge.source,
            "target": edge.target,
            "conditional": bool(getattr(edge, "conditional", False)),
            "label": str(label) if label is not None else None,
        })

    return {"agent_id": agent_id, "nodes": nodes, "edges": edges}


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
