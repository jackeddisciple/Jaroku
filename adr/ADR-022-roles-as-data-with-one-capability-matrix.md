# ADR-022: Express Roles as Data in One Capability Matrix, Checked at the Door

## Status

Accepted. Introduced in v0.2.6 (7 August 2026).

## Context

A workspace can have more than one member, and not every member should be able to do everything.
Three things in particular commit the whole workspace to something outside itself: connecting a
third-party MCP server, storing a provider API key, and putting an agent on a public URL. Each
implies money, an external dependency, or an internet-facing endpoint.

The default way this gets implemented is a role check inside each command handler:

```ts
if (ctx.role !== "owner") throw forbidden();
```

That is how you get a hole, and the hole is always in the handler nobody thought about. It is
also invisible in review, because the absence of a line is not a line.

Two further problems compound it. First, roles written as three independent lists drift: the day
somebody adds a member capability and forgets to add it to the admin and owner lists is the day
admins stop being able to do something members can, and nothing says so. Second, a refusal has to
go *somewhere*. A refusal delivered on the wrong channel is indistinguishable from no answer at
all: the panel that asked waits forever while an unrelated one shows an error about something it
never did.

There is one more requirement that is easy to miss. The socket's role is captured at the
handshake, and a role can change while the socket is open. If the capability check reads the
captured role, a demoted member keeps their old powers for as long as their tab stays open.

## Decision

**Three roles, one table, one check.**

| Role | May |
|---|---|
| **member** | Build, run, edit, pause, branch and evaluate agents; answer an MCP confirmation on their own run; read members, providers, MCP servers and deployments |
| **admin** | Everything a member may, plus connect MCP servers, store provider keys, and deploy |
| **owner** | Everything an admin may, plus manage membership, the workspace, and billing |

**The split follows one question: does this change what the workspace *is*, or what is *in* it?**
Building and running agents is the product, and every member does it. Connecting a third-party
MCP server, storing a provider key, or putting an agent on a public URL commits the whole
workspace to something. Membership and the existence of the workspace itself are the owner's.

**Roles are nested**, expressed as a member floor that admin extends and owner extends again,
rather than as three copied lists. A new member capability is automatically an admin's and an
owner's.

**`system` is not a membership role.** It is the role a *request* has when nobody triggered it:
the startup reconciliations, the checkpoint sweeper, an evaluation job draining in the
background. It holds every capability because it is the server acting on its own behalf, and it
can never arrive from a client: it is minted in code, and the context resolver only ever produces
`owner`, `admin` or `member` from a membership row.

**Unclassified is refused, not allowed.** `npm run test:capabilities` reads `wsRelay.ts` directly
and fails when a command exists with no entry in `COMMAND_CAPABILITY`, so a command added in a
later session cannot arrive ungated. Because the test reads the source rather than a maintained
list, it cannot pass by being out of date.

**Every command is capability checked at the door**, before it reaches the application. A refusal
that forwards first has already written the key.

**A refusal is answered on the channel the asking panel is listening to.** `COMMAND_CHANNEL` in
`wsRelay.ts` records where each command's refusal goes. `log` is a legitimate answer for a command
whose own channel carries data rather than errors, but it has to be written down, so "log because
that is right" and "log because nobody decided" cannot look the same.

**The check reads the socket's live context on every command**, not the role captured at the
handshake. A role change is applied in place because the connection is still legitimately theirs;
what changed is what it may do.

Adding a command therefore requires two entries, both in the same commit as the command: one in
`COMMAND_CAPABILITY` and one in `COMMAND_CHANNEL`.

## Alternatives Considered

### Option 1: A capability matrix as data, checked once at the relay door

- Pros
  - One place to read to know what each role may do, so deciding a new capability means looking
    at every other capability at once.
  - A test can prove exhaustiveness by reading the source, so an ungated command is a build
    failure.
  - Nesting removes the drift between three lists.
  - Checking at the door means a refused command never reaches the application, so a partially
    executed refusal is impossible.
  - Named capabilities are more stable than roles: a capability can be reassigned to a different
    role without touching any handler.
