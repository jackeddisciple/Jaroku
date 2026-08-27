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

WHERE THE CHECKPOINTS LIVE — two implementations, selected by ``JAROKU_CHECKPOINTER``.

``sqlite`` (the default) writes ``runtime/.checkpoints/<run_id>.sqlite``, exactly as it always
has: no database to stand up, no cloud account, and ``npm run dev`` unchanged.

``postgres`` writes to a real database through ``PostgresSaver``, because a file on one machine
cannot be resumed by a worker on another — which is the whole of Session 3. Three things about
that path are deliberate:

  * ITS OWN CONNECTION. LangGraph does not issue ``SET LOCAL app.workspace_id``, so it must not
    borrow a pool whose isolation depends on that. It opens its own, from
    ``JAROKU_CHECKPOINT_PG_URL``.

  * ITS OWN SCHEMA. ``langgraph``, set on the connection's search_path, so LangGraph's tables
    and its migrations live somewhere Jaroku's schema does not, and neither one's migration
    runner has an opinion about the other's tables.

  * THE WORKSPACE IN THE THREAD ID. ``ws:<workspace_id>:run:<run_id>``. Access is mediated
    entirely by Jaroku's code — there is no RLS in that schema — so the workspace has to be part
    of the key rather than a column somebody remembers to filter on. It also makes the sweep a
    prefix delete and makes a thread collision between two tenants impossible.

An exported project has neither variable set, gets the SQLite saver, and works standalone —
the same way the absence of ``JAROKU_CONTROL_DIR`` is how it knows nobody is watching.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from . import controlplane_http

# runtime/.checkpoints/ — sibling of jaroku_runner/, alongside .staging/ and .history/.
#
# OVERRIDABLE, AND THE DEPLOYED PATH IS WHY. This resolves relative to wherever the package
# lives, which is right locally and wrong in a container: a deploy vendors the runner INSIDE the
# agent project, so the default lands checkpoints under `<project>/.jaroku/.checkpoints/` — a
# directory inside the image's own writable layer, unbounded, and gone the moment Railway
# restarts the service. serve.py sets JAROKU_CHECKPOINT_DIR to somewhere it owns and can sweep,
# and that is the whole of the difference. An exported project sets nothing and is unchanged.
_CHECKPOINT_DIR_ENV = "JAROKU_CHECKPOINT_DIR"


def checkpoint_dir() -> Path:
    override = (os.environ.get(_CHECKPOINT_DIR_ENV) or "").strip()
    return Path(override) if override else Path(__file__).resolve().parent.parent / ".checkpoints"


#: Kept as a module attribute because the branch tooling on the Node side and the eval sweep both
#: reason about "the checkpoint directory" as a single place. Read through `checkpoint_dir()`
#: everywhere it matters, so an override applies; this stays the local answer.
CHECKPOINT_DIR = Path(__file__).resolve().parent.parent / ".checkpoints"

# stderr sentinel for runner -> server control events (never on stdout / the trace stream).
CTRL_SENTINEL = "@@JAROKU_CTRL@@ "


def _log(*args: Any) -> None:
    print(*args, file=sys.stderr, flush=True)


def checkpoint_db_path(run_id: str) -> Path:
    directory = checkpoint_dir()
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{run_id}.sqlite"


# The schema LangGraph's tables live in on the Postgres path. Jaroku owns the schema and the
# grant; LangGraph owns everything inside it and creates it with its own setup().
CHECKPOINT_SCHEMA = "langgraph"


def checkpointer_kind() -> str:
    """``sqlite`` or ``postgres``. Anything else is a configuration error, not a fallback."""
    kind = (os.environ.get("JAROKU_CHECKPOINTER") or "sqlite").strip().lower()
    if kind not in ("sqlite", "postgres"):
        raise RuntimeError(
            f'JAROKU_CHECKPOINTER must be "sqlite" or "postgres", not "{kind}". Falling back '
            f"would run with checkpoints nobody can find."
        )
    return kind


