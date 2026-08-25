"""Reviewed connector templates — the MVP subset of the eventual connector library.

These files are hand-written and verified once (auth flow, error handling, blast radius),
then copied byte-for-byte into generated projects. The builder model sees only the
signatures in catalog.json and is forbidden from rewriting them, so a reviewed connector
cannot be silently mangled by a generation.

catalog.json is the machine-readable index the Node builder reads. check_catalog() proves
it still matches the Python, so the two cannot drift unnoticed.
"""

from __future__ import annotations

import json
from pathlib import Path

CATALOG_PATH = Path(__file__).parent / "catalog.json"
CATALOG = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
CONNECTORS = {c["id"]: c for c in CATALOG["connectors"]}


def required_env(connector_ids) -> list[str]:
    """Union of the env vars the given connectors need, in stable order."""
    seen: list[str] = []
    for cid in connector_ids:
        for key in CONNECTORS.get(cid, {}).get("required_env", []):
            if key not in seen:
                seen.append(key)
    return seen


def pip_requires(connector_ids) -> list[str]:
    """Union of the PyPI requirements the given connectors need, in stable order.

    What a deployed image has to install. Per connector rather than the whole `connectors`
    extra, because an agent with one Postgres tool has no business pulling in the Google API
    client — that is image size, build time and attack surface for nothing.
    """
    seen: list[str] = []
    for cid in connector_ids:
        for req in CONNECTORS.get(cid, {}).get("pip_requires", []):
            if req not in seen:
                seen.append(req)
    return seen


def check_catalog() -> list[str]:
    """Verify catalog.json matches the modules. Returns a list of problems (empty = good)."""
    import importlib

    problems: list[str] = []
    for cid, entry in CONNECTORS.items():
        if not (Path(__file__).parent / entry["file"]).exists():
            problems.append(f"{cid}: missing file {entry['file']}")
            continue

        module = importlib.import_module(f"{__name__}.{entry['module']}")

        declared = set(entry["required_env"])
        actual = set(getattr(module, "REQUIRED_ENV", []))
        if declared != actual:
            problems.append(
                f"{cid}: required_env mismatch — catalog {sorted(declared)} "
                f"vs module {sorted(actual)}"
            )

        # AND THE SECOND DOOR, which is the one that fails silently. `optional_env` is what the
        # connections panel offers BEYOND the required names — an optional default auth header, a
        # hosted access token — and a name offered there that the module does not actually read
        # produces the worst outcome available here: the user types a value, the vault stores it,
        # the panel reports it configured, and the run authenticates with nothing. That is the
        # failure "a key stored under a name the runtime does not read" already cost this project
        # once, in onboarding, and it looks like success from every angle except the one that matters.
        #
        # A SUBSET RATHER THAN AN EQUALITY, unlike `required_env` above. A module may read a name
        # the catalog does not offer: `GMAIL_ACCESS_TOKEN` is gmail.py's OPTIONAL_ENV and is filled
        # by the OAuth service from the connector spec's `accessSecretName`, so listing it here too
        # would be a second place for that name to live and a second place to forget it. The
        # direction that must hold is the other one — everything the catalog offers is read.
        declared_optional = set(entry.get("optional_env", []))
        module_optional = set(getattr(module, "OPTIONAL_ENV", []))
        unread = declared_optional - module_optional
        if unread:
            problems.append(
                f"{cid}: optional_env {sorted(unread)} is offered to users but "
                f"{entry['module']} never reads it — a value stored under it would do nothing"
            )

        # `auth` decides what the connections panel offers, what .env.example says about each
        # key, and what the generation prompt tells the model about where a credential comes
        # from. A connector with none of those decided would quietly behave as `user_secret`
        # everywhere, which for Gmail means telling a user to obtain a refresh token by hand —
        # the exact instruction the Connect button exists to make unnecessary.
        auth = entry.get("auth")
        if auth not in {"oauth", "user_secret", "none"}:
            problems.append(
                f"{cid}: auth is {auth!r} — it must be 'oauth', 'user_secret' or 'none'"
            )

        catalog_tools = {t["name"] for t in entry["tools"]}
        module_tools = {t.name for t in getattr(module, "TEMPLATE_TOOLS", [])}
        if catalog_tools != module_tools:
            problems.append(
                f"{cid}: tool names mismatch — catalog {sorted(catalog_tools)} "
                f"vs module {sorted(module_tools)}"
            )

    problems.extend(_check_pip_requires())
    return problems


