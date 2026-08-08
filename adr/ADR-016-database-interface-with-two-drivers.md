# ADR-016: Put Every Database Access Behind One Interface With Two Drivers

## Status

Accepted. Introduced in v0.2.5 (7 August 2026). The refusal to boot on SQLite under
`NODE_ENV=production` was added in v0.2.6.

## Context

Jaroku began as a local tool with a SQLite trace store, using Node's built-in `node:sqlite`
module so there is no native build step and no `better-sqlite3` to compile. That is the right
choice for a product whose defining property is that `npm run dev` works with nothing installed
and nothing running.

Becoming a hosted multi-tenant product requires Postgres: row-level security, real concurrency,
managed backups, and connection pooling. But the local path is not a legacy to be migrated away
from. It is the free development path the fixtures, the mock MCP server and the whole
documentation experience are built around, and no hosted feature is allowed to cost it.

So both drivers have to work, permanently, and the application has to be unable to tell which it
got. Two constraints made that harder than it sounds.

**`node:sqlite` is synchronous and every store in the codebase was written against that.** No
Postgres client is synchronous, and an interface shaped around the synchronous one cannot have a
Postgres implementation at all.

**The two dialects genuinely disagree** about what a uuid, a citext and a jsonb are, about
placeholder syntax, and about how JSON columns behave. SQL written to paper over that is
portable and wrong.

There is also a hazard specific to this product's naming. Postgres connection strings are
already meaningful here: `DATABASE_URL` is the credential the reviewed Postgres *connector*
reads, which is the user's own database that their agents query.

## Decision

**One `Db` interface in `server/src/db/`, two implementations, and nothing outside that directory
may import a driver.**

Five properties define it.

**Two implementations, always.** SQLite is the local development path and stays the default.
Postgres is production. The driver is selected by `JAROKU_DB_DRIVER`, and the application cannot
tell which it got.

**Asynchronous, even though SQLite is not.** The asynchrony is not overhead added to the local
path, it is the only shape both drivers can satisfy. The cost is real and was paid at the time:
every call site had to await, and writes that used to be uninterruptible had to say so.

**`?` placeholders everywhere.** Both dialects are written against the SQLite spelling and the
Postgres driver rewrites them to `$1` through `$n`. One spelling, chosen because it was already
in the codebase, so porting a store is a signature change rather than a rewrite of every query.
String interpolation into SQL is not an alternative here, for the same reason validation rule 10
rejects it in generated agents.

**A refusal rather than a fallback.** `JAROKU_DB_DRIVER` set to anything other than `sqlite` or
`postgres` throws. Falling back to SQLite when somebody asked for Postgres means a server that
starts, works, and writes every row to a file nobody is looking at.

**SQLite refuses to run under `NODE_ENV=production`.** The reason is not performance and not
durability. It is that the two drivers *disagree*, and the disagreement is silent:
`users.external_id` is `COLLATE NOCASE` on SQLite and case-sensitive on Postgres, so two auth
provider `sub` claims differing only in case are one person on SQLite and two on Postgres. That
is an identity bug, invisible until it is a breach, and fixing it properly needs a table rebuild.
The second reason is larger: row-level security is the backstop the whole tenancy model leans on
and it exists only on Postgres, so SQLite in production is a deployment with the backstop
silently absent.

**Jaroku's own database URL is `JAROKU_PG_URL`, deliberately not `DATABASE_URL`.** Reusing
`DATABASE_URL` would point every agent's `pg_query` at Jaroku's control plane, at the traces,
evaluation results and MCP registry of everyone on the box, and it would do it silently because
both are valid Postgres URLs and nothing would error.

The interface itself distinguishes a `Db`, a `Tx` and a `Queryable`, so a function that must run
inside a transaction says so in its signature rather than in a comment.

## Alternatives Considered

### Option 1: One interface, two hand-written drivers

- Pros
  - The local path keeps working with nothing installed, permanently.
  - Dialect differences are handled explicitly where they occur, rather than hidden behind a
    lowest common denominator.
  - No ORM in the request path, so the SQL is the SQL.
  - The boundary is enforceable by a test: nothing outside `src/db/` imports a driver.
  - A conformance suite can be run against both drivers, which is how silent divergence is
    caught.
