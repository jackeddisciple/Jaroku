"""The runner's HTTP client for a hosted control plane — the transport a sandboxed run uses in
place of the local pipe and control file, when one is configured.

WHY THIS EXISTS. Locally, `processManager.ts` reads this process's stdout directly and the pause
control file lives on a disk both processes share. Neither survives a hosted run: the sandbox has
no shared disk, and there is nobody local reading its stdout pipe. So a hosted run instead PUSHES
what it observes — trace events, control lines — to `POST /v1/runs/<id>/trace` and
`POST /v1/runs/<id>/control` (server/src/sandbox/controlPlaneRoutes.ts), and PULLS what to do next
from `GET /v1/runs/<id>/control`, a bounded poll rather than a blocking wait — see
``poll_control``'s own note on why the boundary check stays short even though the server's own
long-poll can hold a connection open for up to 25 seconds.

CONFIGURED, NEVER ASSUMED. Both ``JAROKU_CONTROL_PLANE_URL`` and ``JAROKU_RUN_TOKEN`` must be
set, or this module treats itself as unconfigured and every function below is a safe no-op —
which is exactly the local path (nothing sets either variable) and exactly the copied-out project
this README promises works standalone. Nothing here changes local behaviour by one byte.

Stdlib only, deliberately: ``urllib.request``, same as ``serve.py``. This module ships inside the
sandbox image (sandbox/Dockerfile), and a dependency here is a dependency every hosted run pays
for on every cold start.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any

CONTROL_PLANE_URL_ENV = "JAROKU_CONTROL_PLANE_URL"
RUN_TOKEN_ENV = "JAROKU_RUN_TOKEN"

# The boundary pause-check happens once per node, in the middle of the run loop — it must not
# turn a fast multi-node graph into a run that waits up to 25s at every single boundary just to
# find out nothing changed. A short, effectively-instant timeout here preserves the local file
# check's near-zero latency; the server's own long-poll budget (up to 25s) is there for it to use
# when a caller DOES want to hold the connection open, which this call deliberately does not.
BOUNDARY_POLL_TIMEOUT_S = 2.0

# The wall-clock ceiling on a push — a slow control plane must not stall the run indefinitely.
PUSH_TIMEOUT_S = 10.0


def _log(*args: Any) -> None:
    print("[controlplane_http]", *args, file=sys.stderr, flush=True)


def configured() -> bool:
    """Whether a hosted control plane is present. Everything else in this module is a no-op
    when this is False, which is the whole of how the local path stays unaffected."""
    return bool(os.environ.get(CONTROL_PLANE_URL_ENV)) and bool(os.environ.get(RUN_TOKEN_ENV))


def _base_url() -> str:
    return os.environ[CONTROL_PLANE_URL_ENV].rstrip("/")


def _run_id() -> str:
    run_id = os.environ.get("JAROKU_RUN_ID")
    if not run_id:
        raise RuntimeError("a control plane is configured but JAROKU_RUN_ID is not set")
    return run_id


def _request(method: str, path: str, body: dict | None, timeout_s: float) -> dict:
    url = f"{_base_url()}{path}"
    headers = {"authorization": f"Bearer {os.environ[RUN_TOKEN_ENV]}"}
    # No body at all for a bodyless call (the long-poll GET) rather than an empty JSON object —
    # a GET carrying a Content-Length is legal HTTP but an unforced edge case neither side needs
    # to exercise, and the four routes this client speaks to never expect one on GET.
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310 - fixed https scheme, run-scoped token
        raw = resp.read()
        return json.loads(raw) if raw else {}


# Batched the same way the WORKER side of ingestion is (server/src/sandbox — "50 steps or 100ms,
# whichever comes first"): one HTTP POST per event would mean a step-heavy run paying a full
# round trip for every LLM call, tool call and state update it makes. A run emits one event at a
# time, synchronously, so batching here is "buffer until a threshold, flush inline on the next
# call that crosses it" rather than a background thread — simpler, and correct because
# jaroku_interceptor.schema.emit already calls this once per event in order.
_TRACE_BATCH_MAX = 50
_TRACE_BATCH_WINDOW_S = 0.1
_trace_buffer: list[dict] = []
_trace_buffer_opened_at: float | None = None


def queue_trace_event(envelope: dict) -> None:
    """Buffer one trace envelope, flushing the batch once it is 50 events or 100ms old.

    Best-effort throughout: a control-plane hiccup must not crash the run — the local stdout
    write already happened (see jaroku_interceptor/schema.py:emit, which calls this AFTER
    writing, never instead of), so the worst case of a failed flush is a gap in what the server
    ingested, not a corrupted or lost local record.
    """
    global _trace_buffer_opened_at
    if not configured():
        return
    _trace_buffer.append(envelope)
    if _trace_buffer_opened_at is None:
        _trace_buffer_opened_at = time.monotonic()
    if len(_trace_buffer) >= _TRACE_BATCH_MAX or (time.monotonic() - _trace_buffer_opened_at) >= _TRACE_BATCH_WINDOW_S:
        flush_trace_events()


def flush_trace_events() -> None:
    """Send whatever is buffered right now, even a partial batch. Called on every threshold
    crossing above, and MUST also be called once at run end (see __main__.py's finally block) —
    otherwise a run whose last few events never cross a threshold loses them silently."""
    global _trace_buffer_opened_at
    if not _trace_buffer:
        return
    batch = _trace_buffer[:]
    _trace_buffer.clear()
    _trace_buffer_opened_at = None
    if not configured():
        return
    try:
        _request("POST", f"/v1/runs/{_run_id()}/trace", {"events": batch}, PUSH_TIMEOUT_S)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        _log(f"failed to push a batch of {len(batch)} trace event(s): {exc}")


def push_trace_event(envelope: dict) -> None:
    """Back-compat single-event push, unbatched. Kept because it is simpler to reason about in
    a test that pushes exactly one event and checks exactly one thing arrived — production code
    should use queue_trace_event, which is what jaroku_interceptor's sink is bound to."""
    if not configured():
        return
    try:
        _request("POST", f"/v1/runs/{_run_id()}/trace", {"events": [envelope]}, PUSH_TIMEOUT_S)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        _log(f"failed to push a trace event: {exc}")


def push_control_line(ctrl: dict) -> None:
    """Push one control line — the HTTP-transported twin of the `@@JAROKU_CTRL@@` stderr line
    debug.py and mcp_bridge.py already emit locally. Both still emit the stderr line too; this
    is additive, not a replacement — see the module docstring."""
    if not configured():
        return
    try:
        _request("POST", f"/v1/runs/{_run_id()}/control", {"ctrl": ctrl}, PUSH_TIMEOUT_S)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        _log(f"failed to push a control line: {exc}")


def poll_control(timeout_s: float = BOUNDARY_POLL_TIMEOUT_S) -> str | None:
    """Ask the control plane what to do next. Returns "pause", "resume", "cancel", or None
    (nothing to do, or the poll itself failed — a network hiccup must read as "keep going", the
    same fail-open-toward-progress choice the local file check makes by simply not existing yet).

    CANCEL FAILS OPEN TOWARD PROGRESS TOO, and that is deliberate rather than overlooked. A poll
    that could not reach the control plane knows nothing, and a run that stopped itself on a
    network hiccup would be a cancel nobody asked for — the run continues, the next boundary asks
    again, and the server's own reconciliation is the backstop if it never gets an answer."""
    if not configured():
        return None
    # The server is told to give up SLIGHTLY before this client's own socket timeout does. Told
    # the same number, the two race — and when the client wins that race it abandons a request
    # the server is still holding a waiter open for, so the very next signal can wake a dead
    # connection instead of queuing for the poll that actually follows. A margin makes the
    # server's own {"action":"none"} answer the common case instead of a client-side timeout.
    server_budget_ms = max(200, int(timeout_s * 1000) - 500)
    try:
        result = _request(
            "GET", f"/v1/runs/{_run_id()}/control?timeoutMs={server_budget_ms}", None, timeout_s
        )
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        _log(f"control poll failed, continuing: {exc}")
        return None
    action = result.get("action")
    return action if action in ("pause", "resume", "cancel") else None


def request_mcp_confirm(nonce: str, payload: dict, timeout_s: float) -> str:
    """Block until a human answers this run's MCP confirmation, or the server's own timeout
    denies it. Returns "run", "once" or "deny" — mcp_bridge.py treats anything else, including a
    request that failed outright, as "deny", exactly as it already treats an unreadable local
    approval file. Never raises for a network failure: the caller's own fallback IS denial."""
    body = {**payload, "nonce": nonce, "timeout_s": timeout_s}
    try:
        # A little slack over the server's own timeout, so the SERVER's denial-on-timeout is
        # what actually decides — the same margin mcp_bridge.py already gives its local poll
        # loop relative to CONFIRM_TIMEOUT_S.
        result = _request("POST", f"/v1/runs/{_run_id()}/mcp-confirm", body, timeout_s + 10)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        _log(f"mcp-confirm request failed, treating as denied: {exc}")
        return "deny"
    verdict = result.get("verdict")
    return verdict if verdict in ("run", "once", "deny") else "deny"
