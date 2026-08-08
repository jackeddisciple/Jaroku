# ADR-004: Standardise on LangGraph as the Agent Runtime Framework

## Status

Accepted. Established in v0.0.1 (16 July 2026).

## Context

Jaroku generates agents, runs them and traces them. The framework those agents are written in
determines almost everything else about the product: what a trace can contain, whether the
graph view is possible, whether pausing and branching are possible, and whether a generated
project is something a user recognises as their own code.

The requirements the framework had to satisfy:

1. **Observable through a public interface.** The tracer must be able to see model calls, tool
   calls, node transitions and routing decisions without patching internals. A framework whose
   execution is opaque makes the product impossible.
2. **Introspectable topology.** The graph view renders an agent's structure. That structure has
   to be readable from the compiled object rather than parsed out of source code, because
   parsed source is a guess.
3. **Durable checkpointing at node boundaries.** Pause, resume and branch all require a
   framework that can stop between steps and resume from persisted state.
4. **Explicit state.** The state diff view shows what changed at each node, which requires the
   framework to have a state object that is passed through and mutated in an observable way.
5. **Ordinary, readable Python.** A generated project has to look like something a developer
   would have written, so they can read it, edit it and take it with them.
6. **Model injection.** The same project must run on different providers without regeneration,
   so the framework must not require the model to be constructed inside the agent's own code.

## Decision

Generated and hand-written agents are **plain LangGraph** projects, built on `langgraph` with
`langchain-core` and the provider integrations `langchain-anthropic` and `langchain-openai`.
Durable checkpointing uses the official `langgraph-checkpoint-sqlite` saver.

Three properties of LangGraph are used directly and are therefore part of the architecture:

- **LangChain's callback interface.** `JarokuTracer` is a `BaseCallbackHandler`. The mapping
  from callbacks to schema v1 steps is fixed: `on_chat_model_start` or `on_llm_start` plus
  `on_llm_end` becomes an `llm_call`; `on_tool_start` plus `on_tool_end` becomes a
  `tool_call`; `on_chain_start` plus `on_chain_end` for a LangGraph node becomes a
  `state_update`, and for a conditional edge becomes a `router`.
- **`app.get_graph()` and `graph.builder.branches`.** Topology for the graph view is read from
  the compiled object. `builder.branches` is also what lets the tracer classify routers
  exactly rather than heuristically when the compiled graph is passed to it.
- **`StateGraph` recompilation.** The checkpointed debug driver recompiles a twin from the same
  builder with a durable saver and `interrupt_after="*"`, which is what makes pause, resume and
  branch possible without changing the generated contract.

Jaroku deliberately does not use LangGraph's platform, server or persistence services. It uses
the library.

## Alternatives Considered

### Option 1: LangGraph

- Pros
  - Graph-shaped execution with explicit state, which maps directly onto the trace's
    `state_update` and `router` step types.
  - A public callback interface that yields model calls, tool calls and node transitions
    without any patching.
  - `get_graph()` returns real topology from the compiled object, so the graph view never
    guesses.
  - Official checkpointer implementations, and `interrupt_after` support, which pause, resume
    and branch are built on.
  - Very large ecosystem of tool and provider integrations, so connectors are thin.
  - Generated code reads as ordinary Python that a developer can take away.
- Cons
  - Large dependency surface, and a fast-moving one.
  - The callback interface is stable but not a formal contract, so upgrades need checking.
  - Some LangChain abstractions leak into generated code, for example the fact that a
    decorated `@tool` is a `StructuredTool` object and cannot be called as a plain function.
  - Ties the product's observability story to one vendor's public interfaces.

### Option 2: A bespoke agent loop written in-house

- Pros
  - Total control over the execution model, so the trace could be emitted from first
    principles with no adaptation layer.
  - No third-party upgrade risk and a much smaller dependency set.
  - Every abstraction would exist because the product needs it.
- Cons
  - Generated agents would be written in a private framework, which destroys the portability
    promise entirely: a user could not take their project anywhere.
  - Tool integrations, provider integrations, streaming, structured output and checkpointing
    would all be built and maintained in-house.
  - The model would have to be prompted to write code in a framework it has never seen,
    which is materially worse for generation quality than a framework in its training data.

### Option 3: A different established framework, for example a plain LangChain agent executor,
or an assistants-style provider-hosted API

- Pros
  - Simpler mental model for a linear tool-calling loop.
  - Provider-hosted options remove the execution problem entirely.
- Cons
  - A linear executor has no graph, so the graph view and the router step type have nothing to
    describe.
  - No node boundaries, so no durable checkpoint to pause at, resume from or branch at.
  - A provider-hosted agent runs on somebody else's machine, so there is no local execution to
    trace, no state to diff, and the product's whole premise disappears.
  - Provider-hosted also means vendor lock-in at the agent level, which contradicts the
    multi-provider comparison the evaluation engine exists to perform.

## Consequences

### Positive

- The four step types in the frozen schema map one to one onto observable framework events, so
  the trace is a faithful record rather than an interpretation.
- The graph view is exact, because the topology comes from the compiled object.
- Pause, resume and branch were added without changing the generated agent contract, because
  the checkpointed twin is recompiled from the same builder.
- Multi-provider execution is free: `build_graph(llm)` receives an injected model, so the same
  project runs on the dry-run model, on Claude or on GPT with one environment variable.
- Generated projects are recognisable. A user who knows LangGraph can read, edit and deploy
  their agent without learning anything about Jaroku.

### Negative

- The product's observability depends on LangChain's callback interface remaining stable.
  A change there is a change to the trace.
- The dependency set is large, and connector SDKs would make it larger, which is why they are
  an optional extra rather than a base dependency.