- Cons
  - Two implementations to maintain, and a conformance suite to keep them honest.
  - Placeholder rewriting is a small piece of parsing that must be exactly right.
  - Genuine dialect differences (`COLLATE NOCASE`, JSON column behaviour, NUL handling) still
    leak and must be tested for.
  - The asynchronous interface imposed a codebase-wide refactor of every call site.

### Option 2: An ORM or query builder that abstracts the dialects

- Pros
  - Dialect handling is somebody else's problem.
  - Migrations, types and relations often come in the same package.
  - Less code to write.
- Cons
  - Adds a substantial dependency to the path every request takes, in a codebase that
    deliberately has no framework in the HTTP router and no test runner.
  - Abstractions leak exactly where it matters: `SET LOCAL` for row-level security, forced RLS,
    advisory locks for migrations, and `DELETE ... RETURNING` for single-use tickets.
  - The generated SQL is harder to reason about at the moment a tenancy bug is being
    investigated.
  - Does not remove the need for a conformance suite; it just makes the divergence harder to
    see.

### Option 3: Postgres only, dropping SQLite

- Pros
  - One driver, one dialect, no conformance suite, no placeholder rewriting.
  - Row-level security available everywhere, so no "backstop absent" caveat.
  - Simpler operationally in production.
- Cons
  - Destroys the property that `npm run dev` needs nothing installed and nothing running, which
    the README is built around and which the fixtures and mock MCP server depend on.
  - Every contributor and every documentation reader would need Docker or a local Postgres to
    see a trace.
  - The local single-user product is a real use case, not just a development convenience.

## Consequences

### Positive

- The local free-development path survived the hosted migration entirely intact.
- The application layer is driver agnostic, so a tenancy test written once runs against both.
- The `Db` interface made the transaction boundary explicit, which is what `SET LOCAL` for
  row-level security needs. See ADR-019.
- Silent divergences were found because both drivers are exercised: Postgres dropped any step
  containing a NUL character, losing the whole step, and SQLite MCP rebuilds failed against
  populated databases. Neither would have surfaced with one driver.
- `npm run test:shape-parity` puts one Run and four Steps through both drivers and compares them
  field by field, so a step replayed from either is the same shape.

### Negative

- Two implementations and a conformance suite are ongoing maintenance.
- The asynchronous interface was a codebase-wide change with no user-visible benefit on the day
  it landed.
- One known divergence remains and is documented rather than fixed: `users.external_id` is
  case-insensitive on SQLite and case-sensitive on Postgres. The mitigation is the production
  refusal, and the table rebuild is still owed.
- On SQLite there is no second wall. The repository layer is the whole of tenant enforcement,
  which is acceptable for one person on one machine and is why the production refusal exists.

### Trade-offs

- Maintenance of two drivers was traded for keeping the local path free and installation-free.
- An asynchronous interface was accepted even though the default driver is synchronous, because
  it is the only shape both can satisfy.
- The production refusal trades flexibility for safety: it makes a known identity discrepancy
  structurally unreachable rather than merely improbable, for the cost of a paragraph of
  explanation.

## Implementation Notes

- `server/src/db/db.ts` defines `Queryable`, `Tx` and `Db`. `Queryable` is shared by a database
  and a transaction inside one, so a query helper is written once and used in either, which is
  what stops the repository layer growing scoped and unscoped copies of every method.
- `server/src/db/open.ts` is the only place a driver is chosen. `driverFromEnv` refuses an
  unknown value and refuses SQLite under `NODE_ENV=production`.
- `server/src/db/sqlite.ts` and `server/src/db/postgres.ts` are the two drivers. Placeholder
  rewriting from `?` to `$n` happens in the Postgres driver.
- `server/src/db/conformance.ts` is the shared suite, run against SQLite by `npm run test:db`
  and against Postgres by `npm run test:db-postgres`.
- `npm run test:db-boundary` asserts that no module outside `src/db/` imports a driver, that the
  drivers *are* imported inside `src/db/` (so a pass cannot come from the feature being
  deleted), and that the rule still fails on text designed to fail it.
- `npm run test:driver` covers the driver choice and the two combinations it refuses to boot on.
- Both SQLite stores share one database file on one connection: a single writer, and aggregation
  can join evaluation jobs against the frozen `steps` table directly.
- `docker-compose.yml` binds Postgres on 5433 rather than 5432, because plenty of machines
  already run a Postgres on the default port and a development database that quietly attaches to
  the wrong server is a bad afternoon.

## Security Considerations

