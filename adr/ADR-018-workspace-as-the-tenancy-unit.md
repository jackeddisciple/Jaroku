# ADR-018: Make the Workspace the Tenancy Unit and Require an Explicit Context Argument

## Status

Accepted. Introduced in v0.2.5 (7 August 2026).

## Context

Jaroku is becoming a hosted, multi-tenant product. Before that work, every row in the system
belonged to whoever was running the server, because that was one person on one machine.
Introducing tenancy meant answering two separate questions.

**What is a tenant?** The obvious answer is a user. It is also the answer that has to be undone
the first time two people want to share an agent, because "share this row with another user"
requires a second concept anyway, and adding it later means re-migrating every table and
rewriting every query.

**How is scoping enforced?** The default in most systems is a `WHERE` clause, remembered by the
author of each query. That works until somebody forgets one, and the forgotten one is always in
the code path nobody thought about. Worse, a missing `WHERE` clause is invisible in review: the
query looks like a query.

The asset makes the stakes concrete. A workspace's traces contain whatever the agent touched:
the contents of a mailbox, rows from a database, the text of Slack channels, and the prompts the
user wrote. That is regulated data belonging to somebody who never consented to another tenant
seeing it.

The threat model assumes an attacker with a legitimate account: someone who can sign in, open
sockets, read every response, send arbitrary commands and try ids all day.

## Decision

**The workspace is the tenancy unit. Every scoping column is `workspace_id`.**

`user_id` appears in exactly three places: membership rows, audit rows, and "who did this"
attribution. A single user is a workspace with one member, so adding a second member later is a
row rather than a re-migration of every table and a rewrite of every query.

| Table | What it is |
|---|---|
| `users` | One row per person. `external_id` is the auth provider's `sub`, opaque and never parsed |
| `workspaces` | The tenancy unit. `personal` is created at signup; `team` is everything else |
| `workspace_members` | Who may act in a workspace, and as what: `owner`, `admin` or `member` |
| `audit_log` | Membership changes, deletions, and every denied cross-tenant attempt |
| `agents` | The agent list, which used to be a directory listing. Slugs are unique per workspace |
| `agent_versions` | Per-version file digests, written now and read by a later session |

`runs`, `steps`, the evaluation control plane, the MCP registry and the deploy records all
carry a `workspace_id` referencing `workspaces.id`.

**Two rules, enforced by tests rather than by review.**

**Every store and repository method takes a context as its first argument.** A parameter you must
supply is harder to forget than a `WHERE` clause you must remember.

```ts
type TenantContext = { workspaceId: string; actorUserId: string | null; role: Role; requestId: string };
type SystemContext = { actorUserId: string | null; role: "system"; requestId: string };
```

Two types, because there are genuinely two situations. Almost everything takes a
`TenantContext`. A short list of operations happen *before* a workspace is known and cannot be
scoped by the thing they are producing: mapping an auth provider's `sub` to a user on first
sight, creating that user's personal workspace, and answering which workspaces somebody belongs
to. Those take a `SystemContext`. They are separate types on purpose, so the compiler refuses to
let a tenant query run unscoped and the exceptions are visible in the signatures rather than
buried in the bodies. Giving them a fake `TenantContext` with a placeholder workspace id would be
worse than having a second type, because it would make "this ran unscoped" indistinguishable
from "this ran scoped to the wrong workspace".

**Nothing outside `server/src/db/` imports a driver.** A module that could open its own
connection is a connection nobody scopes.

**`actorUserId` is attribution, never authorisation.** Nothing decides what may happen from that
field. The workspace scope and the role do that; the field exists so an audit row can name a
person.

**Never trust a workspace id from a client.** It arrives the same way a run id or an agent slug
does, as a string in a payload. What turns one into a scope is a `workspace_members` row, and
there is exactly one function that does the turning: `ContextResolver.resolve`.

**The one exception to the frozen event schema** is that `workspace_id` is a storage column on
`runs` and `steps` and must never appear in an emitted event. That is a `SELECT *` away from
being false at all times, so the trace store names its columns explicitly.

## Alternatives Considered

### Option 1: Workspace as the tenancy unit, with a context-first repository API

- Pros
  - Sharing is a membership row rather than a schema change, so collaboration never requires
    re-migrating every table.
  - A context parameter is a compile-time requirement, which is stronger than a convention.
  - Two context types make the small set of genuinely unscoped operations visible in signatures.
  - One resolution function means there is exactly one place to audit for "how does a string
    become a scope".
  - Roles fit naturally, because a membership row already exists to hold one.
