# ADR-003: Split the System into a Python Runtime, a Node Control Plane and a Browser Client

## Status

Accepted. Established in v0.0.1 (16 July 2026), with the browser client added in v0.0.2.

## Context

Jaroku observes agents, and the agent ecosystem it observes is Python. LangGraph, LangChain,
the provider SDKs and every connector library a generated agent would plausibly use are Python
libraries. Meanwhile the product surface is a live, streaming, three-column browser
application, and the orchestration layer between them has to spawn processes, manage a
database, stream files, and talk to several HTTP APIs.

No single runtime is the right answer for all three jobs:

- The **observed side** must be Python, because that is where the agent frameworks are and
  because a generated project has to be a plain Python project the user can copy out.
- The **control plane** needs process management, a WebSocket server, a database, and
  streaming HTTP clients. It also has to be installable with no native build step.
- The **client** is a browser application.

There was also a product constraint that shaped the split. Generated agent projects must be
portable: the README promises that a generated project imports nothing from Jaroku and can be
copied out of the repository and run standalone. That promise is only credible if the
observation machinery lives outside the agent's own process boundary in a way the agent cannot
depend on.

## Decision

Three processes, one direction of data flow.

```
BROWSER          React 19, Vite, Tailwind, Zustand           localhost:5173
    |   one WebSocket, many logical channels
NODE SERVER      process manager, relay, stores              localhost:4317
    |   uv run python -m jaroku_runner <agent>
    |   NDJSON trace events on stdout, control and logs on stderr
PYTHON RUNTIME   jaroku_runner, JarokuTracer, the agent
```

Responsibilities are assigned as follows.

**Python runtime** (`runtime/`) is the observed side. `jaroku_runner` owns all trace wiring:
the stdout guard, the contract check, provider selection, the dry-run model, the checkpointed
debug driver and static graph introspection. `jaroku_interceptor` turns LangChain callbacks
into schema v1 events. The agent itself is plain LangGraph and knows nothing about Jaroku.

**Node server** (`server/`) is the control plane. It spawns and supervises runtime processes,
parses the event stream, persists runs and steps, runs the plan, generate, validate, edit,
evaluate, MCP and deploy pipelines, and relays everything to clients over one WebSocket.

**React client** (`client/`) renders. It holds no authority: every mutation is a command to
the server, and every read is answered by a snapshot the server builds.

The separation is load bearing in both directions. The agent knows nothing about Jaroku, so
generated projects stay portable. Jaroku knows nothing about the agent's internals, so it
observes through LangChain's public callback interface and LangGraph's public `get_graph()`,
never by patching or introspecting private state.

Node 22 or later is required, so the server can use the built-in `node:sqlite` module and
avoid a native build step. Python 3.12 or later is pinned in `runtime/.python-version`, and
`uv` is the runtime's package manager and process launcher.

## Alternatives Considered

### Option 1: Three processes, Python runtime plus Node control plane plus browser client

- Pros
  - Each layer uses the ecosystem that actually has the libraries it needs.
  - The agent process boundary is a real boundary, so portability of generated projects is
    structural rather than a convention.
  - A crashing or hanging agent cannot take the control plane down with it, because it is a
    separate process with a bounded lifetime.
  - Concurrency for evaluations is process-level, which is the simplest correct model for
    running the same agent many times.
  - Observation happens through public interfaces only, so an upgrade to LangGraph does not
    break a private-attribute hack.
- Cons
  - Two languages, two dependency managers, two type systems and two sets of tests.
  - The event schema has to be mirrored by hand in both languages.
  - Cross-language logic (cost accounting in particular) can drift and needs a test that
    asserts both sides compute identical numbers.
  - Development setup requires both toolchains.

### Option 2: All Python, with a Python web server

- Pros
  - One language, one dependency manager, one set of types.
  - No cross-language mirroring of the schema or the pricing table.
  - Direct in-process access to the agent's objects.
- Cons
  - In-process observation makes the portability promise very hard to keep: the easiest
    implementation is one where the agent imports the tracer.
  - A hanging or crashing agent is a hanging or crashing server.
  - Concurrency for the evaluation fan-out becomes a threading or asyncio problem inside the
    same interpreter that is running untrusted generated code.
  - The streaming file protocol, the WebSocket relay and the several HTTP integrations would
    all be rebuilt in a stack chosen for a different reason.

### Option 3: All Node, driving Python only as an opaque script

- Pros
  - One control plane language, one package manager for the server and client.
  - Simple deployment story for the server.
- Cons
  - The tracer has to live somewhere, and the callbacks it needs are Python objects inside the
    agent's process. Observing from Node means reconstructing execution from the outside,
    which is exactly the guessing the product exists to avoid.
  - Graph introspection needs the compiled LangGraph object, which only exists in Python.
  - The dry-run model needs to read each tool's argument schema, which is Python metadata.

## Consequences

### Positive

- Generated projects are genuinely portable. The contract in `runtime/jaroku_runner/contract.py`
  requires three symbols and forbids anything Jaroku, and the validator rejects a generated
  project that imports the host.
- Process isolation gives the evaluation engine a clean concurrency model: N slots, each a
  plain process manager, with slot 0 reserved for the interactive run.
- A run can be killed, timed out, paused at a node boundary or resumed in a fresh process
  without any of that machinery being visible to the agent.
- Each layer's dependency set is minimal and honest. The runtime's base install does not pull
  in connector SDKs; the server's dependency list is five packages.
- The client can be replaced or supplemented without touching either backend, because its only
  interface is the WebSocket command and channel vocabulary.

### Negative

