# ADR-024: Separate Client Stores by Invariant, and Reset Every One on a Workspace Switch

## Status

Accepted. Store separation established in v0.0.2 (19 July 2026); the workspace reset discipline
and the storage key audit introduced in v0.2.6.

## Context

The client holds a lot of live state: a streaming trace, a run history, an agent list, a
conversation with plan and diff cards, a graph, an evaluation dashboard, an MCP registry, a
deployment panel, provider status and membership. All of it arrives over one socket.

Two problems had to be solved.

**Not all client state has the same correctness requirements.** The trace has rules that keep it
honest: steps must be deduplicated by id, because reconnecting mid-run re-delivers them, and they
must render in `seq` order rather than arrival order, because a corrupted or reordered trace is a
lying product. The build pane, the chat log and the UI layout have none of those needs, and
putting them in the same store would add churn to the one store whose correctness actually
matters.

**A perfectly scoped server still leaks if the browser keeps the rows.** This is the problem that
turned out to be underestimated. A `traceStore` still holding the previous workspace's step
payloads after a switch is a cross-tenant leak in the UI, and it is not a rendering bug: those
payloads contain email content, database output and Slack messages.

There is a third problem the reset discipline initially missed. **A store is memory;
`localStorage` is not.** The last test input per agent was remembered under `jaroku.input.<agent>`,
keyed by slug alone, and slugs stopped being globally unique when they became unique per
workspace. Two workspaces with a same-named agent on one browser meant one tenant's last input
loading into the other's composer, and the `R` shortcut re-running it. A test input is whatever
the user typed to drive the agent: a real customer email, a real order id. It survived not just a
switch but a sign-out, which no store reset could reach.

## Decision

**Stores are separated by invariant, not by convenience.** `traceStore` has rules that keep the
trace honest and is kept small and disciplined. `buildStore`, `chatStore`, `evalStore`,
`graphStore`, `uiStore`, `mcpStore`, `deployStore`, `memberStore`, `providerStore` and
`sessionStore` have none of those needs. They share a socket and nothing else.

**Every store fully resets on a workspace switch, before the new socket opens**, so there is no
window in which the new workspace's first snapshot merges into the previous one's rows.

**The reset has no per-store code.** Zustand's `getInitialState()` returns the exact object the
store was created with, data fields and action functions together, so `setState(initial, true)`
restores it completely. A hand-written `reset()` per store would be eleven places to forget a
field, and forgetting one is invisible: the store looks empty in whichever devtools panel
somebody happens to open, and the field nobody looked at still holds the last tenant's data.

**Switching workspace is a new socket, not a message.** The workspace a socket acts in was decided
by the ticket it was opened with, and there is no message that could change it. A message would
also have to reason about the reads already in flight on the existing connection.

**The audit enumerates rather than remembers, twice.** `npm run test:reset` reads the store
*directory* and fails when a store exists that is neither reset nor explicitly excluded, because
the leak that actually happens is not in a store somebody tested, it is in the one added six
months later that nobody wired in. It also audits **every `jaroku.*` key the client writes**,
found by reading the source rather than from a list, and fails when one is classified as neither
workspace scoped nor non-tenant.

Browser storage keys are therefore scoped by construction:

| Key | Contents |
|---|---|
| `jaroku.token` | The bearer token |
| `jaroku.workspace` | The last workspace |
| `jaroku.onboarding.<user id>` | Where a person is up to in the first-run flow |
| `jaroku.input.<workspace id>.<agent>` | The last test input |

The workspace is read inside `inputKey` rather than passed in, so every call site is scoped
whether its author remembered or not. Sign-out sweeps the prefix as well, for the browser two
people share.

**Onboarding is a fact about the account, not the browser.** `users.onboarded_at`, reported as
`user.onboarded` on `/v1/auth/session`, decides whether the first-run flow appears. What stays in
the browser is *where* somebody is up to, keyed by user id.

**The socket layer makes one distinction everything else depends on**, because "disconnected" and
"unauthorised" arrive at a browser looking identical: a request fails, a socket closes.

- **Retryable**: offline, a 5xx, a 429, a dropped socket. Back off exponentially with jitter,
  capped, and try again. The backoff is reset by a connection that *opened*, not one that was
  attempted.
- **Not retryable**: a 401 or a 403. Stop, and show the sign-in screen.

Getting that backwards produces the worst behaviour this client is capable of: retrying a 401
every second, forever, behind a spinner, while the user has no idea they need to sign in.

