# ADR-001: Freeze a Versioned Trace Event Schema as the Product's Primitive

## Status

Accepted. Established in v0.0.1 (16 July 2026) and unchanged through v0.2.6.

## Context

Jaroku exists to make an agent's execution visible. Most agent frameworks give a developer a
way to *write* an agent and almost no way to *see* one, so a misbehaving agent is debugged by
reading print statements and guessing which tool call went wrong, what the state looked like
before it, and what it cost.

Every feature the product has shipped since is a consumer of the same underlying data:

- the timeline renders it live,
- the state diff view reads `state_before` and `state_after`,
- the evaluation dashboard aggregates it across providers,
- cost figures are summed from it,
- branching forks from a checkpoint correlated to it.

That creates a specific architectural risk. If each of those features reads a slightly
different shape, or if the shape drifts as features land, then two views of the same run
disagree and the product stops being trustworthy. A tracing tool that lies is worse than no
tracing tool, because the user acts on what it says.

The constraints at the time of the decision:

1. Two languages consume the data. The Python interceptor produces it, the TypeScript server
   stores and aggregates it, and the browser renders it. There is no shared type system.
2. The data has to survive persistence and replay. A step read back from SQLite months later
   must be the same shape as one streamed live.
3. Features not yet designed (checkpointing, branching, evaluations, MCP tools, deployments)
   would all want to attach information to a run.

## Decision

Define a single event schema in `schema/events.md`, stamp every event with
`schema_version: 1`, and **freeze it**. Three event kinds, two record types, and nothing else:

```jsonc
{ "kind": "run_start", "schema_version": 1, "run":  Run  }
{ "kind": "step",      "schema_version": 1, "step": Step }
{ "kind": "run_end",   "schema_version": 1, "run":  Run  }
```

A `Run` carries id, agent id, provider, model, status, timestamps, aggregate cost and tokens,
and an error. A `Step` carries id, run id, `seq`, type (`llm_call`, `tool_call`,
`state_update`, `router`), name, input, output, `state_before`, `state_after`, tokens, cost,
latency, error, `parent_step_id` and a start timestamp.

Two ordering guarantees are part of the contract: within a run the sequence is `run_start`,
then steps with `seq` ascending from 0, then `run_end`; and `seq` is assigned at step *start*
time although the step is emitted at end time, so steps sort in causal order regardless of
nesting.

Freezing means every subsequent capability rides **beside** the schema, in new database tables
and new WebSocket channels, rather than inside the event shape. Pause and resume, branching,
the whole evaluation engine, the MCP registry and deployments all did exactly that.

Exactly one storage-layer exception exists and is documented: `workspace_id` on `runs` and
`steps`. Which tenant a row belongs to is a property of the database, not of the event, and it
must never appear in an emitted event.

## Alternatives Considered

### Option 1: A frozen v1 schema with additive features beside it

- Pros
  - Every consumer agrees about the shape, permanently.
  - A step replayed from history is byte-identical in shape to one streamed live.
  - New features cannot break old traces, because they cannot touch the event shape.
  - The freeze is a forcing function: it makes people design the storage for a feature
    rather than smuggling it into a field somebody else parses.
- Cons
  - Genuinely useful fields cannot be added without a version bump that does not yet exist.
  - Some information ends up split across an event and a side table, so a consumer needs both.
  - Discipline has to be enforced by review and by tests, since nothing structural forbids
    adding a field.

### Option 2: An evolving schema with optional fields

- Pros
  - New information can be attached where it naturally belongs.
  - No side tables or extra joins for feature data.
  - Faster to ship any individual feature.
- Cons
  - Every consumer becomes defensive: each field must be treated as possibly absent.
  - Old traces and new traces are different shapes, so replay and live rendering diverge.
  - Cross-language drift is near certain, because Python and TypeScript definitions are
    maintained by hand.
  - Aggregation over a mixed-vintage set of runs silently produces wrong numbers.

### Option 3: A schema registry with negotiated versions

- Pros
  - Formal evolution path, with producers and consumers negotiating a version.
  - Well understood in event-driven systems at scale.
- Cons
  - Substantial machinery for a single-writer, single-reader local pipeline.
  - Requires a registry service or a build-time codegen step across two languages.
  - Solves a compatibility problem the product does not yet have, at a cost paid immediately.

## Consequences

### Positive

- One shape, agreed by four consumers across two languages, for the life of the product.
- Traces recorded in v0.0.1 still render in the current client.
- Evaluation aggregation can join `eval_jobs` against the frozen `steps` table directly, so
  the integration surface between the evaluation engine and the trace pipeline is a single
  foreign key.
- The freeze made the storage boundary explicit and therefore testable. `npm run test:trace`
  asserts both halves: no field named `workspace_id` reaches a Run, a Step or a history
  summary, and every field schema v1 promises is still present.
- Adding a capability is a design conversation about where its data lives, which is a better
  conversation than the one about which field to overload.

### Negative

- Information the schema does not carry needs a second lookup. Checkpoint correlation,
  branch lineage and evaluation attribution all live in additive columns and side tables.
- There is no schema v2 machinery, so the day a genuine breaking change is required, that
  machinery has to be built before the change can land.
