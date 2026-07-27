"""Model pricing — the Python reader of the shared ``runtime/pricing.json`` table.

The Node server has its own reader (``server/src/pricing.ts``) over the SAME file, so a
per-step cost computed here and a pre-run estimate computed there can never disagree
about what a model costs. Anything that changes a price changes one file.

Three rules this module exists to enforce (doc §8: "wrong cost numbers destroy trust
instantly" — the eval comparison is where that lands hardest):

1. **An unpriced model costs UNKNOWN, not zero.** ``cost_for`` returns ``None``, which
   travels as the schema's nullable ``Step.cost``. A model whose price we don't know
   must never render as free next to one we do — that's not a rounding error, it's a
   different claim.

2. **Matching is exact-then-longest-prefix**, never unordered substring. The old table
   walked a dict and took the first ``key in model`` hit, so a future
   ``claude-haiku-4-5-fast`` could have matched whichever haiku-ish key happened to be
   iterated first. Longest prefix is deterministic and picks the most specific entry.

3. **Cached input is priced as cached input.** Anthropic bills cache reads at ~0.1x and
   cache writes at ~1.25x of the input rate; LangChain folds all three into one
   ``input_tokens`` figure. Charging the full input rate for a cache read overstates
   cost by up to 10x on a caching workload.

Loading is best-effort and never raises into the observed agent: a missing or malformed
table degrades to "every model is unpriced" (null cost), which is honest, rather than to
a guess.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# runtime/pricing.json — sibling of jaroku_interceptor/, like .checkpoints/ and agents/.
PRICING_PATH = Path(__file__).resolve().parent.parent / "pricing.json"

_PER_MILLION = 1_000_000.0

# USD is stored to 8 decimals throughout (0.00000001 — orders of magnitude below any real
# step cost, so per-step rounding can't accumulate into a visible aggregate error).
_USD_DP = 8


@dataclass(frozen=True)
class Price:
    """One model's rates. ``input``/``output`` are USD per MILLION tokens."""

    id: str
    provider: str
    input: float
    output: float
    cache_read_mult: float
    cache_write_mult: float
    free: bool = False


def _load() -> dict[str, Price]:
    try:
        raw = json.loads(PRICING_PATH.read_text(encoding="utf-8"))
        out: dict[str, Price] = {}
        for m in raw.get("models", []):
            try:
                out[str(m["id"])] = Price(
                    id=str(m["id"]),
                    provider=str(m.get("provider", "")),
                    input=float(m["input"]),
                    output=float(m["output"]),
                    cache_read_mult=float(m.get("cache_read_mult", 0.0)),
                    cache_write_mult=float(m.get("cache_write_mult", 1.0)),
                    free=bool(m.get("free", False)),
                )
            except (KeyError, TypeError, ValueError):
                continue  # one bad row must not void the whole table
        return out
    except Exception:
        # No table -> every model is unpriced. Honest, and never fatal to a run.
        return {}


_TABLE: dict[str, Price] = _load()


def price_for(model: str) -> Optional[Price]:
    """The most specific entry for ``model``: exact match, else longest matching prefix."""
    if not model:
        return None
    exact = _TABLE.get(model)
    if exact is not None:
        return exact
    best: Optional[Price] = None
    for key, price in _TABLE.items():
        if model.startswith(key) and (best is None or len(key) > len(best.id)):
            best = price
    return best


def is_priced(model: str) -> bool:
    """Whether a cost can be computed at all for this model."""
    return price_for(model) is not None


def cost_for(
    model: str,
    *,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> Optional[float]:
    """USD for one model call, or ``None`` when the model has no pricing entry.

    ``input_tokens`` is the **uncached** input only — cache reads and cache writes are
    passed separately and priced at their own multipliers. Callers that only have a
    combined figure must subtract the cached portions first (see
    ``JarokuTracer._extract_usage``), or they will overcharge cached tokens at the full
    input rate.
    """
    price = price_for(model)
    if price is None:
        return None
    usd = (
        input_tokens * price.input
        + cache_read_tokens * price.input * price.cache_read_mult
        + cache_write_tokens * price.input * price.cache_write_mult
        + output_tokens * price.output
    ) / _PER_MILLION
    return round(usd, _USD_DP)