## Alternatives Considered

### Option 1: Per-concern stores, reset wholesale on switch, with a directory-reading audit

- Pros
  - The store whose correctness matters stays small and disciplined.
  - Reset is one mechanism for every store, so there is no per-store field list to forget.
  - The audit catches the store added later, which is the one that actually leaks.
  - Resetting before the new socket opens removes the merge window entirely.
  - Extending the audit to browser storage caught a leak that no amount of store discipline
    would have.
- Cons
  - Several stores means several imports and some cross-store coordination.
  - Wholesale reset discards state that was arguably safe to keep, so a switch feels heavier.
  - The audit's exclusion list is a small maintained artifact, and the test asserts its exact
    contents.
  - Reconnecting on every switch is more work than a message would be.

### Option 2: One global store

- Pros
  - One place for all state, one reset, and no cross-store coordination.
  - Simpler mental model for a newcomer.
- Cons
  - The trace's invariants (dedupe by id, render in `seq` order) would live in a store that
    changes for unrelated reasons, so every UI change is a change to the module holding the
    correctness rules.
  - Every unrelated update re-renders more than it needs to, unless selectors are written
    carefully everywhere.
  - A single large object makes it harder to reason about what a workspace switch must clear.

### Option 3: Per-store hand-written reset methods

- Pros
  - Explicit, greppable, and obvious at each store.
  - Allows selective retention where it is genuinely safe.
- Cons
  - Eleven places to forget a field, and forgetting one is invisible.
  - The failure mode is exactly the cross-tenant leak the reset exists to prevent.
  - Selective retention is a judgement made per store, repeatedly, with a data leak as the
    penalty for getting it wrong once.

## Consequences

### Positive

- The trace store's correctness rules (dedupe by step id, render in `seq` order) live in one small
  module and are covered by their own tests.
- A workspace switch cannot leave a row behind, and the guarantee is checked by reading the store
  directory rather than a list.
- The browser storage audit found and fixed a real cross-tenant leak that survived sign-out,
  which no store reset could have reached.
- Onboarding follows the person: it appears on a second device for a new account and does not
  appear for an existing user in a private window.
- The retry versus stop decision is isolated in one testable module, so the worst client failure
  mode is covered by `npm run test:auth`.

### Negative

- Several stores to know about, and some coordination between them.
- A workspace switch is heavier than it might be: full reset plus a new socket plus refetching
  everything.
- The exclusion lists in the audit are maintained artifacts, and the test asserts their exact
  contents, so adding a legitimate exclusion is a deliberate act that must be justified.
- Client-side state is entirely derived from server snapshots, so a slow reconnect shows empty
  panels rather than stale ones. That is the correct trade and it is visible.

### Trade-offs

- Wholesale reset was chosen over selective retention, accepting a heavier switch in exchange for
  a guarantee that does not depend on per-store judgement.
- A new socket per switch was chosen over a message, accepting reconnection cost in exchange for
  never having to reason about reads in flight on a connection whose scope just changed.
- `getInitialState()` plus `setState(initial, true)` couples the reset to a Zustand behaviour,
  accepted because the alternative is eleven hand-maintained field lists.
- The bearer token lives in `localStorage`, which is stated as a trade-off rather than hidden: it
  survives a reload, and it is readable by any script on the page. The mitigation that matters is
  a Content-Security-Policy, not the storage choice, because an attacker with script execution can
  use the token from memory or mint a fresh one through the same API.

## Implementation Notes

- `client/src/store/reset.ts` performs the reset and its header states the reasoning.
  `WORKSPACE_STORES` lists what is reset; `NOT_WORKSPACE_SCOPED` lists the deliberate exclusions,
  and the test asserts its exact contents.
- `client/src/store/reset.test.ts` (`npm run test:reset`) reads the store directory and the client
  source, so both audits are enumerations rather than lists.
- `client/src/lib/socket.ts` owns the retry versus stop decision and the backoff. The backoff is
  reset by a connection that opened.
- `client/src/lib/auth.ts` owns the three-request exchange and states the `localStorage` trade-off
  in its header. It reads Vite build-time variables through a helper, because `import.meta.env`
  exists only under Vite and reading it directly throws at module load under `tsx`, which is what
  every test suite here runs on. A module that cannot be imported outside a bundler is a module
  that cannot be tested, and this one holds the retry versus sign-out decision.
