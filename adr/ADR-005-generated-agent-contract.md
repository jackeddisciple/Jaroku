# ADR-005: Define a Three Symbol Agent Contract With an Injected Model and No Host Imports

## Status

Accepted. Established in v0.0.3 (21 July 2026) and unchanged since, including through the
deployment work in v0.2.3 which explicitly did not alter it.

## Context

Jaroku generates Python projects with a language model and then runs them. Two things have to
be true about the result, and they pull in opposite directions.

**The host has to be able to run it.** The runner needs to know how to build the graph, what
tools exist, and how to turn a user's input into an initial state. Without a contract, running
a generated project means introspecting whatever the model happened to write, which is
guessing, and the product's first principle is that it does not guess.

**The user has to be able to take it away.** The README promises that a generated project
imports nothing from Jaroku and can be copied out of the repository and run standalone. That
promise is the difference between a tool that builds agents and a platform that owns them.

There is a third requirement that arrived with the provider comparison feature. The same
project must run on the free dry-run model, on Claude and on GPT without regeneration.
Otherwise the provider dropdown is a rebuild, and comparing providers on the same agent
becomes impossible.

Finally, generated text is untrusted. A contract that is checked only at run time fails three
frames deep with an `AttributeError`, at the moment the user is watching. It needs to be
checkable before the project is allowed to exist.

## Decision

A generated or hand-written agent project exposes exactly three symbols from `agent.py`, and
nothing more:

```python
TOOLS: list                                # every @tool the graph can call
def build_graph(llm): ...                  # returns a COMPILED graph; llm is INJECTED
def build_initial_state(user_input: str) -> dict
```

Three rules follow from that shape and are enforced rather than requested.

**The model is injected, never constructed.** `build_graph` receives an already-configured
model. Provider selection happens once, in `runtime/jaroku_runner/models.py`, from
`JAROKU_PROVIDER` and `JAROKU_MODEL` at spawn time. This is hard rule 2 of the generation
prompt, and the validator rejects a generated file that imports `langchain_anthropic` or
`langchain_openai`.

**Nothing named `jaroku` may be imported.** This is hard rule 1, and it is what makes the
portability promise structural. The validator rejects it across every generated file.

**The contract is checked before the project runs and before it lands.** Server side,
`server/src/validator.ts` checks it against the staging directory before the atomic swap.
Runtime side, `runtime/jaroku_runner/contract.py` verifies it at load and raises a
`ContractError` naming the missing symbol rather than failing deep inside LangGraph.

`runtime/agents/example_agent/` is the hand-written reference implementation of the contract:
two dependency-free tools, a custom `notes` state field, and a system prompt as editable
markdown. It exists so a fresh checkout has something to run before anything has been
generated.

## Alternatives Considered

### Option 1: A minimal three symbol contract with an injected model

- Pros
  - Small enough that a model reliably produces it and a human reliably reads it.
  - Provider selection becomes a host concern, so the provider dropdown works without
    regeneration and the evaluation fan-out can run one project across many providers.
  - Portability is structural: there is nothing to remove before the project runs elsewhere.
  - Checkable statically, so a violation is a validation failure rather than a run-time crash.
  - The host can add capabilities (checkpointing, deployment, MCP grants) without changing it.
- Cons
  - The host cannot pass anything to the agent that is not the model or the input, so any new
    host capability has to be expressed some other way.
  - `build_initial_state` takes a single string, so an agent with structured input needs to
    encode it.
  - A contract is a constraint on generation quality: the prompt has to describe it precisely
    and the validator has to enforce it, and both are maintenance.

### Option 2: A base class or framework the generated agent inherits from

- Pros
  - Richer interface, with lifecycle hooks and shared helpers available to the agent.
  - Easier to add host capabilities later, since the base class can grow.
  - Less prompt engineering, because the shape is expressed in code the model subclasses.
