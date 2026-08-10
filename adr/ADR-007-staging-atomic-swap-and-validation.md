# ADR-007: Stage Generated Projects and Promote Them by Atomic Swap After Layered Validation

## Status

Accepted. Established in v0.0.3 (21 July 2026). The import check was added in v0.1.0 after a
real generation shipped a project that parsed and crashed on import.

## Context

Generation writes a complete Python project produced by a language model into the user's
filesystem. Editing rewrites files in an existing project the same way. Both operations can
fail in several ways that have nothing in common:

- the stream can be truncated by a network failure or a cancelled request,
- the model can emit a path that escapes the project directory,
- the model can produce code that violates a rule the product depends on,
- the model can produce code that parses and then fails on import,
- the server can crash halfway through writing.

If any of those happen while writing directly into `runtime/agents/<id>/`, the user loses a
working agent. That is the worst outcome the build pipeline can produce, and it is worse than
the generation simply failing, because the failure is silent until the next run.

There is a second problem. Validation that runs *after* files land is a report, not a gate. To
be a gate it has to run against something that is not yet the user's project.

A third consideration is that the checks themselves vary enormously in cost. A regular
expression over a file is microseconds. Importing the project in its virtual environment is
seconds. Running the expensive check first on a project that fails a cheap one wastes time on
every failed generation.

## Decision

**Nothing lands unvalidated, and nothing lands partially.**

Generation writes to `runtime/agents/.staging/<id>/`. The edit loop writes to
`runtime/agents/.staging/<id>__edit/`, which is a full copy of the project with the model's
files applied. Validation runs against the staging directory. Only if it passes does the
project move into place by `atomicSwap`, a directory replacement that either fully succeeds or
leaves the previous directory exactly as it was.

A crash, a truncated stream, or a rule violation leaves any previously working agent untouched.

**Path confinement applies to every path the model emits.** Absolute paths, `..`, null bytes
and anything escaping the staging root are rejected outright, before any write. Agent ids are
validated against `^[a-z][a-z0-9_]{0,63}$`, the same pattern the Python runner enforces, so a
client-supplied id cannot traverse out of `agents/`.

**Host-owned files are written after the model's**, so the model cannot shadow them:
`jaroku.json`, `.env.example` merged with whatever keys the model declared, the top-level
`__init__.py`, and where applicable `mcp_tools.json`, `mcp_bridge.py`, `serve.py`, `Dockerfile`,
`.dockerignore` and `pyproject.toml`. Reviewed connector templates are copied byte for byte,
never re-rendered.

**Validation is layered, cheapest first.** In order:

1. **Contract checks.** `build_graph`, `build_initial_state`, a reference to `TOOLS`, and on
   fresh generation `handle_tool_errors=True` on the tool node.
2. **Regular expression rules across every generated file.** Imports of anything named
   `jaroku`, construction of a model, and bare `print()` (allowing the documented
   `print(..., file=sys.stderr)`).
3. **Secret declaration.** Every `os.environ` key referenced must appear in `.env.example`.
4. **AST analysis via Python's own parser**, in the project's own virtual environment: syntax
   errors with file and line; calling a `@tool` as a plain function; SQL assembled with an
   f-string, requiring actual query shape so an error message mentioning `SELECT` does not trip
   it; and shadowing or unwiring a reviewed tool, following `TOOLS = ...` assignments through
   one level of local variable so `TOOLS = CONNECTOR_TOOLS + [mine]` is understood.
5. **An actual import**, only reached when every cheaper check has passed, executing the
   project's top-level code exactly as the runner would, in the same virtual environment, with
   stdout captured and a 20 second timeout.

Step 5 exists because of a specific failure. A real generation once shipped
`class AgentState(StateGraph.__bases__[0] ...)`, which is syntactically valid and raises
`TypeError` on import. Every run died at step 0 while validation waved it through. `ast.parse`
proves a file parses; it does not prove it loads.

The eleven hard rules in the generation prompt are the specification, and the validator is the
enforcement. The prompt asks; the validator enforces.

## Alternatives Considered

### Option 1: Staging plus atomic swap, gated by layered validation