- Cons
  - An indirection: reading a handler no longer tells you who may call it.
  - Capability names have to be chosen well, and a badly named one is a long-lived mistake.
  - Two registrations per command, which is a thing to forget, mitigated by the test.
  - A capability that is genuinely per-resource rather than per-command does not fit.

### Option 2: Role checks inside each command handler

- Pros
  - The check is next to the code it protects, so it is visible when reading the handler.
  - No indirection and no registry.
  - Trivial to add for a single new command.
- Cons
  - Coverage is unverifiable. The handler with no check looks exactly like a handler that
    intentionally has none.
  - Changing what a role may do means finding every handler.
  - The check runs after the command has been routed, so "refused" and "partially executed" can
    blur.
  - Consistency of refusal shape and refusal channel is left to each author.

### Option 3: A full policy engine, for example an external authorisation service or a policy
language

- Pros
  - Expressive, supporting per-resource and attribute-based rules.
  - Policies can change without a deployment.
  - Auditable policy evaluation.
- Cons
  - Substantial infrastructure for three roles and seventeen capabilities.
  - Adds a dependency, and possibly a network call, to the path every command takes.
  - Policy in a separate language or service is harder to keep in step with the commands it
    governs than a table the exhaustiveness test can read.

## Consequences

### Positive

- A command cannot arrive ungated, and the test that guarantees it reads the source rather than a
  list somebody maintains.
- Deciding a new capability is a decision made while looking at every other capability, which is
  the point of the table.
- Reassigning a capability between roles is a one-line change and touches no handler.
- Refusals arrive where the asking panel is listening, so a refused command produces a visible
  error rather than a hang.
- Role changes are enforced on live sockets, proven by a test that demotes an admin mid-session
  and immediately re-sends the command it just succeeded at.
- `billing:manage` is named already, so the matrix does not have to be reopened when billing
  arrives.

### Negative

- Reading a handler no longer tells you who may call it; the matrix has to be consulted.
- Two registrations per command is a small ceremony, enforced by a failing test rather than by
  memory.
- The model is per-command, not per-resource. "May edit *this* agent" cannot be expressed;
  everything in a workspace is visible to every member of it.
- Capability names, once chosen, are effectively permanent because they appear in the matrix and
  in the command map.

### Trade-offs

- Indirection was traded for verifiable coverage, deliberately, because the failure mode of the
  alternative is a silent hole in the handler nobody thought about.
- Three coarse roles were chosen over fine-grained per-resource permissions, matching the
  product's current collaboration model: a workspace is a shared space, and membership is the
  boundary.
- A member can answer an MCP confirmation on their own run, which is a deliberate exception to
  "third-party integrations are admin". Whoever is watching a run must be able to answer its
  gate, or the gate becomes a way to block work rather than to authorise it.

## Implementation Notes

- `server/src/auth/capabilities.ts` holds `CAPABILITIES`, the nested role definitions, `can()` and
  `capabilityFor()`. Its header comment states the design and the reasoning.
- `COMMAND_CAPABILITY` maps each WebSocket command to the capability it needs.
  `COMMAND_CHANNEL` in `server/src/wsRelay.ts` maps each command to the channel its refusal goes
  to.
- The current capability list: `agent:read`, `agent:write`, `run:execute`, `mcp:confirm`,
  `eval:read`, `eval:write`, `eval:run`, `mcp:read`, `provider:read`, `deploy:read`,
  `member:read`, `mcp:manage`, `provider:manage`, `deploy:manage`, `member:manage`,
  `workspace:manage`, `billing:manage`.
- `npm run test:capabilities` reads `wsRelay.ts` and fails when a command has no capability. It
  reads the source deliberately, so the list cannot pass by being stale.
- The relay answers reads locally to the requesting client and forwards mutations to the
  application, which answers by broadcasting the affected snapshot. See ADR-023.
