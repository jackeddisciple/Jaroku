# ADR-029: Record and Replay Model Responses So the Build Path Is Free to Develop Against

## Status

Accepted. Introduced in v0.0.3 (21 July 2026). Extended with edit fixtures in v0.1.0, plan
fixtures in v0.1.10, and a live fixture MCP server in v0.2.0.

## Context

Every real generation, plan or edit is a paid model call producing a long streaming response. The
work that most needs iteration is the work around that stream: the parser at every chunk boundary,
the streaming file list, the plan card's layout, the diff card, the staging and validation
pipeline, and the failure paths.

Iterating on any of that against a live model has three problems.

**It costs money on every reload.** A design pass on the plan card is dozens of generations.

**It is not reproducible.** The model produces a different project each time, so a rendering bug
that appeared once may not appear again, and a fix cannot be verified against the case that
provoked it.

**Failure cases are almost impossible to produce on demand.** A generation that violates a
validation rule, or one that parses and crashes on import, cannot be requested. They happen, and
if they are not captured they are gone.

There is a fourth requirement that is specific to this product. The README's promise that
`npm run dev` works with nothing installed and nothing running extends to the *experience*: a
developer or a curious reader should be able to exercise the whole build path without an API key.

## Decision

**Record real model responses to plain text files, and replay them at zero cost.**

Three environment variables:

| Variable | Replays |
|---|---|
| `JAROKU_GEN_FIXTURE` | A generation |
| `JAROKU_PLAN_FIXTURE` | A plan |
| `JAROKU_EDIT_FIXTURE` | An edit proposal |

**Pointing one at a path that does not exist records a fresh fixture from a real call.** Pointing
it at an existing file replays.

**Replay is chunked and paced**, so the UI behaves exactly as it would live. A fixture that
arrived instantly would not exercise the streaming parser at realistic chunk boundaries, and would
not let anyone see what the streaming UI actually looks like.

**Fixtures are plain text**, which is possible because the wire format is a delimiter protocol
rather than escaped JSON (ADR-006). They are readable, editable and diffable.

**Failure fixtures are first-class.** Two genuine defects found in a live generation are preserved
permanently:

| File | Purpose |
|---|---|
| `support_bot.txt` | A known-good generation. Should always pass validation |
| `plan-support-bot.txt` | The matching plan, so plan, card, confirm and generate runs end to end for free |
| `rejected-tool-call-and-sql.txt` | A real response that called `pg_query` directly and built SQL with an f-string. Should always be **rejected**: the regression test for rules 9 and 10 |
| `rejected-import-time-failure.txt` | Parses fine, `TypeError` on import. The regression test for the import check |
| `edit-*.txt` | A no-op, a syntax error, a prompt tweak, a connector-bait attempt, and a real limit |

**MCP has a fixture too, but a live one rather than a recording.** `npm run mock:mcp` starts a
server that speaks real MCP, so the whole path is exercisable with no third party and no spend.
That difference is deliberate: MCP is a protocol conversation with pagination, timeouts and
failure classification, and a recording could not exercise a server that never answers.

**The dry-run model is the fixture for execution.** It is schema driven rather than recorded: it
walks the agent's `TOOLS`, reads each tool's argument schema, synthesises one call per tool and
then answers plainly. That covers the run path the way recorded fixtures cover the build path.

**The plan fixture carries a warning.** A forgotten `JAROKU_GEN_FIXTURE` replays a canned project
anyone can see is wrong. A forgotten `JAROKU_PLAN_FIXTURE` feeds stale plan text into a **real**
generation, so the output is genuinely model written but built to somebody else's plan. The
planner logs a loud warning for exactly this reason, and every replay is warned about in the
server log.

## Alternatives Considered

### Option 1: Recorded text fixtures with record-on-missing, plus a live fixture MCP server

- Pros
  - Free and instant, so UI iteration is unbounded by cost.
  - Deterministic, so a rendering bug is reproducible and a fix is verifiable against the exact
    case.
  - Failure cases become permanent regression tests, which is the only way to keep them.
  - Recording is trivial: point at a path that does not exist.
  - Plain text files are readable and diffable in review.
  - Chunked pacing means the streaming path is genuinely exercised.
- Cons
  - Fixtures go stale relative to what the model would produce today.
  - A fixture variable left set in a shell silently changes behaviour, and the plan variable
    dangerously so.
  - Fixtures are large text files in the repository.
  - Replay exercises the parser and the pipeline, not the model or the prompt.

### Option 2: Mock the model client in tests only

- Pros
  - Contained to the test suites, with no runtime configuration and no chance of a stray variable.
  - No fixture files in the repository.
- Cons
  - Does not help interactive development at all, which is where most of the iteration happens.
  - A hand-written mock produces what its author imagined a model produces, not what one actually
    produced. Both preserved failure fixtures are real responses that nobody would have invented.
  - The streaming UI cannot be exercised by a unit-level mock.

### Option 3: Always use a real model, with a cheap model for development

- Pros
  - Always current, exercising the real prompt and the real model behaviour.
  - No fixtures to maintain and nothing to go stale.
- Cons
  - Still costs money on every iteration, and still requires an API key to see anything.
  - Still non-deterministic, so a rendering bug may not reproduce.
  - A cheap model behaves differently, so it is neither free nor representative.
  - Failure cases remain unreproducible on demand.

## Consequences

### Positive

- The whole build path (plan, card, confirm, stream, stage, validate, swap) is exercisable end to
  end for free and repeatably.
- Two real defects became permanent regression tests, so rules 9 and 10 and the import check
  cannot regress unnoticed.