- Two toolchains must be installed to develop, and both must be installed in the right order,
  because the client's test scripts borrow the server's `tsx` binary.
- The event schema, the pricing table format and the safe-agent-id pattern all exist in both
  languages and are kept in sync by tests rather than by a compiler.
- A subprocess boundary means every interaction is serialised, so anything the server wants
  from the runtime needs an explicit protocol. Graph introspection, for example, is its own
  entrypoint printing exactly one JSON object.
- Debugging a failure sometimes requires reading logs from two processes.

### Trade-offs

- Cross-language duplication was accepted in exchange for correct library ecosystems and a
  real portability boundary. Where duplication is dangerous it is tested:
  `runtime/pricing.json` is read by both sides and a test asserts they compute identical
  numbers, and `isSafeAgentId` in TypeScript mirrors `_SAFE_AGENT_ID` in Python.
- Startup latency of a Python process per run was accepted, because a run costs seconds of
  model latency anyway and the isolation is worth far more than the milliseconds.
- The server is a single process with in-process orchestration rather than a distributed
  system. That is correct for the current load and is explicitly revisited when it is not.

## Implementation Notes

- The server spawns `uv run python -m jaroku_runner <agent> <input>` with configuration passed
  as environment variables (`JAROKU_PROVIDER`, `JAROKU_MODEL`, `JAROKU_RUN_ID` and the
  resume and branch variables). Nothing sensitive is passed as an argument, because a process
  table is world readable. See ADR-026.
- `server/src/runPool.ts` holds N process managers. Slot 0 is reserved for the interactive
  run, because pause, resume and branch all assume a single addressable run the user drives.
- Timeouts are opt-in. Evaluation jobs get a wall-clock deadline; interactive runs deliberately
  get none, because a user may be running something genuinely long.
- Static graph introspection spawns `jaroku_runner.graph`, which builds the compiled graph with
  the free dry-run model and never invokes it. See ADR-030.
- Deliberately not in the agent contract: anything named `jaroku`. The validator's first hard
  rule rejects such an import at generation time.
- The client's only server interface is `client/src/lib/socket.ts` plus the small HTTP
  credential exchange in `client/src/lib/auth.ts`.

## Security Considerations

- Process isolation is not a sandbox. Model-written Python executes on the control plane host
  during validation, during graph introspection and during every run, with the same privileges
  as the runtime. This is documented as a known limitation in `SECURITY.md` and in the threat
  model, and it is why the server binds localhost.
- The subprocess boundary does provide useful containment for availability: a wedged or
  crashing agent consumes a pool slot and a deadline, not the server.
- Environment variables carrying credentials are scoped per spawn. The Railway deploy token in
  particular is stripped from every agent subprocess, because an agent needs its own keys and
  does not need a deploy credential.

## Performance Considerations

- One Python process per run. Interpreter start plus imports is a fixed cost of roughly a
  second, which is small next to model latency and is paid in parallel across evaluation slots.
- The pool bounds total concurrency (`JAROKU_EVAL_CONCURRENCY`, default 4) and per-provider
  concurrency is bounded separately, because providers rate limit independently. See ADR-011.
- The server is single threaded. Everything expensive is either a subprocess or an awaited I/O
  call, so the event loop stays responsive while runs execute.
- `node:sqlite` is synchronous, which is why the database interface is asynchronous anyway: it
  is the only shape both drivers can satisfy. See ADR-016.

## Operational Considerations

- Three ports and two toolchains to know about: 5173 for Vite, 4317 for the server, and the
  Python runtime with no port at all.
- The server inherits `PATH` at launch, so installing `uv` or the Railway CLI after starting
  the server requires a restart.
- A dependency-free fallback client is served by the relay itself at
  `http://localhost:4317` (`server/debug-client.html`), which is the fastest way to confirm
  the pipeline is alive without running Vite.
- On startup the server fires one run of the hand-written fixture agent so a fresh checkout
  shows a live trace immediately. `JAROKU_NO_AUTORUN=1` suppresses it.

## Rejected Alternatives

**All Python** was rejected primarily because it makes the portability promise difficult to
keep. The natural implementation of in-process observation is one where the agent imports the
tracer, and once that happens a generated project is no longer a plain LangGraph project. It
also puts untrusted generated code in the same interpreter as the control plane, which turns
an agent crash into a server crash and makes the evaluation fan-out a concurrency problem
inside that interpreter.

**All Node, driving Python as an opaque script** was rejected because the information the
product needs does not exist outside the Python process. The callback stream, the compiled
graph object and each tool's argument schema are Python objects. Reconstructing execution from
outside would mean guessing, and the first principle in the README is that the trace never
guesses.

## Related Decisions

- ADR-002: NDJSON on stdout as the transport, guarded at the file descriptor
- ADR-004: LangGraph as the agent runtime framework
- ADR-005: The generated agent contract
- ADR-011: Evaluations as batches of ordinary runs on a persisted job queue
- ADR-016: A database interface with two drivers
- ADR-023: One WebSocket carrying many logical channels
- ADR-030: Graph topology introspected from the compiled object

## References

- README section "Architecture" and "Repository layout"
- `runtime/jaroku_runner/__main__.py`, `runtime/jaroku_runner/contract.py`
- `server/src/index.ts`, `server/src/processManager.ts`, `server/src/runPool.ts`
- `server/package.json`, `client/package.json`, `runtime/pyproject.toml`
- CHANGELOG v0.0.1 "Foundation, the Core Trace Pipeline" and v0.0.2 "Trace Layer UI"
- Node.js `node:sqlite` documentation, https://nodejs.org/api/sqlite.html
- uv, https://docs.astral.sh/uv/
