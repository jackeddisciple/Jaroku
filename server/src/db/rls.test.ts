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
    // Session 2. It keeps its policy even though the person redeeming an invite is not yet a
    // member — the token carries the workspace id, so the lookup is scoped and the secret is
    // what proves it. See migration 012 for why that was worth the trouble when `ws_tickets`
    // could not do it.
    "workspace_invites",
    // Session 3. The vault holds ciphertext, so a policy here is the second wall behind a
    // third one: the rows are scoped, RLS backstops the scope, and the ciphertext itself is
    // sealed against `<workspace_id>:<name>` so a row that escaped both decrypts to nothing.
    // The policy is still not optional — a leaked WRAPPED DATA KEY plus a leaked master key is
    // the whole workspace, and "we also encrypted it" is not a reason to skip the scope.
    "workspace_data_keys", "workspace_secrets", "secret_refs",
    // Session 12's per-agent access. The strongest case for a policy of any table on this list,
    // and the one where a missing one would be hardest to notice: every other table here leaks a
    // FACT across the boundary, and this one would leak an ANSWER — a row saying who may deploy
    // an agent, read by a workspace that cannot see the agent. It is also the table an attacker
    // would rather write to than read, which is why the policy's WITH CHECK half matters here
    // more than anywhere else in the schema.
    "agent_grants",
  ];
  // `'p'` AS WELL AS `'r'`, because a partitioned table is not an ordinary one.
  //
  // `steps` became `relkind = 'p'` in migration 029 and this filter stopped matching it, so the
  // table with the most tenant data in the system was reported missing from a check it had in
  // fact passed. The failure was loud, which is luck rather than design: the same filter would
  // have said nothing at all if the list had been built from the catalogue instead of by hand.
  const guarded = await db.all<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname = ANY(?) AND relkind IN ('r', 'p')`,
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

  // And the three that must NOT have one, because a policy on any of them would break the
  // thing that makes every other policy work. See migrations 009 and 010.
  //
  // `ws_tickets` is the Session 2 addition, and it is the same argument as workspace_members:
  // a policy reads `app.workspace_id`, and redeeming a ticket is the operation that PRODUCES
  // that value. Scoping the lookup by the answer it is computing would return nothing, every
  // time. Issuing is fully scoped — the repository takes a TenantContext — and the rows hold
  // a digest, an id and a role for thirty seconds.
  // --- and every partition of the one partitioned table ------------------------------------
  //
  // WHAT 029 CLAIMS AND WHAT POSTGRES ACTUALLY DOES. The migration says the policy is "declared
  // on the PARENT and inherited by every partition". That is true of a query that goes THROUGH
  // the parent — `FROM steps` applies the parent's policy to every partition it touches, which
  // is every query this codebase writes. It is not true of a query that names a partition:
  // `FROM steps_2026_08` sees only that table's own RLS settings, and `ALTER TABLE steps ENABLE
  // ROW LEVEL SECURITY` did not set them. Neither does `CREATE TABLE … PARTITION OF`, which is
  // what `lifecycle/partitions.ts` runs every month at RUNTIME, unreviewed, forever.
  //
  // So the invariant is not "every partition has RLS". It is that a partition must not be
  // REACHABLE by the application role without it — and today the thing that holds is the other
  // half: privileges on a partitioned parent do not cascade either, so `jaroku_app` was granted
  // on `steps` and on nothing beneath it. Two defaults happen to line up.
  //
  // Written as the implication rather than as either half, because either half could change
  // alone. A GRANT loop that helpfully includes partitions, or a partition created by hand
  // during an incident, turns a month of every tenant's traces into rows any workspace can read
  // by naming the table. That is the failure mode 029's own header calls out and then guards
  // against with a mechanism that does not reach this far.
  const partitions = await db.all<{
    relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; app_can_read: boolean;
  }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            has_table_privilege('jaroku_app', c.oid, 'SELECT') AS app_can_read
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'steps'`,
  );
  check(partitions.length > 0, `steps has partitions to check (${partitions.length})`);
  const reachable = partitions.filter(
    (p) => p.app_can_read && !(p.relrowsecurity && p.relforcerowsecurity),
  );
  check(
    reachable.length === 0,
    `no partition of steps is readable by the app role without a policy ` +
      `(${reachable.map((p) => p.relname).join(", ") || "none is"})`,
  );

  // --- and the same question asked of the data rather than the catalogue --------------------
  //
  // The check above reads flags. This one reads rows, because the fix in migration 031 rests on
  // a claim about POSTGRES — that a query routed through a declaratively partitioned parent is
  // authorised against the parent, so revoking the app role's privileges on the partitions costs
  // it nothing — and a claim about Postgres that this codebase has bet its trace ingestion on
  // should be exercised rather than cited. Both directions, because either could fail alone: a
  // revoke that also broke the parent would take every read and write of `steps` with it, and
  // CI's own connection is a superuser, so nothing else here would notice.
  const stepA = randomUUID();
  const stepB = randomUUID();
  const seedStep = async (ws: string, runId: string, id: string): Promise<void> => {
    await db.scoped(ws, (tx) =>
      tx.run(
        `INSERT INTO steps (id, workspace_id, run_id, seq, type, name, started_at)
         VALUES (?, ?, ?, 0, 'state_update', 'rls', ?)`,
        [id, ws, runId, new Date().toISOString()],
      ),
    );
  };
  await seedStep(A, runA, stepA);
  await seedStep(B, runB, stepB);

  const stepsSeenByA = await asApp(A, (tx) => tx.all<{ id: string }>(`SELECT id FROM steps`));
  check(
    stepsSeenByA.some((s) => s.id === stepA) && !stepsSeenByA.some((s) => s.id === stepB),
    `the app role still reads its own steps through the parent (${stepsSeenByA.length} row(s))`,
  );

  // Which partition B's step actually landed in — asked of the row rather than computed from
  // the date, so the test cannot disagree with the bounds the migration wrote.
  const home = await db.scoped(B, (tx) =>
    tx.get<{ part: string }>(`SELECT tableoid::regclass::text AS part FROM steps WHERE id = ?`, [stepB]),
  );
  const part = home?.part ?? "";
  check(/^steps_[a-z0-9_]+$/.test(part), `B's step lives in a partition (${part || "none found"})`);
  if (/^steps_[a-z0-9_]+$/.test(part)) {
    // Refused is the expected answer and empty is an acceptable one — the first is the REVOKE,
    // the second would be the policy if the privilege were ever handed back. What must never
    // happen is a row.
    let leaked: string[] = [];
    let refused = false;
    try {
      const rows = await asApp(A, (tx) => tx.all<{ id: string }>(`SELECT id FROM ${part}`));
      leaked = rows.map((r) => r.id);
    } catch {
      refused = true;
    }
    check(
      !leaked.includes(stepB),
      `naming a partition directly does not reach another workspace ` +
        `(${refused ? "refused outright" : `${leaked.length} row(s) visible`})`,
    );
  }

  // --- the platform marker opens exactly one door, and only when asked -----------------------
  //
  // Migration 032 gives two statements a way to cross workspaces on purpose. The danger in any
  // such mechanism is that it becomes the answer to "no scope set", which would turn the one
  // failure this design exists to survive — a forgotten `SET LOCAL` — into a full read of every
  // tenant's rows. So the three cases are asserted together: unscoped sees nothing, scoped sees
  // its own, and only `app.platform` sees across.
  console.log("\nthe platform marker");

  // AS THE APP ROLE, not through `db.asPlatform` itself. That method sets the marker on this
  // connection, which is the owner and — in CI and on most development machines — a superuser
  // with no policies at all, so calling it here would assert that a superuser can read a table.
  // The claim worth checking is about the POLICY, so the marker is set the same way `asPlatform`
  // sets it and then the role is dropped to the one a deployment serves as.
  const asPlatformApp = <T>(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => {
      await tx.run("SELECT set_config('app.platform', ?, true)", ["on"]);
      await tx.exec("SET LOCAL ROLE jaroku_app");
      return fn(tx);
    });

  const enf = randomUUID();
  await db.scoped(B, (tx) =>
    tx.run(
      `INSERT INTO workspace_enforcements (id, workspace_id, level, reason, applied_at)
       VALUES (?, ?, 'suspended', 'rls probe', now())`,
      [enf, B],
    ),
  );

  const unscopedEnf = await asApp(null, (tx) =>
    tx.all<{ id: string }>(`SELECT id FROM workspace_enforcements`),
  );
  check(
    unscopedEnf.length === 0,
    `a missing scope still sees no enforcements — the marker is not its absence (${unscopedEnf.length} row(s))`,
  );

  const wrongTenantEnf = await asApp(A, (tx) =>
    tx.all<{ id: string }>(`SELECT id FROM workspace_enforcements`),
  );
  check(
    !wrongTenantEnf.some((r) => r.id === enf),
    `and a scoped read sees only its own (${wrongTenantEnf.length} row(s))`,
  );

  const acrossAll = await asPlatformApp((tx) =>
    tx.all<{ id: string }>(`SELECT id FROM workspace_enforcements`),
  );
  check(
    acrossAll.some((r) => r.id === enf),
    `the marker reaches across workspaces when it is set (${acrossAll.length} row(s))`,
  );

  // A door, not a skeleton key: 032 grants the marker SELECT on this table and nothing else, so
  // the INSERT falls to `tenant_isolation`'s WITH CHECK with no workspace in scope.
  let writeRefused = false;
  try {
    await asPlatformApp((tx) =>
      tx.run(
        `INSERT INTO workspace_enforcements (id, workspace_id, level, reason, applied_at)
         VALUES (?, ?, 'blocked', 'should not be possible', now())`,
        [randomUUID(), A],
      ),
    );
  } catch {
    writeRefused = true;
  }
  check(writeRefused, "...and it does not carry a write it was never granted");

  await db.scoped(B, (tx) => tx.run(`DELETE FROM workspace_enforcements WHERE id = ?`, [enf]));

  const exempt = ["audit_log", "workspace_members", "ws_tickets"];
  const wrongly = exempt.filter((t) => policies.some((p) => p.tablename === t));
  check(
    wrongly.length === 0,
    `audit_log and workspace_members stay policy-free (${wrongly.join(", ") || "correct"})`,
  );
} catch (err) {
  // A THROW IS A FAILURE, NOT A CRASH.
  //
  // Every assertion here goes through `check`, which counts and keeps going, so anything that
  // escapes to this point is a statement that could not run at all — a missing table, a role
  // that does not exist, a connection that went away. Left to propagate it exits with a stack
  // and no test output at all, and worse, it hands the `finally` below the chance to throw over
  // it: for one CI run the reported error was `relation "steps" does not exist` from the CLEANUP
  // delete, while the actual first failure was the same missing schema six statements earlier.
  // Recorded as a failure with its stack, it stays the last thing in the log and the exit code
  // is still 1.
  failures++;
  console.log(`  FAIL the suite could not finish — ${(err as Error).stack ?? String(err)}`);
} finally {
  // CLEANUP REPORTS, IT DOES NOT REPLACE. Each delete is on its own so one impossible statement
  // does not skip the rest, and a cleanup that fails is counted rather than thrown — the run
  // that just failed has a reason, and this is not it.
  const tidy = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      failures++;
      console.log(`  FAIL cleanup left ${what} behind — ${(err as Error).message}`);
    }
  };
  // Owner + scope, because the owner is not exempt.
  for (const [ws, id] of [[A, runA], [B, runB]] as const) {
    await tidy(`the trace for run ${id.slice(0, 8)}`, () =>
      db.scoped(ws, async (tx) => {
        await tx.run(`DELETE FROM steps WHERE run_id = ?`, [id]);
        await tx.run(`DELETE FROM runs WHERE id = ?`, [id]);
      }));
  }
  await tidy("two workspaces", () => db.run(`DELETE FROM workspaces WHERE id IN (?, ?)`, [A, B]));
  // Unguarded on purpose: an open pool keeps the process alive, so this has to run even if
  // everything above it went wrong.
  await db.close();
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
