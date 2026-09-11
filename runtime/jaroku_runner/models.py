"""Provider selection — the one place a generated agent's model is chosen.

Generated code never constructs a model (hard rule 2 of the generation prompt). It receives
one already configured. That is what makes the provider dropdown a real feature rather than
a regeneration: the same generated project runs on Claude, on GPT or on Muse Spark, decided
here at spawn time from ``JAROKU_PROVIDER`` / ``JAROKU_MODEL``. The scripted dry-run model is
still reachable, but only as the test suites' stand-in — no product surface offers it.

Note on sampling parameters: no ``temperature`` is passed. Current Claude models (Opus 4.7+,
Sonnet 5, Fable 5) reject ``temperature``/``top_p``/``top_k`` with a 400, so passing it would
break exactly the models a user is most likely to pick.
"""

from __future__ import annotations

import os
from typing import Any, Sequence

from jaroku_interceptor.pricing import price_for

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

# WHICH MODELS STILL TAKE A FIXED THINKING BUDGET, and it is a closed, shrinking set.
#
# `{"type": "enabled", "budget_tokens": N}` was the whole of extended thinking until the 4.6
# generation. It is DEPRECATED on Opus 4.6 / Sonnet 4.6 and REJECTED WITH A 400 on everything
# newer — Opus 4.7, 4.8 and 5, Sonnet 5, Fable 5 — which is the bug this table exists for: the
# runtime sent the old shape to every Anthropic model, so every run on a current model died on
# `"thinking.type.enabled" is not supported for this model`, before a single token was generated.
#
# THE DEFAULT IS THE MODERN SHAPE AND THE EXCEPTIONS ARE NAMED, which is the direction that fails
# safe. A model released after this line is written gets `adaptive` and works; the alternative — an
# allowlist of adaptive models — would greet every new release with the 400 above.
#
# EFFORT IS NOT SENT TO THESE, either: `output_config.effort` errors on Haiku 4.5 and Sonnet 4.5.
# The two halves are one decision, so they are made in one place.
_FIXED_BUDGET_MODELS = frozenset({
    "claude-haiku-4-5",
    # The same snapshot under its dated id, which is the one Anthropic's model table leads with.
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5",
    "claude-opus-4-5",
    "claude-3-5-haiku-latest",
    "claude-3-5-sonnet-latest",
})

# `output_config.effort` takes the level as a NAME, so the server's four levels pass straight
# through. `low` is a real level here rather than "off": thinking is on by default on Opus 5, and
# `{"type": "disabled"}` is both refused above effort `high` and documented to make the model write
# tool calls into its visible text. Lowering effort is the supported way to spend less.
_ADAPTIVE_EFFORT = {"low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh"}

# ROOM FOR THE ANSWER PLUS THE THINKING IT IS SPENT OUT OF. The client's own default is small, and
# a thinking block drawn from the same allowance is how a response gets truncated mid-sentence with
# no error attached — the failure the fixed-budget branch below already doubled `max_tokens` for.
_ADAPTIVE_MAX_TOKENS = 16_000
# OpenAI and Meta take the level as a NAME rather than a budget. WHICH names a model takes is a fact
# in pricing.json (`effort_levels`), read here through the cost callback's own loader so the run
# clamps exactly where effort.ts reports a clamp: the highest level the model lists at or below the
# one asked for. A model that lists none takes the three every such API has taken, so XHigh becomes
# High there — on the run, in the plan and on the metadata row alike.
_EFFORT_ORDER = ("low", "medium", "high", "xhigh")
_THREE_LEVELS = ("low", "medium", "high")


def _named_effort(model_name: str, level: str | None) -> str | None:
    if level is None:
        return None
    price = price_for(model_name)
    accepted = price.effort_levels if price and price.effort_levels else _THREE_LEVELS
    for candidate in reversed(_EFFORT_ORDER[: _EFFORT_ORDER.index(level) + 1]):
        if candidate in accepted:
            return candidate
    return None

# Meta's Model API speaks OpenAI's wire format at its own address.
META_BASE_URL = "https://api.meta.ai/v1"


