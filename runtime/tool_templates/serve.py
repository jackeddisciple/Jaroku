"""Reviewed serve wrapper — runs an agent project as a long-lived HTTP service.

Copied byte-for-byte into a project as ``serve.py`` when it is deployed, exactly like a
connector template. Never written by a model, never editable by the fix loop.

    python -m <agent_id>.serve        (cwd: the directory CONTAINING the project)

This file exists because the agent contract already describes a request handler and nothing
was calling it in a loop::

    build_initial_state(text) -> state -> graph.invoke(state) -> answer

``jaroku_runner`` does exactly that once and exits. So a deployed agent needs no new contract
symbol, no change to agent.py, and no regeneration — it needs a caller that loops. That is all
this is.

Two properties it holds to, and both are load-bearing:

  * **It imports nothing from Jaroku.** The whole promise of a generated project is that you
    can copy it out of the repo and run it yourself. Importing ``jaroku_runner.models`` for the
    twelve lines of provider selection below would quietly end that, so those twelve lines are
    duplicated instead. A deployed image contains your agent and its dependencies. Nothing else.

  * **It adds no dependency.** Everything here is the standard library. LangGraph invocation is
    blocking, so a threading server is the right shape, and a project's dependency closure is
    unchanged by being deployable.

It does two things a *generated* file may not, and both are the point:

  * It constructs the model. Rule 2 forbids ``agent.py`` from doing that precisely so the model
    can be injected — this is the injection point.
  * It writes to stdout. Rule 3 protects the NDJSON trace stream, and out here there is no
    trace stream: stdout is the deployment's log pane, which is where logs belong.

No trace events are emitted. Production trace streaming is a separate layer; shipping the
interceptor inside the image would break the first property above to get it.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# A deployed agent answers a public URL and spends a real API key on every request, so the
# defaults here fail closed rather than open.
DEFAULT_PORT = 8080
DEFAULT_CONCURRENCY = 4
MAX_BODY_BYTES = 64 * 1024

DEFAULT_MODELS = {"anthropic": "claude-haiku-4-5", "openai": "gpt-4o-mini"}


def log(*args) -> None:
    """Human-facing logging. stdout, because out here that is the log pane."""
    print(*args, flush=True)


# --- the agent -------------------------------------------------------------------------


def _load_agent():
    """Import the sibling agent module — the project this file was copied into.

    A relative import, so the project is reached as a package exactly the way it already
    reaches its own ``prompts`` and ``tools`` sub-packages. Nothing is resolved by path or by
    agent id, so this file is identical in every project.
    """
    from . import agent as agent_module

    missing = [
        name
        for name in ("TOOLS", "build_graph", "build_initial_state")
        if getattr(agent_module, name, None) is None
    ]
    if missing:
        raise RuntimeError(
            f"agent.py does not satisfy the agent contract; missing: {', '.join(missing)}"
        )
    return agent_module


def _build_model(tools):
    """The provider selection from jaroku_runner/models.py, duplicated rather than imported.

    Importing it would make a deployed project depend on Jaroku, which is the one thing a
    generated project is promised never to do. The cost is twelve lines that must be kept in
    step by hand; the alternative costs the promise.

    The dry-run provider is deliberately absent. It is a local smoke test that answers with
    placeholder text, and deploying it would put a URL on the internet that looks like a
    working agent and is not.
    """
    provider = (os.environ.get("JAROKU_PROVIDER") or "").strip().lower()
    if provider not in DEFAULT_MODELS:
        raise RuntimeError(
            f"JAROKU_PROVIDER must be one of {sorted(DEFAULT_MODELS)} to serve"
            + (f", not {provider!r}" if provider else " (it is unset)")
            + ". The dry-run provider answers with placeholder text and cannot be deployed."
        )
    model_name = os.environ.get("JAROKU_MODEL") or DEFAULT_MODELS[provider]

    # No temperature/top_p: current Claude models reject them with a 400.
    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(model=model_name), provider, model_name

    from langchain_openai import ChatOpenAI

    return ChatOpenAI(model=model_name), provider, model_name


def _final_answer(state) -> str:
    """The reply a user would have seen, out of the graph's final state.

    Same rule the Jaroku eval judge scores on: the last assistant message. Getting it wrong is
    not a crash, it is confidently returning the wrong string — so when the rule finds nothing,
    this says so with an empty string rather than guessing at a tool result, and the caller
    still gets the whole final state alongside to read for itself.
    """
    if not isinstance(state, dict):
        return ""
    messages = state.get("messages")
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        if getattr(message, "type", None) not in ("ai", "assistant"):
            continue
        content = getattr(message, "content", None)
        if isinstance(content, str) and content.strip():
            return content.strip()
        # Anthropic-style content blocks: [{"type": "text", "text": "…"}, …]
        if isinstance(content, list):
            parts = [
                block["text"]
                for block in content
                if isinstance(block, dict) and isinstance(block.get("text"), str)
            ]
            joined = "".join(parts).strip()
            if joined:
                return joined
    return ""


def _jsonable(value):
    """Best-effort JSON for a LangGraph state. Never raises — a state that cannot be rendered
    is still a response worth sending, and the answer is carried separately anyway.

    LangChain messages get ``model_dump()`` rather than ``repr()``: a state field is worth
    reading programmatically, and a wall of ``AIMessage(content='…', additional_kwargs={}, …)``
    is not. Falling back to ``repr`` only for objects that offer nothing better.
    """
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        pass
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        try:
            return _jsonable(dump())
        except Exception:  # noqa: BLE001 — a state field must never fail a response
            pass
    return repr(value)


# --- the service -----------------------------------------------------------------------


class AgentService:
    """One compiled graph, shared across requests, behind a bounded semaphore.

    The graph is built once at startup on purpose. Building it per request would rebind tools
    on every call for nothing, and — more usefully — a graph that cannot be built is a broken
    deployment, which should fail the container immediately and loudly rather than turning
    every request into a 500 forever.
    """

    def __init__(self, agent_id: str, concurrency: int) -> None:
        self.agent_id = agent_id
        module = _load_agent()
        self.llm, self.provider, self.model = _build_model(list(module.TOOLS))
        self.graph = module.build_graph(self.llm)
        self.build_initial_state = module.build_initial_state
        self.slots = threading.Semaphore(concurrency)
        self.concurrency = concurrency

    def run(self, user_input: str) -> dict:
        started = time.monotonic()
        final = self.graph.invoke(self.build_initial_state(user_input))
        return {
            "output": _final_answer(final),
            "state": _jsonable(final),
            "provider": self.provider,
            "model": self.model,
            "duration_ms": int((time.monotonic() - started) * 1000),
        }


class Handler(BaseHTTPRequestHandler):
    service: AgentService
    token: str | None

    protocol_version = "HTTP/1.1"
    server_version = "jaroku-serve"
    sys_version = ""

    # How long one client may hold a connection without finishing what it is saying.
    #
    # Without this a peer can open a socket, send half a request line, and keep a thread for
    # as long as it likes — no bytes, no cost, no timeout. A few dozen of those exhaust a
    # threaded server, and this one is on a public URL where anybody can open a socket. The
    # ceiling is generous because a legitimate slow uploader is a real thing, and finite
    # because an illegitimate one is too.
    timeout = float(os.environ.get("JAROKU_SERVE_TIMEOUT_S") or 30)

    # --- plumbing ---

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _refuse(self, code: int, payload: dict) -> None:
        """Answer without having read the request body, and end the connection.

        Under HTTP/1.1 a connection is a stream of framed messages, so a body left unread is
        not discarded — it stays in the socket and the server parses it as the NEXT request
        line. Refusing an oversized body produced exactly that: the client got a connection
        reset instead of the 413, and a following request came back as `414 Request-URI Too
        Long` made of its own JSON. Saying `Connection: close` is the honest framing when the
        rest of the message is not going to be consumed.
        """
        self.close_connection = True
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def handle_one_request(self) -> None:
        """Turn a stalled connection into a closed one instead of an exception on stderr.

        socketserver arms self.timeout on the socket, so a client that stops mid-request
        raises here. The base class would let it escape as a traceback; the connection is
        simply over, and that is not an error worth a stack trace on every port scan.
        """
        try:
            super().handle_one_request()
        except (TimeoutError, OSError):
            self.close_connection = True

    def log_message(self, fmt: str, *args) -> None:
        # BaseHTTPRequestHandler logs to stderr by default and includes the request line.
        # Route it to stdout with the rest of the service's output, and keep it one line.
        log(f"[serve] {self.address_string()} {fmt % args}")

    def _authorised(self) -> bool:
        """Constant-time bearer check.

        compare_digest rather than ==, because a plain comparison on a secret leaks its
        prefix through timing, and this endpoint is reachable by anyone who finds the URL.
        """
        if self.token is None:
            return True  # explicitly public; main() already said so loudly
        header = self.headers.get("Authorization", "")
        scheme, _, presented = header.partition(" ")
        if scheme.lower() != "bearer" or not presented:
            return False
        return secrets.compare_digest(presented, self.token)

    # --- routes ---

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's spelling
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path == "/health":
            # Unauthenticated on purpose: it reveals nothing, and a health check that needs a
            # credential is a health check the platform cannot make.
            self._send(200, {"ok": True, "agent": self.service.agent_id})
        elif path == "/":
            self._send(
                200,
                {
                    "agent": self.service.agent_id,
                    "provider": self.service.provider,
                    "model": self.service.model,
                    "endpoints": {
                        "GET /health": "liveness",
                        "POST /run": '{"input": "..."} -> {"output", "state", "duration_ms"}',
                    },
                },
            )
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0].rstrip("/") != "/run":
            self._send(404, {"error": "not found"})
            return

        # The body is framed BEFORE anything else is decided. Content-Length is the only
        # honest way to know where this message ends, and a refusal issued without consuming
        # the message corrupts every request behind it on the same connection.
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length < 0:
                raise ValueError
        except ValueError:
            # Unparseable framing: there is no safe number of bytes to skip, so end here.
            self._refuse(400, {"error": "invalid Content-Length"})
            return
        if length > MAX_BODY_BYTES:
            # Refused on the header, so an oversized body is never buffered. The connection
            # goes with it — draining megabytes to be polite is the attack, not the fix.
            self._refuse(413, {"error": f"request body over {MAX_BODY_BYTES} bytes"})
            return

        # Read before authorising. It looks backwards and is not: the body is already bounded
        # to MAX_BODY_BYTES above, so this is a bounded read from an unauthenticated peer —
        # and consuming it is what lets the 401 below be an ordinary answer on a connection
        # the client can keep using, rather than a desync.
        try:
            raw = self.rfile.read(length) if length else b""
        except OSError:
            self._refuse(408, {"error": "timed out reading the request body"})
            return
        if len(raw) < length:
            self._refuse(400, {"error": "the request body was shorter than Content-Length"})
            return

        if not self._authorised():
            # No detail: which half of a credential was wrong is not the caller's business.
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Bearer realm="jaroku"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        try:
            payload = json.loads(raw or b"{}")
        except (ValueError, UnicodeDecodeError):
            self._send(400, {"error": "body must be JSON"})
            return
        user_input = payload.get("input") if isinstance(payload, dict) else None
        if not isinstance(user_input, str) or not user_input.strip():
            self._send(400, {"error": 'expected {"input": "<text>"}'})
            return

        # A public URL must not be able to fan out unbounded model calls. Refusing is the
        # honest answer; queueing would just hide the same spend behind a longer wait.
        if not self.service.slots.acquire(blocking=False):
            self.send_response(429)
            self.send_header("Retry-After", "5")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        try:
            self._send(200, self.service.run(user_input))
        except Exception as exc:  # noqa: BLE001 — an agent failure is a 500, not a crash
            # The type and message, and the traceback to the log. A deployed agent's failures
            # are the operator's to read; they are not for whoever called the URL.
            log(f"[serve] run failed: {type(exc).__name__}: {exc}")
            traceback.print_exc(file=sys.stdout)
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})
        finally:
            self.service.slots.release()


# --- entrypoint ------------------------------------------------------------------------


def _int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        log(f"[serve] {name}={raw!r} is not a number — using {default}")
        return default


def _resolve_token() -> str | None:
    """The bearer token, or None if the operator explicitly asked for a public endpoint.

    Fails closed. An unauthenticated agent URL is an unmetered way to spend somebody else's
    API key, so an unset token is a startup error, not a default.
    """
    token = (os.environ.get("JAROKU_SERVE_TOKEN") or "").strip()
    if token:
        return token
    if (os.environ.get("JAROKU_SERVE_PUBLIC") or "").strip() == "1":
        log(
            "[serve] WARNING: JAROKU_SERVE_PUBLIC=1 — /run is unauthenticated. Anyone who "
            "finds this URL can run this agent on your provider key."
        )
        return None
    raise RuntimeError(
        "JAROKU_SERVE_TOKEN is not set. /run spends a real API key on every request, so it "
        "will not be served without one. Set it, or set JAROKU_SERVE_PUBLIC=1 to say out loud "
        "that this endpoint is open."
    )


def main() -> int:
    # The package this file was copied into IS the agent id (see contract.py's regex — it is
    # always a valid Python package name), so nothing has to be passed in. Last segment only:
    # in a container the project is imported as `<agent_id>`, but run from the Jaroku checkout
    # it is `agents.<agent_id>`, and the id is the part that means something either way.
    agent_id = (__package__ or "agent").rpartition(".")[2]
    port = _int_env("PORT", DEFAULT_PORT)
    concurrency = max(1, _int_env("JAROKU_SERVE_CONCURRENCY", DEFAULT_CONCURRENCY))

    try:
        token = _resolve_token()
        service = AgentService(agent_id, concurrency)
    except Exception as exc:  # noqa: BLE001
        # Fail the container, loudly. A process that starts and then 500s on every request is
        # a deployment that looks healthy and is not.
        log(f"[serve] cannot start: {type(exc).__name__}: {exc}")
        traceback.print_exc(file=sys.stdout)
        return 1

    Handler.service = service
    Handler.token = token

    # 0.0.0.0, and this is the one place in Jaroku that means it: a deployed service bound to
    # localhost is a service nothing can reach. The bearer token above is what makes that safe.
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    log(
        f"[serve] {agent_id} on :{port} · {service.provider}/{service.model} · "
        f"{concurrency} concurrent · auth {'on' if token else 'OFF'}"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
