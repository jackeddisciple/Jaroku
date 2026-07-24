"""Jaroku runner — executes a generated agent and emits its trace.

    uv run python -m jaroku_runner <agent_id> ["user input"]     (cwd: runtime/)

This is the counterpart to the hand-written test_agent: same event contract, but the agent
under observation is generated code that knows nothing about Jaroku. Everything trace-shaped
lives here, so a bad generation can produce a *failing* run but never a *lying* one.

Order of operations matters and is load-bearing:

  1. load_env()             provider keys, from runtime/.env (values never logged)
  2. install_stdout_guard() BEFORE any generated code is imported
  3. emit_run_start()       so a run appears in the UI even if step 4 fails
  4. load_agent()           import + contract check
  5. build_model/graph, invoke with the tracer attached
  6. emit_run_end()         in a finally, always

Steps 3 and 6 bracket everything, so a contract violation, an import error, or a crash mid-
graph all surface as a run with `status: "error"` rather than as silence.
"""

from __future__ import annotations

import os
import sys
import uuid

from jaroku_interceptor import JarokuTracer, Run, load_env
from jaroku_interceptor.schema import emit_run_end, emit_run_start, now_iso

from .contract import ContractError, load_agent, tools_of
from .debug import run_with_checkpoints
from .guard import install_stdout_guard
from .models import build_model, resolve_model_name

DEFAULT_INPUT = "Hello! Please introduce yourself and show me what you can do."


def log(*args) -> None:
    """Human-facing logging — stderr only. (After the guard, stdout *is* stderr, but being
    explicit keeps this correct if the guard ever fails to install.)"""
    print(*args, file=sys.stderr, flush=True)


def main(argv: list[str]) -> int:
    # Provider keys live in runtime/.env — the subprocess doesn't inherit a shell rc.
    load_env()

    if len(argv) < 2:
        log("usage: python -m jaroku_runner <agent_id> [\"user input\"]")
        return 2
    agent_id = argv[1]
    user_input = argv[2] if len(argv) > 2 else DEFAULT_INPUT

    # Before ANY generated module is imported. Irreversible, by design.
    install_stdout_guard()

    provider = os.environ.get("JAROKU_PROVIDER", "fake").lower()
    if provider not in ("anthropic", "openai"):
        provider = "fake"
    model_name = resolve_model_name(provider, os.environ.get("JAROKU_MODEL"))

    run = Run(id=str(uuid.uuid4()), agent_id=agent_id,
              provider=provider, model=model_name)

    log(f"[jaroku] run {run.id} agent={agent_id} provider={provider} model={model_name}")
    emit_run_start(run)

    try:
        module = load_agent(agent_id)
        tools = tools_of(module)
        llm, provider, model_name = build_model(provider, model_name, tools)
        run.provider, run.model = provider, model_name

        app = module.build_graph(llm)
        initial_state = module.build_initial_state(user_input)

        # Passing the compiled graph lets the tracer identify conditional edges exactly
        # (graph.builder.branches) instead of inferring them.
        tracer = JarokuTracer(run, graph=app)
        # Recompile a checkpointed twin and drive it node-by-node. The emitted trace is identical
        # to the old app.invoke(...) — same nodes/callbacks/seq — but every node boundary now
        # leaves a durable checkpoint that pause/resume/branch build on (checkpoints are
        # control-plane, never on the frozen stdout trace stream).
        run_with_checkpoints(app, initial_state,
                             run_id=run.id, thread_id=run.id, tracer=tracer)
        run.status = "completed"
    except ContractError as exc:
        run.status = "error"
        run.error = f"ContractError: {exc}"
        log(f"[jaroku] {run.error}")
    except Exception as exc:  # noqa: BLE001 — any agent failure belongs in the trace
        run.status = "error"
        run.error = f"{type(exc).__name__}: {exc}"
        log(f"[jaroku] run errored: {run.error}")
    finally:
        run.ended_at = now_iso()
        emit_run_end(run)

    log(f"[jaroku] run {run.id} {run.status} tokens={run.tokens} cost={run.cost}")
    return 0 if run.status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