- Cons
  - Every repository signature carries a parameter, which is verbose.
  - A single-user installation carries a workspace concept it does not need.
  - The context has to be threaded through every layer that reaches storage.
  - Two context types mean choosing between them, and choosing wrong is a design error rather
    than a compile error.

### Option 2: User as the tenancy unit, with `user_id` on every row

- Pros
  - Simplest possible model for a single-user product.
  - No membership table, no roles, no invitations.
  - Slightly less to thread through the code.
- Cons
  - Sharing requires a second concept, added later, which means re-migrating every table and
    rewriting every query.
  - Role-based authorisation has nowhere natural to live.
  - "Who owns this row" and "who may see this row" become the same question, which they are not
    the moment two people collaborate.

### Option 3: Implicit scoping through a request-local variable or middleware

- Pros
  - No parameter on every signature, so the code is less verbose.
  - Scoping happens once, at the request boundary.
- Cons
  - Ambient state is invisible at the call site, so a query that runs outside a request, or in a
    background job, silently has no scope or the wrong one.
  - This product has real background work: the startup run, sweepers and restart reconciliations.
    Those genuinely have no request.
  - The failure discovered in practice was exactly this shape: a single module-level
    `buildContext` covered planning, generation, editing and explaining, four subsystems with
    four independent locks, so one variable could not hold two answers.

## Consequences

### Positive

- The migration to multi-tenant was a schema and signature change rather than a redesign, and
  the local single-user path was unaffected.
- `npm run test:tenancy` covers 84 scoped repository methods across 227 assertions, on both
  database drivers, and fails until a new method is added to `SCOPED_API` and exercised.
- The compiler catches an unscoped tenant query, so the class of bug most likely to leak data is
  a build error.
- Slugs becoming unique per workspace rather than globally was the single intentional
  behavioural change, and it fell out of the model rather than being bolted on.
- Because roles live on a membership row, the capability matrix had a natural home. See ADR-022.

### Negative

- Every repository signature is longer.
- A single-user installation carries workspaces, memberships and roles it does not need.
- One namespace is still shared: agent slugs are unique per workspace in the table, but two
  workspaces with a `support_bot` would still collide on `runtime/agents/support_bot/`. This is
  documented as outstanding, to be resolved by an object store keyed by workspace id and agent
  uuid.
- Agent files and the graph are still read from a global directory. Those two relay reads take a
  context and ignore it, so the signature will not change when storage moves.
- Cross-workspace maintenance reads run unscoped and say so in their signatures. Under row-level
  security they need an administrative connection rather than the application role.

### Trade-offs

- Verbosity was traded for a compile-time guarantee, deliberately, because the alternative
  failure is silent and the asset is regulated data.
- A workspace concept was introduced before it was needed for collaboration, in exchange for
  never having to re-migrate every table to add it.
- The scope was attached to the *operation* rather than to the process. This was learned the
  hard way: a single shared context, assigned before the busy guard, meant a refused request
  still repointed it, so one workspace's rejected generate redirected another workspace's
  still-streaming source code into the wrong build pane.

## Implementation Notes

- `server/src/db/tenant.ts` defines `TenantContext`, `SystemContext`, `AnyContext`, `Role` and
  `MemberRole`.
- `server/src/auth/resolve.ts` holds `ContextResolver.resolve`, the only function that turns an
  authenticated identity plus a requested workspace into a `TenantContext`, and it does so from a
  `workspace_members` row and nowhere else.
- `npm run test:db-boundary` is a plain `tsx` script rather than a lint rule, because there is no
  lint toolchain here and every other check is a script. It asserts the drivers *are* imported
  inside `src/db/`, so a pass cannot come from the feature being deleted; that no exemption names
  a method that no longer exists; and that the rule still fails on text designed to fail it.
- `npm run test:tenancy` asserts coverage: a new repository method must be listed in `SCOPED_API`
  and exercised, or the suite fails. That assertion is what makes the contributing checklist
  mechanical rather than aspirational.
- Indexes lead with `workspace_id`. A trailing tenant column makes the planner scan an index
  built for a different question, which is invisible at one workspace and is the whole cost of
  the query at six thousand.
- `JAROKU_DEV_WORKSPACE` names the workspace the server acts in **on its own behalf**: the
  startup run, the sweepers and the restart reconciliations. Work nobody triggered still needs a
  scope, and it is announced at boot.
