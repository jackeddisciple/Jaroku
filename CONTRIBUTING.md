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
| No secret is written anywhere that outlives a run, or returned to a browser | `test:env-writer`, `test:deploy-secrets` |
| `workspace_id` never appears in an emitted event | `test:trace` |

## Commits

Every commit leaves `npm run typecheck` green on both `server/` and `client/`, and leaves the
existing suites passing. A commit that breaks a test is not a working commit.
