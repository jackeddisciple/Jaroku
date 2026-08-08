# ADR-002: Carry Trace Events as NDJSON on stdout, Guarded at the File Descriptor

## Status

Accepted. Established in v0.0.1 (16 July 2026). Hardening against raw file descriptor writes
landed in v0.0.3.

## Context

The Python runtime executes an agent and the Node server observes it. Something has to carry
the trace events between the two processes, and the choice is load bearing because a corrupted
event stream is indistinguishable from a lying product.

The specific hazard is that Jaroku runs **model-written Python**. A generated agent's tool
functions are text produced by a language model, and the generation prompt's third hard rule
is "never write to stdout". A prompt is a request, not an invariant. One stray `print()` in a
generated tool interleaves text with the event stream. In the best case the server reports a
parse error; in the worst case a partial line lands mid-event and silently corrupts a trace
that a user then reads and believes.

Constraints:

1. The server already spawns the runtime as a subprocess (`uv run python -m jaroku_runner`),
   so the pipes exist.
2. Events must appear in the browser the instant they complete. Batching or buffering the
   whole run defeats the product.
3. The runtime must remain independently runnable by hand, so the transport has to be
   inspectable with ordinary shell tools.
4. Ordinary logging still has to go somewhere, and so does the agent's own output.
5. A C-level write from a native extension bypasses `sys.stdout` entirely, so a
   Python-level redirect is not sufficient on its own.

## Decision

**stdout carries trace events and nothing else.** The transport is newline-delimited JSON:
exactly one JSON object per line, one line per event, flushed as it is produced. Everything
else, including all logging, the agent's own output and the pause/resume control plane, goes
to stderr.

The guarantee is enforced at the file descriptor level rather than requested. Before importing
any generated module, `runtime/jaroku_runner/guard.py` performs three steps in order:

1. `os.dup(1)` takes a private copy of the real stdout file descriptor and pins it as the
   event stream. Events keep flowing to the pipe the process manager reads.
2. `os.dup2(2, 1)` repoints file descriptor 1 at stderr, so even a C-level write from a
   subprocess or a native extension lands on stderr.
3. `sys.stdout = sys.stderr` redirects the Python-level view, so a bare `print()` follows.

After that, "write to stdout" and "write to stderr" are the same thing for every line of code
that is not the event emitter. The guard is irreversible by design and idempotent, because a
second installation would duplicate an already-redirected descriptor and send events to
stderr.

The server side reads stdout line by line and parses each line as an event. A malformed or
partial line is reported on the `log` channel and skipped; it never crashes the parser.

## Alternatives Considered

### Option 1: NDJSON on stdout with a file descriptor guard

- Pros
  - No transport dependency, no port, no broker, no serialisation library beyond JSON.
  - Line-oriented, so the stream is inspectable with `jq`, `python3 -m json.tool --json-lines`
    or plain `cat` while a run is in flight.
  - Streaming is native: a line is an event, and a flush is a delivery.
  - The guard makes the invariant structural rather than aspirational, which matters
    precisely because the code being guarded against was written by a model.
  - Works identically when the runtime is run by hand outside the server.
- Cons
  - stdout becomes a reserved channel, which is surprising to anyone who expects to debug with
    `print()`.
  - The guard is a deliberate, irreversible mutation of process state, which is unusual code
    and must be read carefully.
  - Payloads are text, so binary content has to be coerced or named rather than embedded.

### Option 2: A Unix domain socket or a dedicated pipe

- Pros
  - stdout stays free for ordinary output, so nothing needs guarding.
  - Clean separation between the event channel and the process's console.
- Cons
  - Requires path management, cleanup on crash, and a connection lifecycle that has to be
    established before the first event and torn down after the last.
  - The runtime stops being trivially runnable by hand: piping a run into `jq` becomes
    a socket client instead of a pipe.
  - A crashed runtime leaves a socket file behind, which is a new operational failure mode.
  - Does not actually remove the corruption problem, it relocates it: generated code can
    still write to a file descriptor, it just corrupts something else.

### Option 3: A message broker or an HTTP callback per event

- Pros
  - Decouples producer and consumer, and would survive the two running on different machines.
  - Standard, well-understood delivery semantics with retries.
- Cons
  - Adds a service that must be installed and running, which destroys the property that
    `npm run dev` works with nothing installed.
  - Per-event HTTP is a request per step, with latency that shows up directly in the timeline.
  - A broker is the correct answer for a distributed system and the wrong one for a parent
    process reading its own child's pipe.

## Consequences

### Positive

- A generated agent physically cannot corrupt the trace, whatever it prints and however it
  prints it.
- The transport has zero dependencies and zero configuration.
- Debugging the pipeline is possible with shell tools alone, which has repeatedly been the
  fastest way to isolate a problem.
- Because stderr is unreserved, the pause/resume control plane and the MCP confirmation gate
  could both be added later as sentinel-prefixed stderr lines without touching the frozen
  event schema. See ADR-010 and ADR-015.
- Killing a run mid-execution leaves no zombie process and no half-written event, because a
  line is either complete or absent.

### Negative

- Anyone debugging generated code must know that `print()` goes to stderr. This is documented
  in the generation prompt, in the validator's allowance for `print(..., file=sys.stderr)`,
  and in the guard's own docstring.
