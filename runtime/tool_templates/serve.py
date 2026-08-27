"""Reviewed serve wrapper — an agent project's HTTP front onto the Jaroku runner.

Copied byte-for-byte into a project as ``serve.py`` when it is deployed, exactly like a
connector template. Never written by a model, never editable by the fix loop.

    python -m <agent_id>.serve        (cwd: the directory CONTAINING the project)

WHAT THIS FILE IS. It accepts a request, starts ``python -m jaroku_runner <agent_id>`` for it,
and answers while that run is still going. It does not select a provider, does not build a
model, and does not invoke the graph — every one of those belongs to the runner, and it is the
same runner a local run, an eval job and a sandboxed run already go through. The README states
the principle about evals: "there is deliberately no second way to execute an agent". This file
was that second way, and this is the file that stops being it.

THIS HEADER USED TO CLAIM TWO THINGS THAT ARE NOW FALSE. They are named rather than deleted,
because both were load-bearing arguments and both were reversed deliberately:

  * **"It imports nothing from Jaroku."** The image now ships ``jaroku_interceptor`` and
    ``jaroku_runner`` beside the project, and this file starts the runner. The promise that was
    actually being defended is about the GENERATED PROJECT, not the image: ``agent.py`` still
    imports nothing named jaroku, the validator still rejects it if it tries, and the contract
    is still three symbols. The image is a different boundary and this repository already drew
    it — runtime/sandbox/Dockerfile's header says plainly that what lives in an image is code
    Jaroku wrote and reviewed. ``serve.py`` and ``mcp_bridge.py`` were already inside that
    boundary; two more reviewed modules is the same decision, made again.

  * **"No trace events are emitted."** A deployed run now emits an ordinary schema-v1 trace —
    same kinds, same step types, same ordering as the identical agent run locally — pushed to
    the control plane by the runner itself. Nothing about it is deploy-shaped.

AND THE ONE THAT IS STILL TRUE, because it is what keeps a copied-out project standalone:
everything here is the standard library, and the run this starts reports to nobody unless it is
told where to. ``controlplane_http.py`` no-ops unless both ``JAROKU_CONTROL_PLANE_URL`` and
``JAROKU_RUN_TOKEN`` are set, and those arrive per request, from Jaroku, in the body of
``POST /run``. Copy this directory out, run it yourself, and it answers with nobody watching —
the same way the absence of ``JAROKU_CONTROL_DIR`` already tells a project that.

THE RUNNER IS A SUBPROCESS, NOT AN IMPORT, and that is not incidental. ``guard.py`` dups fd 1
as the event stream and repoints fd 1 at stderr before any generated code is imported —
irreversibly, by design. Out here fd 1 is the deployment's log pane. In one process those two
ideas collide and the log pane becomes the trace stream; in two they cannot. It is also what
makes one job's module-level state its own, which is what stops an MCP "allow for this run"
grant reaching the next request this container serves.

It still does one thing a *generated* file may not, and it is still the point: it writes to
stdout. Rule 3 protects the NDJSON trace stream, and out here that stream is a child process's
private fd — stdout is the deployment's log pane, which is where logs belong.
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# A deployed agent answers a public URL and spends a real API key on every request, so the
# defaults here fail closed rather than open.
DEFAULT_PORT = 8080
DEFAULT_CONCURRENCY = 4
MAX_BODY_BYTES = 64 * 1024

#: What a deployed agent may run on.
#:
#: The dry-run provider is deliberately absent, and the reason is unchanged from when this file
#: selected the model itself: it answers with placeholder text, so deploying it would put a URL
#: on the internet that looks like a working agent and is not. The runner would happily accept
#: it — this is the deploy layer declining to ask for it.
DEPLOYABLE_PROVIDERS = ("anthropic", "openai")

#: The project directory this file was copied into. Resolved from ``__file__`` rather than from
#: the agent id or the working directory, so it is the same expression in a container
#: (``/app/<agent_id>/``) and in the Jaroku checkout (``runtime/agents/<agent_id>/``).
PROJECT_DIR = Path(__file__).resolve().parent

#: Where a deploy vendors Jaroku's own reviewed packages inside the project.
#:
#: THE SAME STRING server/src/dockerfile.ts SPELLS, and the coupling is real: the deploy writes
#: the directory and this reads it. It is asserted across the two languages rather than trusted,
#: the same way the runtime's confirmation phrases are asserted against mcp_bridge.py's source —
#: a rename on one side alone produces an image that builds, starts, answers /health, and cannot
#: import the runner, which is a failure with no line of either file to look at.
VENDORED_RUNTIME_DIR = ".jaroku"


def log(*args) -> None:
    """Human-facing logging. stdout, because out here that is the log pane."""
    print(*args, flush=True)


def _now_iso() -> str:
    """UTC, to the second, with a Z — the same spelling the trace schema uses everywhere else.

    Built from ``time`` rather than ``datetime.now(timezone.utc)`` for no reason beyond keeping
    this file's imports as short as they already are; both produce the same string.
    """
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _num_env(name: str, default: float) -> float:
    """A positive number from the environment, or the default.

    Falls back rather than raising, and that matters most where it is used: the connection
    timeout is read in a class body, so a typo in it did not produce a bad timeout — it raised
    ValueError while the module was being imported, and the container never started at all. A
    configuration typo should cost you the setting, not the service.

    Zero and negatives fall back too. A timeout of zero is not a fast timeout, it is a broken
    one, and it fails in the silent direction.
    """
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        log(f"[serve] {name}={raw!r} is not a number — using {default}")
        return default
    if value <= 0:
        log(f"[serve] {name}={raw!r} is not positive — using {default}")
        return default
    return value


def _int_env(name: str, default: int) -> int:
    return int(_num_env(name, default))


# --- the agent -------------------------------------------------------------------------


def _check_contract():
    """Import the sibling agent module and prove it is runnable, at startup, once.

    A relative import, so the project is reached as a package exactly the way it already
    reaches its own ``prompts`` and ``tools`` sub-packages. Nothing is resolved by path or by
    agent id, so this file is identical in every project.

    WHY THIS STILL HAPPENS HERE, when the runner will import the same module again in its own
    process a moment later and check the same three symbols with a better error message. A
    container that starts and then 500s on every request is a deployment that looks healthy and
    is not, and the two things most likely to be wrong — a syntax error and a missing contract
    symbol — are both knowable before a single request arrives. Paying one import at boot to
    turn "every run fails mysteriously" into "the container refuses to start, here is why" is
    the same trade the graph build used to make.

    WHAT IT NO LONGER DOES IS BUILD THE GRAPH, because building one needs a model and this file
    does not construct models any more. That is a real reduction in what boot proves: a
    ``build_graph`` that raises is now found by the first run rather than at startup. It surfaces
    as an errored run with the exception on its trace, which is exactly what the same failure
    produces locally — and having one execution path means having its failure modes too.
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


