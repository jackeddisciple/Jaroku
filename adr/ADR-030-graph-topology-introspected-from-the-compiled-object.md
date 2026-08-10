# ADR-030: Introspect Graph Topology From the Compiled Object, Never From Source or Names

## Status

Accepted. Introduced in v0.1.1 (23 July 2026), with the visual rework in v0.1.2.

## Context

The graph view renders an agent's structure: its nodes, its edges, which edges are conditional and
what condition they branch on. It also syncs with a live trace, highlighting the node currently
executing and, after a run, showing which edges were actually traversed.

Both halves can be done badly in ways that look fine.

**Topology can be guessed from source.** Parsing `agent.py` for `add_node` and `add_edge` calls
gives a plausible graph. It is wrong whenever the graph is built conditionally, whenever nodes are
added in a loop, or whenever a helper function does the adding, and there is no indication that it
is wrong.

**Step-to-node mapping can be guessed from names.** A step called `call_model` and a node called
`call_model` look like a match. They are not necessarily the same thing, and any steps whose names
collide are mismapped silently.

There are two further constraints. The frozen event schema carries no topology and must not gain
any (ADR-001), so the graph's data has to come from somewhere else entirely. And whatever produces
it must not *run* the agent, because building a graph should not call anybody's API, cost money or
have side effects.

## Decision

**Topology is read from the real compiled LangGraph object, through LangGraph's own public
interface.**

`runtime/jaroku_runner/graph.py` is a separate entrypoint, deliberately not part of the trace
pipeline:

```
uv run python -m jaroku_runner.graph <agent_id>        (cwd: runtime/)
```

It builds the compiled graph with the **free dry-run model**, so there is no API key, no cost and
no execution, then prints the topology from `app.get_graph()` as a **single JSON object on
stdout**, then exits.

The contract with the caller is exact:

- Exactly one JSON line on stdout, then exit.
- Success: `{"agent_id", "nodes": [{"id","type"}], "edges": [{"source","target","conditional",
  "label"}]}`.
- Failure: `{"agent_id", "error": "<message>"}` with a non-zero exit code.
- All human logging goes to stderr, and the agent's own import and build output is redirected to
  stderr too, so stdout stays clean even if generated code prints.

**It never runs the graph.** There is no `.invoke`, so it is safe and instant regardless of what
the agent's tools would do against real APIs.

**The step-to-node mapping was built deliberately rather than by name matching.** Tool call and
model call steps resolve to their enclosing node by walking the step hierarchy through
`parent_step_id`. Router steps resolve to the specific edge they took.

**The same resolution is reused for traversed edges.** The trace-to-graph mapping layer that
already powered live sync answers "which edges did this run actually traverse", rather than a
second mapping being introduced that could drift from the verified one.

**A node that has never run gets the static highlight only**, never a fabricated animation
implying execution that did not happen. The particle that pulses along an edge moves in the real
direction data flowed, for nodes that actually executed in the current trace.

The same public-interface discipline appears in the tracer. Passing the compiled graph
(`JarokuTracer(run, graph=app)`) lets it read `graph.builder.branches` and know precisely which
node and branch pairs are conditional edges. Without it, a conservative heuristic proposes
candidates that must still pass an end-time output-shape check, and anything that fails is emitted
as a `state_update` exactly as before. A step's `type` is only materialised at finish, so a
rejected guess costs nothing, not even a `seq`.

## Alternatives Considered

### Option 1: Introspect the compiled object through a separate non-executing entrypoint

- Pros
  - The topology is the truth, because it comes from the object that will actually run.
  - Correct for graphs built conditionally, in loops, or through helper functions.
  - Uses a public interface, so no private attribute can break on an upgrade.
  - No execution, so no cost, no API key, and no side effects.
  - Completely separate from the trace pipeline, so the frozen schema and transport are untouched.
- Cons
  - Requires spawning a Python process per request, which is slower than parsing a file.
  - Imports the agent, which executes its top-level code.
  - Depends on `get_graph()` remaining available and stable.
  - A second entrypoint with its own single-JSON-line contract to maintain.

### Option 2: Parse the agent's source for graph construction calls

- Pros
  - Fast, with no process spawn.
  - No code execution at all, so no side effects and no import risk.
  - Works even for a project that fails to import.
- Cons
  - Wrong whenever the graph is not built by literal top-level calls, and silently so.
  - Conditional construction, loops and helper functions all defeat it.
  - Would be a second, independent model of what an agent's graph is, which is exactly the kind of
    guess the product's first principle forbids.

### Option 3: Emit topology as part of the trace, on the frozen stream

- Pros
  - No second entrypoint and no extra process.
  - Topology and execution arrive together, already correlated.
- Cons
  - Changes the frozen event schema, which is the one thing that must not change.
  - Only available *after* a run, so an agent that has never run would have no graph.
  - Couples a static property of the agent to a dynamic record of one execution.

## Consequences

### Positive

- The graph view is exact rather than plausible, including conditional edges labelled by their
  branch condition.
- An agent can be inspected before it has ever run, which matters immediately after generation.
- Because introspection never invokes, opening the graph view for an agent whose tools hit real
  APIs is safe and instant.
- The step-to-node mapping resolves by hierarchy rather than by name, so steps with colliding
  names are not mismapped.
- Reusing the verified resolver for traversed edges avoided a second mapping layer that would have
  drifted.
