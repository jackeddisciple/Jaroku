"""MCP bridge — calls tools on third-party MCP servers.

Reviewed template. Copied byte-for-byte into generated projects alongside a host-written
``mcp_tools.json``; the builder model is shown only the tool signatures and may not rewrite
either file.

WHY THIS FILE IS NOT WRITTEN BY A MODEL
---------------------------------------
Every other connector template wraps a service the user already trusts. This one wraps
whatever endpoint they pointed at, running code nobody here has read. That makes the wiring
around the call the *last* thing that should be model-authored: it is where the argument
check, the scope check, the timeout and (see the gate below) the human confirmation live. A
generated version of this file would put the only unreviewed thing in the path exactly where
the guarantees are supposed to be.

THE MANIFEST IS THE GRANT
-------------------------
``mcp_tools.json`` sits beside ``jaroku.json`` in the project root, is written by the host,
and is read-only to the edit loop. This module builds one tool per entry and offers no way to
reach anything else: no dynamic discovery, no name passed in from the agent, no "call
whatever the server offers now". If a server grows a ``delete_everything`` tool tomorrow, an
agent generated today still cannot call it, because it was never in the manifest.

That is what "least privilege" reduces to in practice. The finest grain MCP exposes is the
tool — there is no sub-tool scoping in the protocol — so the manifest scopes per tool and the
README says so rather than implying more.

NO NETWORK AT IMPORT
--------------------
Import reads one JSON file and builds tool objects. Nothing connects. This is load-bearing:
validation imports the staged project under a 20-second kill timer, and graph introspection
imports it again to read the topology. A module that dialled out at import time would make
both of those depend on a third party being awake.

THE FIRST-USE CONFIRMATION GATE
-------------------------------
A tool the manifest marks ``"impact": "high"`` stops before its FIRST call in a run and asks
the person watching. The mechanism is the one pause/resume already uses, deliberately: a
control line on stderr going out, an approval file coming back. stdout is the trace stream
and nothing else is ever written there.

A denial, or a timeout, RAISES — so a refused action lands as a red tool_call step the model
still sees as an error, rather than as silence. Timing out denies; it never allows.

Running OUTSIDE Jaroku (no host to ask) is the portability case the README promises, and it
is handled explicitly rather than by accident. See ``_confirm``.

Environment:
    JAROKU_MCP_<SERVER>_TOKEN      per-server credential, when the server needs one.
                                   Written by the host into runtime/.env; never logged.
    JAROKU_RUN_ID                  set by the host; its absence means nobody is watching.
    JAROKU_CONTROL_DIR             where approval files are exchanged with the host.
    JAROKU_MCP_CONFIRM             "require" | "skip". Defaults to require under a host.
    JAROKU_MCP_CONFIRM_TIMEOUT_S   how long to wait before denying (default 120).

A tool that could not do its job raises. It does not return the reason as if it were an
answer — see the note in postgres.py, which explains at length why a returned error string is
worse than a raised one.
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import re
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from langchain_core.tools import StructuredTool

# tools/mcp_bridge.py -> the project root, beside jaroku.json.
MANIFEST_PATH = Path(__file__).resolve().parent.parent / "mcp_tools.json"

# Wall-clock ceiling on one tool call, including connect and handshake. Deliberately well
# under the eval job deadline (JAROKU_JOB_TIMEOUT_MS, 180s) so a hanging third-party server
# produces a failed STEP the trace can show, rather than a killed run that explains nothing.
CALL_TIMEOUT_S = float(os.environ.get("JAROKU_MCP_CALL_TIMEOUT_S", "60"))

# Ceiling on what one call may hand back.
#
# This bounds what reaches the MODEL and the TRACE, not what the transport reads — an HTTP
# client has already buffered the response by the time we see it. That is still the boundary
# that matters: jaroku_interceptor._json_safe faithfully records whatever a tool returns, so
# an unbounded return is a 10MB step in the trace store, a 10MB line on the event stream, and
# a context window spent on one hostile answer. Truncation is announced rather than silent,
# because a quietly cut result reads to the model as a complete one.
MAX_RESULT_CHARS = int(os.environ.get("JAROKU_MCP_MAX_RESULT_CHARS", "20000"))

# How long to wait for a human before denying. Denying, not allowing: a gate that opens when
# nobody answers is a gate that opens whenever someone steps away from their desk.
CONFIRM_TIMEOUT_S = float(os.environ.get("JAROKU_MCP_CONFIRM_TIMEOUT_S", "120"))
CONFIRM_POLL_S = 0.2

# Arguments travel to the UI so a human can see what they are approving. Capped, because the
# whole point of showing them is that someone reads them.
MAX_ARGS_CHARS = 4000

# Must match jaroku_runner/debug.py:CTRL_SENTINEL and processManager.ts:CTRL_SENTINEL.
# Three copies, because this file is copied into projects that import nothing from Jaroku —
# a generated agent stays plain LangGraph, and that is worth one duplicated constant.
CTRL_SENTINEL = "@@JAROKU_CTRL@@ "

# Control characters worth removing: the C0 set except tab and newline, plus DEL and the C1
# range. They serve no purpose in a tool result and they corrupt the things that render it —
# a NUL truncates C-string consumers, \r overwrites a terminal line, and an ANSI escape can
# repaint a whole screen. stdout is already protected by the runner's guard; this protects
# everything downstream of the trace.
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
_ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")

_MISSING_DEPS = (
    "The MCP bridge needs the 'mcp' package. Install the connector extras: "
    "uv sync --extra connectors"
)


class ManifestError(RuntimeError):
    """The project's mcp_tools.json is missing or unusable."""


