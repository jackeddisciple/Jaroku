# ADR-027: Deploy Agents Into the User's Own Hosting Account Through a Reviewed Serve Template

## Status

Accepted. Introduced in v0.2.3 (5 August 2026) and hardened in v0.2.4.

## Context

An agent a user trusts is an agent they want reachable. Making a generated agent answer a URL is
the natural next step after building, running, tracing, editing and evaluating it.

There are two fundamentally different ways to provide that.

**Host it.** Jaroku runs the agent, holds the credentials and issues the URL. That is a better
onboarding experience and a plausible business model, and it makes Jaroku responsible for other
people's model spend, other people's mailbox and database credentials, and the availability of
other people's production endpoints.

**Orchestrate it.** Jaroku packages the agent and ships it to the user's own hosting account,
using their credentials, on their bill, with no Jaroku infrastructure in the path at all.

There were also three constraints specific to this codebase.

**The agent contract must not change.** Fifteen agents already existed. A deployment feature that
required regeneration would be a feature that did not apply to anything anyone had already built.

**A generated project imports nothing from Jaroku.** Whatever serves HTTP has to hold that
promise, which means it cannot import the runner's provider selection even though it needs
exactly that behaviour.

**Credentials would leave the machine for the first time.** Everything before this took one path:
into `runtime/.env`, out of `process.env` at the moment of use, never further.

## Decision

**Jaroku orchestrates a deploy into the user's own Railway account. It hosts nothing.** Their
credentials, their account, their agent, their bill.

```
you press Deploy
  refuse      everything knowable locally, BEFORE touching your account
  record      a row, before the first Railway call
  package     serve.py + Dockerfile + .dockerignore + pyproject.toml, atomically
  provision   a project and a service, in your Railway account
  variables   your credentials, over HTTPS, in a request body
  upload      the project, over the Railway CLI, token in the environment
  follow      the build, until it settles
  publish     a public URL, once there is something behind it
```

**The agent contract does not change.** Not one line, and no agent is regenerated. The contract
already describes a request handler: `build_initial_state(text) -> state -> graph.invoke(state) ->
answer`. What was missing was a caller that loops, not a symbol. So
`runtime/tool_templates/serve.py` is a **reviewed template**, copied byte for byte into a project
exactly like `mcp_bridge.py` and the connectors, and every agent ever generated became deployable
the day it landed.

`serve.py` holds two properties, and both are the reason it looks the way it does. **It imports
nothing from Jaroku**: pulling in `jaroku_runner.models` for twelve lines of provider selection
would quietly end the promise that a generated project is the user's to copy out and run, so those
twelve lines are duplicated instead. **It adds no dependency**: stdlib `ThreadingHTTPServer`,
because LangGraph invocation is blocking so threads are the right shape, and a project's
dependency closure is unchanged by being deployable.

