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
    fork_from_checkpoint: str | None = None,
    edit_values: dict | None = None,
    edit_node: str | None = None,
) -> str:
    """Drive a checkpointed twin of ``app`` one node at a time.

    Returns ``"completed"`` when the graph reaches END, or ``"paused"`` when a pause was requested
    and honoured at a node boundary (the checkpoint is durable; the caller must NOT emit run_end).
    Any agent exception propagates to the caller (recorded as the run's error).

    Modes (mutually exclusive seeding):
      * fresh (default) — seed with ``initial_state``.
      * ``resume=True`` — continue an existing thread from its last durable checkpoint.
      * ``fork_from_checkpoint`` — a branch: re-enter at that specific checkpoint. With
        ``edit_values`` (a validated domain-field edit) applied via ``update_state`` first, the
        branch diverges from the parent; without it, it re-runs forward unchanged. The caller runs
        this against a COPY of the parent's checkpoint db (``run_id`` names the copy), so the
        parent's checkpoints are never touched. ``thread_id`` stays the parent's thread.
    """
    builder = getattr(app, "builder", None)
    if builder is None:
        if resume or fork_from_checkpoint:
            raise RuntimeError("cannot resume/branch: graph exposes no builder/checkpointer")
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

        # Seed the first stream call per mode. A no-edit fork re-enters AT the chosen checkpoint;
        # an edited fork applies the validated edit (a new forked checkpoint) then continues from
        # the thread head; fresh seeds initial_state; resume continues from the last checkpoint.
        graph_input: Any = None if (resume or fork_from_checkpoint) else initial_state
        first_config = config
        if fork_from_checkpoint:
            # Pinning a specific checkpoint requires the checkpoint namespace alongside the id
            # (default ""); LangGraph reads configurable["checkpoint_ns"] on this path.
            fork_cfg = {
                "configurable": {
                    "thread_id": thread_id,
                    "checkpoint_ns": "",
                    "checkpoint_id": fork_from_checkpoint,
                },
            }
            if edit_values:
                # Apply the validated edit as a fork descending from the chosen checkpoint, then
                # continue from the resulting head (the returned config points at the new fork).
                updated = graph.update_state(fork_cfg, edit_values, as_node=edit_node)
                first_config = {**config, "configurable": {**updated["configurable"], "checkpoint_ns": ""}}
            else:
                first_config = {**config, **fork_cfg}

        stream_config = first_config
        while True:
            for _ in graph.stream(graph_input, stream_config, stream_mode="updates"):
                pass
            graph_input = None  # subsequent iterations resume from the checkpoint
            stream_config = config  # after the first call, always continue from the thread head
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
