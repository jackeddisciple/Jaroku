# ADR-010: Drive Runs Through a Checkpointed Twin, With the Control Plane on stderr

## Status

Accepted. Foundation in v0.1.3, pause and resume in v0.1.4, branching in v0.1.5 and v0.1.6
(24 July 2026).

## Context

The product's debugging story requires three capabilities that a plain `.invoke()` cannot
provide: pausing a run mid-graph, resuming it later, and forking a new run from any completed
node boundary with an optionally edited state.

The obstacle is the agent contract. A generated agent's `build_graph(llm)` returns a bare
compiled graph with no checkpointer, deliberately, because the contract must stay minimal and
portable (ADR-005). A plain invoke of that graph leaves nothing on disk to resume from, and
adding a checkpointer to the contract would mean every generated project carried machinery that
exists for the host's benefit.

There is a second constraint that is easy to underestimate. Pause, resume and branch need
bidirectional control messaging between the server and the runner: the runner must report where
it has got to and which checkpoint it just wrote, and the server must be able to tell it to
stop. stdout is reserved for the frozen trace stream (ADR-002), so the control plane needs to
live somewhere else entirely.

The third constraint is the strictest. A trace produced by the debuggable path must be
identical to a trace produced by an ordinary run. If the two differ, then either the debugging
tools are showing something the normal path would not have done, or the normal path is not what
the user is debugging.

## Decision

**Recompile a checkpointed twin from the same builder.** `runtime/jaroku_runner/debug.py` takes
the compiled graph's own `StateGraph` builder and recompiles it with a durable `SqliteSaver` and
`interrupt_after="*"`, then drives it with a stream loop rather than a single blocking invoke.
One checkpoint database per run, stored under `runtime/.checkpoints/<run_id>.sqlite`.

The generated contract is unchanged. Generated agents still compile a bare graph with no
checkpointer. A fallback path exists for graph objects that do not expose a compatible builder.

**The load-bearing guarantee: the trace from this path is identical to a plain invoke.** Same
nodes, same callbacks, same `seq`, because the interrupt only hands control back between nodes
and never re-runs a completed node. What changes is that every node boundary now leaves a
durable checkpoint on disk. This was verified by comparing checkpointed and non-checkpointed
runs of the same agent step for step.

**The control plane is entirely off the frozen stdout stream.**

- Runner to server: one `@@JAROKU_CTRL@@ {json}` line per boundary on **stderr**, carrying
  `seq_high`, `checkpoint_id` and the next nodes. The server correlates the checkpoint to the
  steps it covers.
- Server to runner: a per-run `<run_id>.control` file the runner reads at each boundary.

**Three operations, with precise semantics.**

| Action | Behaviour |
|---|---|
| Pause | The live run halts at its next node boundary. Its status becomes `paused`, which is a store-only status and never an emitted event. The process exits **without** a `run_end`, so the run stays open. |
| Resume | A fresh subprocess continues the **same run id**, with `seq` starting where the paused segment left off. No `run_start`, and no completed node is re-run. |
| Branch | Forks a **new run** from a parent's checkpoint at a step's node boundary, optionally with a validated domain-field edit applied to the state first. The parent's step rows are copied verbatim into the branch, and its checkpoint database is physically copied. |

Branching is always at a whole-node boundary, never mid-node. The parent is never mutated and
both runs stay fully inspectable. Lineage is recorded on the run row through `parent_run_id`
and `branch_from_seq`, which are additive storage columns rather than schema fields.

`messages` is read-only when editing state before a branch, because an arbitrary edit to the
message history can produce an invalid resume. All other domain state fields are editable as
JSON and are validated as part of the fork.

## Alternatives Considered

### Option 1: A checkpointed twin recompiled from the same builder

- Pros
  - The generated contract is untouched, so portability is preserved and no agent needs
    regenerating.
  - The trace is provably identical to the ordinary path, because the same callbacks fire in
    the same order.
  - Uses LangGraph's official checkpointer and its public interrupt mechanism, so nothing is
    patched.
  - Per-run checkpoint databases mean a branch can physically copy one and never touch its
    parent's.
