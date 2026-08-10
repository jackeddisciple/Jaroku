# ADR-020: Verify Provider Agnostic OIDC Tokens, and Run a Real Local Issuer for Development

## Status

Accepted. Introduced in v0.2.6 (7 August 2026).

## Context

The tenancy work put a `workspace_id` on every row and made every repository method take a
context. What it did not do is decide *whose* workspace a request is in. That requires
authentication: real users, real sessions, and a client that cannot see anything it is not a
member of.

Two decisions had to be made together.

**Which identity provider?** Committing to a vendor SDK in the request path means the answer to
"which provider" becomes a rewrite rather than a configuration value. Clerk, Auth0, Okta, Cognito
and Supabase Auth all issue an OIDC JWT with a `sub` claim, verifiable against a JWKS URL.

**What happens locally?** The obvious shape for local development is a flag that skips
verification. It is also the worst one: the path that runs on every developer's machine every day
would then be a *different* path from the one that runs in production, so the code that actually
matters is the code nobody exercises, and the day it breaks is the day it is in front of users.

The local path also has a hard constraint. `npm run dev` must continue to start with no Postgres,
no Redis, no Docker and no cloud account, which the README is built around.

A further consideration is failure semantics. "This token is bad" and "we cannot check it right
now" are different facts with different correct responses, and conflating them signs every user
out of a working session because a third party had a bad minute.

## Decision

**Authentication is spelled as OIDC, not as a vendor.** The server verifies a JWT against a JWKS
URL, checks `iss`, `aud`, `exp`, `nbf` and the signature, and maps `sub` to `users.external_id`.
There is no SDK in the request path, so pointing this at any provider is three environment
variables and no code:

```
JAROKU_AUTH_ISSUER=https://your-app.example.com
JAROKU_AUTH_AUDIENCE=jaroku
JAROKU_AUTH_JWKS_URL=https://your-app.example.com/.well-known/jwks.json   # optional
```

`external_id` holds the provider's `sub`, which is opaque and is never parsed.

**With no issuer configured, the server runs one.** An RS256 key pair generated at boot,
published at its own `/v1/auth/jwks.json`, minting real tokens that go through the **same**
verifier, the same JWKS fetch and the same `iss`, `aud` and `exp` checks. What is missing locally
is a password, not a signature: `POST /v1/auth/dev-login` takes an email address and hands back a
token for it.

That is exactly as dangerous as it sounds, which is why it announces itself at every boot and
**refuses to start under `NODE_ENV=production`**. The signing key is persisted to
`server/.devauth.json` (`chmod 600`, gitignored) so a restart does not sign the developer out,
because the predictable alternative is somebody reaching for a bypass to stop being logged out.

**The JWKS cache has the usual shape for the usual reasons**, plus one that is specific: a TTL so
the provider's latency is not this server's latency, a **forced refresh on an unknown `kid`** so
rotation works, and a **rate limit on that refresh**, because `kid` comes off an unverified token
header and "re-fetch on unknown kid" with no leash is a remote trigger that makes this server
hammer its own auth provider on demand. A failed refresh **keeps the keys it already had**,
exactly as a failed MCP discovery keeps its tool list. Asymmetric keys only.

**JWT verification refuses by allow-list, not by branch.** `alg: "none"` and every symmetric
algorithm are absent from the allow-list rather than special-cased, which is the difference
between a check that can be bypassed and one that cannot.

**A token that cannot be verified because the issuer is down is a 503, not a 401.** A 401 there
would sign every user out of a working session, and the client's socket layer branches on
precisely that distinction. See ADR-024.

**Session provisioning happens on first sight**, inside one transaction: `sub` maps to
`users.external_id`, and if this is the first time, a user and a personal workspace are created
together.

## Alternatives Considered

### Option 1: Provider agnostic OIDC verification, with a real local issuer

- Pros
  - Changing identity provider is configuration, not code.
  - No vendor SDK in the request path, so nothing to swap and nothing to keep up to date.
  - The local path exercises the production verification code, so the code that matters is
    exercised daily.
  - `npm run dev` still needs nothing installed and no cloud account.
  - Standard, well-specified verification with a well-understood threat model.
- Cons
  - The verifier, the JWKS cache and the local issuer are all code this project owns and must get
    right.
  - JWT verification is a category with well-known implementation pitfalls, so the code needs
    careful review and thorough tests.
  - No vendor SDK also means no vendor conveniences: session management, refresh flows and
    organisation features are the provider's to expose and this server's to ignore.

### Option 2: Integrate one provider's SDK directly

- Pros
  - Fastest to a working sign-in, with sessions, refresh and UI components provided.
  - Less security-sensitive code owned by this project.
  - Provider-specific features available immediately.