- LangChain idioms leak into the generation rules. Hard rule 9, "never call one `@tool` from
  inside another", exists because a decorated tool is a `StructuredTool` and calling it raises
  a `TypeError`. Hard rule 7 requires `ToolNode(TOOLS, handle_tool_errors=True)`.
- Agents written in other frameworks are not supported, and supporting them would mean a
  second tracer and a second introspection path.

### Trade-offs

- Vendor coupling at the observability layer was accepted in exchange for a public interface
  that yields exactly the events the schema needs. The mitigation is that only public
  interfaces are used, so an upgrade is a compatibility check rather than a rewrite.
- Dependency weight was accepted in the base install for LangGraph and both provider
  integrations, and refused for connector SDKs, which lazy-import.
- Router classification accepts imprecision rather than fabricating a label. When the compiled
  graph is available the classification is exact; when it is not, a conservative heuristic
  proposes candidates that must pass an end-time output-shape check, and anything that fails is
  emitted as a `state_update`. See ADR-001.

## Implementation Notes

- Base dependencies in `runtime/pyproject.toml`: `langgraph>=0.2.0`, `langchain-core>=0.3.0`,
  `langchain-anthropic>=0.3.0`, `langchain-openai>=0.2.0`, `langgraph-checkpoint-sqlite>=2.0.0`.
- Connector SDKs are in the `connectors` optional extra and are lazy-imported by each template,
  so the base install and the dry-run path never depend on them.
- Pass the compiled graph to the tracer (`JarokuTracer(run, graph=app)`) wherever it is
  available. That is what turns router classification from a heuristic into a lookup against
  `graph.builder.branches`.
- No sampling parameters are passed when constructing a model. Current Claude models reject
  `temperature`, `top_p` and `top_k` with a 400, so passing them would break the models a user
  is most likely to choose. See `runtime/jaroku_runner/models.py`.
- Generated agents compile a bare graph with no checkpointer. The checkpointed twin is built by
  `runtime/jaroku_runner/debug.py`, so the generated contract stays unchanged.
- A fallback path exists for agents whose graph object does not expose a compatible builder.

## Security Considerations

- LangGraph and LangChain are ordinary third-party dependencies with an ordinary supply chain
  risk. They are pinned by minimum version in `pyproject.toml` and locked in `runtime/uv.lock`.
- Tool execution is where an agent reaches the outside world. The framework does not
  distinguish a reviewed connector from an unread MCP tool, so that distinction is enforced by
  Jaroku: connectors are hand-audited and copied verbatim, and MCP tools are granted per tool
  through a manifest. See ADR-014 and ADR-015.
- Hard rule 7 requires tools to raise on failure rather than return an error string. A returned
  error string is recorded as a *successful* tool call, so the trace shows a green step whose
  content is an error and the model then answers the user from it.

## Performance Considerations

- Import time for LangGraph and the provider integrations is the dominant fixed cost of a run,
  roughly a second. It is paid once per process and in parallel across evaluation slots.
- The checkpointed path writes a durable checkpoint after every node boundary. That is a SQLite
  write per node, which is negligible next to model latency and is the price of resumability.
- `interrupt_after="*"` hands control back between nodes only, and never re-runs a completed
  node, so the checkpointed path produces a trace identical to a plain `.invoke()`.
- Graph introspection builds the compiled object with the dry-run model and never invokes it,
  so it is fast and free regardless of what the agent's tools would do.

## Operational Considerations

- Python 3.12 or later is required and pinned in `runtime/.python-version`.
- `uv sync` installs the base runtime; `uv sync --extra connectors` adds the connector SDKs and
  the MCP client.
- A LangGraph or LangChain upgrade should be validated against the trace-shape suites before it
  lands, because the callback mapping is the thing most likely to be affected.
- Deployed agent images install what the agent actually uses: base LangGraph, the one provider
  SDK it will run on, and each selected connector's declared requirements. An agent with one
  Postgres tool does not pull in the Google API client. See ADR-027.

## Rejected Alternatives

**A bespoke in-house agent loop** was rejected because it would make every generated project a
Jaroku project. The README's promise that "the generated projects import nothing from Jaroku,
they are plain LangGraph you can copy out of the repo and run yourself" is a product
commitment, and a private framework contradicts it directly. It would also require building
and maintaining tool integration, provider integration, streaming and checkpointing, none of
which is the problem the product is trying to solve.

**A linear agent executor or a provider-hosted assistants API** was rejected because neither
has node boundaries. Without node boundaries there is no durable checkpoint, and without a
durable checkpoint there is no pause, no resume and no branching, which are three of the
product's distinguishing features. A provider-hosted agent additionally runs on someone else's
infrastructure, leaving nothing local to trace and no way to compare providers on the same
agent.

## Related Decisions

- ADR-001: Freeze a versioned trace event schema as the product's primitive
- ADR-003: Three process architecture with a Python runtime and a Node control plane
- ADR-005: The generated agent contract
- ADR-010: A checkpointed twin for pause, resume and branch
- ADR-014: Reviewed connector templates copied byte for byte
- ADR-030: Graph topology introspected from the compiled object

## References

- `runtime/pyproject.toml`, `runtime/uv.lock`
- `runtime/jaroku_interceptor/callback.py`, the callback to step mapping
- `runtime/jaroku_runner/models.py`, provider selection and the note on sampling parameters
- `runtime/jaroku_runner/debug.py`, the checkpointed twin
- `runtime/jaroku_runner/graph.py`, topology introspection
- `runtime/agents/example_agent/`, the hand-written reference implementation
- LangGraph documentation, https://langchain-ai.github.io/langgraph/
- LangChain callback documentation, https://python.langchain.com/docs/concepts/callbacks/