class ToolNotApproved(RuntimeError):
    """A high-impact call the user declined, or did not answer in time."""


# Tools granted "for this run". Module-level, so the grant lasts exactly as long as the
# process does: a new run asks again, which is what "first use in a run" means.
_run_grants: set[str] = set()


# --- the confirmation gate --------------------------------------------------


def _host_control_dir() -> Path | None:
    """Where approval files are exchanged, or None when nothing is listening.

    Both variables are required. A run id without a control directory is a host that cannot
    answer, and treating that as "a host is present" would hang every high-impact call for
    the full timeout before denying it.
    """
    run_id = os.environ.get("JAROKU_RUN_ID")
    control_dir = os.environ.get("JAROKU_CONTROL_DIR")
    if not run_id or not control_dir:
        return None
    return Path(control_dir)


def _emit_ctrl(obj: dict[str, Any]) -> None:
    """One control line on stderr. Never stdout — that carries the trace and nothing else."""
    print(CTRL_SENTINEL + json.dumps(obj), file=sys.stderr, flush=True)


def _confirm(server_id: str, name: str, args: dict[str, Any], reason: str) -> None:
    """Block until a high-impact call is approved, or raise.

    Four situations, and each is decided on purpose rather than by fallthrough:

      * Already granted for this run -> proceed silently. That is what "first use" means.

      * A host is listening -> ask it, and wait. Deny on refusal or on timeout.

      * No host, JAROKU_MCP_CONFIRM=require -> refuse. Somebody asked for the gate in a place
        that cannot show it, and quietly running anyway would answer their question wrongly.

      * No host, anything else -> proceed, with a warning naming the tool. This is the
        copied-out project the README promises: a person running the script themselves, on
        their own machine, IS the authorisation, and a hard denial would mean generated
        projects are not really portable. The warning exists so it is never a surprise.
    """
    key = f"{server_id}/{name}"
    if key in _run_grants:
        return

    mode = os.environ.get("JAROKU_MCP_CONFIRM", "").strip().lower()
    if mode == "skip":
        return

    control_dir = _host_control_dir()
    if control_dir is None:
        if mode == "require":
            raise ToolNotApproved(
                f"{key} is a high-impact MCP tool and JAROKU_MCP_CONFIRM=require, but there "
                f"is no Jaroku session to ask. Run it from Jaroku, or unset the variable."
            )
        print(
            f"[jaroku] WARNING: calling high-impact MCP tool {key} without confirmation "
            f"(no Jaroku session is watching). {reason}",
            file=sys.stderr,
            flush=True,
        )
        return

    run_id = os.environ["JAROKU_RUN_ID"]
    nonce = uuid.uuid4().hex[:12]
    approval = control_dir / f"{run_id}.{nonce}.approval"

    try:
        payload = json.dumps(args, default=str)
    except Exception:  # noqa: BLE001 - showing something beats showing nothing
        payload = repr(args)
    if len(payload) > MAX_ARGS_CHARS:
        payload = payload[:MAX_ARGS_CHARS] + " …(truncated)"

    _emit_ctrl(
        {
            "ctrl": "tool_confirm",
            "run_id": run_id,
            "nonce": nonce,
            "server": server_id,
            "tool": name,
            "impact_reason": reason,
            "args": payload,
            "timeout_s": CONFIRM_TIMEOUT_S,
        }
    )

    deadline = time.monotonic() + CONFIRM_TIMEOUT_S
    verdict = ""
    while time.monotonic() < deadline:
        try:
            if approval.exists():
                verdict = approval.read_text(encoding="utf-8").strip().lower()
                if verdict:
                    break
        except OSError:
            pass  # a half-written file on the next poll is fine; keep waiting
        time.sleep(CONFIRM_POLL_S)

    try:
        approval.unlink(missing_ok=True)
    except OSError:
        pass

    if verdict == "run":
        _run_grants.add(key)
        return
    if verdict == "once":
        return

    # Denied, or nobody answered. Both raise, and the message says which — "you declined
    # this" and "nobody was there" call for different next steps.
    _emit_ctrl({"ctrl": "tool_confirm_closed", "run_id": run_id, "nonce": nonce})
    if verdict == "deny":
        raise ToolNotApproved(f"{key} was not approved: you declined this call.")
    if verdict:
        # An answer arrived and it was not one of ours. Denying is right; blaming it on a
        # timeout that did not happen sends someone looking at the wrong thing entirely.
        raise ToolNotApproved(
            f"{key} was not approved: the answer was {verdict[:40]!r}, which is not one of "
            f"run, once or deny. Anything Jaroku cannot read is treated as a refusal."
        )
    raise ToolNotApproved(
        f"{key} was not approved: nobody confirmed it within {CONFIRM_TIMEOUT_S:.0f}s, so it "
        f"was declined. High-impact MCP tools are never allowed by default."
    )


