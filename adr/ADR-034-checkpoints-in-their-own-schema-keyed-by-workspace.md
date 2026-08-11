# ADR-034: Keep LangGraph's Checkpoints in Their Own Schema, Isolated by the Thread Id

## Status

Accepted. Introduced in Session 3, migration `017_langgraph_schema`.

## Context

Every run is driven through a checkpointed twin so it can be paused, resumed and branched.
`debug.py` wrote those checkpoints with `SqliteSaver` into `runtime/.checkpoints/<run_id>.sqlite`,
and branching copied that file.

A file on one machine cannot be resumed by a worker on another, which is the whole of Session 3.
The obvious replacement is LangGraph's `PostgresSaver`, and it brings three problems that are not
about checkpoints at all.

First, **LangGraph never issues `SET LOCAL app.workspace_id`.** Every RLS policy in this schema
reads that setting, and a policy that is not satisfied does not admit the row — so a policy on
LangGraph's tables would match nothing and fail every checkpoint write.

Second, **LangGraph runs its own migrations.** `PostgresSaver.setup()` creates and upgrades its
tables on its own timetable. This repository's runner is forward-only and checksummed and refuses
a file that changed. Two runners in one schema means every LangGraph upgrade is a table Jaroku's
migrations did not create, in a namespace they are supposed to describe.

Third, **the tables are shared.** One `checkpoints` table holds every tenant's threads.

## Decision

**`JAROKU_CHECKPOINTER` selects `sqlite` (default) or `postgres`.** The local path is unchanged.

**The Postgres saver gets its own connection**, from `JAROKU_CHECKPOINT_PG_URL` and deliberately
not `JAROKU_PG_URL`, **and its own schema**, `langgraph`, set on the connection's search path.
Migration `017` creates the schema and the grant and describes nothing inside it.

**The workspace goes in the thread id**: `ws:<workspace_id>:run:<run_id>` on Postgres, and the
bare run id on SQLite, where one file per run is already a namespace. A project with no workspace
— a copied-out one — gets the bare form either way.

**Branching becomes an `INSERT … SELECT`** of the parent's checkpoints up to the fork point into a
new thread, with the columns read from `information_schema` rather than declared.

**The sweep becomes a delete by thread**, with the run ids still coming from the eval's own job
rows.

## Alternatives considered

**Put LangGraph's tables in `public` beside Jaroku's.** One schema, one connection, one migration
story. Rejected on the migration collision: two forward-only runners cannot share a namespace
without one of them being wrong about what is in it.

**Add a `workspace_id` column to LangGraph's tables and a policy on it.** Rejected twice over:
they are not our tables to alter, an upgrade would drop the change, and the policy could not be
satisfied because the saver does not set the GUC. Naming the thread costs nothing and cannot be
undone by somebody else's migration.

**Prefix the thread on SQLite too, for consistency.** Rejected: it buys nothing where there is a
file per run, and it breaks branching from any run checkpointed before this session, which is a
real cost for a cosmetic gain. The difference is a consequence of the two stores.

**Keep copying the whole thread when branching, rather than bounding it.** Simpler, and matches
what the file copy did. Rejected: a file copy was bounded in practice because a per-run file only
held that run's checkpoints, and copying an unbounded thread into a fork would carry checkpoints
from *after* the fork point into a branch that is supposed to diverge before them.

**Declare LangGraph's columns in the copy.** Rejected: they have changed before —
`checkpoint_writes` grew a `task_path` — and a hard-coded list would silently stop copying a
column the day one is added, producing a branch whose state is subtly incomplete rather than an
error.

## Consequences

**This is a weaker wall than every other table has, and it is stated plainly.** There is no RLS in
the `langgraph` schema; the isolation is the key and the code that builds one. `test:branch`
asserts that a fork, a sweep and a listing each refuse to reach past the prefix, and the tenancy
suite asserts that one run id in two workspaces is two threads.

The thread name is computed in two languages, so `test:checkpoint-threads` runs both and compares.
A disagreement would surface exactly once, on a branch, as a fork finding no checkpoint at an id
the server just read out of its own database.

`langgraph-checkpoint-postgres` is an optional extra (`uv sync --extra hosted`), so the base
install and the dry-run path stay free of it — the same discipline the connector SDKs follow.