- Cons
  - Ties the product to one vendor at the request path, so changing provider is a rewrite.
  - Self-hosting or a customer's own identity provider becomes unsupported.
  - A vendor SDK in the request path is a dependency on somebody else's release cadence for
    something on the authentication hot path.

### Option 3: Roll a local username and password system

- Pros
  - No external dependency at all, and full control.
  - No configuration required to run.
- Cons
  - Owning password storage, reset flows, brute-force protection, multi-factor authentication and
    session management is a large, permanent, high-risk surface.
  - Enterprise deployments want SSO, which would then have to be added alongside.
  - It is the part of the problem most thoroughly solved by existing providers.

### Option 4: A verification bypass flag for local development

- Pros
  - Trivial to implement and to explain.
  - Zero friction locally.
- Cons
  - The path exercised every day is not the path that runs in production, so the production path
    is the one nobody runs.
  - A bypass is a flag somebody eventually sets in the wrong environment.
  - It would leave the client's sign-in flow untested locally, because there would be nothing to
    sign in to.

## Consequences

### Positive

- Pointing Jaroku at a real provider is three environment variables.
- The local development experience includes a genuine sign-in screen, a genuine token and genuine
  verification, so the whole exchange is exercised constantly.
- Because the local issuer is real, the client's three-request exchange (`session`, `ws-ticket`,
  socket) is the same locally and in production, and the fallback debug client performs it too.
- The 401 versus 503 distinction is preserved end to end, which is what lets the client decide
  between retrying and showing sign-in.
- `npm run test:jwt` covers `alg: "none"`, algorithm confusion, wrong issuer, wrong audience,
  expiry and clock skew. `npm run test:jwks` covers key caching, forced refresh with a leash and
  the refusal of symmetric keys.

### Negative

- Security-sensitive verification code is owned by this project rather than a vendor.
- The local issuer is a real facility that mints real tokens for any address with no password,
  and it must never run in production. It refuses, and it announces itself, but it exists.
- No vendor conveniences: refresh flows, organisation management and multi-factor authentication
  are the provider's concern and are not surfaced here.
- `users.email` is unique, so an address held by a different provider `sub` produces a sentence
  rather than an automatic resolution. That is deliberate, because nothing automatic can safely
  resolve it.

### Trade-offs

- Owning the verifier was traded for provider independence, mitigated by using only standard
  mechanisms and by an adversarial test suite.
- A real local issuer costs more code than a bypass flag, and buys the property that the
  production path is the path everybody runs.
- Persisting the local signing key to disk trades a small local exposure for the removal of the
  incentive to add a bypass, which would be a much larger exposure.
- The 30 second membership cache introduces a bounded staleness window on revocation, which is
  stated as a security property rather than hidden as a tuning detail. See ADR-018.

## Implementation Notes

- `server/src/auth/config.ts` decides which issuer is trusted, or runs the local one. It refuses
  to start under `NODE_ENV=production` in local mode. `LOCAL_ISSUER` is `urn:jaroku:local`,
  deliberately not a URL, because nothing resolves it and nothing ever will.
- `server/src/auth/jwks.ts` holds the key cache: TTL, forced refresh on unknown `kid`, a rate
  limit on that refresh, negative caching, and asymmetric keys only.
- `server/src/auth/jwt.ts` performs compact JWS verification with an algorithm allow-list.
- `server/src/auth/localIssuer.ts` is the development issuer: real RS256, real tokens, no
  password.
- `server/src/auth/verifier.ts` turns a bearer token into an `AuthContext` and distinguishes "this
  token is bad" from "we cannot check it right now".
- `server/src/auth/session.ts` serves `/v1/auth/*`, `/v1/ws-ticket` and `/v1/invites/accept`.
- HTTP routes are absent rather than disabled in the wrong mode: `/v1/auth/jwks.json` and
  `/v1/auth/dev-login` do not exist in provider mode.
- `/v1/auth/session` and `/v1/ws-ticket` share a single workspace selection function, because
  applying different rules once handed a user two different default workspaces.
- User provisioning is transactional. A race where simultaneous first sign-ins both inserted the
  same user on Postgres was fixed; SQLite had masked it through single-connection serialisation.
- `POST /v1/auth/onboarded` takes no user id, which is the whole of its authorisation story: the
  only person it can mark is whoever presented the token, so there is nothing to forge because
  there is nothing to send. It is idempotent and records the first time rather than the latest.

## Security Considerations

- **`alg: "none"` and symmetric algorithms are absent from the allow-list**, not branched around.
  Algorithm confusion attacks work by getting a verifier to use a public key as an HMAC secret,
  and the defence is refusing to consider the algorithm at all.
