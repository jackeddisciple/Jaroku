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


def push_trace_event(envelope: dict) -> None:
    """Push one already-serialised trace envelope (the exact shape schema/events.md defines).

    Best-effort: a control-plane hiccup must not crash the run — the local stdout write already
    happened (see jaroku_interceptor/schema.py:emit, which calls this AFTER writing, never
    instead of), so the worst case is a gap in what the server ingested, not a corrupted or lost
    local record. Logged loudly on stderr rather than swallowed silently, though, since a run
    whose every push is failing needs that to be visible somewhere.
    """
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
    """Ask the control plane whether to pause. Returns "pause", "resume", or None (nothing to
    do, or the poll itself failed — a network hiccup must read as "keep going", the same fail-
    open-toward-progress choice the local file check makes by simply not existing yet)."""
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
    return action if action in ("pause", "resume") else None


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
