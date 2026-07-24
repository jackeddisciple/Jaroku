"""Checkpointed execution driver — the foundation for pause / inspect / resume + branching.

A generated agent's ``build_graph(llm)`` returns a bare compiled graph with no checkpointer, so a
plain ``app.invoke(...)`` leaves nothing to resume from. To make a run pausable and branchable we
recompile a *twin* from the same ``StateGraph`` builder with a durable ``SqliteSaver`` and
``interrupt_after="*"`` (a checkpoint after every node), then drive it with a stream loop instead
of a single invoke.

Load-bearing guarantee: the trace the ``JarokuTracer`` emits from this path is IDENTICAL to a
plain ``.invoke()`` — same nodes, same callbacks, same ``seq`` — because the interrupt only hands
control back to this loop between nodes and never re-runs a completed node. What changes is that
every node boundary now leaves a durable checkpoint on disk that a later subprocess can resume or
branch from. Checkpoints live under ``runtime/.checkpoints/<run_id>.sqlite`` (gitignored); they
are pure control-plane and never touch the frozen NDJSON trace stream on stdout.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from typing import Any

# runtime/.checkpoints/ — sibling of jaroku_runner/, alongside .staging/ and .history/.
CHECKPOINT_DIR = Path(__file__).resolve().parent.parent / ".checkpoints"


def _log(*args: Any) -> None:
    print(*args, file=sys.stderr, flush=True)


def checkpoint_db_path(run_id: str) -> Path:
    CHECKPOINT_DIR.mkdir(exist_ok=True)
    return CHECKPOINT_DIR / f"{run_id}.sqlite"


def run_with_checkpoints(
    app: Any,
    initial_state: Any,
    *,
    run_id: str,
    thread_id: str,
    tracer: Any,
    recursion_limit: int = 25,
) -> None:
    """Drive a checkpointed twin of ``app`` to completion, one node at a time.

    Returns normally on completion; any agent exception propagates to the caller, which records it
    as the run's error (same contract as the old ``app.invoke`` call site).

    ``thread_id`` is the LangGraph checkpoint thread. For a fresh run it equals ``run_id``; resume
    and branch (later commits) pass a thread that already has checkpoints to continue/fork from.
    """
    builder = getattr(app, "builder", None)
    if builder is None:
        # Exotic graph with no exposed builder — fall back to the original non-checkpointed path.
        # Pause/resume/branch won't be available for it, but it still runs and traces correctly.
        _log("[jaroku] no graph.builder — running without checkpoints (pause/branch disabled)")
        app.invoke(initial_state, config={"callbacks": [tracer], "recursion_limit": recursion_limit})
        return

    from langgraph.checkpoint.sqlite import SqliteSaver

    conn = sqlite3.connect(str(checkpoint_db_path(run_id)), check_same_thread=False)
    try:
        saver = SqliteSaver(conn)
        saver.setup()
        graph = builder.compile(checkpointer=saver, interrupt_after="*")
        config = {
            "configurable": {"thread_id": thread_id},
            "callbacks": [tracer],
            "recursion_limit": recursion_limit,
        }

        # Stream loop: run to the next node boundary (interrupt), then continue from the durable
        # checkpoint. `next == ()` means the graph reached END — the run is complete.
        graph_input: Any = initial_state
        while True:
            for _ in graph.stream(graph_input, config, stream_mode="updates"):
                pass
            graph_input = None  # subsequent iterations resume from the checkpoint
            snapshot = graph.get_state(config)
            if not snapshot.next:
                break
    finally:
        conn.close()