- `inputKey` reads the workspace itself rather than taking it as a parameter, so every call site is
  scoped by construction.
- Sign-out sweeps the `jaroku.` prefix, for a browser two people share.
- `traceStore` keys steps by id so re-delivery is idempotent, and always renders sorted by `seq`.
- Adding a store means adding it to `WORKSPACE_STORES`. If it genuinely holds nothing a workspace
  owns, it goes in `NOT_WORKSPACE_SCOPED` and the addition has to be justified, because the list
  is two entries long and the test asserts it.

## Security Considerations

- **The client is a cross-tenant boundary in its own right.** A flawless server still shows one
  workspace's runs under another's name if the browser kept them, and those payloads contain
  regulated data.
- **The reset happens before the new socket opens**, so there is no window in which the new
  workspace's first snapshot merges into the previous one's rows.
- **`localStorage` survives sign-out**, which is why the storage key audit exists separately from
  the store audit. A store reset cannot reach a key that outlives the session.
- **Keys carry the workspace or the user id** so a shared browser never hands one person's data to
  the next.
- **The token in `localStorage` is a stated trade-off**, and XSS defeats the auth model regardless
  of where the token lives. A concrete XSS vector is in scope for a security report; the general
  observation is documented as a known limitation.
- **A 401 must stop and a 5xx must retry.** Inverting that either signs users out during a
  transient failure or hides a genuine sign-in requirement behind an infinite spinner.

## Performance Considerations

- Per-concern stores mean a trace update re-renders trace consumers rather than the whole
  application.
- `traceStore` keys by id, so deduplication is a map write rather than a scan, and rendering sorts
  by `seq`.
- A workspace switch refetches everything, which is a burst of traffic at a moment the user
  expects a change of context.
- Backoff is exponential with jitter and a cap, and it is reset by a connection that opened rather
  than one that was attempted, so a server that accepts and immediately drops does not reset the
  backoff.
- Streamed text is revealed in proportion to the backlog rather than character by character, so a
  fast stream does not produce a slow-looking reveal.

## Operational Considerations

- "Everything disappeared after I switched workspace" is the switch working.
- Deleting `jaroku.token` and `jaroku.workspace` signs the user out; the remaining keys lose
  nothing that matters.
- A client stuck reconnecting behind a spinner points at the retry versus stop decision, which
  `npm run test:auth` covers.
- Adding a store or a new `jaroku.*` key requires classifying it, and `npm run test:reset` fails
  until it is done.
- Existing users all received `NULL` for `onboarded_at` at migration time, so everybody
  provisioned before it was offered onboarding once. There was no truthful backfill, since the
  only record of who had onboarded was in browsers the migration cannot reach, and one extra
  welcome screen is a smaller harm than silently skipping it for somebody genuinely new.

## Rejected Alternatives

**One global store** was rejected because it would put the trace's correctness rules in a module
that changes for unrelated reasons. Deduplication by step id and rendering in `seq` order are the
invariants that keep the product from lying, and they should not share a file with panel layout
state that changes every time the UI does.

**Per-store hand-written reset methods** were rejected because they are eleven places to forget a
field, and the forgotten field is invisible: the store looks empty in whichever panel somebody
inspects, while the field nobody looked at still holds the previous tenant's data. A single
mechanism that restores the store's exact initial object removes the category, and the directory
audit removes the "somebody added a store and forgot" case that would otherwise remain.

## Related Decisions

- ADR-001: Freeze a versioned trace event schema as the product's primitive
- ADR-018: The workspace as the tenancy unit, with an explicit context argument
- ADR-020: Provider agnostic OIDC verification with a real local issuer
- ADR-021: Single use WebSocket tickets and a mandatory Origin allowlist
- ADR-023: One WebSocket carrying many logical channels
- ADR-025: One composer with deterministic intent routing
- ADR-028: Tests as plain scripts, with structural audits

## References

- `client/src/store/reset.ts` and `reset.test.ts` (`npm run test:reset`)
- `client/src/store/traceStore.ts`, and the remaining stores in `client/src/store/`
- `client/src/lib/socket.ts`, `client/src/lib/auth.ts` and `auth.test.ts` (`npm run test:auth`)
- `CONTRIBUTING.md`, "A new client store must reset on a workspace switch"
- README sections "The client", "Where data lives", "Onboarding belongs to the person, not the
  browser"
- CHANGELOG v0.0.2 "Trace Layer UI" and v0.2.6 "Authentication and Workspace Access"