def thread_id_for(run_id: str, workspace_id: str | None = None) -> str:
    """The checkpoint thread a run writes to.

    ``ws:<workspace_id>:run:<run_id>`` on the Postgres checkpointer, and the bare run id on
    SQLite — the same rule the Node side computes in checkpoints/threads.ts, which is where the
    long version of why lives.

    The short version: on Postgres every tenant's threads share one table in a schema with no
    row-level security, so the workspace has to be part of the key. On SQLite it is one file per
    run, which is already a namespace — and prefixing there would break a branch from any run
    checkpointed before this session, for nothing.

    A copied-out project has no workspace and gets the bare form either way, which is what keeps
    an exported project standalone.
    """
    ws = workspace_id or os.environ.get("JAROKU_WORKSPACE_ID") or ""
    if not ws or checkpointer_kind() == "sqlite":
        return run_id
    return f"ws:{ws}:run:{run_id}"


def control_path(run_id: str) -> Path:
    return checkpoint_dir() / f"{run_id}.control"


def emit_ctrl(obj: dict) -> None:
    """One control line on stderr, prefixed so the server can separate it from real logs.

    ALWAYS emitted, hosted or not — the stderr line is the local mechanism, still read by
    worker code even hosted (Fly's own log capture, ADR-010's ctrl-plane-on-stderr design).
    Pushing it over HTTP too is additive: see controlplane_http's module docstring on why a
    hosted run pushes rather than being read from.
    """
    print(CTRL_SENTINEL + json.dumps(obj), file=sys.stderr, flush=True)
    controlplane_http.push_control_line(obj)


def _pause_requested(run_id: str) -> bool:
    """Whether the boundary just reached should stop and hold.

    Hosted, this is controlplane_http's short poll of GET /control — see that module's note on
    why the boundary check stays effectively instant rather than using the server's full 25s
    long-poll budget. Locally (the only case a copied-out project ever reaches, since neither
    JAROKU_CONTROL_PLANE_URL nor JAROKU_RUN_TOKEN exists outside Jaroku) this is unchanged: the
    control file's mere presence and content, nothing else.
    """
    if controlplane_http.configured():
        return controlplane_http.poll_control() == "pause"
    p = control_path(run_id)
    try:
        return p.exists() and p.read_text().strip() == "pause"
    except OSError:
        return False


@contextmanager
def _open_saver(run_id: str) -> Iterator[Any]:
    """The checkpointer for this run, opened and closed. See the module docstring for the choice.

    Both branches call ``setup()``, which is idempotent and creates whatever tables the saver
    needs. On the Postgres side that runs inside the ``langgraph`` schema, because the search
    path says so — LangGraph's migrations are LangGraph's, and they must not land beside
    Jaroku's tables where Jaroku's migration runner would then have an opinion about them.
    """
    kind = checkpointer_kind()
    if kind == "sqlite":
        from langgraph.checkpoint.sqlite import SqliteSaver

        conn = sqlite3.connect(str(checkpoint_db_path(run_id)), check_same_thread=False)
        try:
            saver = SqliteSaver(conn)
            saver.setup()
            yield saver
        finally:
            conn.close()
        return

    url = os.environ.get("JAROKU_CHECKPOINT_PG_URL") or ""
    if not url:
        raise RuntimeError(
            "JAROKU_CHECKPOINTER=postgres needs JAROKU_CHECKPOINT_PG_URL. It is deliberately "
            "NOT JAROKU_PG_URL: the checkpointer opens its own connection, because LangGraph "
            "never issues SET LOCAL app.workspace_id and must not borrow a pool whose isolation "
            "depends on it."
        )
    try:
        from langgraph.checkpoint.postgres import PostgresSaver
    except ImportError as exc:  # pragma: no cover - depends on the optional extra
        raise RuntimeError(
            "JAROKU_CHECKPOINTER=postgres needs the checkpoint extra. Install it with: "
            "uv sync --extra hosted"
        ) from exc

    # The schema is created here rather than by a Jaroku migration, and that is the same
    # separation as above: Jaroku's migration runner owns Jaroku's schema, and this owns the one
    # LangGraph's own setup() then fills. CREATE SCHEMA IF NOT EXISTS is idempotent and cheap.
    import psycopg

    with psycopg.connect(url, autocommit=True) as bootstrap:
        bootstrap.execute(f"CREATE SCHEMA IF NOT EXISTS {CHECKPOINT_SCHEMA}")

    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(f"SET search_path TO {CHECKPOINT_SCHEMA}")
        saver = PostgresSaver(conn)
        saver.setup()
        yield saver


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

    with _open_saver(run_id) as saver:
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
