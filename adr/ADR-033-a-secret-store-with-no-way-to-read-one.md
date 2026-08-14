# ADR-033: Give the Secret Store No Method That Returns a Plaintext Value

## Status

Accepted, and **partly superseded by [ADR-035](ADR-035-a-reveal-path-gated-by-elevation.md)**.
Introduced in Session 3, migrations `015_secret_vault` and `016_secret_refs`.

The absolute form of the rule below — that NO method returns a plaintext value to a request
handler — held for six sessions and no longer does. Session 9 added `revealForUser`, behind an
unforgeable elevation receipt, because the product decided a user must be able to read their own
credential back. Everything else in this ADR is unchanged and still binding: there is still no
`get`, the run and platform paths are still the only unattended exits, `secret_refs` still has no
column a value would fit in, and the ciphertext is still bound to `<workspace_id>:<name>`.

Read ADR-035 before citing this one, and do not quote the Decision section below as current
without the qualifier. A half-remembered version of a rule is how the next widening gets argued
for.

## Context

`envWriter.ts` has followed one rule since the day it was written: callers learn that a key IS
SET; they do not learn what is in it. The rule is real and the module is careful — the value is
not logged, not returned, not held in any structure that outlives the call — but it is a
discipline held up by comments and by everybody remembering.

Locally that was proportionate. `runtime/.env` is one file on one machine owned by the person
sitting at it, and the worst case of a leak is showing somebody their own key. Hosted it is ~6,000
people's provider keys, Slack tokens and database URLs, and the file has nowhere to put a
workspace: every tenant on the box would read every other tenant's credentials out of one process
environment, and nothing would error and nothing would look wrong.

## Decision

**The interface has no `get(ctx, name)`.** Values move in one direction: in through `set`, out
only into a run's environment through `getForRun`. Everything else — is it configured, what is it
called, when was it last used — is answered by `listNames`, which returns names.

**`getForRun` takes a run id, not a context.** Its caller assembles a run's environment, and a run
outlives the request that started it; by then the asking context is gone. The run is therefore the
unit of authorisation, and its workspace is resolved from the run rather than asserted.

**Two implementations.** `DotEnvSecretStore` wraps `envWriter.ts` unchanged, holding a reference
to the one writer rather than opening its own. `KmsSecretStore` seals values with a per-workspace
data key, wrapped by a master key that is configuration and never in the database.

**Each ciphertext is bound to `<workspace_id>:<name>`** as AES-GCM authenticated data.

**A store-agnostic `secret_refs` table** holds the names, with no column a value would fit in.

**The refusals are shared.** A value containing a line break is refused by both.

## Alternatives considered

**A `get` that only privileged callers may use.** Rejected: privilege is a runtime check, and the
absence of a method is a compile-time one. The point of the design is that no code path exists,
not that the existing paths are careful.

**Keep the values in `workspace_secrets` and answer `listNames` from there.** Rejected once
`secret_refs` existed: two copies of "what is configured" is how they disagree — the local store
has no vault row at all, so it could not answer, and the client's panel would then behave
differently depending on how the server was deployed.

**Let the hosted store accept values the `.env` format cannot hold.** AES-GCM will seal anything.
Rejected: it produces a credential that works hosted and fails locally, which is exactly the class
of difference having two implementations is meant to prevent — and an exported project, which the
README promises is portable, writes a `.env`.

**A real cloud KMS now, instead of a master key from configuration.** Strictly better: a KMS never
hands the key out at all. Rejected for this session because it makes the secret tests need
credentials or a stub, which costs the free-development path. The `MasterKeyProvider` interface
and the `master_key_id` recorded on every wrapped data key are what make the swap a rewrap of N
data keys rather than a re-encryption of the platform.

**Generate a master key when none is set**, as the object store's signing key does. Rejected
firmly: a regenerated signing key invalidates outstanding URLs, which is annoying; a regenerated
master key makes every stored credential permanently unreadable.

## Consequences

Nothing above the interface can read a credential, including future code written by somebody who
has not read this. That is the point, and it will occasionally be inconvenient — a feature that
genuinely needs a value has to route through a run, or change this decision on purpose.

The binding means a mistake in the application layer, or a hand-run `UPDATE`, cannot hand one
tenant another's key under a name they chose. It also means a restore that reshuffles rows between
workspaces silently produces unreadable secrets rather than wrong ones.

The local store shares one file between workspaces, and its test says so out loud rather than
leaving it to be discovered. `JAROKU_SECRET_STORE=dotenv` refuses `NODE_ENV=production`.

Rotation is per workspace and resumable, because a read uses the key the row names.
