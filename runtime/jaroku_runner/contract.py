"""The generated-agent contract: load a generated module and prove it is runnable.

A generated project is text a model wrote. Before we hand it to LangGraph we check it
exposes exactly what the runner needs, and fail with a message that says which symbol is
missing rather than an AttributeError three frames deep.

The contract — the three symbols a generated agent must expose:

    TOOLS: list                               every @tool the graph can call
    build_graph(llm) -> CompiledGraph         llm is INJECTED, never constructed here
    build_initial_state(user_input) -> dict   the graph's starting state

Deliberately *not* in the contract: anything Jaroku. A generated agent that imports
jaroku_interceptor is rejected at generation time (server-side validation) precisely so the
user's project stays portable standard LangGraph.
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import re
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

# Generated ids come from the server, but this module is also runnable by hand, and the id
# becomes an import path — so it is validated here rather than trusted.
_SAFE_AGENT_ID = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

REQUIRED_CALLABLES = ("build_graph", "build_initial_state")


class ContractError(Exception):
    """A generated project does not satisfy the runner contract."""


def validate_agent_id(agent_id: str) -> str:
    if not _SAFE_AGENT_ID.match(agent_id or ""):
        raise ContractError(
            f"invalid agent id {agent_id!r}: expected lowercase letters, digits and "
            "underscores, starting with a letter"
        )
    return agent_id


def agent_dir() -> Path | None:
    """An explicit project directory to import from, or None for ``runtime/agents/<id>/``.

    ``JAROKU_AGENT_DIR`` is how a project that does not live under ``runtime/agents/`` gets
    imported: a version materialised out of the object store into a temp directory, and — in
    Session 4 — a tmpfs inside a sandbox. The directory is the project itself (the one holding
    ``agent.py``), not the directory above it.

    Absent, everything behaves exactly as it did: the project is a package under ``agents.``
    and the import path is the agent id. That is what a copied-out project and a local
    ``npm run dev`` both do, and it must keep working with nothing set.
    """
    raw = os.environ.get("JAROKU_AGENT_DIR")
    return Path(raw).resolve() if raw else None


def load_agent(agent_id: str) -> ModuleType:
    """Import the agent module and verify the contract.

    ``agents.<agent_id>.agent`` normally; the file under ``JAROKU_AGENT_DIR`` when one is set.
    """
    validate_agent_id(agent_id)
    explicit = agent_dir()
    if explicit is not None:
        module = _load_from_directory(agent_id, explicit)
    else:
        module_path = f"agents.{agent_id}.agent"
        try:
            module = importlib.import_module(module_path)
        except ModuleNotFoundError as exc:
            raise ContractError(f"cannot import {module_path}: {exc}") from exc

    missing = [name for name in REQUIRED_CALLABLES if not callable(getattr(module, name, None))]
    if not isinstance(getattr(module, "TOOLS", None), (list, tuple)):
        missing.append("TOOLS (list)")
    if missing:
        raise ContractError(
            f"{module.__name__} does not satisfy the agent contract; missing: {', '.join(missing)}"
        )
    return module


def _load_from_directory(agent_id: str, directory: Path) -> ModuleType:
    """Import ``<directory>/agent.py`` as ``agents.<agent_id>.agent``.

    UNDER THE NAME IT WOULD HAVE HAD, deliberately. A generated project's own modules import
    each other relatively — ``from .tools.notes import ...`` — and a relative import resolves
    against the module's package, so importing ``agent.py`` as a top-level module would break
    every project with a ``tools/`` directory. Registering the package under the same dotted
    name it has on disk means the project cannot tell where it was materialised.

    The parent of the directory goes on ``sys.path`` rather than the directory itself, for the
    same reason: ``agents.<id>`` has to be resolvable as a package.
    """
    if not (directory / "agent.py").exists():
        raise ContractError(f"no agent.py in {directory}")
    parent = str(directory.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)

    # The package the project's relative imports resolve against. Built by hand rather than
    # imported, because the directory the project was materialised into is not named after the
    # agent — a temp directory has whatever name mkdtemp gave it.
    package = f"agents.{agent_id}"
    if "agents" not in sys.modules:
        agents_pkg = ModuleType("agents")
        agents_pkg.__path__ = [parent]  # type: ignore[attr-defined]
        sys.modules["agents"] = agents_pkg
    if package not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            package, directory / "__init__.py", submodule_search_locations=[str(directory)]
        )
        if spec is None or spec.loader is None:
            raise ContractError(f"cannot import {package} from {directory}")
        pkg = importlib.util.module_from_spec(spec)
        sys.modules[package] = pkg
        try:
            spec.loader.exec_module(pkg)
        except FileNotFoundError:
            # A project with no __init__.py is still a project. Register a bare package so the
            # relative imports below resolve, rather than refusing something that runs fine.
            pkg.__path__ = [str(directory)]  # type: ignore[attr-defined]

    try:
        return importlib.import_module(f"{package}.agent")
    except ModuleNotFoundError as exc:
        raise ContractError(f"cannot import {package}.agent from {directory}: {exc}") from exc


def tools_of(module: ModuleType) -> list[Any]:
    return list(module.TOOLS)
