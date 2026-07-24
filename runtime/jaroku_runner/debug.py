"""Checkpointed execution driver — the foundation for pause / inspect / resume + branching.

A generated agent's ``build_graph(llm)`` returns a bare compiled graph with no checkpointer, so a
plain ``app.invoke(...)`` leaves nothing to resume from. To make a run pausable and branchable we
recompile a *twin* from the same ``StateGraph`` builder with a durable ``SqliteSaver`` and
``interrupt_after="*"`` (a checkpoint after every node), then drive it with a stream loop instead
of a single invoke.

Load-bearing guarantee: the trace the ``JarokuTracer`` emits from this path is IDENTICAL to a
plain ``.invoke()`` — same nodes, same callbacks, same ``seq`` — because the interrupt only hands
control back to this loop between nodes and never re-runs a completed node. What changes is that
every node boundary now leaves a durable checkpoint on disk.

Control plane (all off the frozen stdout trace stream):
  * runner -> server: one ``@@JAROKU_CTRL@@ {json}`` line per boundary on **stderr** (seq_high +
    checkpoint_id + next nodes), which the server maps to steps and uses to place a "paused"
    marker. stdout stays pure schema-v1 NDJSON.
  * server -> runner: a per-run ``<run_id>.control`` file the runner reads at each boundary;
    ``pause`` makes it stop AT the boundary (checkpoint durable) and exit without a run_end.

Checkpoints and control files live under ``runtime/.checkpoints/`` (gitignored).
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

# runtime/.checkpoints/ — sibling of jaroku_runner/, alongside .staging/ and .history/.
CHECKPOINT_DIR = Path(__file__).resolve().parent.parent / ".checkpoints"

# stderr sentinel for runner -> server control events (never on stdout / the trace stream).
CTRL_SENTINEL = "@@JAROKU_CTRL@@ "


def _log(*args: Any) -> None:
    print(*args, file=sys.stderr, flush=True)


def checkpoint_db_path(run_id: str) -> Path:
    CHECKPOINT_DIR.mkdir(exist_ok=True)
    return CHECKPOINT_DIR / f"{run_id}.sqlite"


def control_path(run_id: str) -> Path:
    return CHECKPOINT_DIR / f"{run_id}.control"


def emit_ctrl(obj: dict) -> None:
    """One control line on stderr, prefixed so the server can separate it from real logs."""
    print(CTRL_SENTINEL + json.dumps(obj), file=sys.stderr, flush=True)


def _pause_requested(run_id: str) -> bool:
    p = control_path(run_id)
    try:
        return p.exists() and p.read_text().strip() == "pause"
    except OSError:
        return False


def run_with_checkpoints(
    app: Any,
    initial_state: Any,
    *,
    run_id: str,
    thread_id: str,
    tracer: Any,
    recursion_limit: int = 25,
    resume: bool = False,
) -> str:
    """Drive a checkpointed twin of ``app`` one node at a time.

    Returns ``"completed"`` when the graph reaches END, or ``"paused"`` when a pause was requested
    and honoured at a node boundary (the checkpoint is durable; the caller must NOT emit run_end).
    Any agent exception propagates to the caller (recorded as the run's error).

    ``resume=True`` continues an existing thread from its last durable checkpoint (input is None);
    ``thread_id`` selects the checkpoint thread (== ``run_id`` for a fresh run or a resume of it).
    """
    builder = getattr(app, "builder", None)
    if builder is None:
        # Exotic graph with no exposed builder — fall back to the original non-checkpointed path.
        if resume:
            raise RuntimeError("cannot resume: graph exposes no builder/checkpointer")
        _log("[jaroku] no graph.builder — running without checkpoints (pause/branch disabled)")
        app.invoke(initial_state, config={"callbacks": [tracer], "recursion_limit": recursion_limit})
        return "completed"

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

        # Optional per-boundary delay (ms) so a live run is slow enough to pause from the UI.
        # Off by default; purely a debug aid, like test_agent's JAROKU_DELAY_MS.
        step_delay_s = float(os.environ.get("JAROKU_STEP_DELAY_MS", "0") or "0") / 1000.0

        # Fresh run seeds the graph with the initial state; a resume continues from the checkpoint.
        graph_input: Any = None if resume else initial_state
        while True:
            for _ in graph.stream(graph_input, config, stream_mode="updates"):
                pass
            graph_input = None  # subsequent iterations resume from the checkpoint
            if step_delay_s:
                time.sleep(step_delay_s)

            snapshot = graph.get_state(config)
            checkpoint_id = snapshot.config.get("configurable", {}).get("checkpoint_id")
            # seq_high = the highest seq the tracer has assigned so far == this boundary's last step.
            seq_high = tracer._seq - 1
            emit_ctrl({
                "ctrl": "boundary", "run_id": run_id, "seq_high": seq_high,
                "checkpoint_id": checkpoint_id, "next": list(snapshot.next),
            })

            if not snapshot.next:
                return "completed"
            if _pause_requested(run_id):
                emit_ctrl({
                    "ctrl": "paused", "run_id": run_id, "seq_high": seq_high,
                    "checkpoint_id": checkpoint_id, "next": list(snapshot.next),
                })
                return "paused"
    finally:
        conn.close()
