# ADR-019: Use Postgres Row Level Security as the Backstop, Not as the Enforcement

## Status

Accepted. Introduced in v0.2.5 (7 August 2026), migration `009_rls`.

## Context

The tenancy model puts a `workspace_id` on every row and requires every repository method to take
a context as its first argument (ADR-018). That makes an unscoped tenant query a compile error,
which is a strong guarantee.

It is not a complete one. The compiler enforces that a context was *supplied*, not that the
resulting SQL actually filtered on it. A method can take a `TenantContext` and then write a query
that ignores it. A hand-written query added in a hurry can filter on the wrong column. The
application layer is written by people and will eventually be wrong.

Postgres offers a second wall: row-level security policies evaluated by the database itself, on
every statement, regardless of what the application intended.

The question is what role that second wall plays. Two answers were possible:

- **RLS as the enforcement.** The application does not scope; the database does. Queries are
  written plainly and the policy filters them.
- **RLS as the backstop.** The application scopes explicitly and the database enforces it again,
  so a bug in one layer is caught by the other.

There is also a constraint the design has to live with: **SQLite has no row-level security and no
roles.** The local default driver cannot have a second wall at all.

## Decision

**Row-level security is the backstop. The repository layer is the enforcement.**

Every tenant table on Postgres has `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, plus a
`tenant_isolation` policy with both `USING` and `WITH CHECK`:

```sql
CREATE POLICY tenant_isolation ON runs
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
```

Every detail is load bearing.

**`FORCE`**, because `ENABLE` alone exempts the table owner, and on a modest deployment the owner
is whoever ran the migrations, often the application, so `ENABLE`-only RLS never applies once.

**`WITH CHECK`**, because `USING` alone lets a caller INSERT into another workspace and merely not
read it back, which is a write across the boundary and still a hole.

**`SET LOCAL`** in the repository's transaction wrapper, because a session-scoped `SET` leaks to
whoever gets that pooled connection next. This is precisely the bug a session-scoped `SET`
produces under transaction pooling infrastructure such as PgBouncer, where a connection is handed
on between statements.

**`NULLIF`**, because a custom setting that has ever been set keeps *existing* on that connection
holding an empty string, so the next unscoped user of a pooled connection gets `''` rather than
NULL, and `''::uuid` raises instead of matching nothing.

**A missing setting matches nothing.** Fail closed, which is the entire point.

**Two tables are deliberately policy free**, and both for the same reason: a policy on either
would break the thing that makes every other policy work. `audit_log`'s most important row is a
*denied* attempt, whose workspace may not exist. `workspace_members` is what *answers* which
workspace a request may act in.

**The application must not connect as a superuser or with `BYPASSRLS`.** Either ignores every
policy unconditionally, and nothing in the schema would tell you. Migration `009_rls` creates a
`jaroku_app` role with neither, and `npm run test:rls` asserts it.

**On SQLite there is no second wall.** The repository layer is the whole of the enforcement.
That is acceptable for what SQLite is here, one person on one machine, and it is why
`npm run test:tenancy` runs there too and why the driver refuses to boot under
`NODE_ENV=production`.

## Alternatives Considered

### Option 1: Explicit application scoping, with RLS as a backstop

- Pros
  - Two independent walls: a bug in the application layer is caught by the database, and a
    misconfigured policy is caught by the application.
  - The SQL says what it means, so a query is readable without knowing the current policy state.
  - Works identically on both drivers at the application layer, so the same tenancy suite runs on
    SQLite and Postgres.
  - `WITH CHECK` closes cross-boundary writes, which a `USING`-only policy leaves open.
  - Fails closed when the setting is absent.
- Cons
  - Scoping is expressed twice, in the query and in the policy.
  - Every operation runs inside a transaction issuing `SET LOCAL`, which is an extra statement.
  - Policies are schema objects that must be added for every new table and are easy to forget,
    which is why the contributing checklist and the tenancy test enforce it.
  - The role and ownership setup is an operational requirement that is invisible in the
    application code.

### Option 2: RLS as the sole enforcement, with unscoped application queries

- Pros
  - Scoping written once, in the policy.
  - Queries are simpler.
  - Impossible for an application query to forget a filter, because there is no filter to forget.
- Cons
  - Does not work on SQLite at all, so the local default driver would have no tenancy enforcement
    whatsoever.
  - A single misconfiguration removes all isolation: a connection as the owner without `FORCE`, a
    role with `BYPASSRLS`, or a missing `SET LOCAL` and every query returns everything.
  - Reading a query tells you nothing about what it returns, which is a poor property when
    investigating a suspected leak.
  - Tests would have to run against Postgres exclusively.

### Option 3: Application scoping only, with no RLS

- Pros
  - One place to express scoping, one mental model, and no policy maintenance.
  - Identical behaviour across both drivers.
  - No `SET LOCAL` overhead and no role or ownership requirements.
- Cons
  - The only wall is code written by people, and the failure mode is a silent cross-tenant read
    of regulated data.
  - A single hand-written query that filters on the wrong column has no second check.
  - Offers nothing against a future code path that reaches the database outside the repository
    layer.

## Consequences

### Positive

- Two independent walls, so the leak requires two failures rather than one.
- The `SET LOCAL` requirement forced the transaction boundary to be explicit in the `Db`
  interface, which is good design independently of RLS.
- `npm run test:rls` exercises the policies rather than asserting they exist: forced, write
  checked, and failing closed when unscoped.
- Isolation holds under transaction pooling, which is what a hosted deployment will use.
- The two policy-free tables are documented with their reasons, so a future contributor does not
  "fix" them.

### Negative

- Scoping is expressed twice, which is duplication and a place for the two to disagree.
- Every Postgres operation carries a transaction and a `SET LOCAL`.
- The backstop is absent on SQLite, which is why production on SQLite is refused rather than
  merely discouraged.
- A new table needs a policy added to the loop in a new migration, and forgetting it produces a
  table with no backstop.
- Correct operation depends on the application role being neither the owner nor `BYPASSRLS`,
  which is an operational property outside the code.

### Trade-offs

- Duplication of scoping logic was accepted in exchange for defence in depth over regulated data.
- The `SET LOCAL` cost per operation was accepted because a session-scoped alternative is a leak
  under pooling.
- SQLite's missing backstop was addressed by refusing production rather than by trying to emulate
  RLS, because an emulation would be a third mechanism to trust and would not be enforced by the
  database.
- `audit_log` and `workspace_members` were left policy free deliberately, accepting that both
  need their access controlled by the repository layer alone.

## Implementation Notes

- Migration `009_rls` enables and forces RLS on every tenant table, creates the `tenant_isolation`
  policies, and creates the `jaroku_app` role with neither ownership nor `BYPASSRLS`.
- The `SET LOCAL app.workspace_id` is issued by the repository's transaction wrapper in
  `server/src/db/db.ts` and `server/src/db/postgres.ts`, not by individual queries.
- Adding a table means adding it to the policy loop in a **new** RLS migration. Migrations are
  forward only, so an existing one is never edited. See ADR-017.
- `workspace_invites` does keep a policy, and the trick that makes it possible is worth noting:
  the invite token is `<workspace_id>.<secret>`, and the workspace id in it authorises nothing.
  It selects which rows to search so the query can be scoped, and the 256-bit secret is the whole
  of the proof. `ws_tickets` could not use that trick, which is why that table is policy free and
  holds nothing but a digest, an id and a role for thirty seconds.
- `npm run test:rls` covers the policies being forced, the write check rejecting a
  cross-workspace insert, and an unscoped connection returning nothing.
- `npm run test:tenancy` runs against SQLite always and against Postgres as well when
  `JAROKU_PG_URL` is set, because the ways the two drivers differ are almost all silent.

## Security Considerations

- **`ENABLE` without `FORCE` is a no-op in the common deployment**, because the owner is exempt
  and the owner is often the application. This is the single most likely way to believe RLS is
  protecting a system that it is not.
- **`USING` without `WITH CHECK` permits a cross-boundary write.** The caller cannot read the row
  back, which makes the hole quiet rather than absent.
- **A session-scoped `SET` leaks across pooled connections.** Under PgBouncer in transaction
  pooling mode, the next user of that connection inherits the scope.
- **An empty setting is not a missing setting.** A custom setting that has ever been set persists
  on the connection holding `''`, and `''::uuid` raises. `NULLIF` converts it to NULL so the
  policy matches nothing, which is the fail-closed behaviour.
- **A superuser or `BYPASSRLS` role ignores every policy unconditionally**, and nothing in the
  schema would indicate it. This is asserted by test rather than left to deployment discipline.
- RLS guards what a *query* returns. It guards nothing about what the server **pushes**, and a
  WebSocket relay's whole job is pushing. That gap is closed separately. See ADR-023.

## Performance Considerations

- One extra statement, `SET LOCAL app.workspace_id`, per repository operation.
- Policy evaluation adds a predicate to every statement on a tenant table. Because every relevant
  index leads with `workspace_id`, the predicate is satisfied by the index rather than by a
  filter over a scan.
- `SET LOCAL` is transaction scoped, so it is compatible with transaction pooling and does not
  require session affinity.
- No measurable cost on the SQLite path, which has no policies.

## Operational Considerations

- The application must connect as `jaroku_app`, or as an equivalent role that is neither the
  table owner nor `BYPASSRLS`. Connecting as a superuser silently disables every policy.
- Migrations run as the owner, the application runs as the application role. A server whose
  connection cannot apply migrations reports which are owed and who has to apply them.
- Maintenance reads that legitimately cross workspaces (restart reconciliations, the startup
  checkpoint sweep) need an administrative connection under RLS and say so in their signatures.
- After adding a table, verify the policy exists. `npm run test:rls` is the check.
- SQLite in production is refused at boot. That refusal is the mitigation for the absent backstop
  and should not be worked around.

## Rejected Alternatives

**RLS as the sole enforcement** was rejected primarily because it does not exist on SQLite, which
is the default driver and the whole of the free local development path. It would mean the driver
most people run has no tenancy enforcement at all. It is also brittle in a specific way: a
connection as the owner without `FORCE`, a role with `BYPASSRLS`, or a missing `SET LOCAL`
silently removes all isolation, and reading a query would tell an investigator nothing about what
it returns.

**Application scoping with no RLS** was rejected because the only wall would be code written by
people, over an asset that is regulated data belonging to someone who never consented. The
compiler can enforce that a context was supplied; it cannot enforce that the SQL used it. A second
wall evaluated by the database on every statement is exactly the check the first wall cannot
perform on itself.

## Related Decisions

- ADR-016: A database interface with two drivers
- ADR-017: Forward only checksummed migrations across two dialects
- ADR-018: The workspace as the tenancy unit, with an explicit context argument
- ADR-021: Single use WebSocket tickets, whose table is deliberately policy free
- ADR-023: One WebSocket carrying many logical channels, which is what RLS does not cover

## References

- `server/migrations/postgres/009_rls.sql`, `server/migrations/sqlite/009_rls.sql`
- `server/src/db/db.ts` and `server/src/db/postgres.ts`, the transaction wrapper
- `server/src/db/rls.test.ts` (`npm run test:rls`)
- `server/src/tenancy.test.ts` (`npm run test:tenancy`)
- README section "RLS is the backstop, not the enforcement"
- CHANGELOG v0.2.5 "Jaroku's Tenancy"
- PostgreSQL row-level security documentation,
  https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- PgBouncer pooling modes, https://www.pgbouncer.org/features.html
