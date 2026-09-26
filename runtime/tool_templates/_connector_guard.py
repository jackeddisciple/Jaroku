"""The enablement check every reviewed connector template calls, copied in beside them.

A FILE OF ITS OWN, NOT THE PACKAGE'S `__init__.py`. In a generated project `tools/__init__.py` is
written by the model, so a template that did `from . import require_enabled` imported a name that
file never defines, and every generation with a connector failed its import check. This module is
host-owned and copied byte-for-byte whenever a connector is, so the import cannot depend on what
the model chose to write.
"""

from __future__ import annotations

import os


def require_enabled(connector_id: str, label: str) -> None:
    """Raise when this conversation has switched `connector_id` off.

    §12.10's other half, for the six rows that are not MCP servers. The composer's connector deck
    lists reviewed connectors, user-secret connectors and MCP servers in one list and lets you
    disable any of them; the run dispatch applied those decisions to MCP servers alone, so
    switching Gmail off dimmed a tile, persisted a row, and left its tools bound, its token minted
    and its host on the egress allowlist. That is a safety control that reads as enforced and is
    not, and it is the exact gesture somebody makes before pasting something they do not want an
    agent's mail tools near.

    THE HOST NARROWS FIRST AND THIS IS THE SECOND WALL. The dispatch no longer resolves a disabled
    connector's credentials and no longer puts its host on the allowlist, so a tool that reached
    here would already fail. What this adds is the SENTENCE: without it the failure reads "Gmail is
    not configured", which sends somebody to the Connections panel to fix a credential that is
    perfectly fine. "Disabled for this conversation" is a different problem with a different fix,
    one tile away.

    IT RAISES RATHER THAN RETURNING, which is the rule `check_failures_raise` exists to hold:
    LangChain records a returned string as a SUCCESSFUL tool call, so a template that returned this
    would draw a green step whose content happened to be a refusal, and the model would answer the
    user out of it.

    ABSENT MEANS NO RESTRICTION, matching `JAROKU_MCP_SERVERS` and the store's own absent-row-means-
    yes rule: a run outside any conversation, or in one nobody has scoped, behaves exactly as it did
    before this existed. `-` means nothing is allowed — a real state, reachable by switching
    everything off — and an empty string cannot carry that distinction, because Windows deletes an
    environment variable set to "".
    """
    allowed = os.environ.get("JAROKU_CONNECTORS")
    if allowed is None:
        return
    ids = [] if allowed.strip() == "-" else [p.strip() for p in allowed.split(",") if p.strip()]
    if connector_id not in ids:
        raise RuntimeError(
            f"{label} is switched off for this conversation. Turn it back on in the composer's "
            f"connector deck (⋯ → Connectors) to let this agent use it again."
        )