- Contributors have to be told the freeze is real. It is stated at the top of `store.ts`,
  `evalStore.ts` and `wsRelay.ts` for that reason.

### Trade-offs

- Stability was chosen over expressiveness, deliberately, because the product's value
  proposition is that the trace is trustworthy.
- Some duplication of concepts across the frozen schema and the control plane tables is
  accepted as the price of never breaking a consumer.
- `parent_step_id` is resolved through LangChain's parent run id chain rather than through a
  structure Jaroku controls, which ties one field of the schema to a third party's public
  interface. That was accepted because the alternative is guessing.

## Implementation Notes

- The schema lives in `schema/events.md`. It is the normative definition; the Python
  dataclasses in `runtime/jaroku_interceptor/schema.py` and the TypeScript types in
  `server/src/types.ts` are mirrors of it, not the other way round.
- `seq` is assigned when a step starts and the step is emitted when it ends. Do not reverse
  this: it is what makes a nested tool call sort after the model call that requested it.
- A step's `type` is only materialised at finish. That is what lets the router heuristic
  propose a classification and withdraw it without consuming a `seq`.
- Consumers sort by `seq`, never by arrival time. The client's `traceStore` keys steps by id
  so re-delivery is idempotent, and renders in `seq` order.
- When adding a feature, the first question is which new table and which new channel it needs.
  If the answer appears to be "a new field on Step", the design is wrong.
- `workspace_id` is kept out of emitted events by naming columns explicitly in every SELECT.
  A `SELECT *` reintroduces the leak silently, which is why `RUN_COLUMNS` and `STEP_COLUMNS`
  exist in `server/src/store.ts` as the enforcement rather than as documentation.

## Security Considerations

- Trace payloads are the most sensitive data in the system. A step's `input` and `output` hold
  whatever the agent touched: mailbox contents, database rows, Slack messages and the user's
  own prompts. The schema is therefore also the definition of what gets persisted, and any
  change to it is a change to the data retention surface.
- The frozen shape is what makes tenant scoping auditable. Because `workspace_id` is a storage
  column that must never appear in an event, a single test can assert the boundary across the
  entire pipeline.
- Payload capture is best-effort and never raises. An unserialisable value falls back to its
  `repr`, so an agent cannot crash the tracer by returning something exotic, and the tracer
  cannot become a denial of service against the agent it observes.

## Performance Considerations

- One JSON object per event, serialised once at the producer and parsed once at the consumer.
  Cost is linear in the size of the payloads, which are the agent's own data.
- Large tool outputs dominate. MCP results are capped at 20,000 characters before they reach a
  step, which bounds the worst case for third-party data.
- Storing payloads as TEXT on SQLite and as JSON on Postgres means the hydration layer is what
  keeps the two drivers indistinguishable, at the cost of a parse on the way out.
- `seq` ordering allows an index-ordered read of a run's steps, so replaying a long run is a
  single ordered scan rather than a sort.

## Operational Considerations

- There is no migration path for the event shape, by design. Operationally this means a trace
  is readable by any version of the product that has ever existed.
- Additive columns on `runs` and `steps` (`parent_run_id`, `branch_from_seq`, checkpoint
  correlation, `workspace_id`) are storage concerns and are applied through the ordinary
  migration runner. See ADR-017.
- Backups of the trace store contain regulated data. Treat a database dump as a dump of user
  mailboxes and database rows, because that is what it is.
- If a schema v2 is ever needed, `schema_version` is already on every event, so the transport
  can carry both and consumers can branch on it. Building that machinery is the prerequisite,
  not an afterthought.

## Rejected Alternatives

**An evolving schema with optional fields** was rejected because it converts every consumer
into a defensive parser and makes aggregation across runs of different vintages quietly wrong.
The product's core claim is that the numbers on the dashboard match reality. A schema where a
field may or may not be present is a schema where "this run has no cost" and "this run's cost
was never recorded" look identical, which is the exact failure ADR-013 exists to prevent.

**A schema registry with negotiated versions** was rejected as disproportionate. The pipeline
has one producer and one authoritative consumer, both in this repository, released together.
A registry solves the coordination problem of independently deployed services, which this is
not, and it would have added a build-time codegen step across Python and TypeScript on day one
of the project.

## Related Decisions

- ADR-002: NDJSON on stdout as the transport, guarded at the file descriptor
- ADR-010: A checkpointed twin for pause, resume and branch, with a stderr control plane
- ADR-011: Evaluations as batches of ordinary runs on a persisted job queue
- ADR-013: One pricing table read by both runtimes, and unknown is never zero
- ADR-018: The workspace as the tenancy unit, with an explicit context argument
- ADR-030: Graph topology introspected from the compiled object

## References

- `schema/events.md`, the normative schema definition
- `runtime/jaroku_interceptor/schema.py`, the Python mirror and NDJSON transport
- `server/src/types.ts` and `server/src/store.ts`, the TypeScript mirror and the trace store
- `server/src/store.test.ts`, run with `npm run test:trace`
- CHANGELOG v0.0.1 "Foundation, the Core Trace Pipeline"
- README section "The event schema"
- RFC 8259, The JavaScript Object Notation (JSON) Data Interchange Format
- RFC 3339, Date and Time on the Internet: Timestamps
