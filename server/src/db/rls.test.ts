// Row-level security, exercised rather than assumed.
//
// RLS is the backstop: the repository layer is what actually scopes queries, and this is what
// catches the day somebody writes one that does not. A backstop nobody has tried is a
// comment, and the ways it silently does nothing are specific and well known:
//
//   * ENABLE without FORCE exempts the table's OWNER, and on a modest deployment the owner is
//     whoever ran the migrations — which is often the app. The policy then never applies once.
//   * SET without LOCAL outlives the transaction and leaks to whoever gets that pooled
//     connection next.
//   * USING without WITH CHECK lets a caller INSERT into another workspace and merely not be
//     able to read it back, which is a write across the boundary and still a hole.
//
// So each of those is a case here.
//
//   JAROKU_PG_URL=postgres://… npm run test:rls

import { randomUUID } from "node:crypto";
import { PostgresDb } from "./postgres.ts";
import { PG_URL_ENV } from "./open.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const url = process.env[PG_URL_ENV];
if (!url) {
  console.log(`SKIPPED: no ${PG_URL_ENV}. RLS exists only on Postgres.`);
  process.exit(0);
}

const db = new PostgresDb({ url });
try {
  await db.ping();
} catch (err) {
  console.log(`SKIPPED: ${PG_URL_ENV} is set but unreachable — ${(err as Error).message}`);
  await db.close();
  process.exit(0);
}

const A = randomUUID();
const B = randomUUID();
const runA = randomUUID();
const runB = randomUUID();
const slug = (id: string): string => `rls-${id.slice(0, 8)}`;

/**
 * Run as the application role, with a workspace scope — or without one.
 *
 * SET LOCAL ROLE rather than a separate connection, so the test needs no second credential.
 * It is transaction-scoped like everything else here, so the connection goes back to the pool
 * as itself.
 */
async function asApp<T>(workspaceId: string | null, fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (workspaceId) await tx.run("SELECT set_config('app.workspace_id', ?, true)", [workspaceId]);
    await tx.exec("SET LOCAL ROLE jaroku_app");
    return fn(tx);
  });
}

const run = (id: string): unknown[] => [
  id, "rls_agent", "fake", "fake-scripted", "completed", new Date().toISOString(), 0, 0,
];