- Cons
  - Ends the portability promise immediately. A project that inherits from a Jaroku class is a
    Jaroku project and cannot be copied out.
  - Couples every generated agent, including ones generated a year ago, to the host's release
    cadence.
  - Encourages the agent to reach into host facilities, which is exactly the coupling the
    three-process split exists to prevent.

### Option 3: No contract, with the host introspecting whatever the model produced

- Pros
  - Maximum freedom for the model, so generation is less constrained.
  - No validator rules to maintain for contract conformance.
- Cons
  - The runner has to guess which function builds the graph and which list holds the tools.
  - A failure surfaces as an `AttributeError` deep in a stack, at run time, in front of a user.
  - Provider injection has nowhere to happen, so the model is constructed inside the agent and
    the provider dropdown becomes a regeneration.
  - Every downstream feature that needs to know an agent's shape (deployment, graph
    introspection, the dry-run model) has to re-derive it independently.

## Consequences

### Positive

- The provider dropdown, the multi-provider evaluation fan-out and the free dry-run path are
  all the same mechanism: a different `llm` handed to the same `build_graph`.
- The dry-run model is schema driven. It walks `TOOLS`, reads each tool's argument schema,
  synthesises one call per tool and then answers plainly, which exercises every generated tool
  function with no API key and no cost.
- Deployment required no contract change at all. The contract already describes a request
  handler, `build_initial_state(text) -> state -> graph.invoke(state) -> answer`, and what was
  missing was a caller that loops rather than a symbol. Every agent ever generated became
  deployable the day `serve.py` landed.
- Pause, resume and branch also required no contract change, because the checkpointed twin is
  recompiled from the same builder.
- A contract violation is caught before the project is written to its final location, with a
  message naming the missing symbol.

### Negative

- Structured input is awkward. `build_initial_state` takes one string, so an agent that wants
  richer input has to encode and decode it.
- Anything the host wants to hand an agent that is not the model or the input has to travel
  another way. MCP grants travel as a host-written `mcp_tools.json` file plus a reviewed
  bridge, not as a contract parameter.
- The contract has to be described in the generation prompt and enforced in the validator, and
  those two must not drift. They are kept in one place each: `server/src/prompt.ts` holds every
  prompt, `server/src/validator.ts` holds every check.
- Hand-written agents must follow it too, which is a small tax on the reference implementation
  and the fixture agent.

### Trade-offs

- Expressiveness was traded for checkability. A three symbol contract is less capable than a
  base class and immeasurably easier to validate, generate reliably and explain.
- The host is forbidden from making the agent's life easier by giving it helpers, and accepts
  the resulting duplication. `serve.py` duplicates twelve lines of provider selection rather
  than importing `jaroku_runner.models`, precisely because importing would end the promise.
- Agent ids are constrained to `^[a-z][a-z0-9_]{0,63}$` because an id becomes both a directory
  name and a Python import path. The pattern is enforced independently on both sides.

## Implementation Notes

- The contract is defined in `runtime/jaroku_runner/contract.py` and mirrored by the checks in
  `server/src/validator.ts`. `REQUIRED_CALLABLES` is `("build_graph", "build_initial_state")`,
  and `TOOLS` must be a list or tuple.
- `validate_agent_id` in Python and `isSafeAgentId` in TypeScript enforce the same pattern. The
  TypeScript version explicitly checks `typeof agentId === "string"` first, because
  `RegExp.test` coerces its argument and previously returned true for `undefined`, `null` and
  `["ok_agent"]`.
- Tools are not bound in `build_model`. They are passed in only so the dry-run model can script
  one call per tool; `build_graph(llm)` calls `llm.bind_tools(TOOLS)` itself, per the contract.
- Host-owned files are written after the model's, so the model cannot shadow them:
  `jaroku.json`, `.env.example`, the top-level `__init__.py`, and for MCP-scoped or deployed
  agents `mcp_tools.json`, `mcp_bridge.py`, `serve.py`, `Dockerfile`, `.dockerignore` and
  `pyproject.toml`.
