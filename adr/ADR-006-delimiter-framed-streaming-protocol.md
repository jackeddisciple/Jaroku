# ADR-006: Stream Generated Files and Plans Over a Delimiter Framed Protocol

## Status

Accepted. Established in v0.0.3 (21 July 2026) for file emission, extended to plans in v0.1.10.

## Context

Generation produces a complete multi-file Python project from a language model, and the product
shows the files streaming in as they are written. The plan gate produces a structured summary
that is rendered as a card while it streams. Both need a wire format between the model's token
stream and the server's parser.

The obvious choice is JSON, and it is the wrong one here for a specific reason. Streaming
*partial* JSON means every newline in every source file has to be escaped, every quote has to
be escaped, and the parser has to handle a document that is syntactically invalid until the
final token arrives. For code payloads that is both fragile to parse mid-stream and materially
more expensive in tokens, because escaping inflates exactly the content that dominates the
response.

There is a second constraint that matters more for plans than for files. A model does not
always honour a format. If the output format is JSON and the model emits prose, the result is
unparseable and the feature fails. The plan card has to degrade to rendering raw text rather
than failing, because a plan a user can read is worth more than a parse error.

A third constraint is mechanical. A streaming parser is fed arbitrary chunk boundaries. A
delimiter can be split across two chunks, so a naive implementation emits the first half of a
delimiter as file content.

## Decision

Use an explicit, unmistakable delimiter protocol for both streams.

Files:

```
<<<FILE path="agent.py">>>
...contents...
<<<ENDFILE>>>
```

Plans:

```
<<<PLAN section="tools">>>
- gmail_search: reviewed connector template (gmail)
- order_lookup: bespoke; reads order status from Postgres by order id
<<<ENDPLAN>>>
```

Three properties are part of the decision.

**The parser holds back a tail.** `FileProtocolParser` is fed arbitrary chunk boundaries, so it
retains a tail of `delimiter length - 1` characters until it can prove they are content, and
never emits text that might turn out to be the front of a delimiter.

**Parsing degrades, never hard-fails.** Every plan carries its `raw` text, the plan card always
falls back to rendering it, and confirming a plan is never blocked on a successful parse.

**Paths are confined.** Every path the model emits is checked before it becomes a filesystem
operation: absolute paths, `..`, null bytes and anything escaping the staging root are rejected
outright. See ADR-007.

The same discipline appears elsewhere in the codebase and is deliberate: the control plane
between the runner and the server uses a `@@JAROKU_CTRL@@ ` sentinel on stderr, and the trace
transport is newline-delimited JSON. Simple framing that a person can read beats a format that
requires a library, in every place where a stream has to be parsed incrementally.

## Alternatives Considered

### Option 1: Delimiter framed text

- Pros
  - No escaping of file content at all, so source code passes through verbatim.
  - Token efficient for code payloads, which is where the cost is.
  - Parseable incrementally with a small hand-written parser and no dependency.
  - Human readable, so a recorded fixture is a text file a developer can read and edit.
  - Degrades gracefully: unrecognised text is still text, and can be shown to the user.
  - Models follow explicit, unusual delimiters reliably.
- Cons
  - The delimiter must not appear in content. `<<<FILE path="..." >>>` is chosen to be
    improbable, but improbable is not impossible.
  - Chunk-boundary handling is subtle enough to need its own test suite at every boundary.
  - No schema validation for free, so structure has to be checked by hand.
  - A bespoke format rather than a standard one.

### Option 2: Streaming JSON

- Pros
  - A standard format with library support and schema validation available.
  - Structure is unambiguous once the document is complete.
  - No delimiter collision problem.
- Cons
  - Every newline, quote and backslash in every source file must be escaped, which inflates
    the token count of exactly the payload that dominates the response.
  - Partial JSON is invalid JSON, so incremental rendering requires a streaming or lenient
    parser, which is a dependency and a source of subtle bugs.
  - A model that drifts from the format produces an unparseable document rather than
    degraded but useful output.
  - Escaping errors in generated code are invisible until the file is written.

### Option 3: Provider structured output or tool-calling modes

- Pros
  - The provider enforces the schema, so malformed output is impossible.
  - No parser to write and no delimiter to collide.
- Cons
  - Ties the generation path to one provider's feature set, when the product's premise is
    provider comparison.
  - Structured output modes have their own size limits and behaviours around long string
    payloads, which is what a source file is.
  - Streaming partial structured output has the same incremental-parse problem as JSON.
  - Recording and replaying a fixture becomes provider-specific rather than a text file.

## Consequences

### Positive

- Source code streams through verbatim, so what the model wrote is what lands on disk.
- Token cost is lower on the payload that dominates a generation, which is a direct cost saving
  on every build.
- Fixtures are plain text files. `server/fixtures/support_bot.txt` and the plan and edit
  fixtures are readable, editable and diffable, which is what makes the free development path
  practical. See ADR-029.
- The plan card renders something useful even when the model ignores the protocol entirely,
  because the raw text is always carried and always renderable.
- The parser has no dependencies and is exhaustively tested at every chunk boundary
  (`npm run test:protocol`).

### Negative