- Membership operations are owner-only and each writes an `audit_log` row **inside the transaction
  that makes the change**, so there is no path that alters membership without a record of who did
  it. Demoting or removing the last owner is refused.
- `systemContextFor` mints the `system` role in code. Nothing from a client can produce it.
- `CONTRIBUTING.md` documents the two required entries under "A new command needs a capability and
  a channel".

## Security Considerations

- **Unclassified is refused, not allowed.** This is the property that makes the matrix a security
  control rather than documentation.
- **The check happens at the door**, before the command reaches the application, so a refusal
  cannot have already had a side effect. The concrete case: a refusal that forwards first has
  already written the provider key it was refusing to let somebody write.
- **The live context is read on every command**, so a demoted member is refused immediately rather
  than at their next reconnect. The demotion test is deliberately constructed to fail for the
  right reason: the socket handshakes as an admin from a real membership row, so a server reading
  the handshake context would pass the command and the test would catch it.
- **`system` can never arrive from a client.** The context resolver only produces membership
  roles.
- **Every membership change is audited inside its own transaction**, and the last-owner guard
  prevents a workspace from becoming unadministrable.
- **A refusal message must not depend on whether something exists.** The same reasoning that
  governs workspace refusals applies here. See ADR-018.
- The matrix does not bound what an *agent* can do. An agent's reach is bounded by its grants: its
  connectors and its MCP manifest. See ADR-014 and ADR-015.

## Performance Considerations

- A capability check is a set membership test against a small constant table, performed once per
  command before routing.
- The role comes from the socket's live context, which reads a membership decision cached for 30
  seconds, so the common case is not a database round trip.
- Checking at the door means refused commands cost nothing beyond the check itself.
- The exhaustiveness test runs at development time by reading source, so it adds nothing to
  runtime.

## Operational Considerations

- Adding a command requires an entry in `COMMAND_CAPABILITY` and one in `COMMAND_CHANNEL`, in the
  same commit. `npm run test:capabilities` fails the build otherwise.
- Changing what a role may do is a change to `capabilities.ts` alone.
- An owner cannot demote or remove the last owner, so a workspace always has an administrator.
- Removing a member kills their outstanding tickets and their open sockets close on the next
  re-check. A role change leaves the socket open and re-authorises it in place.
- Denied cross-tenant attempts and membership changes both land in `audit_log`, which is worth
  monitoring in a hosted deployment.

## Rejected Alternatives

**Role checks inside each command handler** were rejected because coverage is unverifiable. A
handler with no check is indistinguishable from a handler that deliberately has none, so the
absence of a line is invisible in review and untestable in aggregate. Changing what a role may do
would also mean finding every handler, and the one that gets missed is exactly the one nobody
thought about, which is the definition of this failure mode.

**A full policy engine** was rejected as disproportionate. Three roles and seventeen capabilities
do not need an external service or a policy language, and adding either would put a dependency,
and possibly a network call, on the path every command takes. It would also make the
exhaustiveness guarantee harder rather than easier, because a policy in a separate artifact is
harder to check against the command list than a table the test can read directly.

## Related Decisions

- ADR-018: The workspace as the tenancy unit, with an explicit context argument
- ADR-020: Provider agnostic OIDC verification with a real local issuer
- ADR-021: Single use WebSocket tickets and a mandatory Origin allowlist
- ADR-023: One WebSocket carrying many logical channels
- ADR-026: Credential handling: names travel, values do not

## References

- `server/src/auth/capabilities.ts`, `server/src/wsRelay.ts` (`COMMAND_CHANNEL`)
- `server/src/auth/capabilities.test.ts` (`npm run test:capabilities`)
- `server/src/auth/members.test.ts` (`npm run test:members`)
- `server/src/tenancy.test.ts`, the mid-session demotion test
- `CONTRIBUTING.md`, "A new command needs a capability and a channel"
- README sections "Roles, as data" and "Membership"
- CHANGELOG v0.2.6 "Authentication and Workspace Access"
