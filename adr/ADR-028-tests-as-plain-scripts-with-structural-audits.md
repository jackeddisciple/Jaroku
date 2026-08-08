# ADR-028: Write Tests as Plain Scripts, and Audit Invariants by Enumerating the Source

## Status

Accepted. Established in v0.0.1 (16 July 2026); the structural audit pattern introduced in v0.2.5
and extended in v0.2.6.

## Context

This codebase has a specific testing problem, and it is not coverage.

Most of the invariants that matter here fail **silently**. A trace rendered in arrival order
rather than causal order looks fine. An unpriced model reported as `$0.00` looks like a cheap
provider. A WebSocket channel that broadcasts one payload to every socket looks like a working
feature until two workspaces are connected. A client store that keeps its rows across a workspace
switch looks empty in whichever devtools panel somebody happens to open.

None of those produce an exception. They produce a wrong answer that a user acts on.

There is a second, harder problem. The most dangerous version of each of those bugs is not in the
code somebody tested. It is in the **module added six months later that nobody wired in**. A test
that asserts "these eleven stores reset correctly" passes forever while the twelfth store leaks.
The stale-broadcast bug in the relay was found twice by hand, and finding them one at a time as
somebody happens to notice is not the same as knowing there are none left.

A third constraint is the project's consistent preference: a script it can read over a tool it has
to trust. The migration runner has no framework, the HTTP router has no framework, and the event
transport is delimiters rather than a parser library.

## Decision

**Test suites are plain `tsx` scripts with no test-runner dependency**, each registered as its own
`npm run test:*` script, covering the logic where a bug would be silent rather than loud.

**Structural audits enumerate the source rather than remembering a list.** Where an invariant must
hold across a *category* of things, the suite discovers the category by reading the code, and
fails when a member is unclassified. Four of these exist:

| Audit | What it reads | What it fails on |
|---|---|---|
| `test:channels` | `wsRelay.ts` for every `channel:` it can emit, and `COMMAND_CHANNEL` | a channel not classified as tenant data or connection state; a sender that is neither `broadcastTo` nor `perClient` |
| `test:capabilities` | `wsRelay.ts` for every command | a command with no entry in `COMMAND_CAPABILITY` |
| `test:db-boundary` | every module outside `src/db/` | a driver import; an exemption naming a method that no longer exists |
| `test:reset` | the client store *directory*, and every `jaroku.*` key the client writes | a store neither reset nor excluded; a storage key classified as neither workspace scoped nor non-tenant |

**A structural audit must be able to fail.** `test:db-boundary` asserts that the drivers *are*
imported inside `src/db/`, so a pass cannot come from the feature being deleted, and that the rule
still fails on text designed to fail it.

**Coverage assertions make checklists mechanical rather than aspirational.**
`npm run test:tenancy` lists scoped repository methods in `SCOPED_API` and fails until a new method
is added and exercised. That single assertion is what turns the contributing guide's five-step
list into something enforced.

**Both database drivers run the same assertions.** The tenancy suites run against SQLite always
and against Postgres as well when `JAROKU_PG_URL` is set, because the ways the two drivers differ
are almost all silent.

**Adversarial suites drive the real components.** The MCP fixture server is written against
`node:http` and raw JSON-RPC rather than the MCP SDK, because a fixture has to be able to
advertise things a well-behaved server never would, and because it means the client is tested
against something that does not share its implementation. The deployment path was exercised
against a stub API and a fake CLI, adversarially rather than along the happy path.

**An acceptance suite is separate from an attack suite**, because they catch different failures.
An attack asks *can I reach across the boundary if I try*. Acceptance asks *does the server keep
two ordinary sessions apart while it is busy*, and the answers differ wherever per-operation state
lives in a module-level variable. No adversarial test would have provoked the build-scope leak,
because the attacker's move there is to do something entirely legitimate in their own workspace at
the wrong moment.

**Real defects become permanent fixtures.** Two genuine defects found in a live generation, a tool
called as a plain function and SQL built with an f-string, are recorded as fixtures that must
always be rejected. `rejected-import-time-failure.txt` parses fine and raises `TypeError` on
import, and is the regression test for the import check.

**Every commit leaves `npm run typecheck` green on both `server/` and `client/`**, and leaves the
existing suites passing.

## Alternatives Considered

### Option 1: Plain scripts, per-suite npm scripts, structural audits that read source

