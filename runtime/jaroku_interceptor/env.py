"""Minimal .env loader — no third-party dependency.

The agent runs as a subprocess spawned by the Node process manager, which does not
inherit the developer's shell rc files. Provider keys therefore have to come from
``runtime/.env``. Precedence: a variable already present in the environment always
wins, so ``JAROKU_PROVIDER=anthropic uv run ...`` and CI secrets still override the file.

Never logs values — only the *names* of the keys it set, and only to stderr.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

# runtime/jaroku_interceptor/env.py -> runtime/.env
DEFAULT_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"

# Credentials that belong to the Jaroku server and never to an agent, though they share the file.
#
# The Railway account token can create and delete whole projects in somebody's hosting account,
# and a deployed agent's serve token spends that agent's provider key. The process manager strips
# them from a run's environment — and this loader used to read them straight back out of the
# file ("loaded 1 var(s) from .env: RAILWAY_API_TOKEN"), handing them to generated code.
PLATFORM_ONLY = re.compile(r"^(RAILWAY_API_TOKEN|JAROKU_DEPLOY_[A-Z0-9_]+_SERVE_TOKEN)$")


def _parse_line(line: str) -> tuple[str, str] | None:
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    if line.startswith("export "):
        line = line[len("export "):].lstrip()
    key, sep, value = line.partition("=")
    if not sep:
        return None
    key = key.strip()
    if not key:
        return None
    value = value.strip()
    # Strip one layer of matching quotes, if present.
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        value = value[1:-1]
    return key, value


def load_env(path: Path | None = None, *, verbose: bool = True) -> list[str]:
    """Load KEY=VALUE pairs from ``path`` into os.environ. Returns the names set.

    Existing environment variables are never overwritten, and the server's own credentials
    (``PLATFORM_ONLY``) are never loaded at all. Missing/unreadable files are not an error —
    the fake provider needs no keys at all.
    """
    env_path = Path(path) if path is not None else DEFAULT_ENV_PATH
    try:
        text = env_path.read_text(encoding="utf-8")
    except OSError:
        return []

    loaded: list[str] = []
    for line in text.splitlines():
        parsed = _parse_line(line)
        if parsed is None:
            continue
        key, value = parsed
        if key in os.environ or PLATFORM_ONLY.match(key):
            continue
        os.environ[key] = value
        loaded.append(key)

    if verbose and loaded:
        # Names only — a value must never reach stdout, stderr, or the trace.
        print(f"[jaroku] loaded {len(loaded)} var(s) from {env_path.name}: "
              f"{', '.join(sorted(loaded))}", file=sys.stderr, flush=True)
    return loaded
