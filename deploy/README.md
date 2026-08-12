# Deploying Jaroku

Four tiers, three of which are in this directory. The fourth — the run sandbox — is not deployed
at all: it is a machine created per run and destroyed with it, from a digest-pinned image (see
`server/src/sandbox/image.ts`).

```
edge (WAF, CDN, TLS)     deploy/edge/          — rules as code, rendered from a table
gateway (N replicas)     deploy/fly/gateway.fly.toml
worker  (N replicas)     deploy/fly/worker.fly.toml
run sandbox (per run)    created by the worker; never deployed
```

| | Gateway | Worker |
|---|---|---|
| Serves | HTTP + WebSockets | nothing; it pulls |
| Scales on | connections | queue depth per class — **never CPU** |
| Strategy | `rolling` | `immediate` |
| Runs migrations | **yes**, in the release command | no |
| Minimum machines | 2 (it holds sockets; zero closes every one) | 0 is acceptable |

## The order, and why it is the order

1. **CI passes.** A deploy that runs its own tests is a deploy somebody skips when in a hurry.
2. **`npm run migrate:check`** — the expand/migrate/contract gate. See below.
3. **Build and pin a digest.** A tag is a mutable pointer; two machines resolving one tag during a
   rolling deploy can end up running different code.
4. **Migrate, to completion, before any new machine takes traffic.** This is Fly's
   `release_command`. A non-zero exit stops the deploy with the old version still serving.
5. **Roll the gateway**, one machine at a time. Replace the workers all at once — they serve no
   connections, and `SIGTERM` already stops admission, drains what is in flight, and requeues the
   rest.

**A rollback is a deploy of the previous digest.** There is no rollback step in the pipeline
because there does not need to be one — provided the rule below was followed.

## Expand, migrate, contract

Migrations run **before** the new version takes traffic, which means that for the length of every
rolling deploy the **old code is running against the new schema**. If a migration removed
something the old code uses, the old replicas start failing *during the deploy* — in a way that
looks like the new version broke and is "fixed" by rolling back to code that no longer matches
the database.

So a schema change is three deploys, never one:

| | What ships | Old code sees |
|---|---|---|
| **Expand** | the new column/table/index, nullable or defaulted | something it ignores |
| **Migrate** | code that writes both and reads the new; backfill | both work |
| **Contract** | the old thing is removed | nothing still reads it |

`npm run migrate:check` enforces this. It reads every migration above `server/migrations/gate-baseline`,
classifies each statement, and fails the build on anything that would break a running version —
`DROP COLUMN`, a rename, `SET NOT NULL`, `ADD COLUMN … NOT NULL` with no default — or that would
hold a long lock on a large table, such as a non-`CONCURRENTLY` index on `steps`.

When a deploy genuinely **is** the contract step, say so in the migration itself:

```sql
-- jaroku:contract-step: nothing has read runs.legacy since v0.2.9
ALTER TABLE runs DROP COLUMN legacy;
```

A comment rather than a command-line flag, deliberately: a flag is invisible in review and gets
copied between deploys, while a comment sits beside the statement it excuses and appears in the
diff somebody reads. Overridden statements are still **printed** in the deploy log — the claim
should be visible when it turns out to have been wrong.

The gate applies to **Postgres only**. Expand/contract exists because a rolling deploy leaves an
old version serving; SQLite is one local process holding one file, and its table-rebuild idiom
(create, copy, drop, rename) is the only way that driver alters a table at all. The two dialect
directories are still checked against each other, version for version.

## Configuration

Both tiers set `NODE_ENV=production`, which is load-bearing rather than cosmetic — several
modules refuse to start without their hosted configuration under it:

| Refuses to start in production unless… | Where |
|---|---|
| `JAROKU_ALLOWED_ORIGINS` is set | `auth/origin.ts` — WebSockets are not covered by CORS |
| the object store is not `fs` | `storage/open.ts` |
| the sandbox is not `local` | `sandbox/runSandbox.ts` — it would run model-written Python on the control plane |
| `JAROKU_DEV_AUTH` is unset | `auth/config.ts` |
| `JAROKU_METRICS_TOKEN` is set | `/metrics` answers 403 without one |

`JAROKU_PUBLIC_TLS=1` turns on HSTS, and `JAROKU_TRUST_PROXY=1` makes `X-Forwarded-For`
authoritative for the per-IP rate limit. Both are explicit because both are wrong to assume: the
first sends a two-year promise a browser will honour for a hostname, and the second makes a
client-supplied header decide which bucket a request counts against.

## Backups

See `deploy/backup/`.