- Pros
  - No test-runner dependency, matching the project's stance everywhere else.
  - A suite is a program: it can read the source directory, spawn a real server, open two real
    sockets, and run a real Postgres.
  - Structural audits catch the member added later, which is the failure that actually happens.
  - Each suite is independently runnable, so a failure is reproduced with one command.
  - Suites double as documentation of the invariant, because the reason is written next to the
    assertion.
- Cons
  - No shared reporter, no watch mode, no parallel execution, no coverage reporting.
  - Assertion helpers and setup are per suite, so there is some duplication.
  - Fifty-odd npm scripts to know about, listed in the README.
  - Structural audits parse source, which is inherently brittle against refactoring.

### Option 2: A standard test framework

- Pros
  - Watch mode, parallelism, reporters, coverage, snapshot testing, and mocking utilities.
  - Familiar to any contributor.
  - One command runs everything.
- Cons
  - A dependency, in a codebase that deliberately avoids them for the migration runner, the HTTP
    router and the event transport.
  - Mocking utilities encourage testing against mocks, and several of the invariants here are only
    observable against the real component: a real second socket, a real Postgres, a real hostile
    MCP server.
  - Structural audits are not what a framework is for, so they would be written the same way
    regardless.

### Option 3: Rely on TypeScript types and code review

- Pros
  - No test code to maintain.
  - Types do catch a real class of error, and this project uses them heavily: the two context
    types make an unscoped tenant query a compile error.
  - Review catches design problems that no test expresses.
- Cons
  - Types cannot express "this query filters on the context it was given" or "this channel is
    scoped".
  - Review reads what is present. Every invariant here fails by *absence*: a missing reset, a
    missing capability entry, a missing `WHERE`.
  - The most dangerous case is a module added later, which review sees once and never again.

## Consequences

### Positive

- The invariants that would fail silently have named suites, and `CONTRIBUTING.md` lists each
  invariant next to the suite that defends it.
- The audits converted several "we fixed the ones we noticed" situations into build failures: an
  unclassified channel, an ungated command, a store nobody wired in, a driver import outside the
  database directory.
- Because a suite is a program, the acceptance suite could sign two real accounts in through the
  real three-request exchange, open real sockets, run overlapping scripts of ordinary work, and
  assert the overlap actually happened rather than assuming it.
- The tenancy suite reached 84 scoped repository methods across 227 assertions on both drivers,
  and both driver-specific silent divergences (a dropped step containing a NUL on Postgres, a
  failing SQLite MCP rebuild against a populated database) were found because both are exercised.
- The MCP adversarial suite's 34 assertions found 17 real failures against the code as it stood.
- The timing assertion in the acceptance suite is deliberately a ratio rather than a threshold: it
  does not claim to defeat a lab-grade timing attack, it asserts there is no order-of-magnitude
  oracle, which is what a scoped versus unscoped query produces.

### Negative

- No watch mode, no coverage report, no parallel run, and no single command that runs everything.
- Roughly fifty npm scripts, which is a lot to discover without the README.
- Structural audits parse source and will need updating when the code they read is restructured.
- Assertion helpers are duplicated across suites.
- Some suites require a Postgres to exercise their second half, so a developer without one gets
  weaker coverage locally.

### Trade-offs

- Tooling convenience was traded for zero dependencies and for suites that can do arbitrary
  things, which several of these need.
- Structural audits are brittle by nature, and that brittleness is accepted because the
  alternative is a list that goes stale silently, which is strictly worse: a brittle test fails
  loudly, and a stale list passes.
- Running against both drivers doubles some suite runtimes and is the only way to catch a class of
  bug that is otherwise invisible.

## Implementation Notes

- Every suite is a `tsx` script under `server/src/` or `client/src/`, registered in `package.json`
  as `test:<name>`. The client's scripts invoke `../server/node_modules/.bin/tsx`, so the server's
  dependencies must be installed first.
- Server suites include: `tenancy`, `acceptance`, `channels`, `db-boundary`, `rls`, `trace`,
  `identity`, `driver`, `http`, `jwks`, `jwt`, `session`, `resolve`, `capabilities`, `tickets`,
  `members`, `migrate`, `db`, `db-postgres`, `shape-parity`, `protocol`, `plan`, `pricing`,
  `pool`, `aggregate`, `retry`, `judge`, `cleanup`, `env-writer`, `providers`, the six `mcp-*`
  suites and the three `deploy-*` suites.
- Client suites: `plan-flow`, `deploy-store`, `note-kind`, `inline-code`, `title`, `export`,
  `csv`, `auth`, `reset`.
