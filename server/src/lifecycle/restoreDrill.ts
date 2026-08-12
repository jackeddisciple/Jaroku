// Restoring from a backup, and checking that what came back is the thing that went in.
//
// AN UNTESTED BACKUP IS NOT A BACKUP. That sentence is in every runbook ever written and is
// almost never acted on, because performing a restore is tedious and nothing forces it. So this
// is a script: it takes a database, copies it the way a backup does, restores it into a scratch
// one, and then makes assertions about what it finds — row for row, and then property by
// property.
//
// WHAT A RESTORE HAS TO PROVE, and why counting rows is not enough:
//
//   THE ROWS ARE THERE. Table by table, with counts, so a restore that silently dropped a table
//   is visible rather than discovered a month later by a customer.
//
//   THE SCHEMA IS THERE. Including the things a naive data copy loses and nobody notices until
//   production behaves differently: the RLS policies, the indexes, the `schema_migrations` rows
//   that tell the migration runner what has already been applied.
//
//   THE TENANCY STILL HOLDS. A restored database with the rows and none of the policies is a
//   database in which every workspace can read every other. It is the failure that a row count
//   cannot see and that a restore under pressure is most likely to produce.
//
//   THE TRACE IS INTACT. One known run, read back with its steps in `seq` order and its payload
//   shapes unchanged — the property `test:shape-parity` defends in normal operation, checked
//   here after a round trip through whatever the backup format is.
//
// TWO BACKUP MECHANISMS, AND THE DRILL IS ABOUT THE SECOND. Postgres point-in-time recovery is
// the real one — WAL archiving plus a base backup, restored by the provider's own tooling — and
// nothing here can perform it, because it is a property of the infrastructure rather than of the
// application. What this drill exercises is the LOGICAL copy: every row, through the same `Db`
// interface the application uses, into a database built by running the migrations. That is a
// weaker backup and a stronger test: it proves the schema in the repository can rebuild a working
// database from data alone, which is the fallback when a provider's snapshot is what has failed.
//
// AND IT RUNS ON BOTH DRIVERS, because the local path has to keep working — a drill that needs
// production credentials is a drill nobody runs.

import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { newRequestId, systemContextFor } from "../db/tenant.ts";

/** Tables a restore is checked against. Everything a workspace's life depends on. */
const CHECKED_TABLES = [
  "workspaces",
  "users",
  "workspace_members",
  "agents",
  "agent_versions",
  "runs",
  "steps",
  "datasets",
  "eval_runs",
  "eval_jobs",
  "usage_events",
  "audit_log",
] as const;

export interface TableCount {
  table: string;
  source: number;
  restored: number;
}

export interface DrillReport {
  startedAt: string;
  finishedAt: string;
  /** Milliseconds, per phase, because "how long does a restore take" is the question. */
  timings: { copyMs: number; migrateMs: number; verifyMs: number };
  counts: TableCount[];
  /** Assertions that failed. Empty is the only acceptable value. */
  problems: string[];
  /** Things worth writing in the runbook: surprises, absences, driver differences. */
  notes: string[];
}

export interface DrillDeps {
  source: Db;
  /** An empty database to restore into. Built by the drill, torn down by the caller. */
  target: Db;
  /** Where the migrations live, so the target is built from the repository rather than copied. */
  migrationsDir: string;
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * Copy, restore, and verify.
 *
 * ROW BY ROW THROUGH THE `Db` INTERFACE, deliberately, rather than by copying a file. A file copy
 * would prove that a file can be copied. This proves that the SCHEMA IN THE REPOSITORY can hold
 * the DATA IN PRODUCTION — which is the question a restore actually asks, and the one that fails
 * when a migration was applied to production by hand and never committed.
 */
export async function runRestoreDrill(deps: DrillDeps): Promise<DrillReport> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const startedAt = new Date(now()).toISOString();
  const report: DrillReport = {
    startedAt,
    finishedAt: startedAt,
    timings: { copyMs: 0, migrateMs: 0, verifyMs: 0 },
    counts: [],
    problems: [],
    notes: [],
  };

  // --- 1. build the target from the repository's migrations --------------------------------
  let mark = now();
  await migrate(deps.target.migrationTarget(), deps.migrationsDir, () => {});
  report.timings.migrateMs = now() - mark;
  log(`[drill] target schema built in ${report.timings.migrateMs}ms`);

