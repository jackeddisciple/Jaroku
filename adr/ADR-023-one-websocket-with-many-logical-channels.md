# ADR-023: Carry Everything on One WebSocket With Many Logical Channels

## Status

Accepted. Established in v0.0.1 (16 July 2026). Channel scoping audit added in v0.2.6.

## Context

The client is a live application. A trace streams step by step, generated files stream file by
file, a plan streams as it is written, an evaluation reports progress across twenty parallel
runs, a deployment reports stage transitions and build log lines, and an MCP confirmation
interrupts everything to ask a question.

That is a lot of concurrent server-initiated traffic, and it is the majority of what the product
does. Request and response is the wrong primary shape for it.

Two structural questions followed.

**One connection or several?** Several connections give natural isolation between concerns, at
the cost of several authentications, several lifecycles and several reconnect loops.

**How does the frozen event schema stay frozen?** The trace is schema v1 and must not change. If
every new feature adds fields to trace events, the freeze fails by accretion.

A third question arrived with tenancy and turned out to be the important one. Row-level security
guards what a *query* returns. Nothing there guards what the server **pushes**, and a relay's
whole job is pushing. The stale-broadcast bug was found twice by hand, and finding them one at a
time as somebody happens to notice is not the same as knowing there are none left.

## Decision

**One WebSocket, many logical channels.** Each message carries a `channel`, and the separation is
deliberate: only `trace` carries the frozen event schema, and everything added since rides beside
it.

Server to client channels: `history`, `agents`, `trace`, `runSteps`, `agentFiles`, `graph`,
`gen`, `edit`, `debug`, `eval`, `mcp`, `deploy`, `session`, `members`, `providers`, `reply`,
`log`.

`session` is the only channel about the **connection** rather than the work: `expiring`,
`expired`, `revoked`, `workspace_changed`, `role_changed`.

Client to server is a flat command vocabulary: `run`, `loadRun`, `listAgents`, `loadAgentFiles`,
`loadAgentGraph`, `planAgent`, `discardPlan`, `generate`, `edit`, `applyEdit`, `undoEdit`,
`discardEdit`, `pauseRun`, `resumeRun`, `branchRun`, `explain`, plus the evaluation, MCP,
provider, deploy and membership sets.

Four rules define the behaviour.

**Reads are answered locally by the relay, to the requesting client only. Mutations are forwarded
to the application, which answers by broadcasting the affected snapshot**, in the same shape a
fresh read would return, so a client never has to reconcile a partial update against local state.

**There are exactly two correct ways to send, and a third that is the bug.**

| | |
|---|---|
| `broadcastTo(ctx, ...)` | filtered by `workspaceId`, correct |
| `perClient(...)` | payload rebuilt per recipient, correct |
| one payload, every socket | **this is the bug** |

**Channels are enumerated, not remembered.** `npm run test:channels` reads `wsRelay.ts` for every
`channel:` it can emit and `COMMAND_CHANNEL` for every channel an answer can land on, and fails
when one is not classified as either tenant data or connection state. A channel added in a later
session appears in that list automatically, so it cannot arrive unclassified. The suite asserts
structurally that every sender uses one of the two correct forms, then puts two live sockets in
two workspaces behind it and fires every channel to prove it.

**The scope belongs to the operation, not to the process.** A single shared `buildContext`
covered planning, generation, editing and explaining, four subsystems with four independent locks,
so two can be in flight at once and one variable cannot hold both answers. Worse, it was assigned
*before* the busy guard, so a request that was **refused** still repointed it: one workspace's
rejected `generate` redirected another workspace's still-streaming source code into the wrong
build pane. Each subsystem now has its own scope, claimed only once its operation has actually
started, and a refusal is answered to whoever asked rather than through the scope.
`test:channels` asserts both properties by reading `index.ts`, because the ordering is the whole
of the fix and nothing about it is visible at a type level.

Beside the socket there is a small HTTP surface, because a browser cannot put a header on a
WebSocket: `/healthz`, `/readyz`, `/v1/auth/session`, `/v1/ws-ticket`, `/v1/invites/accept`, and
in local mode `/v1/auth/jwks.json` and `/v1/auth/dev-login`.

Evaluation runs deliberately stay off the live `trace` channel. Their events persist normally,
but twenty parallel runs broadcasting `run_start` would yank the timeline away from whatever the
user was reading. Drill-down loads them on demand through the ordinary `loadRun` path.