- The format is bespoke, so anyone reading the code has to learn it. It is documented in the
  README, in `fileProtocol.ts` and in `planProtocol.ts`.
- Delimiter collision is possible in principle. A generated file that legitimately contained
  `<<<ENDFILE>>>` would truncate. This has not occurred and the delimiter was chosen to make
  it improbable, but it is a real limitation rather than an impossibility.
- Structure is validated by hand rather than by a schema, which is more code in the parser.
- Two protocols exist, one for files and one for plans, with similar but not identical shapes.

### Trade-offs

- A bespoke format was accepted in exchange for verbatim content, lower token cost and
  graceful degradation.
- Hand-written parsing was accepted in exchange for no dependency in the path every generation
  takes, which is the same judgement made about the HTTP router and the migration runner.
- Strictness was deliberately traded away on the plan path and kept on the file path. A plan
  that half-parses is still useful; a file that half-parses is a corrupt project, which is why
  file paths are confined and the staged project is validated before it lands.

## Implementation Notes

- `server/src/fileProtocol.ts` holds `FileProtocolParser`, which emits `file_start`,
  `file_delta` and `file_end` events. The tail-holding behaviour is the subtle part: it must
  never emit text that could turn out to be the beginning of a delimiter.
- `server/src/planProtocol.ts` parses plan sections and is written to degrade. Every parse
  result carries the raw text.
- `npm run test:protocol` feeds the parser arbitrary chunk boundaries, including boundaries
  that split a delimiter in every possible position.
- `npm run test:plan` covers plan parsing, degradation and connector reconciliation. One real
  failure it defends against: a plan mentioning "the reviewed connector template" in plain
  prose was previously parsed as if it named a connector called `reviewed`.
- The same protocol carries edit proposals. The edit stream is rejected the moment the model
  opens a read-only path, which is possible precisely because the protocol announces each file
  before its content.
- Every emitted path goes through `safeRelativePath` before it becomes a filesystem operation.

## Security Considerations

- The protocol is a parser fed untrusted model output, so it is a potential injection surface
  onto the filesystem. The mitigation is path confinement, applied to every announced path
  before any write, plus staging so that nothing reaches the live project until validation has
  passed.
- Because file boundaries are explicit, the edit loop can refuse a read-only file the moment it
  is opened rather than after its content has been buffered. That is what makes "the stream is
  rejected the moment the model opens a reviewed connector" implementable.
- The delimiter itself carries no authority. A model emitting `<<<FILE path="/etc/passwd">>>`
  produces a rejected path, not a write.

## Performance Considerations

- Parsing is a linear scan with a bounded lookback of `delimiter length - 1` characters. Memory
  is bounded by the current file's buffered content, not by the whole response.
- Token savings versus escaped JSON are proportional to the newline and quote density of the
  generated code, which for Python source is substantial.
- The stable half of the generation prompt carries a cache breakpoint, so the fixed instruction
  block is billed at the cached rate on repeat generations. See ADR-013 for how cached input is
  priced.
- Chunks are emitted to the client as they are parsed, so perceived latency is the model's
  token rate rather than the completion time.

## Operational Considerations

- To record a fresh fixture, point `JAROKU_GEN_FIXTURE`, `JAROKU_PLAN_FIXTURE` or
  `JAROKU_EDIT_FIXTURE` at a path that does not exist and run a real generation. To replay,
  point it at an existing file.
- A forgotten `JAROKU_PLAN_FIXTURE` is the dangerous one: it feeds stale plan text into a
  *real* generation, so the output is genuinely model-written but built to somebody else's
  plan. The planner logs a loud warning for exactly this reason.
- If generation appears to return the same project every time, a fixture variable is set and
  pointing at an existing file. The server log warns on every replay.

## Rejected Alternatives

**Streaming JSON** was rejected because escaping every newline in every source file is both
fragile to parse mid-stream and materially more expensive in tokens for code payloads. Those
are the two properties that matter most on this path: the content is source code, and it has to
render incrementally. A format that inflates the content and cannot be parsed until it is
complete is the wrong shape for both.

**Provider structured output or tool-calling modes** was rejected because it couples the
generation path to a single provider's feature set. The product's premise is that providers are
comparable and interchangeable, and the generation path should not be the one place where that
stops being true. It would also make fixtures provider-specific rather than plain text files.

## Related Decisions

- ADR-002: NDJSON on stdout as the transport, guarded at the file descriptor
- ADR-007: Staging directories with atomic swap, gated by layered validation
- ADR-008: A plan gate before generation
- ADR-009: The fix loop: full file rewrites, reviewable diffs, snapshot based undo
- ADR-029: Recorded fixtures so the build path is free to develop against

## References

- `server/src/fileProtocol.ts` and `server/src/fileProtocol.test.ts` (`npm run test:protocol`)
- `server/src/planProtocol.ts` and `server/src/planProtocol.test.ts` (`npm run test:plan`)
- `server/src/generator.ts`, `server/src/editor.ts`, `server/src/planner.ts`
- `server/fixtures/`, the recorded generation, plan and edit fixtures
- README sections "The build pipeline" and "Developing for free (fixtures)"
- CHANGELOG v0.0.3 and v0.1.10 "Plan Before Generate"
