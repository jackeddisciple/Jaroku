# ADR-017: Apply Schema Changes With a Forward Only, Checksummed Runner Across Two Dialects

## Status

Accepted. Introduced in v0.2.5 (7 August 2026).

## Context

The hosted migration introduced a real schema: identity tables, tenancy columns on every
existing table, an agent registry, row-level security policies, and later ticket, invite and
onboarding changes. That schema has to be applied consistently to two different databases, on
developer machines and in production, sometimes by several server processes starting at once.

Four constraints shaped the design.

**Two dialects that genuinely disagree.** SQLite and Postgres do not agree about uuids, citext,
jsonb, or row-level security. SQL written to paper over the difference is portable and wrong.

**No dependency appetite.** This codebase already prefers a script it can read to a tool it has
to trust. The test suites are plain `tsx` scripts, the event transport is delimiters rather than
a parser library, and the HTTP router is ninety lines with no framework. A migration runner that
does only what this one needs is about a hundred lines.

**Editing an applied migration is a real hazard.** Every later migration was written against the
database an earlier one produced, so "undo it and edit it" describes a database nobody has. If
an applied file is edited, the schema in front of you and the schema the checkout describes
drift apart with nothing saying so, which is the failure mode a migration tool exists to prevent
in the first place.

**Several processes may start simultaneously.** Without serialisation, concurrent migration
attempts race.

## Decision

**Numbered SQL files, applied once each, in order, inside a transaction, recorded in
`schema_migrations`.**

Five properties.

**Two directories, one numbering.** `server/migrations/postgres/` and
`server/migrations/sqlite/` hold the same versions under the same names. A version one dialect
has nothing to do for gets a comment-only file rather than a missing one, so the two sequences
can never drift apart silently, and `npm run migrate` on either driver walks the same version
numbers.

**Forward only. There is no `down`.** A migration that has run is history.

**Checksummed.** Editing an applied file is a hard failure naming the file.

**Transactional per migration**, so a failed migration leaves nothing half applied.

**Serialised across processes.** A Postgres advisory lock ensures exactly one instance applies
at boot. This was tested with five simultaneous attempts.

The filename pattern is `NNN_name.sql` with three digits, so a plain lexical sort is also a
version sort. The `schema_migrations` bookkeeping table stores `applied_at` as text rather than
a timestamp, because the table must exist before any dialect-specific migration has run and an
ISO-8601 string means the same thing in both databases without either being asked.

The migration runner's interface is deliberately narrower than the application's `Db`: a
migration runs against **one connection held for the whole run**, because it opens explicit
transactions and takes a lock that only means anything while a single session holds it. A pool
that handed out a different connection per call would silently break both.

**Migrations run as the database owner; the server connects as the application role.** A server
whose connection cannot apply migrations says which ones are owed and who has to apply them,
rather than failing with a raw privilege error.

When a shipped migration turns out to need a change, the answer is a new migration. Migration
011 was introduced rather than editing the already-shipped migration 010, keeping the runner
forward only and checksummed.

## Alternatives Considered

### Option 1: A hand-written forward only checksummed runner, two directories, one numbering

- Pros
  - No dependency in a path that runs at every boot.
  - Dialect differences are expressed as different SQL, which is honest, rather than hidden
    behind an abstraction.
  - Checksums make an edited applied migration a loud failure instead of silent drift.
  - Comment-only files make a dialect's "nothing to do" explicit and keep the sequences aligned.
  - About a hundred lines, all readable when something goes wrong at 3am.
- Cons
  - Every migration must be written twice, once per dialect, even when the SQL is identical.
  - No `down`, so a mistake is corrected by a new migration rather than a rollback.
  - Tooling that comes free with a mature migration framework (squashing, diffing, generating)
    has to be done by hand.
  - The runner is the project's own code and therefore the project's own bug surface.

### Option 2: A migration framework or ORM migration tool

- Pros
  - Mature, widely used, with generation, rollback and squashing.
  - Dialect handling often included.
  - Less bespoke code.
- Cons
  - A dependency in the boot path of a codebase that deliberately avoids them elsewhere.
  - Framework abstractions obscure the parts that matter here: forced row-level security,
    policy loops, an advisory lock, and role ownership distinct from the application role.
  - Most such tools assume one dialect per project, so the two-directory requirement fights the
    tool.
  - Rollback support encourages the "undo and edit" workflow this decision deliberately
    forbids.

### Option 3: An idempotent schema script applied at every boot

- Pros
  - No versioning table, no ordering, no checksums.
  - Trivially simple to reason about for additive changes.
- Cons
  - Data migrations cannot be expressed idempotently in general. Backfilling a column, changing
    a constraint or splitting a table are not `CREATE IF NOT EXISTS` operations.
  - No record of what has been applied, so there is no way to answer "which version is this
    database".
  - Concurrency is unresolved: two processes running the script race with each other.

## Consequences

### Positive

- A database's version is a fact recorded in `schema_migrations` and answerable at any time.
- An edited applied migration fails by name, rather than producing a database that silently does
  not match the checkout.
- The two dialect directories make disagreement visible. Comment-only files document "this
  dialect has nothing to do here" rather than leaving a gap.
- Concurrent boots are safe. Five simultaneous migration attempts were tested and serialised by
  the advisory lock.
- Because migrations are the only way the schema changes, the tenancy rules in `CONTRIBUTING.md`
  can be mechanical: a new table needs a migration in both directories, a `workspace_id`, a
  policy and a test.

