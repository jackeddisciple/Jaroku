# Backup and restore

An untested backup is not a backup. This runbook is written from a restore drill that was
actually performed — including the two things it got wrong the first time, which are the parts
worth reading.

## What is backed up, and by what

| | Mechanism | Recovery point | Restored by |
|---|---|---|---|
| **Postgres** | continuous WAL archiving + a daily base backup (**PITR**) | any second within the retention window | the provider's own tooling |
| **Object store** (R2/S3) | **bucket versioning** + a lifecycle rule keeping non-current versions | any prior version of any object | `CopyObject` from a version id |
| **Checkpoints** | inside Postgres, in the `langgraph` schema | as Postgres | as Postgres |
| **Redis** | *nothing* | — | — |
| **Sandboxes** | *nothing* | — | — |

**Redis and the sandboxes are deliberately not backed up.** Redis holds queues, rate-limit
buckets and pub/sub; every one of those is derived, recoverable or worthless a minute later —
`eval_jobs` in Postgres is the source of truth and the queue is a dispatch mechanism over it
(Session 5). A sandbox is a per-run micro-VM whose whole state is the trace it emitted, which is
already in Postgres.

### Object versioning is what makes an agent's history restorable

Agent files are immutable objects addressed by version (`ws/<id>/agents/<id>/v<n>/…`), so a
deleted or overwritten object is recoverable from the bucket's own version history without
touching the database. Keep non-current versions for **at least as long as the longest plan's
retention** — otherwise a workspace can restore a trace that points at files the bucket already
expired.

## The drill

```bash
cd server
npm run drill:restore                      # seeds a scratch source and restores it
npm run drill:restore -- --db ./jaroku.db  # against a real database, read-only
```

It builds a target database **by running the migrations from this checkout**, copies every row
through the `Db` interface, and then verifies:

- row counts, table by table;
- that `schema_migrations` is populated and **not older than the source's** — restoring into an
  out-of-date checkout is how a restore quietly loses a column;
- that the tenancy still holds (see below — the check differs per driver);
- that one known run reads back with its steps in `seq` order.

It exits non-zero on any problem, so it can be a scheduled job rather than a memory.

## What the drill actually found

Both of these were failures in the first run, and both are the kind of thing a runbook written
from imagination gets wrong.

**1. `schema_migrations` is not data.** The first run copied it and produced a unique violation
per migration. The target had already written its own ledger by running the migrations — and
copying the source's would have been worse than failing: a restored database's applied set is
what the RESTORED schema has, not what the source happened to have when it was backed up. The
drill now skips the table, and asserts instead that the restored ledger is not *behind* the
source's.

**2. Some rows are created by the migrations themselves.** `plans` and the fixed `Local`
workspace that migration 004 backfills pre-tenancy rows into already exist in a freshly migrated
target, so a plain `INSERT` fails on them. A restore that stops at the first such row restores
nothing. The copy is now `ON CONFLICT DO NOTHING`, and the rows that were already present are
counted and reported rather than silently swallowed — in the runs below, four of them.

**3. The isolation probe was testing Postgres's mechanism on SQLite.** It asserted that a scoped
read returns none of another workspace's rows, and on SQLite it failed — correctly.
`forWorkspace` on that driver is the connection itself: there is no RLS to scope, the repository
layer is the whole of the enforcement, and a raw `SELECT` returns what it asks for. The probe is
now per driver: RLS refusal on Postgres, and on SQLite that every restored run names a workspace
that came back with it.

## Two runs, performed

Against a seeded scratch database (3 workspaces, 1 run, 3 steps), on a laptop, SQLite:

```
restore drill 2026-08-12T16:31:10.732Z
  schema 202ms · copy 150ms · verify 4ms
  ok   workspaces: 3 -> 3
  ok   runs: 1 -> 1
  ok   steps: 3 -> 3
  note 4 row(s) were already present from the migrations themselves (plans, the Local workspace)
  note the restored database records 29 applied migration(s)
  note every restored run names a workspace that came back with it
  note one restored run read back with 3 step(s), in seq order
  RESTORE VERIFIED
```

Against the repository's own `server/jaroku.db`:

```
restore drill 2026-08-12T16:31:52.800Z
  schema 163ms · copy 4ms · verify 3ms
  ok   workspaces: 1 -> 1
  note no runs in the source — the trace probe was not meaningful
  RESTORE VERIFIED
```

**The second run is the more instructive one**, and not because it passed: the source was
essentially empty, so most of the verification was vacuous, and the report says so rather than
reporting success. A drill against an empty database proves the mechanism and nothing about the
data — which is why the scheduled drill in production runs against **a restored copy of the
production snapshot**, not against a scratch database.

### What these timings do and do not tell you

The schema build (~200ms) is the whole migration set on SQLite and is a floor, not an estimate:
on Postgres it is dominated by index creation on `steps`, which is proportional to the data
already in the restored snapshot. **The copy phase timing here is meaningless for production** —
150ms for six rows says nothing about tens of millions. For a real capacity figure, run the drill
against a restored production snapshot and record the number in this file; the point of the phase
timings being separate is that the schema build and the data copy scale for different reasons.

## Restoring for real: Postgres PITR

1. **Stop writes.** Scale the workers to zero; leave one gateway up so the product answers 503
   rather than nothing.
2. **Restore to a new instance**, never over the live one, at the chosen timestamp. A restore in
   place removes the only copy of the state that is wrong, which is the state somebody will want
   to look at afterwards.
3. **Point `JAROKU_PG_URL` at the restored instance** and deploy. The gateway's release command
   runs `migrate:check` and `migrate` before taking traffic; a restored instance from an older
   snapshot will have migrations to apply, and that is the correct moment for them.
4. **Run the drill against it** before letting traffic in:
   `npm run drill:restore -- --db …` (or the Postgres equivalent with `JAROKU_PG_URL`).
5. **Reconcile the object store to the same timestamp** if objects were also lost. Agent versions
   are immutable and additive, so a database restored to an earlier point references a *subset*
   of what the bucket holds — which is safe. The reverse is not: an object store rolled back
   below the database's `agents.current_version` leaves agents whose current version has no files.
6. **Expect the queue to be empty.** Redis is not restored. Interactive runs are gone and their
   rows are reconciled at boot (`reconcileInterruptedRuns`); eval jobs are still in `eval_jobs`
   and are re-dispatched, because the queue was always a dispatch mechanism over that table.
7. **Write down what happened here**, including anything this file did not predict. That is what
   the two findings above are, and they are the reason this section is worth trusting.

## Schedule

| | When | Where |
|---|---|---|
| Base backup | daily | provider |
| WAL archiving | continuous | provider |
| **Restore drill** | **weekly**, and after any migration that rewrites a table | CI, against a restored snapshot |

A drill that is not scheduled does not happen. The exit code is what makes it schedulable.