def _resolve_provider() -> str:
    """The provider this deployment runs on, or a startup error.

    The refusal is what is left of ``_build_model`` after the model construction moved to the
    runner, and it is worth keeping in front rather than letting the runner decide: the runner's
    fallback for an unknown provider is the dry-run model, which answers with placeholder text.
    Out here that would be a public URL that looks like a working agent, forever, with every
    request succeeding.
    """
    provider = (os.environ.get("JAROKU_PROVIDER") or "").strip().lower()
    if provider not in DEPLOYABLE_PROVIDERS:
        raise RuntimeError(
            f"JAROKU_PROVIDER must be one of {sorted(DEPLOYABLE_PROVIDERS)} to serve"
            + (f", not {provider!r}" if provider else " (it is unset)")
            + ". The dry-run provider answers with placeholder text and cannot be deployed."
        )
    return provider


# --- the runner ------------------------------------------------------------------------


def _runner_search_path() -> str | None:
    """Where ``jaroku_runner`` lives for the child, or None to use whatever is already there.

    A deploy vendors the interceptor and the runner into ``<project>/.jaroku/`` and the image
    puts that on PYTHONPATH, so in a container this finds them and agrees with the Dockerfile.
    Run from the Jaroku checkout there is no vendored copy and the packages are already
    importable from ``runtime/``, so this answers None and changes nothing — which is what keeps
    ``python -m agents.<id>.serve`` working locally without a deploy having happened.
    """
    vendored = PROJECT_DIR / VENDORED_RUNTIME_DIR
    return str(vendored) if (vendored / "jaroku_runner").is_dir() else None