- The guard mutates global process state, which is the kind of code that looks like a mistake
  to a reader who does not know why it is there. Its docstring is long for that reason.
- Very large payloads pass through a pipe as text and are parsed twice, once at each end.

### Trade-offs

- A reserved stdout was accepted in exchange for an invariant that holds against code nobody
  reviewed.
- Line-delimited text was chosen over a binary framing format because inspectability was
  judged more valuable than density for a local pipeline.
- The guard is deliberately irreversible. Making it restorable would create a path by which
  generated code could turn it off, which is the entire thing it defends against.

## Implementation Notes

- Order of operations in `runtime/jaroku_runner/__main__.py` is load bearing:
  1. `load_env()`
  2. `install_stdout_guard()`, before any generated code is imported
  3. `emit_run_start()`, so a run appears in the UI even if the next step fails
  4. `load_agent()`, which imports and checks the contract
  5. build the model and graph, invoke with the tracer attached
  6. `emit_run_end()` in a `finally`, always
- Steps 3 and 6 bracket everything, so a contract violation, an import error or a crash
  mid-graph surfaces as a run with `status: "error"` rather than as silence.
- The pinned event stream is opened line buffered, so each event lands whole and promptly.
- The validator rejects a bare `print()` in generated files and explicitly allows
  `print(..., file=sys.stderr)`. The prompt asks and the validator enforces. The guard is the
  third layer, for when both are somehow bypassed.
- The server's `processManager.ts` survives non-zero exit, mid-run crash and garbled lines.
  Any unparseable line is surfaced rather than swallowed.
- `runtime/tool_templates/serve.py` is the one reviewed file that deliberately writes to
  stdout, because in a deployed container stdout is the platform's log pane and there is no
  trace stream to protect. See ADR-027.

## Security Considerations

- The guard is a containment boundary against untrusted code, but only for the event stream.
  It does not sandbox the generated code, which still executes with the runtime's privileges.
  That limitation is stated in the threat model and is the subject of planned sandbox work.
- Because stdout is reserved, no credential can be accidentally logged into the trace by an
  agent's own logging. Credentials that appear in an agent's *data*, on the other hand, land
  in step payloads exactly like any other data the agent touched.
- Control plane messages ride on stderr behind a `@@JAROKU_CTRL@@ ` sentinel. Nothing on that
  channel grants access; it carries a sequence number, a checkpoint id and a node list.

## Performance Considerations

- Cost per event is one JSON serialisation, one write, one read and one parse. For typical
  agent runs this is negligible next to the model calls the events describe.
- Line buffering trades a small number of extra syscalls for prompt delivery, which the live
  timeline depends on.
- A very large tool output moves through the pipe as a single long line. MCP results are
  capped at 20,000 characters before reaching a step, and non-text content blocks are named by
  type rather than stringified, which is what stops a base64 image from becoming a multi
  megabyte line.
- Pipe backpressure applies. A consumer that stops reading will eventually block the producer,
  which is correct behaviour and preferable to unbounded buffering.

## Operational Considerations

- Diagnosing a suspected pipeline problem starts with stderr in the server console. A
  completely empty trace almost always means the subprocess never spawned, because
  `run_start` is emitted before the agent is even imported.
- `uv run python -m jaroku_runner <agent> 2>/dev/null | python3 -m json.tool --json-lines`
  pretty prints a live trace, which is the fastest reproduction path for a transport bug.
- On macOS the server prepends `/opt/homebrew/bin` to `PATH` when spawning Python, so a
  Homebrew-installed `uv` is found. `spawn uv ENOENT` is a `PATH` problem, not a transport
  problem.
- Nothing about the transport needs monitoring in production beyond the parse-error count on
  the `log` channel, which should be zero.

## Rejected Alternatives

**A Unix domain socket or dedicated pipe** was rejected because it costs the property that the
runtime is trivially runnable and inspectable by hand, adds a lifecycle and a cleanup path,
and does not actually solve the corruption problem. Generated code can write to any file
descriptor; moving the event stream elsewhere relocates the hazard without removing it. The
file descriptor guard removes it.

**A message broker or per-event HTTP callback** was rejected because it would require a
service to be installed and running before a developer could see a trace. The property that
`npm run dev` works against SQLite with nothing installed and nothing running is one the
project protects deliberately, and no observability feature is allowed to cost it.

## Related Decisions

- ADR-001: Freeze a versioned trace event schema as the product's primitive
- ADR-003: Three process architecture with a Python runtime and a Node control plane
- ADR-005: The generated agent contract
- ADR-007: Staging directories with atomic swap, gated by layered validation
- ADR-010: A checkpointed twin for pause, resume and branch, with a stderr control plane
- ADR-027: Deployment into the user's own hosting account through a reviewed serve template

## References

- `runtime/jaroku_runner/guard.py`
- `runtime/jaroku_runner/__main__.py`
- `runtime/jaroku_interceptor/schema.py`, `bind_event_stream`
- `server/src/processManager.ts`
- `server/src/validator.ts`, the bare `print()` rule
- CHANGELOG v0.0.1 and v0.0.3, stdout hardening against `print()`, `sys.stdout.write()` and
  raw file descriptor writes
- Newline Delimited JSON, https://ndjson.org
- POSIX `dup` and `dup2` semantics, IEEE Std 1003.1