## Alternatives Considered

### Option 1: One WebSocket with logical channels

- Pros
  - One connection to authenticate, one to keep alive, one to reconnect.
  - Server-initiated streaming is native, which is what most of the traffic is.
  - Channel separation keeps the frozen trace schema isolated from everything added later.
  - A single place to enforce capability checks and workspace scoping on every message.
  - Enumerable: the set of channels can be read from the source and audited.
- Cons
  - One connection is one failure point; a drop affects everything at once.
  - Multiplexing means head-of-line concerns if a single large payload is sent.
  - The relay becomes a large module holding every command and channel type.
  - Every channel must be individually classified for tenant scoping, and forgetting one is a
    leak.

### Option 2: Several WebSockets, one per concern

- Pros
  - Natural isolation: a problem on one channel does not affect the others.
  - Smaller, more focused handlers.
  - No multiplexing concerns.
- Cons
  - Several authentications, which with the ticket exchange means several three-request flows.
  - Several reconnect loops and several backoff states to reason about.
  - Cross-channel ordering guarantees disappear, and some do matter: a `gen` completion and an
    `agents` refresh describe one event.
  - More sockets per client, multiplied by every open tab.

### Option 3: HTTP with server-sent events or polling

- Pros
  - Simple, cacheable, well understood, and works through restrictive proxies.
  - Server-sent events give server-initiated streaming without a socket.
- Cons
  - Server-sent events are one directional, so commands need a second mechanism and the
    request-response pairing across two transports has to be managed.
  - Polling adds latency to a product whose selling point is that steps appear the instant they
    complete.
  - Browsers limit concurrent connections per origin, which several event streams would consume.

## Consequences

### Positive

- The frozen event schema stayed frozen. Pause and resume, evaluations, MCP and deployments each
  added a channel rather than a field.
- One authentication path, one reconnect policy, one capability check point.
- Refusals arrive on the channel the asking panel listens to, so a refused command is visible
  rather than a hang. See ADR-022.
- Broadcasting the affected snapshot after a mutation means a client never reconciles a partial
  update, which removed a class of client state bug.
- The channel audit converted "we fixed the leaks we noticed" into "an unclassified channel fails
  the build", which is a categorically different guarantee.

### Negative

- `wsRelay.ts` is the largest module in the server, because it holds every command and channel
  type.
- A single connection is a single failure point, mitigated by an exponential jittered backoff
  that is reset by a connection that *opened*, not one that was attempted.
- Every new channel is a new thing to classify, and the classification is only mechanical because
  a test enforces it.
- Ordering across channels is not guaranteed by the transport, so anything that needs it has to
  say so.

### Trade-offs

- A large relay module was accepted in exchange for one place where authorisation and scoping are
  enforced.
- Evaluation runs were kept off the live trace channel, trading immediate visibility for not
  hijacking the user's timeline, with drill-down as the deliberate alternative.
- Reads answered locally by the relay and mutations forwarded to the application is an asymmetry
  that has to be understood, and it exists so that a read cannot have a side effect and a mutation
  cannot answer only its own caller.

## Implementation Notes

- `server/src/wsRelay.ts` defines every command and channel type, authorises the upgrade,
  capability checks every command, answers reads locally and forwards mutations.
- `broadcastTo(ctx, ...)` filters by `workspaceId`. `perClient(...)` rebuilds the payload per
  recipient. Sending one payload to every socket is the bug the audit exists to prevent.
- `npm run test:channels` enumerates channels by reading the source, classifies each as tenant
  data or connection state, asserts every sender uses a correct form, and then exercises two live
  sockets in two workspaces across every channel.
- `npm run test:relay` covers the relay's own behaviour, including that a socket cannot outlive
  the membership that authorised it.
- `npm run test:acceptance` runs two real accounts in two real workspaces simultaneously and
  asserts that the unbidden traffic is scoped too: the live trace and history pushes one person's
  run causes while the other has a socket open.
- The client reconnects with exponential jittered backoff, capped, reset by a connection that
  opened. A 401 or 403 stops the loop and shows sign-in. See ADR-024.
- `setProviderKey` and `testProviderKey` are two commands rather than one on purpose: the test
  proves a key authenticates and writes nothing, so "Test connection" cannot put a credential on
  disk before Save is pressed. Both tests are models-list calls, so checking a key is free.
