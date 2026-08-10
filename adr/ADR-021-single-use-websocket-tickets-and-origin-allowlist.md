# ADR-021: Open Sockets With a Single Use Ticket, Behind a Mandatory Origin Allowlist

## Status

Accepted. Introduced in v0.2.6 (7 August 2026), migrations `010_ws_tickets` and
`011_ticket_token_expiry`.

## Context

Almost everything in this product happens over one WebSocket. Authenticating that socket runs
into a fact that surprises people, and the surprise is the vulnerability:

**A browser cannot set an `Authorization` header on a WebSocket.**

The two things people reach for instead are both wrong.

**A long-lived JWT in the query string.** URLs are logged: by the load balancer, by the reverse
proxy, by the CDN, in `Referer` headers on any resource the page loads afterwards, and in
whatever aggregates all of that. A token with an hour of life in an access log with a year of
retention is a credential with a year of life, sitting somewhere with much weaker access control
than the database it unlocks.

**A cookie.** **WebSockets are not covered by CORS.** A browser will not let `evil.example` read
a cross-origin `fetch` response without the server's permission, but
`new WebSocket("wss://jaroku.example/ws")` from a page on `evil.example` connects, with the
victim's browser doing the connecting, and no CORS check applies because the handshake is not a
CORS request. A cookie is attached to that upgrade. That is cross-site WebSocket hijacking.

There is a second problem beyond opening the socket. A socket is checked once, at the upgrade,
and would then run for as long as a browser tab is open, still acting on a membership that may
have been revoked in its first ten minutes. Nothing about the socket itself would ever notice.

## Decision

**A socket is opened with a single-use ticket, and the `Origin` is checked before the handshake.**

The client performs a three-request exchange before the socket exists:

```
1. token from the issuer                  verified: iss, aud, exp, nbf, signature
2. POST /v1/auth/session                  sub -> users.external_id; provisions on first sight
3. POST /v1/ws-ticket { workspaceId }     membership lookup; 403 and an audit row if not a member
4. wss://.../ws?ticket=...                Origin checked, ticket consumed exactly once
```

**The ticket is a credential whose leak is worth nothing.**

| Property | Why |
|---|---|
| Single use | Redemption is a `DELETE` whose row count is the decision, so exactly one caller wins even when two race on different replicas. A leaked ticket has already been spent by the legitimate socket. |
| Thirty seconds | A page load, not a session. A log entry from yesterday is inert. |
| Hashed at rest | SHA-256. A dump of `ws_tickets` is not a set of credentials. |
| Scoped to one workspace | Redeeming it establishes the socket's scope, and nothing later can change it. |

SHA-256 rather than a slow key derivation function is deliberate: the input is 256 bits from
`randomBytes`, so there is no dictionary to make expensive, and a KDF on the socket-open path
would be a self-inflicted rate limit.

**The exchange itself is the second wall.** To get a ticket you need a verified bearer token and
a membership row, and a page on another origin cannot read the response of a cross-origin
`POST /v1/ws-ticket`, so it cannot obtain one.

**The origin check is not optional**, and three properties of it are load bearing:

- **It runs before the ticket.** Cheaper, and a rejected cross-origin attempt does not burn a
  ticket the legitimate client is about to use.
- **A refusal is an HTTP 403 on the raw socket**, before the handshake completes. The obvious
  alternative, accept then close, is indistinguishable from a network drop and makes the client's
  reconnect loop retry forever.
- **A missing `Origin` is allowed, and a literal `null` origin is refused.** Browsers always send
  one; `curl`, the `ws` library, the test suites and the fallback debug client do not. Refusing a
  missing origin breaks every non-browser client and stops no attack, because an attacker with a
  non-browser client sends whatever origin they like: the header only *means* anything when a
  browser set it, and a browser always does. What defends the non-browser case is the ticket,
  which is a credential rather than a claim. A literal `null` is a sandboxed iframe or a `file://`
  page, an opaque origin, which is exactly the one not to trust.

`JAROKU_ALLOWED_ORIGINS` is **required in production**. Unset there is a decision nobody made,
and guessing gives either "nothing can connect" or "anything can", so the server refuses to start.

**A socket's workspace is immutable.** It was decided by a `workspace_members` row before the
handshake, and there is no message that changes it. Switching workspace is a new socket,
deliberately.

**A socket must not outlive its membership.** Every open socket is re-checked on a timer and told
the outcome on a `session` channel:

| Event | What happens |
|---|---|
| `expiring` | Under five minutes of token life left. A warning, not a close, because cutting somebody off mid-generation would be the server causing the outage it is warning about |
| `expired` | Closed, with the sign-in-again close code |
| `revoked` | No longer a member. Closed immediately |
| `workspace_changed` | The workspace itself is gone. Closed with the reconnect code, a different instruction |
| `role_changed` | Still a member at a different role. The socket **stays open** and re-authorises against the new one |