- All host-owned files are hard read-only to the edit loop. An edit that could rewrite them
  could widen the agent's reach or change what a public container does, with nobody approving
  it. See ADR-009.
- The eleven hard rules in the generation prompt each exist because violating one breaks
  something specific, and each is enforced by the validator rather than merely requested. See
  ADR-007.

## Security Considerations

- Hard rule 4 requires secrets to be read only from `os.environ` and declared in
  `.env.example`. The validator checks that every `os.environ` key referenced appears there, so
  a user can find out what an agent needs without reading its source.
- Hard rule 10 forbids building SQL by interpolation, and the validator enforces it with AST
  analysis requiring actual query shape. This is an injection vector even against a read-only
  connector: a crafted input can widen a `SELECT` to rows the user should never see.
- Hard rule 7 requires tools to raise on failure. A returned error string is recorded as a
  successful tool call, producing a green step whose content is an error that the model then
  answers the user from.
- Because the contract forbids constructing a model, a generated agent cannot silently point
  itself at a different provider or a different endpoint.
- The contract does not sandbox anything. Generated code executes with the runtime's privileges
  during validation, introspection and every run. That limitation is stated in `SECURITY.md`.

## Performance Considerations

- The contract check is a module import plus three `getattr` calls, so its cost is the import
  itself, which the run needs anyway.
- Server-side validation imports the staged project in the project's own virtual environment,
  under a 20 second timeout with stdout captured. That is the most expensive validation step
  and is deliberately last, after every cheaper check has passed.
- Because the model is injected, switching providers costs nothing: no regeneration, no
  revalidation, no rewrite.

## Operational Considerations

- A `ContractError` names the missing symbol. If a user reports "the trace is empty but the
  agent ran", check stderr: `run_start` is emitted before the agent is imported, so an empty
  trace usually means the subprocess never spawned rather than a contract failure.
- `runtime/agents/example_agent/` is tracked in version control; everything else under
  `runtime/agents/` is the user's and is not.
- Every generated project now carries its own `pyproject.toml`, so it is a standalone uv or pip
  project. That was an old debt paid by the deployment work: `example_agent` had always carried
  one and no generated agent did.
- The project is put on `sys.path` in a deployed image rather than installed, because
  `runtime/pyproject.toml` does not ship `agents` in its wheel and installing would produce an
  image where every agent fails to load.

## Rejected Alternatives

**A base class the generated agent inherits from** was rejected because it ends the portability
promise on contact. A project that subclasses a Jaroku type cannot be copied out and run, which
is the single most concrete commitment the README makes about generated code. It would also
couple every previously generated agent to the host's release cadence, so an agent generated
today would break when the base class changed tomorrow.

**No contract at all** was rejected because it converts every downstream feature into an
independent guessing exercise. The runner, the dry-run model, graph introspection, the
validator and the deployment template all need to know an agent's shape, and without a contract
each would re-derive it differently. It also removes the injection point for the model, which
is what makes provider comparison possible without regeneration.

## Related Decisions

- ADR-003: Three process architecture with a Python runtime and a Node control plane
- ADR-004: LangGraph as the agent runtime framework
- ADR-007: Staging directories with atomic swap, gated by layered validation
- ADR-009: The fix loop: full file rewrites, reviewable diffs, snapshot based undo
- ADR-014: Reviewed connector templates copied byte for byte
- ADR-015: MCP servers treated as untrusted code
- ADR-027: Deployment into the user's own hosting account through a reviewed serve template

## References

- `runtime/jaroku_runner/contract.py`
- `runtime/jaroku_runner/models.py`, `runtime/jaroku_runner/fake.py`
- `runtime/agents/example_agent/agent.py`, the reference implementation
- `server/src/validator.ts`, `server/src/prompt.ts`, `server/src/projectFs.ts`
- README sections "The agent contract" and "The build pipeline: plan, generate, validate"
- CHANGELOG v0.0.3 "Jaroku's Generation Layer" and v0.2.3 "Introducing Agent Deployments"