# --- manifest ---------------------------------------------------------------


def load_manifest(path: Path | None = None) -> dict[str, Any]:
    """Read the host-written manifest. Missing file means no MCP tools, which is not an error."""
    target = path or MANIFEST_PATH
    try:
        text = target.read_text(encoding="utf-8")
    except OSError:
        return {"servers": []}
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        # The host wrote this file, so a parse failure is a bug on our side rather than a
        # third party misbehaving. Fail loudly instead of silently granting nothing: an agent
        # that quietly loses its tools looks like a model that forgot to call them.
        raise ManifestError(f"mcp_tools.json is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ManifestError("mcp_tools.json must contain a JSON object")
    return data


# --- argument checking ------------------------------------------------------


def check_arguments(schema: dict[str, Any], args: dict[str, Any]) -> None:
    """Raise ValueError unless `args` fits the tool's declared schema.

    Deliberately shallow: required keys present, no unknown keys, and nothing more. This is
    not a JSON Schema validator and does not pretend to be one — its job is to catch the two
    mistakes a model actually makes, before they turn into an opaque error from someone
    else's server.

    The same check runs at generation time against literal call sites (validator.ts), so a
    bad call is usually caught before the project is ever written. This is the backstop for
    the arguments a model assembles at runtime, which no static check can see.
    """
    if not isinstance(args, dict):
        raise ValueError(f"arguments must be an object, got {type(args).__name__}")

    properties = schema.get("properties")
    required = schema.get("required")

    if isinstance(required, list):
        missing = [k for k in required if isinstance(k, str) and k not in args]
        if missing:
            raise ValueError(f"missing required argument(s): {', '.join(sorted(missing))}")

    # Only when the server actually declared a property list. A schema with none says
    # nothing about what is allowed, and inventing a restriction from silence would reject
    # calls the server would have accepted.
    if isinstance(properties, dict) and properties:
        unknown = [k for k in args if k not in properties]
        if unknown:
            raise ValueError(
                f"unknown argument(s): {', '.join(sorted(unknown))}. "
                f"This tool accepts: {', '.join(sorted(properties))}"
            )


# --- the call ---------------------------------------------------------------


def _run_call(endpoint: str, token: str | None, tool: str, args: dict[str, Any]) -> Any:
    """Perform one MCP tool call, in a private event loop, and return the raw result.

    Run in a dedicated thread with its own loop rather than via asyncio.run(), because a
    LangGraph node may already be inside a running loop and asyncio.run() would raise there.
    A thread works either way and keeps this module free of assumptions about its caller.
    """
    try:
        from mcp import ClientSession
        from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client
    except ImportError as exc:  # pragma: no cover - exercised only without the extras
        raise RuntimeError(_MISSING_DEPS) from exc

    async def _call() -> Any:
        headers = {"Authorization": f"Bearer {token}"} if token else None
        async with create_mcp_http_client(headers=headers) as http_client:
            async with streamable_http_client(endpoint, http_client=http_client) as streams:
                read_stream, write_stream = streams[0], streams[1]
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    return await session.call_tool(tool, args)

    outcome: queue.Queue[tuple[str, Any]] = queue.Queue(maxsize=1)

    def _worker() -> None:
        try:
            outcome.put(("ok", asyncio.run(asyncio.wait_for(_call(), timeout=CALL_TIMEOUT_S))))
        except BaseException as exc:  # noqa: BLE001 - reported, never swallowed
            outcome.put(("err", exc))

    thread = threading.Thread(target=_worker, name=f"jaroku-mcp-{tool}", daemon=True)
    thread.start()
    try:
        # A slightly longer join than the inner timeout, so the inner one reports first and
        # the error names the tool rather than the plumbing.
        kind, value = outcome.get(timeout=CALL_TIMEOUT_S + 10)
    except queue.Empty as exc:
        raise RuntimeError(
            f"MCP tool {tool!r} did not return within {CALL_TIMEOUT_S:.0f}s and was abandoned."
        ) from exc
    if kind == "err":
        raise value  # type: ignore[misc]
    return value


def describe_exception(exc: BaseException) -> str:
    """Flatten an exception into a message a user can act on.

    anyio task groups — which the MCP transport is built on — surface a failed connection as
    "ExceptionGroup: unhandled errors in a TaskGroup (1 sub-exception)". That is true and
    completely useless: the ConnectionRefusedError naming the port is one level down, and a
    trace showing the wrapper instead of the cause is a trace that cannot be debugged from.
    So groups are flattened to their leaves, recursively.
    """
    leaves: list[str] = []

    def walk(e: BaseException, depth: int = 0) -> None:
        if depth > 5:
            return
        inner = getattr(e, "exceptions", None)
        if isinstance(inner, (list, tuple)) and inner:
            for sub in inner:
                walk(sub, depth + 1)
            return
        leaves.append(f"{type(e).__name__}: {e}")

    walk(exc)
    # Deduplicate: a task group frequently reports the same failure from several tasks, and
    # three copies of one message reads as three problems.
    seen: list[str] = []
    for leaf in leaves:
        if leaf not in seen:
            seen.append(leaf)
    return "; ".join(seen) if seen else f"{type(exc).__name__}: {exc}"


def sanitize(text: str) -> str:
    """Make a third-party string safe to put in a trace and hand to a model.

    Strips ANSI escapes and control characters, then caps the length with an explicit note.
    Never raises: this runs on the return path of every MCP call, and a sanitizer that threw
    would turn a merely-rude response into a failed step for the wrong reason.
    """
    try:
        cleaned = _ANSI_ESCAPE.sub("", text)
        cleaned = _CONTROL_CHARS.sub("", cleaned)
        if len(cleaned) > MAX_RESULT_CHARS:
            dropped = len(cleaned) - MAX_RESULT_CHARS
            cleaned = (
                cleaned[:MAX_RESULT_CHARS]
                + f"\n\n[truncated by Jaroku: {dropped} more characters were returned]"
            )
        return cleaned
    except Exception:  # noqa: BLE001 - a sanitizer must not be the thing that fails
        return "[Jaroku could not read this server's response]"


def _reported_error(result: Any) -> bool:
    """Did the server flag its own call as failed?

    Both spellings are checked. The wire field is ``isError``; the Python SDK exposes it as
    ``is_error`` and has renamed things before. Getting this wrong is silent and expensive:
    the call comes back looking like an ANSWER, so the trace shows a green successful step
    whose content is a failure and the model replies to the user from it — exactly the thing
    rule 7 exists to prevent. Checking both costs one attribute lookup.
    """
    for attr in ("is_error", "isError"):
        if getattr(result, attr, False) is True:
            return True
    return False


def _result_text(server_id: str, name: str, result: Any) -> str:
    """Flatten an MCP CallToolResult into framed, bounded text for the model."""
    body = _content_text(result)
    if _reported_error(result):
        # The server said its own call failed. That is a failure, not an answer — rule 7.
        raise RuntimeError(f"the {server_id} server reported an error: {body[:500]}")
    return _frame(server_id, name, body)


def _frame(server_id: str, name: str, body: str) -> str:
    """Label the payload as data from a named external source.

    Two purposes, one line. The trace gets unambiguous provenance for a result whose Step
    carries none. And the model reading it is told, in the same breath, that what follows was
    written by a third party rather than by Jaroku — worth saying, because a tool result is
    the obvious place to put "ignore your previous instructions" and this is the only point in
    the pipeline where that text can be labelled at all.
    """
    return f"[mcp:{server_id}/{name} returned the following external data]\n{body}"


def _content_text(result: Any) -> str:
    parts: list[str] = []
    blocks = getattr(result, "content", None) or []
    for block in blocks:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            parts.append(sanitize(text))
        else:
            # A non-text block (an image, a resource link) is not something a text-answering
            # tool can hand a model. Naming its type is more useful than dropping it silently,
            # and far better than stringifying a blob into the trace.
            parts.append(f"[{getattr(block, 'type', 'unknown')} content omitted]")
    joined = "\n".join(parts).strip()
    if not joined:
        # A result with no readable content is a result, not a failure — the same distinction
        # postgres.py draws between "zero rows" and "the query failed".
        return "(the server returned no readable content)"
    # Cap again after joining: many small blocks add up to the same problem as one big one.
    return sanitize(joined)


# --- tool construction ------------------------------------------------------


def _make_tool(server: dict[str, Any], spec: dict[str, Any]) -> StructuredTool:
    endpoint = str(server.get("endpoint") or "")
    server_id = str(server.get("id") or "unknown")
    auth_env_key = server.get("auth_env_key")
    name = str(spec.get("name") or "")
    schema = spec.get("input_schema")
    if not isinstance(schema, dict) or not schema:
        schema = {"type": "object", "properties": {}}
    # The impact recorded at generation time, INCLUDING any override the user had set. Read
    # from the manifest rather than recomputed, so the gate cannot change its mind between
    # the plan somebody approved and the run that follows it.
    high_impact = str(spec.get("impact") or "high").lower() == "high"
    impact_reason = str(spec.get("impact_reason") or "it is classified high-impact")

    def _invoke(**kwargs: Any) -> str:
        # 1. Does this call even match what the server said it accepts?
        try:
            check_arguments(schema, kwargs)
        except ValueError as exc:
            raise RuntimeError(f"{name}: {exc}") from exc

        # 2. Ask, if this is a high-impact tool being called for the first time this run.
        #    Before the credential is even read: a call nobody approved should not so much as
        #    look at a secret.
        if high_impact:
            _confirm(server_id, name, kwargs, impact_reason)

        # 3. The credential, read at the moment of use and never held anywhere.
        token = os.environ.get(auth_env_key) if auth_env_key else None
        if auth_env_key and not token:
            raise RuntimeError(
                f"The {server_id} MCP server is not configured: {auth_env_key} is not set in "
                f"the environment. Add it to runtime/.env."
            )

        # 4. The call itself. Every failure below is a failure, not an answer.
        try:
            result = _run_call(endpoint, token, name, kwargs)
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(
                f"MCP call {server_id}/{name} failed: {describe_exception(exc)}"
            ) from exc

        return _result_text(server_id, name, result)

    description = str(spec.get("description") or f"Tool {name} on the {server_id} MCP server.")
    # Marked in the description because this string is what the MODEL reads when deciding
    # whether to call it. The badge in the UI tells the human; this tells the agent.
    description = f"{description}\n\n(From the {server_id} MCP server — external, unreviewed.)"

    return StructuredTool.from_function(
        func=_invoke,
        name=name,
        description=description,
        args_schema=schema,
    )


def build_tools(manifest: dict[str, Any] | None = None) -> list[StructuredTool]:
    """Build one StructuredTool per manifest entry. Never dials out.

    A name granted by two different servers RAISES rather than resolving to one of them.

    Dropping the second silently — which is what this used to do — is the worst available
    outcome. The model sees one tool called ``create_issue`` and calls it; the call goes to
    whichever server happened to be listed first, which may not be the one the user picked. And
    because impact travels per entry, a high-impact tool with a confirmation gate can be
    replaced by a same-named low-impact one from somebody else's server, so the gate does not
    fire and nothing anywhere reports that it did not.

    The host refuses to write a manifest like this (mcpManifest.manifestCollisions), so reaching
    here means the manifest is wrong, and a manifest this module cannot honour exactly is not
    one to honour approximately. Same posture as a manifest that will not parse.
    """
    data = manifest if manifest is not None else load_manifest()
    tools: list[StructuredTool] = []
    owners: dict[str, str] = {}
    for server in data.get("servers") or []:
        if not isinstance(server, dict):
            continue
        server_id = str(server.get("id") or "unknown")
        for spec in server.get("tools") or []:
            if not isinstance(spec, dict):
                continue
            name = spec.get("name")
            if not isinstance(name, str) or not name:
                continue
            prior = owners.get(name)
            if prior is not None:
                # One server listing a tool twice is a duplicate, not an ambiguity: both
                # entries mean the same call to the same place, so the first one stands.
                if prior == server_id:
                    continue
                raise ManifestError(
                    f"mcp_tools.json grants the tool {name!r} from two servers ({prior} and "
                    f"{server_id}). An agent has one tool per name, so this grant is ambiguous "
                    f"— deselect one of them in the MCP panel and regenerate."
                )
            owners[name] = server_id
            tools.append(_make_tool(server, spec))
    return tools


# The scoped set, built once at import. This is the ONLY handle a generated agent has on any
# MCP server, which is what makes the manifest a grant rather than a suggestion.
MCP_TOOLS: list[StructuredTool] = build_tools()

__all__ = [
    "MCP_TOOLS",
    "build_tools",
    "load_manifest",
    "check_arguments",
    "describe_exception",
    "sanitize",
    "ManifestError",
    "ToolNotApproved",
]