A failed re-check does not close anything. The database being briefly unavailable is the server's
problem, and signing every user out over it would turn a blip into an outage.

**The ticket store is Postgres backed rather than Redis backed**, and that is a considered
deviation: there is no Redis client in this codebase yet, and a `DELETE` that returns a row count
has exactly the property `GETDEL` was wanted for. A Redis implementation drops in behind the same
interface. `MemoryTicketStore` is the local default, so `npm run dev` still needs nothing running.

## Alternatives Considered

### Option 1: A single use, short lived, hashed, workspace scoped ticket, plus an origin allowlist

- Pros
  - The value that lands in a URL and therefore in logs is worth nothing thirty seconds later and
    worth nothing twice.
  - Redemption is atomic across replicas, because the delete's row count is the decision.
  - The socket's scope is fixed at open time, so no message can move it.
  - The origin check and the ticket defend against overlapping but different attackers, so both
    are present.
  - Works with a browser, with `curl`, with the `ws` library and with the test suites.
- Cons
  - Three requests before a socket exists, which is more moving parts than one.
  - A ticket store is state that must work across replicas and must be swept.
  - Switching workspace requires a new socket rather than a message.
  - Clock skew and expiry handling have to be right in two places, the ticket and the token.

### Option 2: A long lived JWT in the query string

- Pros
  - One request. The token the client already has opens the socket.
  - No ticket store, no sweeping, no extra table.
- Cons
  - URLs are logged everywhere, and a token with an hour of life in a log with a year of
    retention is a credential with a year of life.
  - It sits in a place with much weaker access control than the database it unlocks.
  - Nothing about it is single use, so a copy from a log is a working credential until it
    expires.

### Option 3: A cookie based session

- Pros
  - The browser attaches it automatically, so the socket URL carries nothing.
  - Familiar and well supported.
- Cons
  - WebSockets are not covered by CORS, so the cookie is attached to an upgrade from *any*
    origin. That is cross-site WebSocket hijacking, and the only thing standing in the way would
    be the origin header check, with no second wall.
  - Requires CSRF protection on the HTTP surface as well.
  - The server authenticates with a bearer header and would need a second credential mechanism.

## Consequences

### Positive

- Nothing that grants access sits in a log with any useful lifetime.
- Ticket redemption is correct under concurrency, verified by a test that races two sockets for
  one ticket.
- A socket's workspace cannot be changed by any message, which removes a whole category of
  confused-deputy bug.
- Revocation is enforced on open sockets, and a role change is applied in place because the
  connection is still legitimately theirs; what changed is what it may do.
- The distinction between `expired`, `revoked` and `workspace_changed` gives the client three
  different correct behaviours instead of one generic disconnect.
- The Postgres-backed store already works across replicas, so no infrastructure is required to
  run more than one instance.

### Negative

- Four requests where there used to be one, and each has to be understood to debug the flow.
- A ticket table has to be swept, and it is deliberately policy free (see below) so its access
  control is entirely in the repository layer.
- Switching workspace tears down and rebuilds a socket, which the client has to handle
  gracefully.
- A non-browser client must perform the exchange. `wscat` will not connect, and the error says so.
- The membership re-check runs on a timer, so revocation is enforced within that interval rather
  than instantly.

### Trade-offs

- Extra round trips were traded for a credential in a URL that is worthless almost immediately.
- SHA-256 rather than a slow KDF was chosen because the input is high-entropy random bytes and a
  KDF on the socket-open path would be a self-inflicted rate limit.
- A missing `Origin` is allowed, which looks like a hole and is not, because refusing it breaks
  every non-browser client while stopping no attack.
- `ws_tickets` is deliberately policy free under row-level security, because the redemption
  happens before a workspace scope exists. It holds nothing but a digest, an id and a role, for
  thirty seconds. `workspace_invites` *can* keep a policy because its token is
  `<workspace_id>.<secret>` where the workspace id authorises nothing and merely selects which
  rows to search.
- The membership decision is cached for 30 seconds, which is a stated staleness window rather
  than a tuning detail.

## Implementation Notes

- `server/src/auth/tickets.ts` defines the interface and both implementations. `TICKET_TTL_S` is
  30. A ticket carries the workspace, the user, the role, its own expiry, and the expiry of the
  *token* that bought it, because a socket outlives the request that opened it and otherwise has
  no idea when the credential behind it ran out.
- `server/src/db/repositories/tickets.ts` is the replica-safe store: the delete is the decision.
- `server/src/auth/origin.ts` holds the allowlist. `server/src/auth/socketAuth.ts` is what the
  relay calls to decide whether a socket may exist and in which workspace.
- Accepting an invitation is deliberately **not** a socket command: the accepter is not a member
  yet, so there is no socket scoped to the workspace they are joining. It is
  `POST /v1/invites/accept`.
- The request logger redacts `ticket` by name, along with `token`, `key`, `code` and
  `access_token`.