try {
  // Workspaces themselves carry no policy — they are the thing policies point at.
  for (const [id, name] of [[A, "rls-a"], [B, "rls-b"]] as const) {
    await db.run(
      `INSERT INTO workspaces (id, slug, name, kind, plan, created_at)
       VALUES (?, ?, ?, 'team', 'free', now()) ON CONFLICT (id) DO NOTHING`,
      [id, slug(id), name],
    );
  }

  // Seeded through `scoped`, which is the only way the owner can write to these tables now —
  // FORCE means the migrator does not get to skip its own policies either.
  await db.scoped(A, async (tx) => {
    await tx.run(
      `INSERT INTO runs (id, workspace_id, agent_id, provider, model, status, started_at, cost, tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [runA, A, ...run(runA).slice(1)],
    );
  });
  await db.scoped(B, async (tx) => {
    await tx.run(
      `INSERT INTO runs (id, workspace_id, agent_id, provider, model, status, started_at, cost, tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [runB, B, ...run(runB).slice(1)],
    );
  });

  console.log("\nvisibility");

  const seenByA = await asApp(A, (tx) => tx.all<{ id: string }>(`SELECT id FROM runs`));
  check(
    seenByA.some((r) => r.id === runA) && !seenByA.some((r) => r.id === runB),
    `a scoped query sees its own workspace and not the other (${seenByA.length} row(s))`,
  );

  // The one that matters most. A query with no scope established must see NOTHING, not
  // everything: current_setting(..., true) is NULL when unset, NULL = anything is NULL, and a
  // policy that is not true does not admit the row.
  const seenUnscoped = await asApp(null, (tx) => tx.all<{ id: string }>(`SELECT id FROM runs`));
  check(seenUnscoped.length === 0, `an UNSCOPED query sees nothing, not everything (${seenUnscoped.length} row(s))`);

  const targeted = await asApp(A, (tx) => tx.all(`SELECT id FROM runs WHERE id = ?`, [runB]));
  check(targeted.length === 0, "naming another workspace's run by id still returns nothing");

  console.log("\nwrites");

  // USING alone would let this succeed and merely be invisible afterwards. WITH CHECK is what
  // makes it fail.
  let insertRefused = false;
  try {
    await asApp(A, (tx) =>
      tx.run(
        `INSERT INTO runs (id, workspace_id, agent_id, provider, model, status, started_at, cost, tokens)
         VALUES (?, ?, 'x', 'fake', 'm', 'completed', ?, 0, 0)`,
        [randomUUID(), B, new Date().toISOString()],
      ),
    );
  } catch {
    insertRefused = true;
  }
  check(insertRefused, "inserting INTO another workspace is refused, not merely hidden");

  const updated = await asApp(A, (tx) =>
    tx.run(`UPDATE runs SET status = 'error' WHERE id = ?`, [runB]),
  );
  check(updated.changes === 0, "updating another workspace's run changes nothing");

  const deleted = await asApp(A, (tx) => tx.run(`DELETE FROM runs WHERE id = ?`, [runB]));
  check(deleted.changes === 0, "deleting another workspace's run deletes nothing");

  const survived = await asApp(B, (tx) => tx.get(`SELECT status FROM runs WHERE id = ?`, [runB]));
  check((survived as { status?: string } | undefined)?.status === "completed", "...and it is still there, unchanged");

  console.log("\nthe policy is FORCEd, not merely enabled");

  // A superuser bypasses RLS unconditionally — no policy, forced or otherwise, applies to
  // one. That is a property of Postgres, not a bug here, and it is why the app must not
  // connect as one. Local development databases usually do (initdb makes the bootstrap user
  // a superuser), so the owner check is conditional and the SUBSTANTIVE assertion — that the
  // role the app is meant to use has neither privilege — always runs.
  const me = await db.get<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  if (me?.rolsuper) {
    console.log(
      `  note this connection is a superuser (${me.rolname}), which bypasses RLS by\n` +
        `       definition. A deployment must NOT connect as one — see the app role below.`,
    );
  } else {
    const asOwner = await db.all<{ id: string }>(`SELECT id FROM runs WHERE id IN (?, ?)`, [runA, runB]);
    check(asOwner.length === 0, `the table owner is subject to its own policies too (${asOwner.length} row(s))`);
  }

  const appRole = await db.get<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'jaroku_app'`,
  );
  check(appRole !== undefined, "the application role exists");
  check(
    appRole?.rolsuper === false && appRole?.rolbypassrls === false,
    "...and has neither SUPERUSER nor BYPASSRLS, so the policies actually bind it",
  );

  console.log("\nevery tenant table carries one");

  const TENANT_TABLES = [
    "runs", "steps", "datasets", "dataset_examples", "rubrics", "eval_runs", "eval_jobs",
    "eval_scores", "mcp_servers", "mcp_tools", "deployments", "deployment_logs", "agents",
    "agent_versions",
  ];
  const guarded = await db.all<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname = ANY(?) AND relkind = 'r'`,
    [TENANT_TABLES],
  );
  const missing = TENANT_TABLES.filter(
    (t) => !guarded.some((g) => g.relname === t && g.relrowsecurity && g.relforcerowsecurity),
  );
  check(missing.length === 0, `enabled AND forced everywhere (missing: ${missing.join(", ") || "none"})`);

  const policies = await db.all<{ tablename: string }>(
    `SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation'`,
  );
  const unpolicied = TENANT_TABLES.filter((t) => !policies.some((p) => p.tablename === t));
  check(unpolicied.length === 0, `and a tenant_isolation policy on each (missing: ${unpolicied.join(", ") || "none"})`);

  // And the two that must NOT have one, because a policy on either would break the thing that
  // makes every other policy work. See the migration.
  const exempt = ["audit_log", "workspace_members"];
  const wrongly = exempt.filter((t) => policies.some((p) => p.tablename === t));
  check(
    wrongly.length === 0,
    `audit_log and workspace_members stay policy-free (${wrongly.join(", ") || "correct"})`,
  );
} finally {
  // Owner + scope, because the owner is not exempt.
  for (const [ws, id] of [[A, runA], [B, runB]] as const) {
    await db.scoped(ws, async (tx) => {
      await tx.run(`DELETE FROM steps WHERE run_id = ?`, [id]);
      await tx.run(`DELETE FROM runs WHERE id = ?`, [id]);
    });
  }
  await db.run(`DELETE FROM workspaces WHERE id IN (?, ?)`, [A, B]);
  await db.close();
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