def _run_environment(
    run_id: str,
    provider: str,
    model: str | None,
    run_token: str | None,
    control_plane_url: str | None,
) -> dict:
    """The environment one run executes in.

    THE RUN TOKEN GOES IN HERE AND NOWHERE ELSE. Not into a log line, not into a response, not
    into any structure that outlives this call — the dict is built, handed to ``Popen``, and
    dropped. It is also deliberately not an argument: a process table is world-readable, which
    is the same reason the Railway CLI is never given its token on a command line.

    The user's input IS an argument, and that is a considered difference rather than an
    oversight. It is the runner's documented interface (``python -m jaroku_runner <id> "text"``),
    it is not a credential, and the process table it lands in belongs to this container alone.

    ``JAROKU_MCP_CONFIRM`` is forced to ``require`` when a control plane is configured, because
    that is the whole reason a confirmation can be answered at all out here: the bridge asks the
    control plane, a person answers, and the run continues. Without one it is left as the image
    set it, which is also ``require`` — nothing can ask, so nothing high-impact runs.
    """
    env = dict(os.environ)
    env["JAROKU_RUN_ID"] = run_id
    env["JAROKU_PROVIDER"] = provider
    if model:
        env["JAROKU_MODEL"] = model
    # The project, named by path rather than by import. `contract.load_agent` resolves this the
    # same way a sandboxed run does — see jaroku_runner/contract.py's agent_dir().
    env["JAROKU_AGENT_DIR"] = str(PROJECT_DIR)
    search = _runner_search_path()
    if search:
        existing = env.get("PYTHONPATH")
        env["PYTHONPATH"] = f"{search}{os.pathsep}{existing}" if existing else search

    # CONFIGURED, NEVER ASSUMED — controlplane_http.py's own contract, honoured from this side.
    # Both or neither: a URL with no token is a run whose every push is a 401, and a token with
    # no URL is a credential in an environment for no reason.
    if run_token and control_plane_url:
        env["JAROKU_RUN_TOKEN"] = run_token
        env["JAROKU_CONTROL_PLANE_URL"] = control_plane_url
        env["JAROKU_MCP_CONFIRM"] = "require"
    else:
        env.pop("JAROKU_RUN_TOKEN", None)
        env.pop("JAROKU_CONTROL_PLANE_URL", None)
    return env


def _pump_stderr(stream, run_id: str) -> None:
    """Forward the runner's stderr into this container's log pane, one line at a time.

    The runner logs to stderr on purpose (see jaroku_runner/__main__.py) and out here stderr is
    not where an operator looks — the log pane is stdout. Prefixed with the run id, because a
    container serves many runs at once and interleaved unlabelled lines are worse than none.
    """
    try:
        for raw in stream:
            line = raw.rstrip("\n")
            if line:
                log(f"[serve] {run_id[:8]} {line}")
    except (ValueError, OSError):
        # The pipe closed under us — the run is over, which is not an error worth a trace.
        pass