- Cons
  - Requires the compiled graph to expose a usable `StateGraph` builder, so a fallback path is
    needed.
  - A SQLite write per node boundary, which is storage and I/O the ordinary path would not do.
  - Checkpoint databases are artifacts that accumulate and have to be swept.
  - Two execution drivers exist in the runner, and they must not diverge.

### Option 2: Put a checkpointer in the generated agent's own graph

- Pros
  - Simplest possible implementation: the graph is already checkpointed when it arrives.
  - No twin, no recompilation, no builder dependency.
- Cons
  - Changes the agent contract, so every generated project carries host machinery and the
    portability promise weakens.
  - Every previously generated agent would need regeneration to become debuggable.
  - A copied-out project would carry a checkpointer it did not ask for and a storage path it
    does not control.

### Option 3: Re-execute from the start with recorded inputs, rather than checkpointing

- Pros
  - No checkpoint storage at all, and no framework dependency on interrupts.
  - Conceptually simple: replay the same inputs.
- Cons
  - Re-executes completed nodes, which spends money again and can produce different results
    with a non-deterministic model.
  - Cannot represent a pause: there is no durable state to be paused at.
  - A branch would not be a fork from a state, it would be a fresh run with edited inputs,
    which is a different and much weaker feature.

## Consequences

### Positive

- Pause, resume and branch were added without changing the frozen event schema, the agent
  contract, or a single generated project.
- A branch is a first-class run with its own history and its own checkpoint database, so both
  the parent and the branch stay fully inspectable.
- The prefix copy means a branch shows its inherited steps immediately, rather than appearing
  empty until it produces new ones.
- Run history renders lineage with indentation and `branch @<seq>` labels, so the relationship
  between a run and its parent is visible.
- Because the control plane is on stderr behind a sentinel, the same mechanism was reused
  unchanged for the MCP first-use confirmation gate. See ADR-015.

### Negative

- Checkpoint databases accumulate under `runtime/.checkpoints/` and need sweeping.
- A checkpoint per node boundary is a write per node, which the ordinary path would not perform.
- The runner has two drivers, the plain path and the checkpointed path, and a change to one
  must be considered against the other.
- Resume depends on the checkpoint still existing. A run that predates checkpointing, or whose
  checkpoint was swept, cannot be branched, and the error says so.
- A paused run is an open run with no `run_end`, which is a state the rest of the system has to
  understand.

### Trade-offs

- Storage and a per-node write were traded for resumability, which is the price of the feature.
- `messages` was made read-only rather than editable, accepting a reduced capability in exchange
  for never producing an invalid resume.
- Checkpoint sweeping is selective rather than universal: finished evaluation jobs are swept,
  and an interactive run's checkpoint is never swept, because it is exactly the thing a user
  might come back to branch from.

## Implementation Notes

- `runtime/jaroku_runner/debug.py` holds the driver. `CTRL_SENTINEL` is `"@@JAROKU_CTRL@@ "` and
  every control line goes to stderr.
- Checkpoints and control files live in `runtime/.checkpoints/`, which is gitignored.
- `JAROKU_RUN_ID` is minted by the server before the process starts, so a run can be addressed
  and paused before `run_start` races back. `JAROKU_RESUME_RUN_ID`, `JAROKU_SEQ_OFFSET`,
  `JAROKU_BRANCH_CHECKPOINT_ID`, `JAROKU_BRANCH_THREAD_ID`, `JAROKU_BRANCH_EDIT_FILE` and
  `JAROKU_BRANCH_EDIT_NODE` carry the rest.
- The tracer accepts a starting `seq` offset, which is what makes a resumed segment continue the
  run's numbering exactly.
- `server/src/processManager.ts` separates the control line from ordinary stderr into its own
  typed event, so ordinary logging is untouched.
- Branching copies the parent's step rows verbatim with relationships remapped, and physically
  copies the checkpoint database. The parent's database is only ever read.
