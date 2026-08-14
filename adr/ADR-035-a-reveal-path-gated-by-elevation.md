# ADR-035: Add One Way to Read a Stored Credential, Behind an Unforgeable Elevation Receipt

## Status

Accepted. Introduced in Session 9, alongside the Secrets tab. Partly supersedes
[ADR-033](ADR-033-a-secret-store-with-no-way-to-read-one.md).

## Context

ADR-033 gave the secret store no method that returns a plaintext value to a request handler, and
argued the point well: *"privilege is a runtime check, and the absence of a method is a
compile-time one."* Two exits existed — `getForRun`, into a run's environment, and
`getForPlatformCall`, into a model call the platform makes on a workspace's behalf — and neither
returns a value to the caller that asked.

The Secrets tab was specified on top of that guarantee. Its build brief is explicit: *"There is no
reveal button, and no endpoint may return a stored plaintext secret… If a user needs the value
again, the answer is rotate."* That is a coherent product position, and the one this codebase had.

**The product decision changed.** A stored credential must be readable by the person who owns it.
The reasoning is the ordinary one every secret manager eventually meets: people put credentials in
Jaroku that they also need elsewhere — a `DATABASE_URL` they must paste into a migration tool, an
API key a colleague needs for a script — and a store that can only ever swallow them makes users
keep a second copy somewhere worse. "Rotate to see it" is a real answer for a key nothing depends
on, and a bad one for a credential six deployed agents are using, where rotation is an outage
scheduled to find out a value.

That is a decision about what the product is, not about what is safe to implement, and it was made
deliberately. What this ADR records is what it cost and what was done to keep the cost bounded.

**What it costs, stated plainly.** Two of the brief's own acceptance criteria are dropped:

- *"No secrets route returns a plaintext value, asserted by an automated test across every route."*
- *"A stored secret's value cannot be revealed anywhere in the UI; the only path to the value is
  rotation."*

And a property this codebase could previously assert by construction — that no request could
possibly result in a credential reaching a browser — becomes a property that holds because a check
passes rather than because no code path exists.

## Decision

**One method, `revealForUser(receipt, name)`, on the `SecretStore` interface.** Six things
constrain it, and each is load bearing:

1. **It takes an `ElevationReceipt`, not a context.** The receipt's type is branded with a symbol
   that `secrets/elevation.ts` does not export, so it cannot be constructed, cannot be built from
   a request body, and cannot be obtained except from `SecretElevations.receiptFor()` returning a
   live, unrevoked, unexpired elevation. This is the deliberate replacement for the compile-time
   guarantee being given up: the method exists, but no caller can reach it by writing plausible
   code. Forging one requires `as unknown`, which is a thing a reviewer sees.

2. **The workspace is read off the receipt.** Exactly as `getForRun` takes a run id and resolves
   the workspace from it, the caller does not get to assert which tenant it is acting for. A
   receipt issued in one workspace cannot open another's credential even when the name matches, and
   `secrets/conformance.ts` asserts that against the hosted store.

3. **One name, never a list.** `getForRun` takes an array because a run needs an environment.
   Nothing legitimate reads every credential a workspace has at once, and a signature that cannot
   express it is one nobody writes by accident.

4. **The route is `mutate`-level and admin-gated.** It needs `secret:manage`, a live elevation, and
   it has its own rate limit — tighter than the unlock limit and separate from it, so a script
   holding one ten-minute elevation cannot walk the whole vault with it.

5. **Every reveal writes `secrets.revealed` to `audit_log`** with actor, IP and user-agent, before
   the response is sent, and is never sampled out. If a credential turns up somewhere it should
   not have, "who read it and when" is the first question and it has an answer.

6. **The revealed value is registered with the log redactor.** `protectSecret` is called on the way
   out, so from that moment the process scrubs it from any line anything writes. A credential
   handed to a browser is one that comes back in stack traces and support pastes.

**The dependency is optional.** `SecretsRouteDeps.reveal` may be absent, and the route 404s when it
is. A deployment that wants ADR-033's original posture keeps it by not wiring one function, and
that build has no reachable path from a request to a plaintext value.

**One asymmetry is accepted and named.** `DotEnvSecretStore` answers from `process.env`, which has
no workspace in it, so it cannot check a receipt's workspace against anything — property 2 holds on
the hosted store only. The conformance suite asserts the exemption explicitly rather than skipping
it silently. It is bounded by what already bounds that store: one machine, one developer, a leak
whose worst case is showing somebody their own key, and a refusal to run under
`NODE_ENV=production`.

## Alternatives Considered

**Keep ADR-033 and offer rotation instead.** The brief's own answer, and still the right default —
the UI says so where somebody looks for reveal. Rejected as the *only* answer for the reason above:
rotating a credential that deployed agents depend on is an outage scheduled to learn a value, so
"rotate to see it" pushes people to keep a second copy somewhere with no audit log at all.

**A privileged `get(ctx, name)` behind a capability check.** ADR-033 rejected this and its argument
still stands: a capability check is a runtime condition somebody can get wrong, and it makes the
method reachable from any handler holding a context — which is all of them. The receipt is what
makes this different: the authorisation is a value you must have been *given*, not a condition you
assert about yourself.

**Decrypt in the browser with a passcode-derived key.** Rejected for the reason the brief gives at
length: Jaroku injects credentials into deployed agents and scheduled runs with nobody present, so
a passcode-derived key silently breaks every unattended execution. See `secrets/passcode.ts`.

**A one-time reveal token, single-use like a WebSocket ticket.** Genuinely attractive, and close to
what the receipt is. Rejected as an extra moving part for no additional property: the elevation is
already short-lived, already revocable, already session-bound, and already rate-limited per user.
A second single-use credential on top would be a second thing to expire, sweep and explain.

## Consequences

- The sentence "no code path exists down which a credential reaches a JSON response" is no longer
  true, and every place that asserted it has been changed rather than deleted:
  `secrets/conformance.ts`, `secretStore.ts`'s header, ADR-033's status, and the invariant table in
  `CONTRIBUTING.md`.
- `test:secrets` and `test:vault` now assert the narrower rule — that the only value-returning
  method takes a receipt, and that a receipt for another workspace opens nothing.
- The serialiser audit in `test:secret-routes` still asserts that no OTHER route returns a value,
  which is most of what the dropped acceptance criterion was worth.
- A future widening — a bulk reveal, an export that includes values, a reveal without elevation —
  now has an ADR to argue against rather than a comment, and should be a new one that supersedes
  this.