- Each subsystem claims its own scope, once its operation has actually started, and a refusal is
  answered to whoever asked rather than through the scope. `npm run test:channels` asserts both
  properties by reading `index.ts`, because the ordering is the whole of the fix and nothing
  about it is visible at a type level.

## Security Considerations

- **A workspace id from a client authorises nothing.** Only a `workspace_members` row does, and
  only through one resolution function. A second path that skipped it would not fail any existing
  test, which is why `test:tenancy` asserts that a forged `workspaceId` is ignored.
- **A refusal message must never depend on whether something exists.** "You are not a member of
  that workspace" and "no such workspace" are the same sentence on purpose, because two different
  messages are an existence oracle over every id an attacker cares to try. The same reasoning
  applies to a spent versus a forged ticket and an expired versus an invented invitation.
- **A cross-tenant attempt is a recorded security event.** Asking to act in a workspace you are
  not a member of writes an `audit_log` row naming who tried and from where. It is deliberately
  not recorded when the workspace does not exist at all, because a scan of random uuids would
  otherwise be an unbounded write against the table whose whole job is recording attempts that
  matter.
- **`workspace_id` never leaves in an emitted event.** The trace store names its columns, and
  `npm run test:trace` asserts both halves: nothing called `workspace_id` comes back on a Run, a
  Step or a history summary, and every field the frozen schema promises is still there.
- **Row-level security is the backstop**, not the enforcement. See ADR-019.
- The acceptance suite runs two real accounts in two real workspaces simultaneously against one
  server and asserts that neither can observe the other by command, by socket push, or by timing.

## Performance Considerations

- Every tenant query filters on `workspace_id` and every relevant index leads with it, so scoping
  is an index seek rather than a filter over a scan.
- On Postgres, each repository operation runs inside a transaction issuing `SET LOCAL
  app.workspace_id`, which is one extra statement per operation and is the cost of the backstop.
- The membership decision is cached for 30 seconds, positives and negatives both. Without the
  negative, guessing workspace ids is a database round trip per guess.
- That staleness window is a stated security property rather than a tuning detail: between a
  revocation and the cache expiring, a request on another replica may still be authorised at the
  old role. Every membership mutation invalidates explicitly, which makes it exact on the replica
  that made the change.

## Operational Considerations

- `JAROKU_DEV_WORKSPACE` is announced at boot and names the workspace the server itself acts in.
- The SQLite to Postgres importer creates or targets a named workspace and is idempotent and
  resumable.
- Restart reconciliations and the startup checkpoint sweep read across workspaces. Under
  row-level security they need an administrative connection.
- Adding a table without a `workspace_id`, a policy and a tenancy test will be rejected, and the
  test suite enforces it rather than a reviewer.
- `audit_log` is where cross-tenant denials land. It is worth monitoring in a hosted deployment.

## Rejected Alternatives

**User as the tenancy unit** was rejected because sharing is inevitable and adding it later is a
re-migration of every table plus a rewrite of every query. A workspace with one member is
indistinguishable from a user-scoped model in behaviour, and it costs one join, so the cheaper
model buys nothing that the more general one does not already provide.

**Implicit scoping through ambient request state** was rejected because ambient state is
invisible at the call site and absent in background work, of which this system has a genuine
amount: the startup run, the sweepers and the restart reconciliations have no request. The
failure this product actually experienced was exactly the ambient-state failure in miniature: a
single module-level context covering four subsystems, assigned before the busy guard, so a
refused request still repointed it and redirected another workspace's in-flight stream.

## Related Decisions

- ADR-016: A database interface with two drivers
- ADR-017: Forward only checksummed migrations across two dialects
- ADR-019: Row level security as the backstop rather than the enforcement
- ADR-020: Provider agnostic OIDC verification with a real local issuer
- ADR-022: Roles as data, one capability matrix checked at the door
- ADR-023: One WebSocket carrying many logical channels
- ADR-024: Client state as per concern stores that reset on a workspace switch

## References

- `server/src/db/tenant.ts`, `server/src/auth/resolve.ts`, `server/src/store.ts`
- `server/src/tenancy.test.ts` (`npm run test:tenancy`),
  `server/src/acceptance.test.ts` (`npm run test:acceptance`),
  `server/src/db/boundary.test.ts` (`npm run test:db-boundary`),
  `server/src/store.test.ts` (`npm run test:trace`)
- `server/src/auth/THREAT-MODEL.md`, "The two rules that are easiest to break by accident"
- `CONTRIBUTING.md`, README section "The tenancy model"
- CHANGELOG v0.2.5 "Jaroku's Tenancy" and v0.2.6