- **`JAROKU_PG_URL` rather than `DATABASE_URL`** is a security decision, not a naming
  preference. Reusing the connector's variable would point every agent's `pg_query` at the
  control plane's own data, silently.
- **Row-level security exists only on Postgres.** SQLite has no RLS and no roles, so on that
  driver the repository layer is the entire enforcement. The production refusal is what keeps
  that from being a deployment posture.
- **The application must not connect as a superuser or with `BYPASSRLS`.** Migration `009_rls`
  creates a `jaroku_app` role with neither, and `npm run test:rls` asserts it.
- **No driver outside `src/db/`** means there is no module that can open its own connection, and
  therefore no connection that nobody scopes.
- **`?` placeholders everywhere, never interpolation.** The `exec` method is the one that cannot
  bind a value, is DDL only, and must never be handed anything a user supplied.
- Database dumps contain trace payloads, which contain whatever agents touched. Treat them as
  regulated data.

## Performance Considerations

- The asynchronous interface adds a promise per query on the SQLite path, where the underlying
  call is synchronous. Measurable, and irrelevant next to the work the queries support.
- Placeholder rewriting is a single pass over the query string, performed per call. Queries are
  short.
- Each Postgres repository operation runs inside a transaction that issues `SET LOCAL
  app.workspace_id`, which is an extra statement per operation and is the cost of row-level
  security under transaction pooling.
- Indexes lead with `workspace_id`, because a trailing tenant column makes the planner scan an
  index built for a different question. See ADR-018.
- SQLite is a single writer on one connection, which is correct for one machine and is exactly
  the property Postgres is introduced to remove.

## Operational Considerations

- Local: nothing to install. `npm run dev` opens `server/jaroku.db`.
- Hosted: `docker compose up -d postgres`, then run migrations and start with
  `JAROKU_DB_DRIVER=postgres JAROKU_PG_URL=...`.
- Migrations run as the database **owner**; the server connects as the application role. A
  server whose connection cannot apply migrations says which ones are owed and who has to apply
  them, rather than failing with a raw privilege error.
- `npm run import -- --workspace "<name>"` moves an existing local install across. It is
  idempotent and resumable, because every insert is `ON CONFLICT DO NOTHING` on an id the source
  already assigned. `--dry-run` reads everything and writes nothing.
- `runtime/agents/` is not copied by the import. Projects still live on the machine's disk.
- Any change to a store should be verified against both drivers, because the ways the two differ
  are almost all silent.

## Rejected Alternatives

**An ORM or query builder** was rejected because it adds a substantial dependency to the path
every request takes, in a codebase that deliberately has no web framework, no test runner and a
hundred-line migration runner. More importantly, the abstraction leaks exactly where the hard
problems are: `SET LOCAL` for row-level security, forced RLS, advisory locks for concurrent
migration, and `DELETE ... RETURNING` for single-use ticket redemption are all things this
system depends on and all things an abstraction obscures.

**Postgres only** was rejected because it destroys the free local path. `npm run dev` with
nothing installed and nothing running is a property the README is built around, the fixtures
depend on, and the mock MCP server depends on. Requiring Docker to see a trace would change what
the product is for a large class of its users, and the single-machine local install is a real
use case rather than a development convenience.

## Related Decisions

- ADR-003: Three process architecture with a Python runtime and a Node control plane
- ADR-017: Forward only checksummed migrations across two dialects
- ADR-018: The workspace as the tenancy unit, with an explicit context argument
- ADR-019: Row level security as the backstop rather than the enforcement
- ADR-021: Single use WebSocket tickets, whose store uses `DELETE ... RETURNING`
- ADR-028: Tests as plain scripts, with structural audits

## References

- `server/src/db/db.ts`, `open.ts`, `sqlite.ts`, `postgres.ts`, `conformance.ts`
- `server/src/db/boundary.test.ts` (`npm run test:db-boundary`),
  `driver.test.ts` (`npm run test:driver`),
  `shapeParity.test.ts` (`npm run test:shape-parity`)
- `server/src/db/import.cli.ts` (`npm run import`)
- `docker-compose.yml`
- README sections "The tenancy model" and "Configuration"
- CHANGELOG v0.2.5 "Jaroku's Tenancy" and v0.2.6
- Node.js `node:sqlite` documentation, https://nodejs.org/api/sqlite.html
- PostgreSQL row-level security documentation,
  https://www.postgresql.org/docs/current/ddl-rowsecurity.html