- Pros
  - A failed generation cannot damage a working agent, under any failure mode including a
    crash of the server itself.
  - Validation is a genuine gate rather than a report, because it runs before the project
    exists at its real path.
  - Cheapest checks first means a fast failure for the common cases and the expensive import
    only for projects that are otherwise clean.
  - The import check catches the entire class of parses-but-does-not-load failures.
  - The same machinery serves generation and editing, so there is one code path to trust.
- Cons
  - Requires disk space for a full copy of the project during an edit.
  - The staging directory is state that has to be cleaned up, including after a crash.
  - The import check executes untrusted code, which is a real cost discussed below.
  - Validation rules are maintenance: each rule needs a fixture and a reason.

### Option 2: Write in place and roll back on failure

- Pros
  - No staging directory and no copy, so less disk and less cleanup.
  - Simpler to implement for the happy path.
- Cons
  - A rollback is itself an operation that can fail, and it cannot run at all if the process
    died. A crash mid-write leaves a half-written project with no recovery.
  - The window during which the project is invalid is a window in which a run can read it.
  - Validation would run against the user's live project, so a failing validation means the
    project is already broken.

### Option 3: Write in place and validate afterwards, warning on failure

- Pros
  - Simplest possible implementation.
  - The user sees exactly what the model produced, including its mistakes.
- Cons
  - The product's promise that a bad generation can never overwrite a working agent becomes
    false.
  - A warning about a broken project is not a gate; the user is left to repair generated code
    by hand, which is the failure mode the plan gate and the diff card exist to prevent.
  - Rule violations that matter for safety, for example f-string SQL, would land on disk.

## Consequences

### Positive

- A bad generation costs a message, never a project. This has been true since v0.0.3 and is the
  property the fixtures `rejected-tool-call-and-sql.txt` and `rejected-import-time-failure.txt`
  regression-test permanently and for free.
- The problem list names the rule and the file and line, so a rejection is actionable rather
  than mysterious.
- Because staging is a real directory, the edit loop can present a proposal as a full validated
  project rather than as a set of hunks that might not apply.
- Two genuine defects found in a live generation, a tool called as a plain function and SQL
  built with an f-string, became permanent regression tests rather than prompt tweaks.
- The same discipline extends to deployment artifacts, which are written through staging and
  atomic swap so a failed or cancelled deploy leaves the project byte for byte as it was.

### Negative

- Disk usage doubles briefly during an edit, because a proposal is a full copy.
- Staging is state. It is cleared on server start, because a proposal interrupted by a shutdown
  is an orphan.
- The import check executes model-written code on the control plane host. This is the single
  largest known security limitation in the product and is documented as such.
- Validation adds seconds to a generation, dominated by the import step.
- A rule that is too strict blocks a legitimate generation. The SQL check requires actual query
  shape for exactly this reason.

### Trade-offs

- Disk and latency were traded for the guarantee that a working agent is never damaged.
- Executing untrusted code during validation was accepted because the alternative is shipping
  projects that fail on every run. The mitigations are that it runs last, in a subprocess, with
  stdout captured and a 20 second kill timer, and that the limitation is stated plainly rather
  than implied.
- The validator duplicates the prompt's rules rather than deriving them from it. That
  duplication is deliberate: a rule the model is asked to follow and a rule that is enforced
  are different artifacts, and only one of them is trustworthy.

## Implementation Notes

- `server/src/projectFs.ts` owns `atomicSwap`, `copyProject`, `listProjectFiles`,
  `readOnlyPaths` and `isSafeAgentId`. It is marked read-every-line territory in its own header
  comment, because a bad move there corrupts the user's project.
- `isSafeAgentId` checks `typeof agentId === "string"` before applying the pattern.
  `RegExp.test` coerces its argument, so the check previously returned true for `undefined`,
  `null` and `["ok_agent"]`, and that guard is shared by run, edit, generate, eval, graph, file
  and deploy operations.
- Validation runs in the project's own uv virtual environment, so the import check exercises
  the same interpreter and the same dependency set the runner would use.
- The AST check follows `TOOLS = ...` assignments through one level of local variable. The
  connector template *files* are read-only, but the file that decides which tools get bound
  cannot be, because adding a bespoke tool means editing it. The check therefore rejects a
  project that advertises a connector it can no longer call, or that defines a function
  shadowing a reviewed tool's name.
