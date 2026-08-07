# The authentication boundary: what it stops, and what it does not

Session 2 of the hosted migration. This is the note the spec asks for, and it exists because two
of the decisions in this directory look like over-engineering until you know what they are for —
and one of them is the kind of thing a later "cleanup" removes.

The README's [Authentication and membership](../../../README.md#authentication-and-membership)
section describes how it works. This describes what it is defending against.

---

## The asset

A workspace's traces. Not "some rows" — a trace's `input` and `output` payloads contain whatever
the agent touched: the contents of the user's Gmail, rows from the user's Postgres, the text of
their Slack channels, and the prompts they wrote. That is regulated data, it is the product's
whole primitive, and it is the thing every boundary here is around.

Secondarily: provider API keys (spendable), MCP server tokens (third-party access), and the
Railway token (their hosting account). Those live in `runtime/.env` and never cross the socket —
what a client learns is `configured: true`.

## Who the attacker is

Hosted, roughly six thousand people share this backend, and the threat model assumes **one of
them is hostile and has a legitimate account**. That is a very different attacker from the one a
localhost tool has: they can sign in, open sockets, read every response, send arbitrary commands,
and try ids all day. Nothing here relies on them not looking.

There is also the ordinary web attacker — a page on another origin that the victim visits while
signed in — which is what the origin check is for and nothing else is.

---

## Why the ws-ticket exists

**A browser cannot set an `Authorization` header on a WebSocket.** That is the whole problem, and
every design that ignores it ends up in one of two places:

**A long-lived JWT in the query string.** URLs are logged. By the load balancer, by the reverse
proxy, by the CDN, in `Referer` headers on any resource the page loads afterwards, and in
whatever aggregates all of that. A token with an hour of life in an access log with a year of
retention is a credential with a year of life, sitting somewhere with much weaker access control
than the database it unlocks. This is the mistake the spec calls out by name.

**A cookie.** WebSockets are not covered by CORS, and a cookie is attached to an upgrade from any
origin. That is cross-site WebSocket hijacking: a page on `evil.example` opens a socket to this
server, the victim's browser attaches their session, and the attacker reads the responses. The
`Origin` check below is what stops it — but choosing cookies means the *only* thing that stops
it is a header check, with no second wall.

So the credential that goes in the URL is one where a leak is worth nothing:

| Property | Why |
|---|---|
| **Single use** | Redemption is a `DELETE` whose row count is the decision. A leaked ticket has already been spent by the legitimate socket. |
| **Thirty seconds** | A page load, not a session. A log entry from yesterday is inert. |
| **Hashed at rest** | SHA-256. A dump of `ws_tickets` is not a set of credentials. |
| **Scoped to one workspace** | Redeeming it establishes the socket's scope, and nothing later can change it. |

SHA-256 rather than a slow KDF is deliberate: the input is 256 bits of `randomBytes`, so there is
no dictionary to make expensive, and a KDF on the socket-open path would be a self-inflicted rate
limit.

**The exchange itself is the second wall.** To get a ticket you need a verified bearer token and
a membership row. A page on another origin cannot read the response of a cross-origin
`POST /v1/ws-ticket`, so it cannot obtain one — which is why the ticket and the origin check
defend against overlapping-but-different attackers, and why both are here.

## Why the origin check is not optional

**WebSockets are not covered by CORS.** This is the single most surprising fact in this
directory, and the surprise is the vulnerability. Developers reason by analogy with `fetch`:
cross-origin reads need the server's permission, so a cross-origin socket must too. It does not.
The handshake is not a CORS request, no preflight happens, and `new WebSocket(...)` from any page
connects.

The `Origin` header is the actual defence, because browsers set it on every upgrade and script
cannot forge it. Three properties of the implementation are load-bearing:

**It runs before the ticket.** Cheaper, and it means a rejected cross-origin attempt does not
burn a ticket the legitimate client is about to use.

**A refusal is an HTTP 403 on the raw socket, before the handshake completes.** The obvious
alternative — accept, then close — is indistinguishable to a client from a network drop, and its
reconnect loop then retries forever.

**A missing `Origin` is allowed.** This looks like a hole and is not. Browsers always send one;
`curl`, the `ws` library, the test suites and the fallback debug client do not. Refusing a missing
origin breaks every non-browser client and stops no attack, because an attacker with a non-browser
client sends whatever origin they like — the header only *means* anything when a browser set it,
and a browser always does. What defends the non-browser case is the ticket, which is a credential
rather than a claim. A literal `null` origin **is** refused: that is a sandboxed iframe or a
`file://` page, an opaque origin, which is exactly the one not to trust.

---

## What each layer actually stops

| Layer | Stops |
|---|---|
| JWT verification | Forged, unsigned (`alg: "none"`), HMAC-confused, tampered, expired, wrong-issuer and wrong-audience tokens |
| Membership lookup | A signed-in user asking to act in a workspace they are not in |
| The ticket | A token leaking through an access log; a replayed socket open |
| The origin check | A page on another origin opening a socket with the victim's browser |
| The capability matrix | A member doing an admin's or an owner's job |
| Per-socket scoping | A socket being talked into another workspace after it is open |
| Session revalidation | A socket outliving the membership that authorised it |
| Client store reset | The previous workspace's rows being visible after a switch |

## What it explicitly does not stop

Stated because a boundary whose limits are not written down gets trusted for things it never did:

- **Model-written Python executing on the control plane.** `validator.ts` imports the staged
  project and `graphIntrospect.ts` spawns a Python module — both untrusted code, both on this
  machine, both before anything is saved. Authentication does not touch this at all. **Session 4**
  is the sandbox, and until it lands this server is not safe to point at strangers.
- **Rate limiting, body-size abuse, and every other volumetric attack.** There is a body cap on
  the HTTP routes and bounded waits on the JWKS fetch; there is no per-IP or per-workspace
  throttle. **Session 8.**
- **Security headers, CORS on the HTTP routes, HSTS, CSP.** **Session 8.** The CSP is also the
  real mitigation for the token being in `localStorage`, which is the trade-off `lib/auth.ts`
  states rather than hides.
- **A compromised auth provider.** If the issuer signs a token for the wrong person, this server
  believes it. That is the trust being placed by choosing an issuer at all.
- **XSS.** Script on the page can read the token, or simply use the API as the user. The storage
  choice does not change that; a CSP does.
- **The cross-replica staleness window.** A membership decision is cached for thirty seconds.
  Revocation is exact on the replica that performed it and bounded by the TTL everywhere else.
  **Session 5's** Redis pub/sub closes it.
- **Prompt injection.** The README is honest that framing MCP output is not a defence, and
  nothing here changes that. An agent's blast radius is bounded by its grants, which is the
  actual mitigation.

---

## The two rules that are easiest to break by accident

**Never trust a workspace id from a client.** It arrives the same way a run id or an agent slug
does: as a string in a payload. What turns one into a scope is a `workspace_members` row, and
there is exactly one function that does the turning — `ContextResolver.resolve`. A second path
that skips it would not fail any existing test, and `test:tenancy` asserting that a forged
`workspaceId` is ignored is what makes it fail.

**Never make a refusal message depend on whether something exists.** "You are not a member of
that workspace" and "no such workspace" are the same sentence here on purpose. Two different
messages are an existence oracle over every id an attacker cares to try, and the audit row that
distinguishes them stays server-side. The same reasoning applies to a spent versus a forged
ticket, and to an expired versus an invented invitation.