- Additive columns on `runs` and `steps` carry checkpoint correlation and lineage. They are
  storage concerns; the emitted events are unchanged.
- Known quirk, documented at the time: a paused and resumed run against the free dry-run model
  can come out slightly longer, because that model's scripted responses reset position when the
  process restarts. A real model resumes exactly, and trace causality holds either way.

## Security Considerations

- Checkpoint databases contain the agent's full state at every node boundary, which means they
  contain whatever the agent touched. They are as sensitive as trace payloads and live under a
  gitignored directory on the host.
- The control file is a per-run file in a directory the server owns. Nothing on the control
  channel grants access; it carries a sequence number, a checkpoint id and a node list.
- State edits before a branch are validated. `messages` is refused outright, and domain fields
  are parsed as JSON before being applied, so an edit cannot inject arbitrary structure into a
  resume.
- A branch never mutates its parent. This is enforced physically, by copying the checkpoint
  database rather than sharing it, which is stronger than a convention about not writing.

## Performance Considerations

- One SQLite write per node boundary. Negligible next to model latency, and it is the entire
  cost of resumability.
- `interrupt_after="*"` hands control back between nodes only. No completed node is ever
  re-executed, so the checkpointed path costs the same model spend as the plain path.
- Branching physically copies a checkpoint database. These are small, bounded by the run's
  state size.
- Checkpoint sweeping runs when an evaluation finishes and again at startup for orphans, so the
  directory does not grow without bound under evaluation load.

## Operational Considerations

- `runtime/.checkpoints/` holds `<run_id>.sqlite` files and pause control files, and is
  gitignored.
- Sweeping removes only the resumable-checkpoint blobs left by finished evaluation jobs; the
  traces stay, because nobody resumes a finished evaluation job. Interactive run checkpoints are
  never swept.
- "No durable checkpoint for that step" means the run predates checkpointing or its checkpoint
  was swept. Re-run the agent interactively and branch from the new run.
- A paused run stays open until it is resumed. A server restart closes out runs it interrupted,
  so a run does not stay permanently in flight.

## Rejected Alternatives

**Putting a checkpointer in the generated agent's own graph** was rejected because it changes
the agent contract. Every generated project would carry a checkpointer and a storage path that
exist for the host's benefit, which weakens the promise that a generated project is plain
LangGraph the user can copy out. It would also mean every agent generated before the change
needed regenerating to become debuggable, whereas the twin made every existing agent debuggable
immediately.

**Re-execution from the start with recorded inputs** was rejected because it re-runs completed
nodes. That spends money again, produces different results with a non-deterministic model, and
cannot represent a pause at all, since there is no durable state to pause at. It would also
reduce branching from "fork this exact state" to "run again with different inputs", which is a
substantially weaker feature and would not support editing the state at a boundary.

## Related Decisions

- ADR-001: Freeze a versioned trace event schema as the product's primitive
- ADR-002: NDJSON on stdout as the transport, guarded at the file descriptor
- ADR-004: LangGraph as the agent runtime framework
- ADR-005: The generated agent contract
- ADR-011: Evaluations as batches of ordinary runs on a persisted job queue
- ADR-015: MCP servers treated as untrusted code
- ADR-023: One WebSocket carrying many logical channels

## References

- `runtime/jaroku_runner/debug.py`
- `runtime/jaroku_interceptor/callback.py`, the `seq` offset parameter
- `server/src/processManager.ts`, `server/src/index.ts` (pause, resume, branch handling)
- `server/src/evalCleanup.ts` and `server/src/evalCleanup.test.ts` (`npm run test:cleanup`)
- `client/src/components/PauseResumeControls.tsx`, `client/src/components/StateBranchEditor.tsx`
- README section "Debug depth: pause, resume, branch"
- CHANGELOG v0.1.3, v0.1.4, v0.1.5, v0.1.6
- LangGraph persistence and checkpointer documentation,
  https://langchain-ai.github.io/langgraph/concepts/persistence/