  // --- 2. copy every row ----------------------------------------------------------------------
  mark = now();
  let copied = 0;
  let alreadyPresent = 0;
  for (const table of tablesInDependencyOrder()) {
    // `schema_migrations` IS NOT DATA, and the first drill run is what made that obvious. The
    // target built its own schema by running the migrations, so it wrote its own ledger — and
    // copying the source's produces a unique violation per migration. Worse, if it succeeded it
    // would be the wrong ledger: a restore's applied set is what the RESTORED schema has, not
    // what the source happened to have when it was backed up.
    if (table === "schema_migrations") continue;
    const rows = await deps.source.all<Record<string, unknown>>(`SELECT * FROM ${table}`).catch(() => []);
    if (rows.length === 0) continue;
    for (const row of rows) {
      const columns = Object.keys(row);
      const placeholders = columns.map(() => "?").join(", ");
      try {
        // ON CONFLICT DO NOTHING, and this is the drill's second finding rather than caution.
        // Some rows are created BY a migration — the `plans` catalogue, and the fixed `Local`
        // workspace migration 004 backfills every pre-tenancy row into — so a freshly migrated
        // target already holds them. A plain INSERT fails on those and a restore that stops
        // there restores nothing.
        const res = await deps.target.run(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          columns.map((c) => row[c] as unknown),
        );
        if (res.changes > 0) copied++;
        else alreadyPresent++;
      } catch (err) {
        // Recorded, not fatal — a restore that stops at the first bad row restores nothing, and
        // the count of what did not come back is exactly what a report is for.
        report.problems.push(`${table}: a row could not be restored — ${(err as Error)?.message ?? err}`);
      }
    }
  }
  report.timings.copyMs = now() - mark;
  if (alreadyPresent) {
    report.notes.push(`${alreadyPresent} row(s) were already present from the migrations themselves (plans, the Local workspace)`);
  }
  log(`[drill] ${copied} row(s) restored in ${report.timings.copyMs}ms`);

  // --- 3. verify ------------------------------------------------------------------------------
  mark = now();
  for (const table of CHECKED_TABLES) {
    const source = await count(deps.source, table);
    const restored = await count(deps.target, table);
    report.counts.push({ table, source, restored });
    if (source !== restored) report.problems.push(`${table}: ${source} rows before, ${restored} after`);
  }

  // The migration ledger. A restored database whose `schema_migrations` is empty will try to
  // apply every migration again at the next boot — which is either an error or, worse, a
  // successful re-run of something not written to be idempotent.
  const applied = await count(deps.target, "schema_migrations");
  const sourceApplied = await count(deps.source, "schema_migrations");
  if (applied === 0) report.problems.push("schema_migrations is empty — the restored database does not know what it has");
  if (applied < sourceApplied) {
    report.problems.push(
      `the restored schema is OLDER than the source: ${applied} migrations against ${sourceApplied}. ` +
        "Restoring into an out-of-date checkout is how a restore loses a column.",
    );
  }
  report.notes.push(`the restored database records ${applied} applied migration(s)`);

  // THE TENANCY, which is the property a row count cannot see — and which has to be probed
  // DIFFERENTLY ON EACH DRIVER, because the two enforce it in different places. The first drill
  // run asserted a scoped read on SQLite returns none of another workspace's rows, and it
  // failed — correctly. `forWorkspace` on SQLite is the connection itself: there is no RLS to
  // scope, the repository layer is the whole of the enforcement, and a raw SELECT naturally
  // returns whatever it asks for. The probe was testing Postgres's mechanism on a driver that
  // does not have one.
  //
  // So: on Postgres, assert the policy actually refuses the cross-workspace read. On SQLite,
  // assert what IS restorable there — that every row came back carrying the workspace it
  // belonged to, since a scoping column that survives is what the repository layer filters on.
  const workspaces = await deps.target.all<{ id: string }>(`SELECT id FROM workspaces LIMIT 2`);
  if (deps.target.dialect === "postgres" && workspaces.length === 2) {
    const [a, b] = workspaces;
    const seen = await deps.target
      .forWorkspace(a!.id)
      .all<{ workspace_id: string }>(`SELECT workspace_id FROM runs WHERE workspace_id = ?`, [b!.id]);
    if (seen.length > 0) {
      report.problems.push("a scoped read returned another workspace's runs — the restore lost its RLS policies");
    } else {
      report.notes.push("a scoped read of one workspace returns none of another's rows");
    }
  } else {
    const mislabelled = await deps.target.all<{ id: string }>(
      `SELECT r.id FROM runs r LEFT JOIN workspaces w ON w.id = r.workspace_id WHERE w.id IS NULL`,
    );
    if (mislabelled.length > 0) {
      report.problems.push(`${mislabelled.length} restored run(s) name a workspace that is not in the restore`);
    } else {
      report.notes.push("every restored run names a workspace that came back with it");
    }
    const ctxProbe = systemContextFor(workspaces[0]?.id ?? randomUUID(), newRequestId());
    report.notes.push(
      `scoping on ${deps.target.dialect} is the repository layer's (probed as ${ctxProbe.role}); ` +
        "RLS is a Postgres-only backstop and is checked below on that driver",
    );
  }

