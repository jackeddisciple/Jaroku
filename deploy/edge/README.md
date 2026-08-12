# The edge

The layer in front of the load balancer: TLS termination, a CDN, and a WAF. It is the only
layer that can refuse a flood without this platform paying for a TCP handshake, a TLS
negotiation and a route lookup per request — and the only one that has never heard of a
workspace, which is why it is not the only layer.

Nothing here runs in the request path. **If the edge is misconfigured or absent, every property
Jaroku actually promises still holds**: tenancy scoping, the sandbox boundary, the per-IP and
per-workspace rate limits, the capability checks. The edge makes an attack cheaper to survive.
It is never what makes an attack fail.

## What is in this directory

| File | What |
|---|---|
| `cloudflare-rules.json` | **Generated.** Do not edit. The rendered form of `server/src/abuse/edgeRules.ts`. |

The rules themselves live in `server/src/abuse/edgeRules.ts`, as a tree rather than as a
provider's expression string, so that a second provider is a second renderer rather than a
second copy of every rule.

```bash
cd server
npm run edge:render            # rewrite cloudflare-rules.json from the table
npm run edge:render -- --check # fail if it is out of date  (the deploy pipeline runs this)
npm run test:edge-rules        # the agreement and escaping assertions
```

## Applying it

The JSON is provider-shaped but not provider-applied: it is the input to whichever mechanism
your account uses — the Cloudflare Terraform provider's `cloudflare_ruleset`, the API, or a
`wrangler` deployment. Rules are matched **in order**, and the first entry is a `skip` that
exists to be first.

```
POST /client/v4/zones/<zone>/rulesets/phases/http_request_firewall_custom/entrypoint
```

Each rendered rule carries a stable `id`. Editing a rule is an update to that id, never a
delete-and-recreate: a recreated rule loses its position, and position is the whole of an edge
configuration's semantics.

## The two exemptions, and why they are not negotiable

`skip-control-plane-and-health` covers `/healthz`, `/readyz` and `/v1/runs/…`, and both halves
are load-bearing:

- **Health checks** are asked by a load balancer, from one address, as often as it likes. An
  edge that challenges or throttles them removes healthy instances from rotation — a WAF rule
  that causes the outage it was bought to prevent.
- **`/v1/runs/…` is the sandbox control plane.** A running agent pushes its trace there, polls
  it for a pause, and blocks on it for an MCP confirmation. Every sandbox in a Fly region shares
  one egress address, so an IP counter on that path is a global cap on how many runs may exist
  at once — and a JavaScript challenge served to a Python process is a run that hangs until its
  wall clock kills it.

`server/src/abuse/edgeRules.test.ts` asserts that this list and `http/rateLimit.ts`'s
`ipRuleFor` exemptions are the same list. That check exists because the two are edited months
apart by people looking at different files, and the failure mode of disagreement is an outage
rather than a warning.

## Bot scores challenge; they never block

`cf.bot_management.score` is a vendor's opinion expressed as a number nobody outside that vendor
can reproduce, and it is wrong about somebody every day. Rules that consult it select a
**managed challenge** — which a person passes and a script does not — so the cost of a wrong
guess is an inconvenience rather than a lockout. The only rules that block outright are for
request shapes that are never legitimate: paths this product has never served, and bodies far
past what any route accepts.