- **`iss`, `aud`, `exp` and `nbf` are all checked**, with bounded clock skew.
- **The `kid` comes off an unverified header**, so forced refresh is rate limited. Without a
  leash, an attacker can make this server hammer its own auth provider on demand.
- **A failed JWKS refresh keeps the existing keys**, so a provider blip does not become an
  outage.
- **A verification failure caused by issuer unavailability is a 503.** Returning 401 would sign
  every user out because a third party had a bad minute.
- **`external_id` is opaque and never parsed.** Nothing is inferred from the shape of a `sub`.
- **A compromised issuer is trusted.** If the issuer signs a token for the wrong person, this
  server believes it. That is the trust implied by choosing an issuer, and it is stated in the
  threat model rather than left implicit.
- **The local issuer and `JAROKU_DEV_AUTH=1` both refuse `NODE_ENV=production`** and both announce
  themselves at every boot. `JAROKU_DEV_AUTH=1` opens sockets with no credential at all.
- **`server/.devauth.json` is `chmod 600` and gitignored.** It only exists in local mode.
- The token lives in the browser's `localStorage`, which is stated as a trade-off rather than
  hidden: it survives a reload, and it is readable by any script on the page. The mitigation that
  matters is a Content-Security-Policy, which is planned work, not the storage choice, because an
  attacker with script execution can use the token from memory or mint a fresh one through the
  same API.

## Performance Considerations

- JWKS keys are cached with a TTL, so provider latency is not per-request latency.
- Negative caching prevents a repeated unknown-key lookup from becoming repeated network calls.
- Signature verification is an asymmetric operation per request, which is the standard cost of
  stateless authentication.
- The membership decision is cached for 30 seconds, positives and negatives both, because without
  the negative, guessing workspace ids costs a database round trip per guess.
- Every HTTP request re-presents its token and is re-checked. A socket is checked once at the
  upgrade and re-checked on a timer, which is a different cost profile and a different decision.
  See ADR-021.

## Operational Considerations

- Local: nothing to configure. The sign-in screen asks for an email address and there is no
  password. That is the local issuer, and the troubleshooting section says so.
- Hosted: set `JAROKU_AUTH_ISSUER` and `JAROKU_AUTH_AUDIENCE`, optionally `JAROKU_AUTH_JWKS_URL`,
  and set `NODE_ENV=production` so the development facilities refuse to run.
- Key rotation at the provider works without intervention, because an unknown `kid` triggers a
  rate-limited forced refresh.
- "My email already belongs to a different sign-in" means `users.email` is unique and that
  address is held by a different provider `sub`, usually because the provider changed or two are
  configured at once. It is a sentence rather than a stack trace because nothing automatic can
  safely resolve it.
- A 503 on sign-in points at the issuer, not at Jaroku. A 401 points at the token.
- Wiring a provider's client-side SDK is a client change with no server consequence, and is
  deliberately left undone.

## Rejected Alternatives

**Integrating one provider's SDK** was rejected because it makes the choice of identity provider
a code change rather than a configuration value, and because it would rule out a customer's own
identity provider or a self-hosted deployment. The verification this system needs is standard: a
signature against a JWKS URL plus four claim checks. Taking a vendor SDK for that would buy
convenience at the cost of the property the design values most.

**Rolling a local username and password system** was rejected because owning password storage,
reset flows, brute-force protection and multi-factor authentication is a large permanent
high-risk surface for a part of the problem that existing providers have solved thoroughly.
Enterprise deployments would want SSO regardless, so the work would be additive rather than a
replacement.

**A verification bypass flag for local development** was rejected because it makes the daily path
and the production path different. The code that authenticates a real user would then be code
nobody runs until it is in front of users. A real local issuer costs more and removes the
category.

## Related Decisions

- ADR-018: The workspace as the tenancy unit, with an explicit context argument
- ADR-021: Single use WebSocket tickets and a mandatory Origin allowlist
- ADR-022: Roles as data, one capability matrix checked at the door
- ADR-024: Client state as per concern stores that reset on a workspace switch

## References

- `server/src/auth/config.ts`, `jwks.ts`, `jwt.ts`, `localIssuer.ts`, `verifier.ts`, `session.ts`
- `npm run test:jwt`, `test:jwks`, `test:session`, `test:resolve`
- `server/src/auth/attacks.test.ts`, the adversarial suite
- `server/src/auth/THREAT-MODEL.md`
- README section "Authentication and membership"
- CHANGELOG v0.2.6 "Authentication and Workspace Access"
- RFC 7519, JSON Web Token; RFC 7515, JSON Web Signature; RFC 7517, JSON Web Key
- OpenID Connect Core 1.0, https://openid.net/specs/openid-connect-core-1_0.html