def _requested_effort() -> str | None:
    level = (os.environ.get("JAROKU_REASONING_EFFORT") or "").strip().lower()
    return level if level in ("low", "medium", "high", "xhigh") else None

# Cheap defaults on purpose: a mis-set provider should cost cents, not dollars. The server
# forwards JAROKU_MODEL explicitly, so these only apply to a hand-run with no model set.
DEFAULT_MODELS = {
    "anthropic": "claude-haiku-4-5",
    "openai": "gpt-5.6-luna",
    "meta": "muse-spark-1.3",
    "fake": "fake-dry-run",
}

#: The providers a run may name. Anything else is the dry-run double, which is what the test
#: suites run on and what a run with no provider set falls back to.
RUN_PROVIDERS = ("anthropic", "openai", "meta")


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

        if model_name in _FIXED_BUDGET_MODELS:
            # `max_tokens` HAS TO RISE WITH THE BUDGET. A thinking block is spent out of the output
            # allowance, so a 12k budget under the client's default ceiling is a response the
            # provider truncates — which reads as the model giving up mid-sentence, with no error
            # attached. No `effort` on this path: these models reject it.
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

        # THE MODERN SHAPE. Thinking is adaptive — the model decides how much to spend — and the
        # level is expressed as effort rather than as a token count.
        effort = _ADAPTIVE_EFFORT.get(level or "")
        if effort:
            return (
                ChatAnthropic(
                    model=model_name,
                    max_tokens=_ADAPTIVE_MAX_TOKENS,
                    thinking={"type": "adaptive"},
                    effort=effort,
                ),
                provider,
                model_name,
            )
        # No level asked for: the provider's own defaults, which on a current model already means
        # adaptive thinking at the default effort. Byte-identical to a run started before any of
        # this existed.
        return ChatAnthropic(model=model_name, max_tokens=_ADAPTIVE_MAX_TOKENS), provider, model_name

    effort = _named_effort(model_name, level)
    named = {"reasoning_effort": effort} if effort else {}

    if provider == "openai":
        from langchain_openai import ChatOpenAI

        # THE RESPONSES API, NOT CHAT COMPLETIONS. GPT-6 Astra answers on Chat Completions but calls
        # tools only through Responses, and every generated agent binds tools — so on the old
        # endpoint the one thing an agent is for would fail. langchain-openai switches on its own
        # only for the `-pro` models, so it is asked for here, for every OpenAI model, rather than
        # left to a prefix list that has never heard of these names. `reasoning_effort` becomes
        # `reasoning.effort` on the way out.
        return ChatOpenAI(model=model_name, use_responses_api=True, **named), provider, model_name

    if provider == "meta":
        from langchain_openai import ChatOpenAI

        # MUSE SPARK IS THE OPENAI CLIENT AT META'S ADDRESS, not a third SDK: Meta's Model API is
        # OpenAI-compatible, key as a Bearer token. Chat Completions rather than Responses, because
        # that is the endpoint that takes the whole transcript every turn — which is what a
        # LangGraph agent sends anyway — where Responses carries state server-side.
        #
        # THE KEY IS PASSED, NEVER LEFT TO THE CLIENT. Unset, `ChatOpenAI` falls back to
        # OPENAI_API_KEY — which would send somebody's OpenAI credential to Meta. Refused by name
        # instead; the server already declines to start a run with no key, so this only fires on a
        # hand-run.
        key = os.environ.get("META_API_KEY")
        if not key:
            raise RuntimeError("META_API_KEY is not set — Muse Spark needs a Meta Model API key")
        # `tool_choice` IS DISABLED because Meta accepts only "auto" and answers "required", "none"
        # or a named function with a 400. Auto is the default whenever tools are bound, so the
        # ordinary agent loses nothing, and a structured-output call that would have forced a
        # function gets the default instead of an error.
        return (
            ChatOpenAI(
                model=model_name,
                base_url=META_BASE_URL,
                api_key=key,
                use_responses_api=False,
                disabled_params={"tool_choice": None},
                **named,
            ),
            provider,
            model_name,
        )

    return build_dry_run_model(tools), "fake", DEFAULT_MODELS["fake"]
