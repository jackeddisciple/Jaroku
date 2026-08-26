"""Provider selection — the one place a generated agent's model is chosen.

Generated code never constructs a model (hard rule 2 of the generation prompt). It receives
one already configured. That is what makes the provider dropdown a real feature rather than
a regeneration: the same generated project runs on the free dry-run model, on Claude, or on
GPT, decided here at spawn time from ``JAROKU_PROVIDER`` / ``JAROKU_MODEL``.

Note on sampling parameters: no ``temperature`` is passed. Current Claude models (Opus 4.7+,
Sonnet 5, Fable 5) reject ``temperature``/``top_p``/``top_k`` with a 400, so passing it would
break exactly the models a user is most likely to pick.
"""

from __future__ import annotations

import os
from typing import Any, Sequence

from .fake import build_dry_run_model

# Reasoning effort, translated where the model is constructed — the run half of the same rule the
# server's effort.ts holds for its own calls: one adapter, never inline at the call site.
#
# THE SERVER SENDS THE WORD, NOT A BUDGET. It resolves the level from the conversation through the
# workspace default and writes it here beside JAROKU_PROVIDER and JAROKU_MODEL; the token
# arithmetic is per provider and belongs next to the constructor that uses it. A budget computed on
# the TypeScript side would be a second implementation of the adapter, in a second language, wrong
# the first time either table moved.
#
# LOW MEANS OFF, which is effort.ts's rule as well: a thinking block of a few hundred tokens is the
# cost of the feature with none of the benefit. An unset or unrecognised value means the provider's
# own default, so a run started before this existed is byte-identical to the one that shipped.
_THINKING_BUDGETS = {"medium": 4_000, "high": 12_000, "xhigh": 24_000}
# OpenAI takes a NAME rather than a budget, and takes three of the four — xhigh clamps to high,
# which is the same clamp effort.ts applies for the same reason.
_OPENAI_EFFORT = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high"}


def _requested_effort() -> str | None:
    level = (os.environ.get("JAROKU_REASONING_EFFORT") or "").strip().lower()
    return level if level in ("low", "medium", "high", "xhigh") else None

# Cheap defaults on purpose: a mis-set provider should cost cents, not dollars. The server
# forwards JAROKU_MODEL explicitly, so these only apply to a hand-run with no model set.
DEFAULT_MODELS = {
    "anthropic": "claude-haiku-4-5",
    "openai": "gpt-4o-mini",
    "google": "gemini-2.0-flash",
    "fake": "fake-dry-run",
}


def resolve_model_name(provider: str, requested: str | None) -> str:
    return requested or DEFAULT_MODELS.get(provider, DEFAULT_MODELS["fake"])


def build_model(provider: str, model_name: str, tools: Sequence[Any]) -> tuple[Any, str, str]:
    """Return ``(llm, provider, model_name)``.

    Tools are *not* bound here — the generated ``build_graph(llm)`` calls
    ``llm.bind_tools(TOOLS)`` itself, per the contract. They are passed in only so the
    dry-run model can script one call per tool.
    """
    provider = (provider or "fake").lower()

    level = _requested_effort()

    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic

        # `max_tokens` HAS TO RISE WITH THE BUDGET. A thinking block is spent out of the output
        # allowance, so a 12k budget under the client's default ceiling is a response the provider
        # truncates — which reads as the model giving up mid-sentence, with no error attached.
        budget = _THINKING_BUDGETS.get(level or "", 0)
        if budget:
            return (
                ChatAnthropic(
                    model=model_name,
                    max_tokens=budget * 2,
                    thinking={"type": "enabled", "budget_tokens": budget},
                ),
                provider,
                model_name,
            )
        return ChatAnthropic(model=model_name), provider, model_name

    if provider == "openai":
        from langchain_openai import ChatOpenAI

        effort = _OPENAI_EFFORT.get(level or "")
        if effort:
            return ChatOpenAI(model=model_name, reasoning_effort=effort), provider, model_name
        return ChatOpenAI(model=model_name), provider, model_name

    if provider == "google":
        # Imported inside the branch, like the other two: a workspace on Claude should not pay the
        # import cost — or the failure — of a package it never uses.
        #
        # The key is read from ``GOOGLE_API_KEY`` by the client itself, which is why that name is
        # the one the server writes. No ``temperature`` here either, for consistency with the note
        # at the top of this module rather than because Gemini refuses one.
        from langchain_google_genai import ChatGoogleGenerativeAI

        return ChatGoogleGenerativeAI(model=model_name), provider, model_name

    return build_dry_run_model(tools), "fake", DEFAULT_MODELS["fake"]