### Negative

- Every migration is written twice, which is duplication even when the SQL is identical.
- No rollback. Correcting a mistake means writing a forward migration, which is more work than a
  `down` in the moment and correct in the long run.
- The runner is project code, so a bug in it is a bug the project owns.
- SQLite lacks an equivalent advisory lock, so cross-process serialisation there relies on the
  local single-writer model rather than an explicit lock.

### Trade-offs

- Duplication across dialects was accepted in exchange for honest, dialect-specific SQL.
- Rollback was given up deliberately. It encourages editing history, which is the failure the
  checksums exist to catch.
- A bespoke runner was accepted in exchange for no dependency and full visibility into a process
  that runs at every boot.

## Implementation Notes

- `server/src/db/migrate.ts` holds the runner and defines `MigrationTarget`, deliberately
  narrower than `Db`. `server/src/db/migrate.cli.ts` is `npm run migrate`.
- Filenames match `^(\d{3})_([a-z0-9_]+)\.sql$`. Three digits, lowercase name.
- `schema_migrations` records version, name, checksum and `applied_at` as text.
- `withLock` serialises across processes. On Postgres this is an advisory lock.
- Current sequence: `001_extensions`, `002_baseline`, `003_identity`, `004_trace_tenancy`,
  `005_eval_tenancy`, `006_mcp_tenancy`, `007_deploy_tenancy`, `008_agents`, `009_rls`,
  `010_ws_tickets`, `011_ticket_token_expiry`, `012_invites`, `013_user_onboarding`.
- Adding a table, per `CONTRIBUTING.md`: write the migration in both directories under the same
  number; add `workspace_id`, backfill, constrain, and index with `workspace_id` **leading**;
  add the table to the policy loop in a new row-level security migration; give it a repository
  whose every method takes a context first; and add its methods to `SCOPED_API` in
  `tenancy.test.ts`.
- `npm run test:migrate` covers forward-only behaviour, checksums, transactionality and the
  refusal of an edited file.

## Security Considerations

- **Ownership is split deliberately.** Migrations run as the owner; the application connects as
  `jaroku_app`, which is neither the table owner nor a superuser and does not carry `BYPASSRLS`.
  That split is what makes `FORCE ROW LEVEL SECURITY` meaningful, because `ENABLE` alone exempts
  the table owner.
- **Row-level security policies are created by migration**, so the backstop is part of the
  schema rather than something an operator remembers to apply. See ADR-019.
- **`exec` is the one method that cannot bind a value**, is DDL only, and must never be handed
  anything a user supplied. Migration SQL is repository content, not input.
- A failed migration rolls back, so a partially applied policy change cannot leave a table with
  RLS enabled and no policy, or a policy with no `WITH CHECK`.
- Checksums are integrity, not authentication. They detect accidental drift between the checkout
  and the database; they are not a defence against an attacker with database access.

## Performance Considerations

- Migration cost is dominated by the individual statements, not by the runner, which reads a
  directory and compares checksums.
- The advisory lock is held for the duration of a migration run, so a slow migration delays
  other instances' boots. That is the intended behaviour: the alternative is a race.
- Indexes are created with `workspace_id` leading, which is invisible at one workspace and is
  the whole cost of the query at six thousand.
- A boot against an already-current database is a directory read, a checksum comparison and one
  query.

## Operational Considerations

- `npm run migrate` applies pending migrations and exits. Run it as the owner.
- Under Postgres, the server started with the application role reports which migrations are
  owed and who has to apply them, rather than failing with a privilege error.
- Never edit an applied migration file. The runner refuses it by name, and the refusal is the
  feature.
- To change something a shipped migration got wrong, add a new migration. Migration 011 exists
  because of exactly this.
- A comment-only file in one dialect's directory is intentional and means that dialect has
  nothing to do for that version.
- Backups should be taken before a migration in production, because there is no `down`.

## Rejected Alternatives

**A migration framework or ORM migration tool** was rejected for the same reason the HTTP router
has no framework and the test suites have no runner: a dependency in a path that runs at every
boot, obscuring the parts of the schema that matter most here. Forced row-level security, a
policy loop, an advisory lock and an ownership split distinct from the application role are all
things this system depends on and all things a framework abstracts away. Most such tools also
assume one dialect per project, which fights the two-directory requirement directly.

**An idempotent schema script applied at every boot** was rejected because data migrations
cannot generally be expressed idempotently. Backfilling a tenancy column across existing rows,
tightening a constraint, or splitting a table are not `CREATE IF NOT EXISTS` operations. It also
leaves no record of what has been applied, so "which schema version is this database" becomes
unanswerable, and it does not address concurrent boots at all.

## Related Decisions

- ADR-016: A database interface with two drivers
- ADR-018: The workspace as the tenancy unit, with an explicit context argument
- ADR-019: Row level security as the backstop rather than the enforcement
- ADR-028: Tests as plain scripts, with structural audits

## References

- `server/src/db/migrate.ts`, `server/src/db/migrate.cli.ts`
- `server/src/db/migrate.test.ts` (`npm run test:migrate`)
- `server/migrations/postgres/` and `server/migrations/sqlite/`
- `CONTRIBUTING.md`, "A new table needs a workspace, a policy and a test"
- README section "Adding a table"
- CHANGELOG v0.2.5 "Jaroku's Tenancy" and v0.2.6