- `test:db-boundary` is deliberately a script rather than a lint rule, because there is no lint
  toolchain here and every other check is a script.
- `test:channels` asserts two properties of `index.ts` that are invisible at a type level: each
  subsystem claims its own scope, and it claims it only once its operation has actually started.
- The MCP mock server supports `MOCK_MCP_TOKEN` for auth and `MOCK_MCP_HOSTILE=1` for tools that
  return 10 MB of text, control characters, non-text-only content, 400-deep nesting, an injection
  attempt, a self-reported error, and one that never answers at all.
- When adding an invariant, add the suite and add the row to the `CONTRIBUTING.md` table. The
  table is the index of what is defended and by what.

## Security Considerations

- Several suites *are* the security control. `test:capabilities` is what makes "unclassified is
  refused" true, `test:channels` is what makes cross-workspace push scoping verifiable, and
  `test:rls` is what asserts the application role is neither the table owner nor `BYPASSRLS`.
- `server/src/auth/attacks.test.ts` covers forged, unsigned, tampered and expired tokens, ticket
  replay, cross-workspace tickets, forged workspace ids, and revocation while a socket is open.
- Adversarial fixtures are built to misbehave rather than to pass, which is the only way to test
  what a hostile third party would actually do.
- The suites leave no residue: the tenancy work confirmed the suites leave behind neither
  production rows nor scratch databases.
- A gap is recorded rather than glossed over when one exists. v0.2.6 noted that the browser
  extension was typechecked and production built but not visually verified, and v0.2.1 noted that
  generated agent code can set an environment variable disabling the MCP confirmation gate, which
  needs a new validation rule rather than a bug fix.

## Performance Considerations

- Suites run sequentially, one process per suite. Individually they are fast; the full set is not
  parallelised.
- Suites that spawn a real server, open real sockets or run against Postgres are the slow ones and
  are also the ones with the highest value.
- Structural audits read source files once, so they are effectively instant.
- Concurrent migration was tested with five simultaneous attempts, and idempotent import across
  106 runs and 1,218 steps, so the heavier scenarios are exercised deliberately rather than
  routinely.

## Operational Considerations

- The README lists every suite with a one-line description of what it defends, grouped by area.
- `npm run typecheck` on both `server/` and `client/` is part of every commit.
- Set `JAROKU_PG_URL` to run the tenancy and database suites against Postgres as well as SQLite.
  Without it, the Postgres halves are skipped, and skipping in silence is exactly what a scratch
  Postgres instance was introduced to stop.
- `npm run mock:mcp` starts the fixture MCP server for the MCP suites and for manual testing.
- A failing structural audit usually means something was added without being classified. The
  failure message names it.

## Rejected Alternatives

**A standard test framework** was rejected for the same reason the migration runner has no
framework and the HTTP router has none: a dependency for something the project can do in a
readable script. More substantively, a framework's main conveniences (mocking, snapshots) point
away from what these suites need. The invariants here are observable only against real components:
a real second socket in a real second workspace, a real Postgres with real policies, a real MCP
server built to misbehave. A framework would not have made any of those easier, and the structural
audits would have been written identically inside it.

**Relying on types and review** was rejected because every invariant here fails by absence. Types
express what a function receives, not whether the SQL it wrote used it. Review reads what is
present, and a missing reset, a missing capability entry or a missing `WHERE` clause is nothing to
read. The decisive point is the module added six months later: review sees it once, and only an
audit that enumerates the category sees it every time.

## Related Decisions

- ADR-013: One pricing table read by both runtimes, and unknown is never zero
- ADR-016: A database interface with two drivers
- ADR-018: The workspace as the tenancy unit, with an explicit context argument
- ADR-022: Roles as data, one capability matrix checked at the door
- ADR-023: One WebSocket carrying many logical channels
- ADR-024: Client state as per concern stores that reset on a workspace switch
- ADR-029: Recorded fixtures so the build path is free to develop against

## References

- `server/package.json` and `client/package.json`, the suite registry
- `server/src/channels.test.ts`, `auth/capabilities.test.ts`, `db/boundary.test.ts`,
  `client/src/store/reset.test.ts`, the four structural audits
- `server/src/tenancy.test.ts`, `acceptance.test.ts`, `auth/attacks.test.ts`
- `server/fixtures/mcp/mockServer.ts`
- `CONTRIBUTING.md`, the invariant to suite table
- README section "Tests"
- CHANGELOG v0.2.1, v0.2.4, v0.2.5, v0.2.6 verification sections
