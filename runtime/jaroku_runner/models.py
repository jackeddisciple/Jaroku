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

from typing import Any, Sequence

from .fake import build_dry_run_model

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

    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(model=model_name), provider, model_name

    if provider == "openai":
        from langchain_openai import ChatOpenAI

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
