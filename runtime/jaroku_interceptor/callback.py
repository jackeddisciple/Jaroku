"""JarokuTracer — the LangChain/LangGraph callback handler that turns agent execution
into Jaroku trace events (doc §5.1 "Event Interceptor", §8).

Mapping:
  on_chat_model_start / on_llm_start  + on_llm_end   -> Step(type="llm_call")
  on_tool_start                       + on_tool_end  -> Step(type="tool_call")
  on_chain_start (langgraph node)     + on_chain_end -> Step(type="state_update")
  on_chain_start (conditional edge)   + on_chain_end -> Step(type="router")

Design notes:
  * ``seq`` is assigned at *start* time, so steps sort in causal start order even though
    each Step is emitted at *end* time (when output/latency/error are known).
  * ``parent_step_id`` is resolved through LangChain's ``parent_run_id`` chain: every
    LangChain run_id is registered to its Jaroku step id at start, so children can look
    up their parent.
  * The tracer must never crash the agent it observes — payload capture is best-effort.

Router capture:
  LangGraph coerces a conditional-edge function with ``trace=True``, so the router *does*
  fire on_chain_start/on_chain_end — nested inside the source node's chain, carrying that
  node's ``metadata.langgraph_node`` and returning the chosen branch from on_chain_end.
  Without the classification below it slips through the ``langgraph_node`` filter and is
  mislabeled as a ``state_update`` of the node, with the branch string in ``state_after``.

  Classification is precise when the compiled graph is supplied (``JarokuTracer(run,
  graph=app)``): ``graph.builder.branches`` yields the exact ``(node, branch_name)`` set.
  Without it, a conservative heuristic proposes candidates that must still pass an
  end-time output-shape check; anything that fails is emitted as a ``state_update``
  exactly as before. A step's ``type`` is only materialized in ``_finish``, so a rejected
  guess costs nothing — not even a ``seq``. Correctness over coverage: the trace must
  never lie.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Optional
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler

from .pricing import cost_for
from .schema import Run, Step, emit_step


class Usage:
    """One LLM call's token breakdown, split the way pricing needs it.

    ``input`` here is the **uncached** input. Providers report a single combined input
    figure with the cached portions folded in; keeping them separate is what lets cache
    reads be billed at their own (much cheaper) rate instead of the full input rate.

    ``total`` is what the frozen schema's ``Step.tokens`` carries — every token the call
    consumed, cached or not. That definition is unchanged.
    """

    __slots__ = ("input", "output", "cache_read", "cache_write")

    def __init__(self, input_: int, output: int, cache_read: int = 0, cache_write: int = 0):
        self.input = input_
        self.output = output
        self.cache_read = cache_read
        self.cache_write = cache_write

    @property
    def total(self) -> int:
        return self.input + self.output + self.cache_read + self.cache_write


class _Pending:
    __slots__ = ("step_id", "seq", "type", "name", "input", "state_before", "t0", "parent",
                 "router_ends", "node")

    def __init__(self, step_id, seq, type_, name, input_, state_before, t0, parent,
                 router_ends=None, node=None):
        self.step_id = step_id
        self.seq = seq
        self.type = type_
        self.name = name
        self.input = input_
        self.state_before = state_before
        self.t0 = t0
        self.parent = parent
        # Router-only: the branch's {returned_value -> destination_node} map, when known.
        self.router_ends = router_ends
        # Router-only: the source node the conditional edge hangs off.
        self.node = node


def _branch_index(graph: Any) -> Optional[dict[tuple[str, str], dict]]:
    """Map ``(source_node, branch_name) -> ends`` from a compiled LangGraph.

    ``ends`` is the branch's path_map (``{"tools": "tools", "__end__": "__end__"}``) or None.
    Returns None if the graph doesn't expose branches — introspection is best-effort and
    must never raise into the observed agent.
    """
    try:
        branches = graph.builder.branches
        index: dict[tuple[str, str], dict] = {}
        for source, specs in branches.items():
            for branch_name, spec in specs.items():
                index[(str(source), str(branch_name))] = dict(getattr(spec, "ends", None) or {})
        return index
    except Exception:
        return None


class JarokuTracer(BaseCallbackHandler):
    def __init__(self, run: Run, graph: Any = None, seq_start: int = 0):
        self.run = run
        # `seq` is monotonic per run starting at 0 for a fresh run. A resumed/branched run is a
        # NEW subprocess (new tracer) continuing the SAME run's timeline, so it must start where
        # the prior segment left off — the server passes the run's current max seq + 1. The
        # emitted Step shape is unchanged; only the starting integer differs, preserving the
        # frozen schema's "seq ascending 0..N per run" guarantee across a pause/resume boundary.
        self._seq = seq_start
        self._pending: dict[UUID, _Pending] = {}
        self._runid_to_stepid: dict[UUID, str] = {}
        # None => no graph supplied; fall back to the heuristic + end-time validation.
        self._branches = _branch_index(graph) if graph is not None else None

    # ---- helpers -------------------------------------------------------------
    def _next_seq(self) -> int:
        s = self._seq
        self._seq += 1
        return s

    def _parent_step(self, parent_run_id: Optional[UUID]) -> Optional[str]:
        if parent_run_id is None:
            return None
        return self._runid_to_stepid.get(parent_run_id)

    def _begin(self, run_id, parent_run_id, type_, name, input_, state_before=None,
               router_ends=None, node=None) -> None:
        step_id = str(uuid.uuid4())
        self._runid_to_stepid[run_id] = step_id
        self._pending[run_id] = _Pending(
            step_id=step_id,
            seq=self._next_seq(),
            type_=type_,
            name=name,
            input_=input_,
            state_before=state_before,
            t0=time.perf_counter(),
            parent=self._parent_step(parent_run_id),
            router_ends=router_ends,
            node=node,
        )

    def _finish(self, run_id, *, output=None, state_after=None, tokens=None,
                cost=None, error=None, type_=None, name=None) -> None:
        pend = self._pending.pop(run_id, None)
        if pend is None:
            return
        step = Step(
            id=pend.step_id,
            run_id=self.run.id,
            seq=pend.seq,
            type=type_ or pend.type,
            name=name or pend.name,
            input=pend.input,
            output=output,
            state_before=pend.state_before,
            state_after=state_after,
            tokens=tokens,
            cost=cost,
            latency_ms=round((time.perf_counter() - pend.t0) * 1000, 3),
            error=error,
            parent_step_id=pend.parent,
        )
        emit_step(step)

    # ---- LLM -----------------------------------------------------------------
    def on_chat_model_start(self, serialized, messages, *, run_id, parent_run_id=None,
                            **kwargs) -> None:
        name = (serialized or {}).get("name") or "chat_model"
        self._begin(run_id, parent_run_id, "llm_call", name, input_=messages)

    def on_llm_start(self, serialized, prompts, *, run_id, parent_run_id=None,
                     **kwargs) -> None:
        name = (serialized or {}).get("name") or "llm"
        self._begin(run_id, parent_run_id, "llm_call", name, input_=prompts)

    def on_llm_end(self, response, *, run_id, **kwargs) -> None:
        usage = self._extract_usage(response)
        tokens = None if usage is None else usage.total
        cost = None if usage is None else cost_for(
            self.run.model,
            input_tokens=usage.input,
            output_tokens=usage.output,
            cache_read_tokens=usage.cache_read,
            cache_write_tokens=usage.cache_write,
        )
        if tokens is not None:
            self.run.tokens += tokens
        if cost is not None:
            self.run.cost = round(self.run.cost + cost, 8)
        self._finish(run_id, output=self._extract_generations(response),
                     tokens=tokens, cost=cost)

    def on_llm_error(self, error, *, run_id, **kwargs) -> None:
        self._finish(run_id, error=self._fmt_error(error))

    # ---- Tools ---------------------------------------------------------------
    def on_tool_start(self, serialized, input_str, *, run_id, parent_run_id=None,
                      inputs=None, **kwargs) -> None:
        name = (serialized or {}).get("name") or "tool"
        # The schema says a tool_call's `input` is its ARGS. LangChain hands us both a
        # stringified `input_str` (a bare `str(dict)`, so Python repr — single quotes,
        # `None`/`True`, and no way back to the values) and the structured `inputs` dict
        # it was built from. Record the dict when there is one: it is the same information
        # unflattened, so the detail panel, the state diff and the JSON export all read
        # real args instead of a string that only looks like them.
        self._begin(run_id, parent_run_id, "tool_call", name,
                    input_=inputs if isinstance(inputs, dict) else input_str)

    def on_tool_end(self, output, *, run_id, **kwargs) -> None:
        self._finish(run_id, output=output)

    def on_tool_error(self, error, *, run_id, **kwargs) -> None:
        self._finish(run_id, error=self._fmt_error(error))

    # ---- Chains / LangGraph nodes & conditional edges ------------------------
    def on_chain_start(self, serialized, inputs, *, run_id, parent_run_id=None,
                       metadata=None, **kwargs) -> None:
        node = (metadata or {}).get("langgraph_node")
        if not node:
            # Not a graph node (top-level graph, RunnableSequence, etc.) — skip.
            return
        chain_name = kwargs.get("name") or (serialized or {}).get("name")

        ends = self._router_ends(node, chain_name, parent_run_id)
        if ends is not None:
            # A conditional edge. `input` is the state it reads; a router does not mutate
            # state, so state_before/state_after stay null. Provisional until on_chain_end
            # confirms the output really is a branch destination.
            self._begin(run_id, parent_run_id, "router", chain_name or "router",
                        input_=inputs, router_ends=ends, node=node)
            return

        self._begin(run_id, parent_run_id, "state_update", node,
                    input_=inputs, state_before=inputs)

    def _router_ends(self, node, chain_name, parent_run_id) -> Optional[dict]:
        """Return the branch's `ends` map if this chain is a conditional edge, else None.

        Precise when the compiled graph was supplied; otherwise a conservative heuristic
        whose guess is still re-checked against the output shape at end time.
        """
        if not chain_name or chain_name == node:
            # The node's own chain is never a router.
            return None
        if self._branches is not None:
            return self._branches.get((str(node), str(chain_name)))
        # Heuristic: a direct child of the source node's own chain. Anything deeper (a
        # nested LCEL chain, a sub-runnable) is not a conditional edge.
        parent = self._pending.get(parent_run_id) if parent_run_id is not None else None
        if parent is not None and parent.type == "state_update" and parent.name == node:
            return {}
        return None

    @staticmethod
    def _as_destinations(outputs) -> Optional[list[str]]:
        """Coerce a router return value to a list of branch labels, or None if it isn't one.

        A conditional edge returns a destination (or a list of them). A node returns its
        state update — a dict. Rejecting anything non-string-shaped is what keeps a
        misclassified chain from being emitted as a bogus router.
        """
        if isinstance(outputs, str):
            return [outputs]
        if isinstance(outputs, (list, tuple)) and outputs and \
                all(isinstance(o, str) for o in outputs):
            return list(outputs)
        return None

    def on_chain_end(self, outputs, *, run_id, **kwargs) -> None:
        pend = self._pending.get(run_id)
        if pend is None:
            return
        if pend.type == "router":
            dests = self._as_destinations(outputs)
            if dests is None:
                # Not a routing decision after all — emit as the state_update it would
                # have been, same seq, same payloads. Never corrupt the trace on a guess.
                self._finish(run_id, output=outputs, state_after=outputs,
                             type_="state_update", name=pend.node or pend.name)
                return
            ends = pend.router_ends or {}
            chosen = [str(ends.get(d, d)) for d in dests]
            self._finish(run_id, output=", ".join(chosen))
            return
        self._finish(run_id, output=outputs, state_after=outputs)

    def on_chain_error(self, error, *, run_id, **kwargs) -> None:
        if run_id not in self._pending:
            return
        self._finish(run_id, error=self._fmt_error(error))

    # ---- extraction utils ----------------------------------------------------
    @staticmethod
    def _fmt_error(error: BaseException) -> str:
        return f"{type(error).__name__}: {error}"

    @staticmethod
    def _extract_generations(response) -> Any:
        try:
            gens = response.generations
            out = []
            for batch in gens:
                for g in batch:
                    msg = getattr(g, "message", None)
                    if msg is not None:
                        item: dict[str, Any] = {"content": getattr(msg, "content", None)}
                        tool_calls = getattr(msg, "tool_calls", None)
                        if tool_calls:
                            item["tool_calls"] = tool_calls
                        out.append(item)
                    else:
                        out.append(getattr(g, "text", None))
            return out
        except Exception:
            return None

    @staticmethod
    def _first_int(d: dict, *keys) -> Optional[int]:
        """First key present with a non-None value, as an int.

        Deliberately not ``d.get(a) or d.get(b)``: a genuine ``0`` is falsy, so the ``or``
        form silently skips a real zero and reads the wrong provider's key instead.
        """
        for k in keys:
            v = d.get(k)
            if v is not None:
                try:
                    return int(v)
                except (TypeError, ValueError):
                    return None
        return None

    @classmethod
    def _extract_usage(cls, response) -> Optional[Usage]:
        """Token breakdown for one LLM call, or None if the provider reported nothing.

        Both sources report a combined input figure that INCLUDES cached tokens, so the
        cached portions are subtracted back out here — leaving ``Usage.input`` as the
        uncached input the full rate actually applies to.
        """
        # 1) message.usage_metadata (langchain-core's normalized shape; the only one that
        #    carries the cache breakdown, so it is tried first).
        try:
            inp = out = c_read = c_write = 0
            found = False
            for batch in response.generations:
                for g in batch:
                    um = getattr(getattr(g, "message", None), "usage_metadata", None)
                    if not um:
                        continue
                    found = True
                    inp += int(um.get("input_tokens") or 0)
                    out += int(um.get("output_tokens") or 0)
                    details = um.get("input_token_details") or {}
                    c_read += int(details.get("cache_read") or 0)
                    c_write += int(details.get("cache_creation") or 0)
            if found:
                # input_tokens is the total input incl. cache; recover the uncached part.
                # clamp at 0 — a provider that reports these independently must not push
                # the uncached figure negative.
                return Usage(max(inp - c_read - c_write, 0), out, c_read, c_write)
        except Exception:
            pass
        # 2) llm_output.token_usage / usage (raw provider shape; no cache breakdown, so
        #    everything counts as uncached input — the conservative direction).
        try:
            llm_out = response.llm_output or {}
            raw = llm_out.get("token_usage") or llm_out.get("usage") or {}
            it = cls._first_int(raw, "prompt_tokens", "input_tokens")
            ot = cls._first_int(raw, "completion_tokens", "output_tokens")
            if it is not None or ot is not None:
                return Usage(it or 0, ot or 0)
        except Exception:
            pass
        return None
