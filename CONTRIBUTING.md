# Contributing

Two rules that are enforced by tests rather than by review, because both fail silently and
both are the kind of thing a reviewer reads past.

## A new table needs a workspace, a policy and a test

Jaroku is multi-tenant. Every row belongs to a workspace, and **a new table without a
`workspace_id`, an RLS policy and a tenancy test will be rejected.** See
[the tenancy model](README.md#the-tenancy-model) for what each of those means and why.

In order:

1. Write the migration in **both** `server/migrations/postgres/` and
   `server/migrations/sqlite/`, under the same number. A dialect with nothing to do gets a
   comment-only file, so the two sequences can never drift apart silently.
2. Add `workspace_id`, backfill existing rows, constrain it, and index with `workspace_id`
   **leading** — a trailing tenant column makes the planner scan an index built for a
   different question, which is invisible at one workspace and is the whole cost of the
   query at six thousand.
3. Add the table to the policy loop in a new RLS migration.
4. Give it a repository whose every method takes a `TenantContext` (or, if it genuinely
   precedes a workspace, a `SystemContext`) as its **first** argument.
5. Add its methods to `SCOPED_API` in `server/src/tenancy.test.ts` and exercise them.
   `npm run test:tenancy` fails until you do — that assertion is what makes this list
   mechanical rather than aspirational.

Migrations are **forward-only and checksummed**. There is no `down`: every later migration
was written against the database an earlier one produced, so editing one that has run
describes a database nobody has. `npm run test:migrate` refuses it by name.

## Never write a driver import outside `server/src/db/`

`node:sqlite` and `pg` are reachable from exactly one directory. A module that can open its
own connection is a connection nobody scopes. `npm run test:db-boundary` enforces it.

## The invariants the README documents are load-bearing

Several of them are non-obvious and a "cleanup" that removes one is a regression. Before
touching a module, read it — the comments say *why*, and the why is usually a specific bug.
The shortest list, with the tests that defend them:

| Invariant | Defended by |
|---|---|
| stdout carries trace events and nothing else | the stdout guard, `runtime/jaroku_runner/guard.py` |
| Unknown ≠ zero: unpriced cost is `null`, an unscored judge is not a 0 | `test:pricing`, `test:aggregate`, `test:export` |
| Cost is summed from `steps`, never `runs.cost` | `test:aggregate` |
| A step replayed from history is the same shape as one streamed live | `test:shape-parity` |
| `readOnlyHint` from an MCP server is ignored; impact is a ratchet | `test:mcp-impact` |
| A failed MCP refresh never destroys a working tool list | `test:mcp-registry` |
| A high-impact MCP call stops for confirmation; timing out denies | `test:mcp-isolation` |
| No secret is written anywhere that outlives a run, or returned to a browser | `test:env-writer`, `test:deploy-secrets`, `test:secrets`, `test:vault` |
| Two implementations of every abstraction, and neither can be told apart | `test:driver`, `test:objects`, `test:secrets`, `test:vault` |
| An agent's files are immutable per version; undo is a pointer move | `test:project-store`, `test:edit-versions` |
| No user string becomes a path on a shared host | `test:object-keys` |
| `workspace_id` never appears in an emitted event | `test:trace` |
| `alg: "none"` and symmetric algorithms can never verify a token | `test:jwt` |
| A ws-ticket works exactly once, even when two sockets race for it | `test:tickets` |
| A socket cannot outlive the membership that authorised it | `test:relay`, `test:tenancy` |
| No client store retains a row across a workspace switch | `test:reset` |
| One workspace's backlog never delays another's work | `test:dispatcher`, `loadtest:queue` |
| A job survives the worker that was running it | `test:chaos`, `test:worker-loop` |
| Eval runs stay off the live trace channel, across replicas too | `test:eval-off-trace` |
| A redelivered trace batch cannot bill twice | `test:metering` |
| Concurrent runs cannot overdraw one balance | `test:balances` |
| A ceiling bounds what is STARTED, never what is spent | `test:gate`, `test:eval-budget` |
| A workspace's provider key reaches its own run's provider and nothing else | `test:byok` |
| An unsigned or replayed payment webhook changes nothing | `test:stripe` |
| A run receives an hour-long access token, never the refresh token behind it | `test:oauth-injection` |
| Concurrent runs refresh one connection exactly once | `test:oauth-refresh` |
| A rejected grant is terminal, and is never retried into a lockout | `test:oauth-refresh` |
| Disconnecting revokes at the provider, not only locally | `test:oauth-revoke` |
| An OAuth state works exactly once, even when two callbacks race | `test:oauth-state` |
| A user-supplied MCP URL cannot reach private space, at discovery or at call time | `test:mcp-url` |
| Two workspaces on one MCP endpoint hold two different credentials | `test:mcp-tenancy`, `test:tenancy` |

## Commits

Every commit leaves `npm run typecheck` green on both `server/` and `client/`, and leaves the
existing suites passing. A commit that breaks a test is not a working commit.

## A new command needs a capability and a channel

Roles are data in one module, checked in one place — see
[roles](README.md#roles-as-data). A WebSocket command added without an entry in
`COMMAND_CAPABILITY` is **refused**, not allowed, and `npm run test:capabilities` fails the
build rather than letting it arrive ungated. It reads `wsRelay.ts` directly, so the list cannot
pass by being out of date.

Two entries, both in the same commit as the command:

1. `COMMAND_CAPABILITY` in `server/src/auth/capabilities.ts` — which capability it needs. Deciding
   that means looking at every other capability at once, which is the point of the table.
2. `COMMAND_CHANNEL` in `server/src/wsRelay.ts` — where its **refusal** goes. A refusal on the
   wrong channel is indistinguishable from no answer: the panel that asked waits forever while an
   unrelated one shows an error about something it never did. `log` is a legitimate answer for a
   command whose own channel carries data rather than errors — but it has to be written down, so
   "log because that is right" and "log because nobody decided" cannot look the same.

## A new thing that costs money needs a kind, a payer and a key

Money is metered in one place — `server/src/billing/usage.ts` — and a row that reaches
`usage_events` without all three of those is a row nobody can defend against an invoice.

1. **A `kind`**, from the closed list. Deciding which one means looking at every other kind at
   once, which is the point of the list being closed.
2. **A `payer`.** `kind` says what was bought; this says whose money bought it, and under BYOK
   those are different questions about the same row. It cannot be recovered later — whether a
   run used its workspace's key depends on what was configured at the time — so it is recorded
   where the call is set up, not inferred where the row is read.
3. **An idempotency key that does not vary between two deliveries of the same event.** No
   timestamp, no fresh uuid at the call site, unless the thing genuinely is not redeliverable —
   and if it is not, say so in a comment, because a random key looks like a mistake.

And the rule that outranks all three: **an unpriced call is metered with a null cost, never
dropped and never zero.** Dropping it makes an unpriced model look like a model nobody used;
zeroing it makes a paid call look free. Both turn a workspace's total into a confident undercount
instead of a flagged one. `npm run test:metering` asserts each.

## A new connector needs an auth mode, and a credential needs a lifetime

Two rules, and the second is the one that is easy to get wrong in the safe-looking direction.

**Every connector in `catalog.json` declares `auth`**: `oauth`, `user_secret` or `none`.
`check_catalog()` refuses a connector without one, because a missing mode reads as
`user_secret` everywhere — which for an OAuth connector means `.env.example` telling somebody to
obtain by hand the credential the Connect button exists to obtain for them.

**A credential that reaches a sandbox is the SHORT-LIVED half.** What executes there is
model-written Python responding to a stranger's prompt. An access token is an hour; a refresh
token is a permanent grant to somebody's account, and it stays on the control plane. If a
connector template cannot use a short-lived credential, the template changes — see `gmail.py`,
which gained one additive branch rather than being handed a refresh token.

And a corollary that has its own test: **no credential rides on a queue payload.** A token on a
job is a token in Redis, which is neither encrypted at rest nor scoped to a tenant. The job
names what it needs; the handler reads the value from the vault at the moment it makes the call.

## A new plan limit goes in `plans.ts`, not in the `plans` table

Concurrency, credits, ceilings, retention and seat counts are data in
`server/src/billing/plans.ts`, for the same reason roles and job classes are data in theirs. The
table holds only what varies per deployment — a price id, and whether a plan can be bought today
— and `npm run test:plans` fails at boot when the two disagree in either direction. A plan row
nothing defines resolves to the FREE limits, so the failure it prevents is a workspace that paid
for Scale quietly getting a free workspace's ceiling.

Plans nest by spreading (`PRO` starts from `FREE`), and the suite asserts a paid plan is never
worse than a free one on any axis. Add a limit to the base and every plan has it; add three
independent objects and the day somebody updates one of them is the day that stops being true.

## A new job class needs a config entry, not a hardcoded number

Concurrency limits and timeouts are data in one module — `JOB_CLASSES` and `jobClassConfig` in
`server/src/queue/jobs.ts` — for the same reason roles are: two copies of the same number drift,
and the one that drifts is always in the file nobody reopened. `npm run test:jobs` asserts every
class has a complete config, so a class added without one fails rather than silently defaulting.

Adding a class means deciding, while looking at every other class at once: how many one workspace
may run at a time, how long one attempt may take, whether a failure is worth retrying at all, and
whether it genuinely belongs on the queue. That last one is a real question — see
[what Session 5 does not do](README.md#what-this-session-does-not-do); a short request a client is
actively waiting on is not automatically better off dispatched asynchronously.

## A new client store must reset on a workspace switch

A perfectly-scoped server still leaks if the browser keeps the rows. Every store that holds
workspace data is emptied when the workspace changes, *before* the new socket opens — see
`client/src/store/reset.ts`.

`npm run test:reset` reads the store **directory** and fails when a store is neither reset nor
named in the short list of deliberate exclusions. Add a store, add it to `WORKSPACE_STORES`. If
it genuinely holds nothing a workspace owns, say so in `NOT_WORKSPACE_SCOPED` and expect to
justify it — the list is two entries long and the test asserts its exact contents.