- Accepting an invitation is deliberately not a command, because the accepter is not a member yet
  and there is no socket scoped to the workspace they are joining.
- `/healthz` and `/readyz` answer two different questions: liveness touches nothing, because a
  probe that checks a dependency turns one database blip into every instance restarting at once;
  readiness probes the database under a deadline.

## Security Considerations

- **Row-level security guards queries, not pushes.** This is the gap the channel audit exists to
  close, and it is the reason the audit enumerates rather than remembers.
- **Every command is capability checked at the door**, before it reaches the application, and a
  command with no capability is refused rather than allowed. See ADR-022.
- **A socket's workspace is fixed at open time** by the ticket it was redeemed with, and no
  message can change it. Switching workspace is a new socket.
- **The scope belongs to the operation.** The build-scope leak was not an adversarial failure: the
  attacker's move there is to do something entirely legitimate in their own workspace at the
  wrong moment, which is why an acceptance suite that runs two ordinary sessions concurrently
  catches things an attack suite does not.
- **Nothing that grants access reaches a log.** The ws-ticket rides in a query string because a
  browser has nowhere else to put it, and the request logger redacts it by name along with
  `token`, `key`, `code` and `access_token`.
- **The origin is checked before the handshake**, because WebSockets are not covered by CORS. See
  ADR-021.

## Performance Considerations

- One connection per client rather than one per concern, which matters when a user has several
  tabs open.
- Trace events are pushed as they are parsed, so perceived latency is the agent's own speed.
- Evaluation runs are deliberately not broadcast live, which is both a usability decision and a
  bandwidth one: twenty parallel runs would broadcast twenty concurrent step streams.
- Build log lines from a deployment are scrubbed before broadcast, and the deploy log re-renders
  on its own rather than redrawing the entire panel.
- `perClient` rebuilds a payload per recipient, which costs more than one shared payload and is
  the correct cost for anything whose content differs by workspace.

## Operational Considerations

- The relay serves the dependency-free fallback client at `http://localhost:4317`, which is the
  fastest way to confirm the pipeline is alive without running Vite.
- `/healthz` for liveness and `/readyz` for readiness. Do not point a liveness probe at
  `/readyz`.
- Adding a channel means classifying it in `test:channels` as tenant data or connection state.
  The build fails otherwise.
- Adding a command means an entry in `COMMAND_CAPABILITY` and one in `COMMAND_CHANNEL`.
- A client that reconnects in a loop while showing a spinner is the symptom of the 401 versus
  retryable distinction being wrong, which is the one decision the client's socket layer exists
  to get right.

## Rejected Alternatives

**Several WebSockets, one per concern** was rejected because the credential exchange is three
HTTP requests per socket, so several sockets means several exchanges per client and several
independent reconnect and backoff states. It would also lose cross-channel ordering where it
matters, since a generation completing and the agent list refreshing describe one event, and it
would multiply connections by every open tab.

**HTTP with server-sent events or polling** was rejected because the traffic is bidirectional and
latency sensitive. Server-sent events are one directional, so commands would need a second
transport and request-response pairing would span both. Polling adds latency to a product whose
distinguishing property is that a step appears in the browser the instant it completes.

## Related Decisions

- ADR-001: Freeze a versioned trace event schema as the product's primitive
- ADR-011: Evaluations as batches of ordinary runs, which stay off the live trace channel
- ADR-018: The workspace as the tenancy unit, with an explicit context argument
- ADR-019: Row level security as the backstop, which does not cover pushes
- ADR-021: Single use WebSocket tickets and a mandatory Origin allowlist
- ADR-022: Roles as data, one capability matrix checked at the door
- ADR-024: Client state as per concern stores that reset on a workspace switch
- ADR-028: Tests as plain scripts, with structural audits

## References

- `server/src/wsRelay.ts`, `server/src/index.ts`, `server/src/http/router.ts`,
  `server/src/http/health.ts`
- `server/src/channels.test.ts` (`npm run test:channels`),
  `server/src/wsRelay.test.ts` (`npm run test:relay`),
  `server/src/acceptance.test.ts` (`npm run test:acceptance`)
- `client/src/lib/socket.ts`
- README sections "WebSocket protocol" and "Every channel, not just the ones somebody noticed"
- CHANGELOG v0.0.1, v0.2.5, v0.2.6
- RFC 6455, The WebSocket Protocol
