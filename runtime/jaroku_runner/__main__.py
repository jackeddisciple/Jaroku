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

import json
import os
import sys
import uuid

from jaroku_interceptor import JarokuTracer, Run, load_env
from jaroku_interceptor.schema import bind_trace_sink, emit_run_end, emit_run_start, now_iso

from . import controlplane_http
from .contract import ContractError, load_agent, tools_of
from .debug import emit_ctrl, run_with_checkpoints, thread_id_for
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

    # Additive, and a no-op unless a hosted control plane is actually configured — see
    # controlplane_http's module docstring. stdout still carries the frozen trace either way.
    # queue_trace_event batches rather than sending one event per call; flush_trace_events()
    # below is what sends whatever is left buffered once the run itself is over.
    if controlplane_http.configured():
        bind_trace_sink(controlplane_http.queue_trace_event)

    provider = os.environ.get("JAROKU_PROVIDER", "fake").lower()
    if provider not in ("anthropic", "openai"):
        provider = "fake"
    model_name = resolve_model_name(provider, os.environ.get("JAROKU_MODEL"))

    # Debug-depth control (all optional / additive):
    #  * JAROKU_RESUME_RUN_ID — resume an existing run's durable checkpoint (continue, don't restart).
    #  * JAROKU_RUN_ID        — server-minted id so it can address the run (e.g. to pause) before
    #                           run_start races; falls back to a locally-minted uuid otherwise.
    #  * JAROKU_SEQ_OFFSET    — the run's current max seq + 1, so a resumed/branched segment's steps
    #                           continue an ascending seq instead of restarting at 0.
    #  * JAROKU_BRANCH_* — fork a NEW run from a parent's checkpoint (run against a copy of the
    #    parent's checkpoint db, so the parent is never touched): CHECKPOINT_ID (fork point),
    #    THREAD_ID (the parent's checkpoint thread), EDIT_FILE (validated domain-field edit, JSON),
    #    EDIT_NODE (as_node for the update). JAROKU_RUN_ID is the new branch id.
    resume_run_id = os.environ.get("JAROKU_RESUME_RUN_ID") or None
    branch_checkpoint = os.environ.get("JAROKU_BRANCH_CHECKPOINT_ID") or None
    branch_thread = os.environ.get("JAROKU_BRANCH_THREAD_ID") or None
    branching = branch_checkpoint is not None
    resuming = resume_run_id is not None

    run_id = resume_run_id or os.environ.get("JAROKU_RUN_ID") or str(uuid.uuid4())
    # The checkpoint thread: a branch continues the PARENT's thread; a fresh run or resume uses
    # its own. `thread_id_for` prefixes the workspace when JAROKU_WORKSPACE_ID is set, because on
    # the Postgres checkpointer every tenant's threads share one table and nothing but the key
    # separates them — see debug.py. A copied-out project has no workspace and gets the bare run
    # id, which is what keeps an exported project standalone.
    thread_id = branch_thread if branching else thread_id_for(run_id)
    seq_offset = int(os.environ.get("JAROKU_SEQ_OFFSET", "0") or "0")
    # Both resume and branch continue a run that already exists in the store — no new run_start.
    is_continuation = resuming or branching

    edit_values: dict | None = None
    edit_node: str | None = None
    if branching:
        edit_file = os.environ.get("JAROKU_BRANCH_EDIT_FILE")
        if edit_file:
            with open(edit_file, encoding="utf-8") as fh:
                edit_values = json.load(fh)
            edit_node = os.environ.get("JAROKU_BRANCH_EDIT_NODE") or None

    run = Run(id=run_id, agent_id=agent_id, provider=provider, model=model_name)

    mode = "branch" if branching else "resume" if resuming else "run"
    log(f"[jaroku] {mode} {run.id} agent={agent_id} provider={provider} model={model_name} "
        f"seq_offset={seq_offset}")
    # A resumed/branched run already exists in the store (with its run_start / copied prefix);
    # re-emitting run_start would duplicate it.
    if not is_continuation:
        emit_run_start(run)

    paused = False
    try:
        module = load_agent(agent_id)
        tools = tools_of(module)
        llm, provider, model_name = build_model(provider, model_name, tools)
        run.provider, run.model = provider, model_name

        app = module.build_graph(llm)
        # A continuation ignores the initial state (it continues from a checkpoint); fresh seeds it.
        initial_state = None if is_continuation else module.build_initial_state(user_input)

        # Passing the compiled graph lets the tracer identify conditional edges exactly
        # (graph.builder.branches) instead of inferring them.
        tracer = JarokuTracer(run, graph=app, seq_start=seq_offset)
        # Recompile a checkpointed twin and drive it node-by-node. The emitted trace is identical
        # to the old app.invoke(...) — same nodes/callbacks/seq — but every node boundary now
        # leaves a durable checkpoint that pause/resume/branch build on.
        outcome = run_with_checkpoints(app, initial_state,
                                       run_id=run.id, thread_id=thread_id, tracer=tracer,
                                       resume=resuming,
                                       fork_from_checkpoint=branch_checkpoint,
                                       edit_values=edit_values, edit_node=edit_node)
        if outcome == "paused":
            paused = True
        elif outcome == "cancelled":
            # A CANCELLED RUN IS AN ERRORED RUN ON THE FROZEN SCHEMA, because the schema has
            # three statuses and this part adds none. "error" with a reason that says what
            # happened is the honest fit: the run did not complete, and the trace says why in the
            # one field built to carry it. It is deliberately NOT a paused run — nothing will
            # resume from it — and deliberately not "completed", which would put a run somebody
            # stopped into the same bucket as one that finished its work.
            run.status = "error"
            run.error = "Cancelled: the run was stopped at a node boundary"
            log(f"[jaroku] {run.error}")
        else:
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
        # A paused run is NOT finished — no run_end, so the run stays open (the server marks it
        # 'paused' from the control event) and a later resume continues its seq/timeline.
        if not paused:
            run.ended_at = now_iso()
            emit_run_end(run)
        # Whatever queue_trace_event has buffered — including run_end itself, which will not
        # otherwise cross the batch threshold on a short run — has to go now. Nothing calls
        # this again: a process about to exit gets exactly one more chance to deliver it.
        controlplane_http.flush_trace_events()
        # AND THE LAST THING THIS PROCESS SAYS: that the bracket above actually closed.
        #
        # WHY IT EXISTS. A local run has a process manager holding its pipe, so "the run ended"
        # is the pipe closing. A deployed run has serve.py, which discards this process's stdout
        # (the trace goes over HTTP from in here) and therefore cannot tell a run that emitted
        # run_end from one the kernel killed between two steps. Both leave a container that
        # exits; only one of them left a finished run behind.
        #
        # An exit code cannot carry it either. A `python -m jaroku_runner` that cannot import
        # its own package exits 1 and emits nothing; a run that errored exits 1 and emitted a
        # perfectly good run_end. So the difference is stated rather than inferred, and the
        # STATUS is on it — because "paused" is the third case, and a paused run deliberately
        # has no run_end at all. Anything that pushed an error run_end over one of those would
        # end a run somebody is about to resume.
        emit_ctrl({"ctrl": "run_closed", "run_id": run.id,
                   "status": "paused" if paused else run.status})

    status = "paused" if paused else run.status
    log(f"[jaroku] run {run.id} {status} tokens={run.tokens} cost={run.cost}")
    return 0 if status in ("completed", "paused") else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