It does two things a *generated* file may not, and both are the point: it **constructs the model**
(rule 2 forbids `agent.py` from doing so precisely so the model can be injected, and this is the
injection point) and it **writes to stdout** (rule 3 protects the NDJSON trace stream, and out
there stdout is the deployment's log pane).

Two routes: `GET /health` is unauthenticated because it reveals nothing and a health check that
needs a credential is one the platform cannot make; `POST /run` requires a bearer token, is UTF-8,
is capped at 64 KB in, and has bounded concurrency out.

**Four host-owned artifacts land in the project** (`serve.py`, `Dockerfile`, `.dockerignore`,
`pyproject.toml`), all read-only to the edit loop alongside `jaroku.json` and the MCP pair,
because an edit able to rewrite `serve.py` or the Dockerfile could change what a container on the
open internet does with nobody approving it. They are written through the same staging and atomic
swap discipline generation uses, so a failed or cancelled deploy leaves the project byte for byte
as it was.

**Names travel, values do not.** See ADR-026. The database never sees a value, values never appear
in an argument, every build log line is scrubbed, and `.dockerignore` keeps `.env` out of the
image.

**A bearer token is minted per deploy and shown once.** A deployed URL runs an agent on the user's
provider key, so an open one is an unmetered way for anyone who finds it to spend their money.
`serve.py` refuses to start without one unless `JAROKU_SERVE_PUBLIC=1` says out loud that the
endpoint is open. That token is the only credential this product ever sends *to* a browser, and it
is never persisted.

**Refusals happen before anything is created**: the dry-run provider (a deployed one would be a
URL that looks like a working agent and is not), a missing or unticked connector credential, an
agent with a run in flight, and a missing Railway CLI.

**High-impact MCP tools fail closed in a container.** A copied-out project proceeds with a warning
because a person running a script on their own machine *is* the authorisation. A container is not
that: nobody is there to ask, and the bridge's per-run grant is module global, so one approval
would leak across every later request for the life of the process. Deployed agents run with
`JAROKU_MCP_CONFIRM=require`.

**The deploy record is written before the first Railway call**, and statuses distinguish outcomes
that mean different things: `cancelled` (you stopped it), `interrupted` (nobody was watching),
`superseded` (it worked and a later deploy replaced it), and `failed`. Exactly one row may claim
to be `live` on a service, because two would be two URLs both described as the current one.

**A redeploy goes back into the same project and service.** The button says *Redeploy* when that
is what it will do, because "replaces what is running there" and "puts up a second one you will
also be billed for" are different decisions and only the user knows which they meant.

## Alternatives Considered

### Option 1: Orchestrate a deploy into the user's own hosting account

- Pros
  - No custody of other people's credentials, model spend or production availability.
  - No Jaroku infrastructure in the path, so there is nothing to scale, secure or bill for.
  - The user keeps full control: they can see, modify and delete the deployment themselves.
  - Required no change to the agent contract, so every existing agent became deployable at once.
  - The reviewed template pattern was already established by the connectors and the MCP bridge.
- Cons
  - Requires the user to have an account with the supported provider and to install its CLI.
  - Couples the feature to one provider's API and CLI behaviour.
  - Failures happen in somebody else's system, so error classification and reconciliation are
    substantial work.
  - Jaroku cannot fix a broken deployment; it can only report it.

### Option 2: Host deployed agents on Jaroku infrastructure

- Pros
  - Best onboarding: one button, no account, no CLI.
  - Full control over the runtime, so traces could stream back from production immediately.
  - A natural commercial model.
- Cons
  - Custody of provider keys, connector credentials and MCP tokens for every user, with the
    corresponding breach surface.
  - Responsibility for other people's model spend, and for the availability of endpoints they
    depend on.
  - Requires running a sandboxed multi-tenant execution platform for model-written Python, which
    is a far larger undertaking than the rest of the product.
  - Contradicts the local-first premise stated on the first line of the README.

### Option 3: Emit deployment artifacts and let the user deploy them

- Pros
  - No provider coupling at all, and no CLI or API integration to maintain.
  - Works with any platform the user prefers.
  - Much less code.
- Cons
  - Stops well short of the promise. "Here is a Dockerfile" is not "here is a URL you can curl".
  - The user carries every operational step, including secret handling, which is exactly where the
    careful work is.
  - No deploy record, no build log, no status, so nothing about the deployment is visible in the
    product.

## Consequences

### Positive

- All fifteen existing agents became deployable retroactively, with no regeneration and no
  contract change.
- `pyproject.toml` paid an old debt: `example_agent` had always carried one promising the project
  was export ready, and no *generated* agent ever had one. Now they all do, so deploy tooling made
  portability stronger rather than weaker.
- The image installs what the agent actually uses: base LangGraph, the one provider SDK it will
  run on, and each selected connector's declared requirements. An agent with one Postgres tool
  does not pull in the Google API client.
- The deploy record is honest about states that mean different things, so telling somebody their
  deploy failed when it may be about to come up (which is how they end up deploying a second copy)
  does not happen.
- Adversarial testing in v0.2.4 uncovered thirteen production bugs against a stub API and a fake
  CLI, including HTTP request desynchronisation, a `NaN` timeout that made every deployment appear
  interrupted, and a scrubber that treated `anthropic` and `claude-haiku-4-5` as secrets.

### Negative

- Coupled to one hosting provider's API and CLI. Supporting another means another client.
- The Railway CLI must be installed and on the server's `PATH` at launch.
- Deployed agents do **not** stream trace events back yet. Building that now would mean shipping
  `jaroku_interceptor` inside the image, breaking the one guarantee the deployed artifact should
  keep hardest.
- Jaroku's record and the user's actual account can diverge, for example if they delete the
  project from their dashboard. The remembered ids are therefore checked before they are trusted.
- **Forget** detaches a record while the old service keeps running, which is a state the user has
  to understand. The notice says so, with its URL, when they press it.

### Trade-offs

- Onboarding friction (an account, a token, a CLI) was traded for having no custody of anyone's
  credentials, spend or uptime.
- Provider coupling was accepted in exchange for actually delivering a URL rather than a
  Dockerfile.
- Twelve lines of provider selection are duplicated in `serve.py` rather than imported, which is
  deliberate duplication protecting the portability promise.
- Trace streaming from production was explicitly deferred rather than implemented by shipping the
  interceptor into the image.

## Implementation Notes

- `server/src/deployManager.ts` orchestrates. `railwayApi.ts` speaks the provider's GraphQL
  control plane with every call bounded, every failure classified and every message scrubbed.
  `railwayCli.ts` performs the one job the API cannot do, with the token in the child's
  environment and never in its arguments.
- `dockerfile.ts` is pure synthesis from `jaroku.json`. `deployArtifacts.ts` writes the four files
  through staging and atomic swap. `deployStore.ts` owns the records and `deploySecrets.ts` owns
  the names-and-scrubbing discipline.
- The project is put on `sys.path` rather than `pip install`ed, because `runtime/pyproject.toml`
  does not ship `agents` in its wheel and installing would produce an image where every agent
  fails to load.
- The Railway token is the **account**-scoped `RAILWAY_API_TOKEN`, not `RAILWAY_TOKEN`, which the
  provider's own tooling reads as project scoped and which cannot create a project. It is stripped
  from every agent subprocess.
- Log streaming follows the provider's sliding window rather than treating the cursor as a page
  offset, which is what fixed hundreds of duplicated lines on long builds.
- Selecting the latest deployment uses `rowid` as a tie breaker, because `created_at` alone made
  two deployments in the same millisecond nondeterministic.
- On startup, any row still in flight is marked `interrupted` with a message pointing at the
  user's dashboard, because whatever was already created is still there.
- Configuration: `JAROKU_RAILWAY_API`, `JAROKU_RAILWAY_CLI`, `JAROKU_RAILWAY_TIMEOUT_MS`
  (20000), `JAROKU_DEPLOY_TIMEOUT_MS` (900000), `JAROKU_DEPLOY_FOLLOW_MS` (600000). On the
  deployed side: `PORT`, `JAROKU_SERVE_TOKEN`, `JAROKU_SERVE_PUBLIC`,
  `JAROKU_SERVE_CONCURRENCY` (4), `JAROKU_SERVE_TIMEOUT_S` (30).

## Security Considerations

- **Values never appear in an argument**, which is the single reason the transport is split
  between the API (variables in a request body) and the CLI (upload only).
- **Every build log line is scrubbed** before it is broadcast or stored, because the platform
  echoes build output and a `RUN echo $DATABASE_URL` would otherwise reach the log pane, the
  database and every browser at once.
- **`.dockerignore` excludes `.env`**, so no artifact contains a credential. Secrets arrive only
  as host environment variables at run time.
- **`deployments.env_keys` holds names.** There is no column a value would fit in.
- **The bearer token is mandatory** and the check is constant time. It is shown once, and is not
  persisted in the deployments row, in the deployment logs, or in `localStorage`.
- **A deployed agent binds `0.0.0.0` deliberately**, because a service nothing can reach is not a
  service, which is exactly why its bearer token is not optional.
- **High-impact MCP tools are refused in a container**, set both in the Dockerfile and on the
  host.
- **`testRailwayToken` proves a token works and writes nothing**, the same two-command split as
  `testProviderKey`.
- **Slow loris protection** bounds how long one client may hold a connection, added after thread
  exhaustion under a partially transmitted request line was reproduced.
- HTTP request desynchronisation was found and fixed: rejecting a request without consuming its
  body left unread data in the socket, corrupting the next request and even preventing a
  `413 Payload Too Large` from reaching clients over persistent connections.

## Performance Considerations

- `ThreadingHTTPServer` with bounded concurrency (`JAROKU_SERVE_CONCURRENCY`, default 4) and a
  `429` beyond it. LangGraph invocation is blocking, so threads are the right shape.
- `JAROKU_SERVE_TIMEOUT_S` (default 30) bounds how long one client may hold a connection.
- The image installs only what the agent uses, so build time and image size scale with the agent's
  actual dependencies.
- Every Railway API call is bounded (`JAROKU_RAILWAY_TIMEOUT_MS`), and the whole upload and build
  is bounded (`JAROKU_DEPLOY_TIMEOUT_MS`).
- Upload exit detection was corrected after uploads could stall for roughly 60 seconds when
  terminating the CLI shell left a child holding stdout open. Correct detection cut it to about
  705 milliseconds.

## Operational Considerations

- The Railway CLI must be installed and the server restarted, because it inherits `PATH` at
  launch. Its absence is checked before any resource exists, so a missing binary costs a message
  rather than an orphaned project.
- "I deployed twice and only see one URL" is deliberate: a redeploy replaces what is running on
  the same service. Use **Forget** first for a genuinely separate deployment, and delete the old
  service in the hosting account, because forgetting a record does not stop the thing it
  described.
- A deploy marked `interrupted` means the Jaroku server restarted while it was in flight. Whatever
  had already been created still exists in the user's account; check there before deploying again.
- A deployed agent returning 401 needs `Authorization: Bearer <token>`. The token is shown once
  and Jaroku keeps no copy; rotate by setting `JAROKU_SERVE_TOKEN` in the hosting account or
  deploying again.
- A deployed agent returning 500 on every request is usually a credential the container does not
  have.
- Deployed agents do not stream traces back. Observability in production is the hosting platform's
  log pane for now.

## Rejected Alternatives

**Hosting deployed agents on Jaroku infrastructure** was rejected because it would put Jaroku in
custody of every user's provider keys, connector credentials and MCP tokens, make it responsible
for their model spend and the availability of endpoints they depend on, and require running a
sandboxed multi-tenant execution platform for model-written Python. That last item is a larger
undertaking than the rest of the product combined, and the security limitation the project states
plainly (model-written Python executes on the control plane) would become a limitation affecting
strangers rather than the operator.

**Emitting artifacts and letting the user deploy them** was rejected because it stops well short
of the promise. "Here is a Dockerfile" is not "here is a URL you can curl", and it leaves the user
carrying every operational step including secret handling, which is precisely where the careful
work is. It would also mean no deploy record, no build log and no status, so nothing about a
deployment would be visible in the product that built it.

## Related Decisions

- ADR-005: The generated agent contract, which the deployment path deliberately did not change
- ADR-007: Staging directories with atomic swap, used for the deployment artifacts
- ADR-009: The fix loop, and why the four artifacts are read-only to it
- ADR-014: Reviewed connector templates copied byte for byte, the pattern `serve.py` follows
- ADR-015: MCP servers treated as untrusted code, and why containers fail closed
- ADR-026: Credential handling: names travel, values do not

## References

- `runtime/tool_templates/serve.py`
- `server/src/deployManager.ts`, `railwayApi.ts`, `railwayCli.ts`, `dockerfile.ts`,
  `deployArtifacts.ts`, `deployStore.ts`, `deploySecrets.ts`
- `npm run test:deploy-artifacts`, `test:deploy-secrets`, `test:deploy-store`
- `client/src/components/DeployPanel.tsx`, `client/src/store/deployStore.ts`
- README section "Deploying an agent"
- CHANGELOG v0.2.3 "Introducing Agent Deployments" and v0.2.4 "Testing and Reliability
  Improvements"