- The design passes in v0.1.11 and v0.2.2 were possible: reworking the plan card, the streaming
  file list and the trace row required dozens of iterations against a real plan rather than a
  mock.
- A contributor with no API key can still work on most of the product.
- Combined with the dry-run model and the mock MCP server, the entire product is exercisable with
  no key, no third party and no spend.

### Negative

- Fixtures drift from what the model would produce today, so they validate the pipeline rather
  than the prompt.
- A leftover `JAROKU_PLAN_FIXTURE` feeds stale plan text into a real generation, producing genuinely
  model-written code built to the wrong plan.
- Text fixtures are sizeable files in the repository.
- Replay proves nothing about prompt quality, so prompt changes need real calls to evaluate.

### Trade-offs

- Fidelity to the current model was traded for determinism and cost, which is the right trade for
  the pipeline and the wrong one for the prompt. Prompt work uses real calls.
- MCP was given a live fixture rather than a recording, accepting a running process during
  development in exchange for exercising timeouts, pagination and a server that never answers.
- Record-on-missing was chosen over an explicit record mode because it makes capturing a fresh
  fixture a one-character change, and the loud replay warning is what keeps that convenience from
  becoming a surprise.

## Implementation Notes

- `replayFixture` in `server/src/generator.ts` handles record and replay, chunked and paced to
  match live streaming behaviour.
- Fixtures live in `server/fixtures/`. `server/fixtures/README.md` describes them.
- The plan fixture and the generation fixture are separate variables, so the plan gate and the
  generation can be replayed independently or together. Running both replays the full path
  end to end.
- `plan-support-bot.txt` expects the **postgres** connector to be selected, because the matching
  generation imports `tools/postgres.py`.
- Both rejection fixtures must always fail validation. If either starts passing, a validation rule
  has regressed.
- `server/fixtures/mcp/mockServer.ts` is written against `node:http` and raw JSON-RPC rather than
  the MCP SDK, so it can advertise things a well-behaved server never would and so the client is
  tested against something that does not share its implementation. `MOCK_MCP_TOKEN` requires a
  bearer token and `MOCK_MCP_HOSTILE=1` adds the badly-behaved tools.
- `runtime/jaroku_runner/fake.py` is the execution-side equivalent, derived from the agent's own
  tool schemas rather than recorded, and it is the default provider.
- Every replay logs a loud warning naming the fixture.

## Security Considerations

- **A recorded fixture is a recorded model response and may contain whatever prompt context was in
  the call.** Review a fresh recording before committing it, and never record against a prompt
  containing real credentials or real customer data.
- Fixtures are model output, so replaying one executes the same pipeline that would run against a
  live response: staging, validation and atomic swap all still apply. A fixture cannot bypass a
  validation rule, which is precisely why the rejection fixtures work as regression tests.
- The fixture MCP server binds a local port and is a development tool. It is not something to run
  in a shared environment.
- The dry-run model uses placeholder arguments, which are recognisable in a trace and obviously
  not real data, so nobody mistakes a dry run for a live result.

## Performance Considerations

- Replay is a file read plus paced chunk emission, so iteration is bounded by the pacing rather
  than by network latency.
- Pacing is deliberate. An instant replay would not exercise the parser at realistic chunk
  boundaries and would not show what the streaming UI looks like.
- The dry-run model is deterministic and local, so a trace can be diffed run over run and an
  evaluation against it is bounded only by the pool (its default per-provider cap is 16).
- Fixture files are read once per replay and are small relative to a model call.

## Operational Considerations

- To replay: `JAROKU_GEN_FIXTURE=fixtures/support_bot.txt
  JAROKU_PLAN_FIXTURE=fixtures/plan-support-bot.txt npm run dev` from `server/`.
- To record: point the variable at a path that does not exist and perform the action once against
  a real model.
- "Every generation returns the same project" means a fixture variable is set and pointing at an
  existing file. The server log warns on every replay.
- Take particular care with `JAROKU_PLAN_FIXTURE`. Unset it before doing real generation work.
- `npm run mock:mcp` in `server/` for the MCP path.
- Refreshing a fixture is worth doing when the prompt changes materially, because the fixture then
  represents a response to a prompt that no longer exists.

## Rejected Alternatives

**Mocking the model client in tests only** was rejected because it does not help interactive
development, which is where most of the iteration on this pipeline happens. It also produces what
its author imagined a model produces rather than what one actually produced, and the two most
valuable fixtures in the repository are real responses containing real defects that nobody would
have thought to invent: a tool called as a plain function, and SQL assembled with an f-string.

**Always using a real model, with a cheap one for development** was rejected because it solves
neither of the two problems that matter. It still costs money on every iteration and still
requires an API key to see anything, and it is still non-deterministic, so a rendering bug that
appeared once may not appear again. A cheaper model is also a differently-behaving model, so the
development experience would neither be free nor representative.

## Related Decisions

- ADR-004: LangGraph as the agent runtime framework, whose tool schemas the dry-run model reads
- ADR-005: The generated agent contract, which the dry-run model exercises
- ADR-006: Delimiter framed streaming protocol, which is what makes fixtures plain text
- ADR-007: Staging directories with atomic swap, gated by layered validation
- ADR-008: A plan gate before generation
- ADR-015: MCP servers treated as untrusted code, and the live fixture server
- ADR-028: Tests as plain scripts, with structural audits

## References

- `server/src/generator.ts`, `replayFixture`
- `server/fixtures/` and `server/fixtures/README.md`
- `server/fixtures/mcp/mockServer.ts` (`npm run mock:mcp`)
- `runtime/jaroku_runner/fake.py`
- README section "Developing for free (fixtures)"
- CHANGELOG v0.0.3, v0.1.0, v0.1.10, v0.2.0
