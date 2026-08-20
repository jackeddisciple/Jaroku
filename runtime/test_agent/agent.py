"""Hand-written 2-tool LangGraph test agent — the permanent trace fixture (doc §8).

Tools: get_weather + calculator. A simple agent<->tools loop.

Model selection (env ``JAROKU_PROVIDER``):
  * unset / "fake"  -> deterministic scripted model, no API key required. This is the
                       default so the trace pipeline is verifiable offline and repeatably.
  * "anthropic"     -> ChatAnthropic (needs ANTHROPIC_API_KEY, JAROKU_MODEL optional)
  * "openai"        -> ChatOpenAI    (needs OPENAI_API_KEY, JAROKU_MODEL optional)

Run directly:  uv run python -m test_agent.agent  ["your input"]
Events (Run/Step JSON) stream to stdout; human logs go to stderr.
"""

from __future__ import annotations

import ast
import operator
import os
import sys
import time
import uuid

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage  # noqa: F401
from langchain_core.tools import tool
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

from jaroku_interceptor import JarokuTracer, Run, load_env
from jaroku_interceptor.schema import emit_run_end, emit_run_start, now_iso


def log(*args) -> None:
    """Human-facing logging — stderr only, so stdout stays pure JSON events."""
    print(*args, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- tools
@tool
def get_weather(city: str) -> str:
    """Return the current weather for a city (stubbed, deterministic)."""
    table = {"paris": "18°C, partly cloudy", "london": "14°C, rain",
             "tokyo": "24°C, clear"}
    return table.get(city.strip().lower(), f"20°C, clear (no data for {city})")


_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.Pow: operator.pow, ast.Mod: operator.mod,
    ast.USub: operator.neg, ast.UAdd: operator.pos,
}


def _safe_eval(node):
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float)):
            return node.value
        raise ValueError("only numeric constants allowed")
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_safe_eval(node.left), _safe_eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_safe_eval(node.operand))
    raise ValueError("unsupported expression")


@tool
def calculator(expression: str) -> str:
    """Evaluate a basic arithmetic expression, e.g. '18 + 4'."""
    result = _safe_eval(ast.parse(expression, mode="eval").body)
    return str(result)


TOOLS = [get_weather, calculator]


# --------------------------------------------------------------------------- model
def build_model(provider: str, model_name: str):
    """Return (runnable, provider, model_name). Binds tools for real providers."""
    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic
        llm = ChatAnthropic(model=model_name, temperature=0)
        return llm.bind_tools(TOOLS), provider, model_name
    if provider == "openai":
        from langchain_openai import ChatOpenAI
        llm = ChatOpenAI(model=model_name, temperature=0)
        return llm.bind_tools(TOOLS), provider, model_name

    # Default: deterministic scripted model (no API key). Cycles through these replies,
    # driving the weather -> calculator -> final-answer path regardless of input.
    from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
    scripted = [
        AIMessage(content="", tool_calls=[
            {"name": "get_weather", "args": {"city": "Paris"}, "id": "call_weather"}]),
        AIMessage(content="", tool_calls=[
            {"name": "calculator", "args": {"expression": "18 + 4"}, "id": "call_calc"}]),
        AIMessage(content="Paris is 18°C, partly cloudy, and 18 + 4 = 22."),
    ]
    return FakeMessagesListChatModel(responses=scripted), "fake", "fake-scripted"


# --------------------------------------------------------------------------- graph
def build_graph(model):
    # Optional per-LLM-step delay (ms) — makes live streaming visible in the UI and lets
    # mid-run kill be tested deterministically. Default 0 (instant).
    step_delay_s = float(os.environ.get("JAROKU_DELAY_MS", "0")) / 1000.0

    def call_model(state: MessagesState):
        if step_delay_s:
            time.sleep(step_delay_s)
        response = model.invoke(state["messages"])
        return {"messages": [response]}

    def should_continue(state: MessagesState) -> str:
        last = state["messages"][-1]
        return "tools" if getattr(last, "tool_calls", None) else END

    graph = StateGraph(MessagesState)
    graph.add_node("agent", call_model)
    graph.add_node("tools", ToolNode(TOOLS))
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    graph.add_edge("tools", "agent")
    return graph.compile()


# --------------------------------------------------------------------------- main
def main() -> int:
    # Provider keys live in runtime/.env — the subprocess doesn't inherit a shell rc.
    # Shell env always wins over the file; values are never logged.
    load_env()

    user_input = sys.argv[1] if len(sys.argv) > 1 else \
        "What's the weather in Paris, and what is 18 + 4?"

    provider = os.environ.get("JAROKU_PROVIDER", "fake").lower()
    default_model = {"anthropic": "claude-opus-4-8", "openai": "gpt-4o"}.get(provider, "fake-scripted")
    model_name = os.environ.get("JAROKU_MODEL", default_model)

    model, provider, model_name = build_model(provider, model_name)
    app = build_graph(model)

    # THE SERVER'S ID WHEN THERE IS ONE, and a fresh one when this is being run by hand.
    #
    # `jaroku_runner.__main__` has always done this and the fixture never did, which was invisible
    # until v0.2.17 made the control plane reconcile a trace event's OWN run id against the pool
    # slot that produced it — a sandbox holding a valid run token could otherwise flip another
    # run in the same workspace to `completed`. That guard is right, and the fixture was the one
    # thing in the product that could not satisfy it: it minted a uuid nobody had heard of, so
    # every event it emitted was dropped at ingest and the startup run the README promises —
    # "so you see a live trace immediately" — has been silently producing nothing ever since.
    #
    # Same precedence as the runner: the environment first, a new id only when nothing set one.
    run = Run(id=os.environ.get("JAROKU_RUN_ID") or str(uuid.uuid4()), agent_id="test_agent",
              provider=provider, model=model_name)
    # Passing the compiled graph lets the tracer identify conditional edges exactly
    # (graph.builder.branches) instead of inferring them.
    tracer = JarokuTracer(run, graph=app)

    log(f"[jaroku] run {run.id} provider={provider} model={model_name}")
    emit_run_start(run)

    try:
        app.invoke({"messages": [HumanMessage(user_input)]},
                   config={"callbacks": [tracer], "recursion_limit": 25})
        run.status = "completed"
    except Exception as exc:  # noqa: BLE001 — capture any agent failure into the trace
        run.status = "error"
        run.error = f"{type(exc).__name__}: {exc}"
        log(f"[jaroku] run errored: {run.error}")
    finally:
        run.ended_at = now_iso()
        emit_run_end(run)

    log(f"[jaroku] run {run.id} {run.status} "
        f"tokens={run.tokens} cost={run.cost}")
    return 0 if run.status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