- The frozen schema and transport are untouched, which is what allowed the graph view to be added
  without any schema conversation at all.

### Negative

- A process spawn per graph request, which is hundreds of milliseconds.
- Importing the agent executes its top-level code, so a project with an expensive or failing
  import is slow or produces an error object.
- Depends on LangGraph's `get_graph()` and, for exact router classification, on
  `builder.branches`. Both are public, and both are a third party's public surface.
- A fallback path is needed for graph objects that do not expose a compatible builder.

### Trade-offs

- Latency was traded for correctness, deliberately, because a graph view that is confidently wrong
  is worse than one that takes a moment.
- Importing the agent was accepted as the cost of reading the real object, mitigated by never
  invoking it and by redirecting the agent's own output to stderr.
- Router classification prefers uncertainty to a wrong label: when the compiled graph is
  unavailable and the heuristic's candidate fails its end-time check, the step is emitted as a
  `state_update` rather than as a guessed `router`.

## Implementation Notes

- `runtime/jaroku_runner/graph.py` is the entrypoint. Its contract is one JSON object on stdout
  and nothing else, with all logging on stderr.
- `server/src/graphIntrospect.ts` spawns it and parses the single line. It never runs the graph.
- The dry-run model is used to build the graph, so no API key is required and no provider is
  contacted.
- Because the MCP bridge does file reads only and never network on import, graph introspection
  works for MCP-scoped agents without any server being awake. See ADR-015.
- The client renders with `@xyflow/react` and lays out with `@dagrejs/dagre`.
  `client/src/lib/traceGraphMap.ts` holds the trace-to-graph resolution, including the traversed
  edges resolver.
- Bidirectional selection: clicking a trace step highlights its node, and clicking a node selects
  its step.
- Router steps resolve to the specific edge they took, which is what makes a conditional edge
  highlightable rather than just a line between nodes.
- Pass the compiled graph to the tracer wherever it is available, so router classification is a
  lookup against `builder.branches` rather than a heuristic.

## Security Considerations

- **Introspection imports model-written code.** It does not invoke the graph, but a Python import
  executes top-level code, so this shares the sandbox limitation stated for validation. It is
  named explicitly in the threat model: `graphIntrospect.ts` spawns a Python module, which is
  untrusted code on this machine.
- The agent's own import and build output is redirected to stderr, so stdout stays clean and a
  printing agent cannot corrupt the single JSON line the caller parses.
- Because the dry-run model is used, no provider credential is needed and none is passed to the
  introspection process.
- A failure produces a structured error object with a message rather than a stack trace on
  stdout, so a broken agent yields a readable error rather than an unparseable line.
- Agent ids are validated by the same pattern on both sides before becoming an import path.

## Performance Considerations

- One process spawn per graph request, dominated by Python start and LangGraph import, roughly a
  second.
- The graph is never invoked, so the cost is independent of what the agent's tools would do.
- The result is a single small JSON object, so transport cost is negligible.
- Layout is computed client side with dagre, so re-layout on resize does not require another
  spawn.
- The traversed-edges resolver reuses the existing step-and-edge resolution rather than
  recomputing a second mapping.

## Operational Considerations

- "Could not read graph" usually means `uv` is not on the server's `PATH`, the same cause as
  `spawn uv ENOENT`. The server prepends `/opt/homebrew/bin` and inherits `PATH` at launch.
- A graph error for one agent is that agent's import failing. The error message carries the
  reason.
- The entrypoint is runnable by hand, which is the fastest way to diagnose:
  `uv run python -m jaroku_runner.graph <agent_id>` from `runtime/`, printing exactly one JSON
  object.
- Graph view behaviour was checked by hand against agents with prior runs and agents without, and
  the rule that a never-run node gets no fabricated animation is part of that check.

## Rejected Alternatives

**Parsing the agent's source** was rejected because it is a guess that looks like a fact. It is
correct only for graphs built by literal top-level calls, and it fails silently for conditional
construction, loops and helper functions, which are all ordinary things for a generated or
hand-edited agent to contain. The product's first principle is that the trace never guesses, and a
graph view built on a parse would be a second model of the agent that can disagree with the one
that runs.

**Emitting topology on the frozen trace stream** was rejected because it would change the schema,
which is the one thing that must not change. It would also make the graph unavailable for an agent
that has never run, which is precisely when a user most wants to look at it: immediately after
generation, before deciding whether to run it at all.

## Related Decisions

- ADR-001: Freeze a versioned trace event schema as the product's primitive
- ADR-002: NDJSON on stdout as the transport, guarded at the file descriptor
- ADR-004: LangGraph as the agent runtime framework
- ADR-005: The generated agent contract
- ADR-007: Staging directories with atomic swap, and the shared import risk
- ADR-015: MCP servers treated as untrusted code, and why the bridge never touches the network on
  import

## References

- `runtime/jaroku_runner/graph.py`
- `server/src/graphIntrospect.ts`
- `client/src/components/GraphView.tsx`, `client/src/lib/traceGraphMap.ts`
- `runtime/jaroku_interceptor/callback.py`, router classification via `graph.builder.branches`
- README sections "Try it in 60 seconds" and "The Node server"
- CHANGELOG v0.1.1 "Graph View, Command Palette, and One Click Fix" and v0.1.2
- LangGraph graph inspection documentation, https://langchain-ai.github.io/langgraph/