def _check_pip_requires() -> list[str]:
    """Verify every connector's pip_requires is real, and is a subset of the extra.

    A deployed image installs from this field, so a typo here is not a lint failure — it is a
    container that builds and then raises ImportError on the first tool call, in production,
    against somebody's real Gmail account. Checking it against runtime/pyproject.toml's
    `connectors` extra is what keeps the two from drifting: that extra is what the local venv
    installs, so anything outside it has never been tried anywhere.
    """
    pyproject = Path(__file__).parent.parent / "pyproject.toml"
    if not pyproject.exists():
        return [f"cannot verify pip_requires: {pyproject} is missing"]

    try:
        import tomllib
    except ModuleNotFoundError:  # pragma: no cover — Python < 3.11
        return []

    extra = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    declared = set(extra.get("project", {}).get("optional-dependencies", {}).get("connectors", []))

    problems: list[str] = []
    for cid, entry in CONNECTORS.items():
        reqs = entry.get("pip_requires")
        if reqs is None:
            problems.append(f"{cid}: no pip_requires — a deployed image would not install it")
            continue
        for req in reqs:
            if req not in declared:
                problems.append(
                    f"{cid}: pip_requires {req!r} is not in pyproject.toml's `connectors` "
                    f"extra, so it is installed nowhere but a deployed image"
                )
    return problems


def check_failures_raise() -> list[str]:
    """Verify every template tool RAISES when its connector is not configured.

    This is the check for the defect that made a misconfigured agent look like a working one. A
    template that *returned* "Gmail is not configured" produced a successful tool call: the trace
    drew a green step, and the model — handed a normal-looking tool result — answered the user out
    of the error text. The one thing the trace exists to show was the one thing it hid.

    Returns a list of problems (empty = good). Runs with the connector variables stripped from the
    environment, so it is safe to call on a configured machine.
    """
    import importlib
    import os

    problems: list[str] = []
    # Every name that could configure a connector, not only the required ones. A template with a
    # second route to being configured — Gmail's hosted access token — would otherwise leave this
    # check passing on a machine where that route happens to be set, which is the one machine the
    # check is least able to be trusted on.
    names = list(required_env(list(CONNECTORS)))
    for entry in CONNECTORS.values():
        module = importlib.import_module(f"{__name__}.{entry['module']}")
        for name in getattr(module, "OPTIONAL_ENV", []):
            if name not in names:
                names.append(name)
    stripped = {k: os.environ.pop(k, None) for k in names}
    try:
        for cid, entry in CONNECTORS.items():
            module = importlib.import_module(f"{__name__}.{entry['module']}")
            for t in getattr(module, "TEMPLATE_TOOLS", []):
                try:
                    result = t.invoke(_sample_args(t))
                except Exception:
                    continue  # raised, which is the point
                problems.append(
                    f"{cid}.{t.name} returned {result!r} while unconfigured — it must raise, "
                    "or the trace records a failed call as a successful one"
                )
    finally:
        for k, v in stripped.items():
            if v is not None:
                os.environ[k] = v
    return problems


def _sample_args(tool) -> dict:
    """Minimal valid-looking arguments for a template tool, from its own schema."""
    schema = tool.args
    out: dict = {}
    for name, spec in schema.items():
        kind = spec.get("type")
        out[name] = 1 if kind == "integer" else ("SELECT 1" if name == "sql" else "x")
    return out


__all__ = [
    "CATALOG",
    "CONNECTORS",
    "required_env",
    "pip_requires",
    "check_catalog",
    "check_failures_raise",
]