- Migration `011_ticket_token_expiry` was introduced rather than editing the already-shipped
  migration `010_ws_tickets`, keeping the runner forward only and checksummed.
- CORS on the HTTP routes uses **the same allowlist**, not a second copy, so the answer to "may
  this origin talk to us" cannot depend on which transport asked. The origin is echoed by name,
  never `*`, and there is deliberately no `Access-Control-Allow-Credentials`, because this server
  authenticates with a bearer header and never a cookie.
- Failing responses carry CORS headers too. A 401 a browser cannot read arrives at the client as
  "could not reach the server", which inverts the one decision the socket layer exists to get
  right.

## Security Considerations

- **CORS and the socket's origin check defend against opposite things and neither replaces the
  other.** CORS asks the *browser* not to hand a response to script from another origin; the
  origin check is the *server* refusing the connection outright, because WebSockets are not
  covered by CORS at all.
- **The ticket is hashed at rest**, so a dump of `ws_tickets` is not a set of credentials. The
  same is true of invitations.
- **A spent ticket and a forged ticket produce the same refusal**, because two different messages
  would be an oracle.
- **Removing a member kills their outstanding tickets**, and their open sockets close on the next
  re-check.
- **The role change case is enforcement, not notification.** The capability check reads the
  socket's live context on every command, and `test:tenancy` proves it with a socket that
  handshakes as an admin from a real membership row, is demoted mid-session, and immediately
  re-sends the exact command it just succeeded at. Connecting as a member and demoting from there
  would prove nothing, because a server reading the handshake context would refuse it too and the
  test would pass for the opposite of the right reason.
- **`JAROKU_DEV_AUTH=1` opens sockets with no credential at all**, in the development workspace.
  It refuses `NODE_ENV=production` and announces itself at boot.
- **The cross-replica staleness window is 30 seconds** and is documented rather than implied.
  Revocation is exact on the replica that performed it.

## Performance Considerations

- Three short HTTP requests before a socket opens, once per connection rather than per message.
- SHA-256 on a 256-bit random value is negligible, and was chosen partly so the socket-open path
  is not rate limited by its own hashing.
- Ticket redemption is one `DELETE` returning a row count, which is a single indexed write.
- The re-check timer runs per open socket. It reads a cached membership decision, so the common
  case is not a database round trip.
- Negative caching of membership decisions means guessing workspace ids does not cost a database
  round trip per guess.

## Operational Considerations

- `JAROKU_ALLOWED_ORIGINS` defaults to the local development origins and is **required** in
  production, where the server refuses to start without it.
- "Open this socket with a ticket from POST /v1/ws-ticket" means something connected without
  doing the exchange. The React client and the fallback debug client both do it; a script will
  not. Either perform the exchange or use `JAROKU_DEV_AUTH=1` in development.
- A 403 "origin not allowed" means the page's origin is not in the allowlist.
- Expired tickets need sweeping. They are short lived, so the table stays small.
- When running more than one instance, the Postgres-backed ticket store is required; the memory
  store is per process and is the local default only.

## Rejected Alternatives

**A long-lived JWT in the query string** was rejected because URLs are logged by every layer
between the browser and the application, and those logs have far longer retention and far weaker
access control than the data the token unlocks. A credential that is captured once and works for
an hour, from a place designed to be kept and aggregated, is precisely the mistake this design
exists to avoid.

**A cookie based session** was rejected because WebSockets are not covered by CORS, so a cookie is
attached to an upgrade initiated from any origin. That is cross-site WebSocket hijacking, and
choosing cookies would leave a single header check as the only thing preventing it, with no
second wall. It would also require CSRF protection on the HTTP surface and a second credential
mechanism alongside the bearer header the server already uses.

## Related Decisions

- ADR-018: The workspace as the tenancy unit, with an explicit context argument
- ADR-019: Row level security as the backstop, and why `ws_tickets` is policy free
- ADR-020: Provider agnostic OIDC verification with a real local issuer
- ADR-022: Roles as data, one capability matrix checked at the door
- ADR-023: One WebSocket carrying many logical channels
- ADR-024: Client state as per concern stores that reset on a workspace switch

## References

- `server/src/auth/tickets.ts`, `origin.ts`, `socketAuth.ts`, `session.ts`
- `server/src/db/repositories/tickets.ts`
- `server/src/http/router.ts`, the CORS allowlist and log redaction
- `npm run test:tickets`, `test:relay`, `test:tenancy`, `test:http`
- `server/src/auth/THREAT-MODEL.md`, "Why the ws-ticket exists" and "Why the origin check is not
  optional"
- README sections "Why the ticket exists", "Why the origin check is not optional", "A socket must
  not outlive its membership"
- CHANGELOG v0.2.6 "Authentication and Workspace Access"
- RFC 6455, The WebSocket Protocol, section 10.2 on the Origin header
- OWASP guidance on cross-site WebSocket hijacking