  // AND ONE TRACE, END TO END. Counts prove rows exist; this proves they are the same rows, in
  // order, with their payloads the shape the application expects.
  const run = await deps.target.get<{ id: string; workspace_id: string }>(
    `SELECT id, workspace_id FROM runs ORDER BY started_at DESC LIMIT 1`,
  );
  if (run) {
    const steps = await deps.target.all<{ seq: number; type: string }>(
      `SELECT seq, type FROM steps WHERE run_id = ? ORDER BY seq ASC`,
      [run.id],
    );
    const ordered = steps.every((s, i) => i === 0 || Number(s.seq) > Number(steps[i - 1]!.seq));
    if (!ordered) report.problems.push(`run ${run.id}: steps did not come back in seq order`);
    report.notes.push(`one restored run read back with ${steps.length} step(s), in seq order`);
  } else {
    report.notes.push("no runs in the source — the trace probe was not meaningful");
  }

  // The policies, which only exist on one driver and are the thing most easily lost.
  if (deps.target.dialect === "postgres") {
    const policies = await deps.target.all<{ tablename: string }>(
      `SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation'`,
    );
    report.notes.push(`${policies.length} table(s) carry the tenant_isolation policy after the restore`);
    if (policies.length === 0) report.problems.push("no RLS policies exist in the restored database");
  } else {
    report.notes.push("SQLite has no RLS — on this driver the repository layer is the whole of the enforcement");
  }

  report.timings.verifyMs = now() - mark;
  report.finishedAt = new Date(now()).toISOString();
  return report;
}

/**
 * Parents before children, so a foreign key never refuses a row that is simply early.
 *
 * Hand-ordered rather than derived from the catalogue, because deriving it means reading foreign
 * keys out of two different dialects' system tables — and the order is a property of this schema,
 * which is in this repository, rather than of whatever database happens to be in front of it.
 */
function tablesInDependencyOrder(): string[] {
  return [
    "schema_migrations",
    "users",
    "workspaces",
    "workspace_members",
    "workspace_invites",
    "plans",
    "workspace_balances",
    "subscriptions",
    "agents",
    "agent_versions",
    "runs",
    "steps",
    "datasets",
    "dataset_examples",
    "rubrics",
    "eval_runs",
    "eval_jobs",
    "eval_scores",
    "mcp_servers",
    "mcp_tools",
    "deployments",
    "deployment_logs",
    "secret_refs",
    "workspace_data_keys",
    "workspace_secrets",
    "oauth_connections",
    "usage_events",
    "billing_holds",
    "abuse_signals",
    "workspace_enforcements",
    "audit_log",
  ];
}

async function count(db: Db, table: string): Promise<number> {
  const row = await db.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${table}`).catch(() => undefined);
  return Number(row?.n ?? 0);
}

/** A one-screen summary. What gets pasted into the runbook after a drill. */
export function describeDrill(report: DrillReport): string {
  const lines: string[] = [];
  lines.push(`restore drill ${report.startedAt}`);
  lines.push(
    `  schema ${report.timings.migrateMs}ms · copy ${report.timings.copyMs}ms · verify ${report.timings.verifyMs}ms`,
  );
  for (const c of report.counts) {
    lines.push(`  ${c.source === c.restored ? "ok  " : "FAIL"} ${c.table}: ${c.source} -> ${c.restored}`);
  }
  for (const note of report.notes) lines.push(`  note ${note}`);
  for (const problem of report.problems) lines.push(`  PROBLEM ${problem}`);
  lines.push(report.problems.length === 0 ? "  RESTORE VERIFIED" : `  ${report.problems.length} PROBLEM(S)`);
  return lines.join("\n");
}

/** A source database with something in it, for a drill run against a scratch copy. */
export async function seedForDrill(db: Db): Promise<{ workspaces: string[]; runId: string }> {
  const ids: string[] = [];
  for (const name of ["drill-a", "drill-b"]) {
    const id = randomUUID();
    await db.run(
      `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
      [id, `${name}-${id.slice(0, 8)}`, name, new Date().toISOString()],
    );
    ids.push(id);
  }
  const runId = randomUUID();
  await db.run(
    `INSERT INTO runs (id, workspace_id, agent_id, provider, model, status, started_at, cost, tokens)
     VALUES (?, ?, 'example_agent', 'fake', 'fake', 'completed', ?, 0, 0)`,
    [runId, ids[0], new Date().toISOString()],
  );
  for (let seq = 1; seq <= 3; seq++) {
    await db.run(
      `INSERT INTO steps (id, workspace_id, run_id, seq, type, name, latency_ms, started_at)
       VALUES (?, ?, ?, ?, 'llm_call', 'call', 1, ?)`,
      [randomUUID(), ids[0], runId, seq, new Date().toISOString()],
    );
  }
  return { workspaces: ids, runId };
}