def _dump(payload: dict) -> bytes:
    """A response body, as UTF-8.

    ``ensure_ascii=False`` because the default escapes every non-ASCII character, and an agent
    that answers in Japanese was returning six bytes of ``\\uXXXX`` for each one — a response
    several times larger than the text it carried, unreadable in a terminal, and identical
    only after a decode step every client has to remember. The Content-Type already says
    UTF-8, which is what the escaping was standing in for.
    """
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


# --- the service -----------------------------------------------------------------------


class AgentService:
    """The container's view of its own agent: what it is, what it runs on, how many at once.

    IT NO LONGER HOLDS A GRAPH, and that is the change. A graph is a thing a run has, and a run
    now happens in its own process — so what is left here is the two facts every request needs
    (which agent, which provider) and the one bound that has to be enforced across all of them.

    The contract is still checked once at startup rather than per request, for the reason
    ``_check_contract`` gives: a container that starts and then fails every request is a
    deployment that looks healthy and is not.
    """

    def __init__(self, agent_id: str, concurrency: int) -> None:
        self.agent_id = agent_id
        _check_contract()
        self.provider = _resolve_provider()
        self.model = (os.environ.get("JAROKU_MODEL") or "").strip() or None
        # STILL BOUNDS RUNNING GRAPHS, NOT OPEN CONNECTIONS. A public URL must not be able to
        # fan out unbounded model calls, and that reasoning does not change because the work
        # moved into a subprocess — if anything it matters more, since each one is now a whole
        # interpreter with a LangGraph import in it.
        self.slots = threading.Semaphore(concurrency)
        self.concurrency = concurrency
        # THE RUNS THIS CONTAINER IS CURRENTLY EXECUTING, by id.
        #
        # Needed the moment POST /run stops waiting for its own run: nothing else holds the
        # process, so without this a started run is unreachable — nothing to wait on, nothing
        # to release a slot, and nothing for a later request to name. Guarded by a lock because
        # ThreadingHTTPServer means several requests genuinely are in here at once.
        self._live: dict[str, "subprocess.Popen[str]"] = {}
        self._lock = threading.Lock()

    def live_run_ids(self) -> list:
        with self._lock:
            return list(self._live)

    def _start(
        self,
        run_id: str,
        user_input: str,
        provider: str,
        model: str | None,
        run_token: str | None,
        control_plane_url: str | None,
    ) -> "subprocess.Popen[str]":
        """Start one run, as its own process, and return it without waiting.

        THE RUNNER IS A SUBPROCESS AND NOT AN IMPORT, and the module docstring says why at
        length: ``guard.py`` irreversibly repoints fd 1 at stderr before importing generated
        code, and out here fd 1 is the log pane. Two processes is what keeps the log pane and
        the event stream from being the same file descriptor.

        stdout is DISCARDED, deliberately. It carries the runner's NDJSON trace, which is read
        locally by a process manager holding the other end of a pipe — and there is no such
        process out here. The trace this run emits reaches Jaroku over HTTP, from inside the
        run, through ``controlplane_http``. A copied-out project with no control plane
        configured therefore produces no trace at all, which is correct: there is nobody to
        send it to, and buffering it in a container that will be recycled would be pretending
        otherwise.

        stderr is PUMPED, because it is the run's human log and the log pane is where an
        operator looks. A thread per run rather than a select loop: the ceiling on how many
        exist at once is the semaphore, which is four.
        """
        env = _run_environment(run_id, provider, model, run_token, control_plane_url)
        proc = subprocess.Popen(
            [sys.executable, "-m", "jaroku_runner", self.agent_id, user_input],
            # The directory CONTAINING the project, which is what makes `agents.<id>` resolvable
            # the way contract.py expects — the same cwd `python -m <agent_id>.serve` itself is
            # started from.
            cwd=str(PROJECT_DIR.parent),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        threading.Thread(
            target=_pump_stderr, args=(proc.stderr, run_id), daemon=True, name=f"log-{run_id[:8]}"
        ).start()
        return proc

    def dispatch(
        self,
        run_id: str,
        user_input: str,
        provider: str,
        model: str | None,
        run_token: str | None,
        control_plane_url: str | None,
    ) -> None:
        """Take a slot, start the run, and hand back immediately.

        THE SLOT IS TAKEN BY THE CALLER, NOT HERE — see do_POST. The 429 has to be decided
        before anything is started and answered on the request that asked, so the acquire is
        where the refusal is; this is the half that must eventually release it.

        RAISES IF THE RUN CANNOT BE STARTED, and the caller releases the slot and answers 500.
        That is the one failure that is genuinely the REQUEST's rather than the run's: nothing
        was accepted, no run exists, and no trace will ever mention it.
        """
        proc = self._start(run_id, user_input, provider, model, run_token, control_plane_url)
        with self._lock:
            self._live[run_id] = proc
        threading.Thread(
            target=self._reap, args=(run_id, proc), daemon=True, name=f"reap-{run_id[:8]}"
        ).start()

    def _reap(self, run_id: str, proc: "subprocess.Popen[str]") -> None:
        """Wait for one run, then release its slot and forget it.

        THE ONLY PLACE A SLOT IS RELEASED once a run has started, and it has to be somewhere
        like this: the request that took the slot returned a 202 seconds or minutes ago, so
        there is no `finally` on any request left to do it. A slot leaked here is permanent —
        the container answers 429 forever, healthy, with nothing running.

        So the wait is unconditional and the release is in a `finally`. `proc.wait()` on a
        process that has already exited returns immediately; on one that never exits, the
        container's own lifetime is the bound, which is the same bound a graph that never
        returns already had.
        """
        try:
            code = proc.wait()
            log(f"[serve] {run_id[:8]} run finished (exit {code})")
        except Exception as exc:  # noqa: BLE001 — a reaper that dies leaks a slot forever
            log(f"[serve] {run_id[:8]} could not be waited on: {type(exc).__name__}: {exc}")
        finally:
            with self._lock:
                self._live.pop(run_id, None)
            self.slots.release()


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
    timeout = _num_env("JAROKU_SERVE_TIMEOUT_S", 30)

    # --- plumbing ---

    def _send(self, code: int, payload: dict) -> None:
        body = _dump(payload)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
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
        body = _dump(payload)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
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
                    # One entry per route, each naming its auth and both ends of its shape.
                    # This document is the only description of this service anybody outside
                    # Jaroku gets, and "liveness" told a reader neither of those things. Every
                    # commit that moves a route moves its line here in the same commit — a
                    # header that lies is worse than no header, and so is an endpoint doc.
                    "endpoints": {
                        "GET /health": "no auth · -> {ok, agent}",
                        "GET /": "no auth · -> this document",
                        "POST /run": (
                            "bearer · {input, run_id?, run_token?, control_plane_url?, "
                            "provider?, model?} -> 202 {run_id, accepted_at} · returns "
                            "immediately; the run's outcome is on its trace"
                        ),
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
        if not isinstance(payload, dict):
            self._send(400, {"error": 'expected {"input": "<text>"}'})
            return
        user_input = payload.get("input")
        if not isinstance(user_input, str) or not user_input.strip():
            self._send(400, {"error": 'expected {"input": "<text>"}'})
            return

        # THE RUN ID COMES FROM JAROKU WHEN JAROKU IS ASKING. It mints one so it can address the
        # run — pause it, cancel it, read its trace — before the run has emitted anything at all;
        # a locally minted id would leave the caller holding nothing to name. A copied-out
        # project has nobody to mint one and gets a uuid here, which is the same fallback the
        # runner itself makes when JAROKU_RUN_ID is unset.
        run_id = payload.get("run_id")
        if not isinstance(run_id, str) or not run_id.strip():
            run_id = str(uuid.uuid4())
        run_id = run_id.strip()

        # CONFIGURED, NEVER ASSUMED, and per request rather than per container. The token is
        # scoped to this one run and expires; the deployment holds nothing long-lived that
        # reaches Jaroku. Both fields or neither — see _run_environment.
        run_token = payload.get("run_token")
        control_plane_url = payload.get("control_plane_url")
        run_token = run_token.strip() if isinstance(run_token, str) and run_token.strip() else None
        control_plane_url = (
            control_plane_url.strip()
            if isinstance(control_plane_url, str) and control_plane_url.strip()
            else None
        )

        # Per-request provider and model, defaulting to what the container was deployed with.
        # A dispatch may legitimately differ — the same agent evaluated on two providers is the
        # feature this product is built around — and refusing one that is not deployable is the
        # same refusal startup makes, applied to a value that arrived later.
        provider = payload.get("provider")
        provider = provider.strip().lower() if isinstance(provider, str) and provider.strip() else self.service.provider
        if provider not in DEPLOYABLE_PROVIDERS:
            self._send(400, {"error": f"provider must be one of {sorted(DEPLOYABLE_PROVIDERS)}"})
            return
        model = payload.get("model")
        model = model.strip() if isinstance(model, str) and model.strip() else self.service.model

        # A public URL must not be able to fan out unbounded model calls. Refusing is the
        # honest answer; queueing would just hide the same spend behind a longer wait.
        if not self.service.slots.acquire(blocking=False):
            self.send_response(429)
            self.send_header("Retry-After", "5")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        try:
            self.service.dispatch(run_id, user_input, provider, model, run_token, control_plane_url)
        except Exception as exc:  # noqa: BLE001 — a failure to START a run is a 500, not a crash
            # THE ONE FAILURE THAT IS STILL THE REQUEST'S. Nothing was accepted, no run exists,
            # and no trace will ever mention this — so it is answered here and the slot goes
            # back. Every failure AFTER this point belongs to the run and arrives as a run_end
            # with status "error", which is exactly what a local crash produces.
            self.service.slots.release()
            log(f"[serve] could not start a run: {type(exc).__name__}: {exc}")
            traceback.print_exc(file=sys.stdout)
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})
            return

        # 202, AND THIS IS THE CHANGE EVERYTHING DOWNSTREAM RESTS ON.
        #
        # The synchronous handler is why a job could not pause for a human, why a long run died
        # on an HTTP timeout, why cancel was impossible, and why a voice or phone surface could
        # never work — all four are the same fact wearing different clothes: the answer was the
        # graph's return value, so the request had to outlive the graph. It does not any more.
        # Accept, start, answer, and let the trace tell the story; Jaroku has always known how
        # to read one as it streams, because that is the one thing this product is built around.
        #
        # NO OUTPUT AND NO STATE. There is nothing honest to put there — the run has not
        # happened. The run id is what the caller needs, and it is the id JAROKU chose, so the
        # caller was already able to address this run before it asked.
        #
        # THE SLOT IS NOT RELEASED HERE. It belongs to the run now, and `_reap` gives it back
        # when the run ends. Releasing it on the response would make DEFAULT_CONCURRENCY bound
        # open connections instead of running graphs, which is exactly the bound it is not.
        self._send(202, {"run_id": run_id, "accepted_at": _now_iso()})


# --- entrypoint ------------------------------------------------------------------------


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
        f"[serve] {agent_id} on :{port} · {service.provider}/{service.model or 'default model'} · "
        f"{concurrency} concurrent · auth {'on' if token else 'OFF'}"
    )
    # Said at boot rather than discovered per run: if the runner is not importable, EVERY run
    # this container serves will fail, and it will fail in a child process whose stderr is a
    # line in a log pane. A container that cannot run its agent should say so while somebody is
    # still watching the deploy.
    search = _runner_search_path()
    log(f"[serve] runner from {search}" if search else "[serve] runner from the ambient PYTHONPATH")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