- An MCP-scoped project gets the same treatment: `MCP_TOOLS` must be reachable from `TOOLS`, a
  generated function shadowing a granted tool's name is rejected, and a literal
  `tool.invoke({...})` is checked against the tool's declared schema.
- A run in flight blocks mutation, and the check is pool aware rather than only
  interactive-aware. An evaluation job reading the agent's files from a subprocess right now
  would make its trace describe code that never ran.

## Security Considerations

- **Path confinement is the primary defence** against a model writing outside the project.
  Every emitted path is validated before any filesystem call, and agent ids are validated
  against a pattern enforced independently in Python and TypeScript.
- **The import check executes untrusted code.** It is bounded by a 20 second timeout with
  stdout captured, and it runs in a subprocess, but it is not a sandbox. `SECURITY.md` and the
  threat model both state that model-written Python executes on the control plane and that the
  server should not be pointed at strangers until a sandbox lands.
- **Rule 10, no f-string SQL, is a security rule rather than a style rule.** It is an injection
  vector even against a read-only connector, because a crafted input can widen a `SELECT` to
  rows the user should never see.
- **Secret declaration** (rule 4) means a project cannot quietly depend on a credential nobody
  knows about.
- Host-owned files being written last, and being read-only to the edit loop, is what stops a
  model from shadowing the MCP manifest, the deployment Dockerfile or the project metadata.

## Performance Considerations

- Checks run cheapest first. Contract checks and regular expressions are microseconds; AST
  analysis is milliseconds; the import is seconds and is reached only by an otherwise clean
  project.
- The import check has a hard 20 second timeout, so a generated project that hangs at import
  cannot wedge a generation.
- `atomicSwap` is a rename where possible, so promotion is close to instantaneous and does not
  scale with project size.
- An edit proposal copies the project. Agent projects are small, tens of kilobytes, so this is
  not a meaningful cost.

## Operational Considerations

- `runtime/agents/.staging/` is cleared on server start. Anything found there at boot is an
  orphan from an interrupted operation.
- `runtime/agents/.history/<id>/` holds per-agent version snapshots plus `history.json`, which
  is what makes Undo survive a reload. See ADR-009.
- "Cannot modify the agent while a run is in progress" means an interactive run or an
  evaluation job is reading the project's files right now.
- A rejected generation is the system working. The staged project was discarded and whatever
  was there before is untouched; the fix is to re-plan with the problem addressed.
- Both rejection fixtures should always fail validation. If either starts passing, a rule has
  regressed.

## Rejected Alternatives

**Write in place and roll back on failure** was rejected because a rollback cannot run if the
process died, which is exactly the failure mode that matters most. It also leaves a window
during which the live project is invalid, and a run started in that window would execute a
half-written agent and produce a trace describing code that never existed as a whole.

**Write in place and validate afterwards** was rejected because it turns validation from a gate
into a warning. The product's principle is that nothing lands unreviewed, and a warning about
a project that has already replaced a working one does not satisfy it. It would also mean
safety rules such as the f-string SQL prohibition became advisory.

## Related Decisions

- ADR-005: The generated agent contract
- ADR-006: Delimiter framed streaming protocol for generated files and plans
- ADR-008: A plan gate before generation
- ADR-009: The fix loop: full file rewrites, reviewable diffs, snapshot based undo
- ADR-014: Reviewed connector templates copied byte for byte
- ADR-027: Deployment into the user's own hosting account
- ADR-029: Recorded fixtures so the build path is free to develop against

## References

- `server/src/validator.ts`, `server/src/projectFs.ts`, `server/src/generator.ts`
- `server/src/prompt.ts`, the eleven hard rules
- `server/fixtures/rejected-tool-call-and-sql.txt`, `server/fixtures/rejected-import-time-failure.txt`
- README section "The build pipeline: plan, generate, validate"
- CHANGELOG v0.0.3, v0.1.0 (sandboxed import checking), v0.1.12 (reviewed tool unwiring)
- `SECURITY.md`, "Known limitations that are not findings"
