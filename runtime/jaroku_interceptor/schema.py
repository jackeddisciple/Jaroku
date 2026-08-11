"""Frozen event schema (v1). Mirrors schema/events.md — keep the two in sync.

The interceptor builds ``Run``/``Step`` objects and serializes them into the transport
envelope: newline-delimited JSON on stdout, one event per line.
"""

from __future__ import annotations

import dataclasses
import json
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Literal, Optional

SCHEMA_VERSION = 1

RunStatus = Literal["running", "completed", "error"]
StepType = Literal["llm_call", "tool_call", "state_update", "router"]


def now_iso() -> str:
    """UTC ISO-8601 timestamp."""
    return datetime.now(timezone.utc).isoformat()


def _json_safe(value: Any) -> Any:
    """Best-effort convert arbitrary LangChain payloads to JSON-serializable data.

    Never raises: anything unserializable falls back to its ``repr``. The trace must
    never crash the agent it is observing.
    """
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(v) for v in value]
    # LangChain messages / pydantic models often expose these.
    for attr in ("model_dump", "dict", "to_json"):
        fn = getattr(value, attr, None)
        if callable(fn):
            try:
                return _json_safe(fn())
            except Exception:
                pass
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return repr(value)


@dataclass
class Run:
    id: str
    agent_id: str
    provider: str
    model: str
    status: RunStatus = "running"
    started_at: str = field(default_factory=now_iso)
    ended_at: Optional[str] = None
    cost: float = 0.0
    tokens: int = 0
    error: Optional[str] = None


@dataclass
class Step:
    id: str
    run_id: str
    seq: int
    type: StepType
    name: str
    input: Any = None
    output: Any = None
    state_before: Any = None
    state_after: Any = None
    tokens: Optional[int] = None
    cost: Optional[float] = None
    latency_ms: float = 0.0
    error: Optional[str] = None
    parent_step_id: Optional[str] = None
    started_at: str = field(default_factory=now_iso)


def _clean(obj: Any) -> dict:
    d = asdict(obj)
    # Sanitize the free-form payload fields.
    for k in ("input", "output", "state_before", "state_after"):
        if k in d:
            d[k] = _json_safe(d[k])
    return d


# The stream events are written to. ``None`` means "use whatever sys.stdout is now",
# which is the historical behaviour and what the hand-written test_agent relies on.
#
# The runner for *generated* agents cannot trust sys.stdout: generated tool code may
# print(), and one stray byte on the event stream corrupts the trace. It therefore dups
# the real fd 1, pins it here, and points sys.stdout at stderr — see
# jaroku_runner.guard.install_stdout_guard. The transport itself is unchanged: still one
# JSON object per line, still flushed per event.
_EVENT_STREAM = None

# An optional second destination for every envelope, ADDITIVE to the stream write above and
# never a replacement for it — see bind_trace_sink. None locally, where there is nobody hosted
# to push to. This module stays dependency-free of jaroku_runner on purpose: the hand-written
# test_agent imports jaroku_interceptor directly, with no runner and no control plane in the
# picture at all, so the wiring lives in jaroku_runner/__main__.py rather than being imported
# here.
_TRACE_SINK = None


def bind_event_stream(stream) -> None:
    """Pin event output to ``stream`` instead of the live ``sys.stdout``."""
    global _EVENT_STREAM
    _EVENT_STREAM = stream


def bind_trace_sink(sink) -> None:
    """Register a callable to receive every envelope AFTER it is written to the event stream.

    This is how a hosted run's trace reaches the control plane: stdout still carries the frozen
    NDJSON stream exactly as it always has (still readable locally, still what a copied-out
    project produces with no sink bound at all), and the sink is a second, best-effort delivery
    path on top — never instead of the write above.
    """
    global _TRACE_SINK
    _TRACE_SINK = sink


def emit(kind: str, payload_key: str, obj: Any) -> None:
    """Serialize one event as a single JSON line to the event stream, then flush.

    The event stream is reserved exclusively for events; keep all logging on stderr.
    """
    envelope = {"kind": kind, "schema_version": SCHEMA_VERSION, payload_key: _clean(obj)}
    out = _EVENT_STREAM if _EVENT_STREAM is not None else sys.stdout
    out.write(json.dumps(envelope, default=str) + "\n")
    out.flush()
    if _TRACE_SINK is not None:
        _TRACE_SINK(envelope)


def emit_run_start(run: Run) -> None:
    emit("run_start", "run", run)


def emit_step(step: Step) -> None:
    emit("step", "step", step)


def emit_run_end(run: Run) -> None:
    emit("run_end", "run", run)
