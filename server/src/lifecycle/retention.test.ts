// The sweeper, against a real database, a real object store and a real checkpoint store.
//
// WHAT IS WORTH TESTING HERE IS WHAT IT DOES NOT TAKE. Deleting old rows is easy to write and
// easy to get subtly, expensively wrong, and every assertion below is about a boundary:
//
//   a run one day inside retention is untouched, and one day outside is gone;
//   a workspace on a longer plan keeps what a workspace on a shorter one loses, on the same day;
//   an expired run's CHECKPOINT goes with it, because a resumable pointer into a deleted trace
//   is worse than either;
//   an export outlives nothing — it is a copy of the same regulated content;
//   a staging copy expires on hours regardless of plan, because it belongs to a dead process.
//
//   npm run test:retention

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestSqlite } from "../db/testDb.ts";
import { TraceStore } from "../store.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { FsObjectStore } from "../storage/fsObjectStore.ts";
import { exportKey, agentStagingKey, workspacePrefix } from "../storage/keys.ts";
import { FileCheckpointStore } from "../checkpoints/store.ts";
import { PLANS } from "../billing/plans.ts";
import {
  RETENTION_KEPT_TABLES, RETENTION_SWEPT_TABLES, RetentionSweeper, STAGING_MAX_AGE_MS, deleted,
  describeSweep, type WorkspaceSweep,
} from "./retention.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

const tmp = mkdtempSync(join(tmpdir(), "jaroku-retention-"));
const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();
const objects = new FsObjectStore({ root: join(tmp, "objects"), signingKey: Buffer.alloc(32, 7) });
const checkpoints = new FileCheckpointStore(join(tmp, "checkpoints"));

/** Two workspaces on different plans, so "the same day" means different things to each. */
async function workspace(plan: string): Promise<TenantContext> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', ?, ?)`,
    [id, `ret-${id.slice(0, 8)}`, "retention", plan, new Date(NOW).toISOString()],
  );
  return systemContextFor(id, newRequestId());
}

const free = await workspace("free"); // 14 days
const team = await workspace("team"); // 365 days

/** A run with one step, started `age` days ago. */
async function seedRun(ctx: TenantContext, ageDays: number): Promise<string> {
  const runId = randomUUID();
  await store.upsertRun(ctx, {
    id: runId,
    agent_id: "example_agent",
    provider: "fake",
    model: "fake",
    status: "completed",
    started_at: daysAgo(ageDays),
    ended_at: daysAgo(ageDays),
    cost: 0,
    tokens: 0,
    error: null,
  } as never);
  await store.insertStep(ctx, {
    id: randomUUID(),
    run_id: runId,
    seq: 1,
    type: "llm_call",
    name: "call",
    input: {},
    output: {},
    state_before: {},
    state_after: {},
    tokens: 1,
    cost: 0,
    latency_ms: 1,
    error: null,
    parent_step_id: null,
    started_at: daysAgo(ageDays),
  } as never);
  return runId;
}

const freshFree = await seedRun(free, 1);
const staleFree = await seedRun(free, 30);
const edgeInside = await seedRun(free, PLANS.free.retentionDays - 1);
const edgeOutside = await seedRun(free, PLANS.free.retentionDays + 1);
const staleTeam = await seedRun(team, 30);

// A checkpoint for each of the free workspace's runs, so "the expired one's goes and the fresh
// one's stays" is a real assertion rather than a vacuous one.
const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync(join(tmp, "checkpoints"), { recursive: true });
for (const runId of [freshFree, staleFree]) writeFileSync(join(tmp, "checkpoints", `${runId}.sqlite`), "cp");

// One export and one staging object per workspace, aged by hand — the store's own mtime is what
// the sweeper reads, so the test has to move the file's clock rather than a column.
const staleExport = exportKey(free.workspaceId, randomUUID());
const freshExport = exportKey(free.workspaceId, randomUUID());
const agentId = randomUUID();
const stagingId = randomUUID();
const staleStaging = agentStagingKey(free.workspaceId, agentId, stagingId, "agent.py");
await objects.put(staleExport, "old,export");
await objects.put(freshExport, "new,export");
await objects.put(staleStaging, "print('abandoned')");

const { utimesSync } = await import("node:fs");
const objectPath = (key: string): string => join(tmp, "objects", key);
const age = (key: string, ms: number): void => {
  const when = new Date(NOW - ms);
  utimesSync(objectPath(key), when, when);
};
age(staleExport, 30 * 86_400_000);
age(freshExport, 2 * 86_400_000);
age(staleStaging, STAGING_MAX_AGE_MS + 3_600_000);

// A thread owning both a fresh run and an expired one, plus a proposal item (whose ref is not a
// run at all) and an eval item pointing at an eval that no longer exists. Migration 044's `ref_id`
// is a plain text column with no foreign key, so nothing about any of these cascades.
const threadId = randomUUID();
await db.run(
  `INSERT INTO threads (id, workspace_id, title, title_is_custom, created_at, last_activity_at, status)
   VALUES (?, ?, 'retention', 0, ?, ?, 'idle')`,
  [threadId, free.workspaceId, daysAgo(40), daysAgo(1)],
);
for (const [kind, ref] of [
  ["run", freshFree], ["run", staleFree], ["run", edgeInside], ["run", edgeOutside],
  ["proposal", "prop-1"], ["eval", "ev-gone"],
] as const) {
  await db.run(
    `INSERT INTO thread_items (id, workspace_id, thread_id, kind, ref_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [randomUUID(), free.workspaceId, threadId, kind, ref, daysAgo(2)],
  );
}

/** What the sweep wrote down, in the order it wrote it. The audit trail, captured. */
const audited: { workspaceId: string; sweep: WorkspaceSweep }[] = [];

const sweeper = new RetentionSweeper({
  db,
  workspaces: async () => [
    { id: free.workspaceId, plan: "free" },
    { id: team.workspaceId, plan: "team" },
  ],
  overridesFor: async () => ({}),
  checkpoints,
  objects,
  audit: (ctx, sweep) => { audited.push({ workspaceId: ctx.workspaceId, sweep }); },
  log: () => {},
  now: () => NOW,
});

console.log("\nsweeping");
const report = await sweeper.sweep();
const freeSweep = report.workspaces.find((w) => w.workspaceId === free.workspaceId)!;
const teamSweep = report.workspaces.find((w) => w.workspaceId === team.workspaceId)!;

{
  check(freeSweep.retentionDays === PLANS.free.retentionDays, "each workspace is swept on ITS plan's clock");
  check(teamSweep.retentionDays === PLANS.team.retentionDays, "...and a longer plan gets the longer one");

  const remaining = (await store.listRuns(free, 100)).map((r) => r.id);
  check(remaining.includes(freshFree), "a run inside retention is untouched");
  check(remaining.includes(edgeInside), "...including one a day inside the boundary");
  check(!remaining.includes(edgeOutside), "and one a day outside it is gone");
  check(!remaining.includes(staleFree), "...as is one long past");
  check(freeSweep.runsDeleted === 2 && freeSweep.stepsDeleted === 2, "steps go with their runs");

  const teamRemaining = (await store.listRuns(team, 100)).map((r) => r.id);
  check(
    teamRemaining.includes(staleTeam),
    "THE SAME DAY-OLD RUN SURVIVES ON A LONGER PLAN — retention is per workspace, not per sweep",
  );
  check(teamSweep.runsDeleted === 0, "...and that workspace loses nothing");
}

console.log("\nwhat goes with a run");
{
  const { existsSync } = await import("node:fs");
  check(!existsSync(join(tmp, "checkpoints", `${staleFree}.sqlite`)), "an expired run's checkpoint goes with it");
  check(
    existsSync(join(tmp, "checkpoints", `${freshFree}.sqlite`)),
    "...and a live run's is left alone — it is exactly the thing somebody might branch from",
  );
  check(freeSweep.checkpointsSwept >= 1, "and the sweep says how many it took");
}

console.log("\nobjects");
{
  check((await objects.head(staleExport)) === null, "an export past the plan's clock is deleted");
  check((await objects.head(freshExport)) !== null, "...and one inside it is kept");
  check((await objects.head(staleStaging)) === null, "an abandoned staging copy is deleted");
  check(freeSweep.exportsDeleted === 1 && freeSweep.stagingDeleted === 1, "...and both are counted");

  // Staging expires on hours regardless of plan. A free workspace's dead staging must not
  // outlive a Team workspace's, which is what making it a plan promise would do.
  const recentStaging = agentStagingKey(team.workspaceId, randomUUID(), randomUUID(), "agent.py");
  await objects.put(recentStaging, "in flight");
  const second = await sweeper.sweepWorkspace(team, PLANS.team.retentionDays);
  check(second.stagingDeleted === 0, "a staging copy from an hour ago is in flight, not abandoned");
  check((await objects.head(recentStaging)) !== null, "...and is still there");
}

console.log("\nreporting");
{
  check(describeSweep(report) !== null, "a sweep that did something says so");
  check(
    describeSweep({ workspaces: [], partitionsDropped: [] }) === null,
    "...and one that did nothing says nothing, so a nightly job is not a nightly log line",
  );
  check(report.partitionsDropped.length === 0, "no partitions are dropped on SQLite, which has none");
}

console.log("\nthe join table does not outlive what it points at");
{
  // `thread_items.ref_id` is a plain text column with no foreign key — one column six kinds share —
  // so nothing cascaded when a run was swept. Two costs, and the second is the worse one: the table
  // became the one in the schema that only ever grows, and it is read IN FULL on every thread
  // snapshot; and §3.3's derivation gives up on a run it cannot find, so a thread that ended in
  // ERROR quietly became `idle` the day its run passed the retention window.
  const rows = await db.all<{ ref_id: string; kind: string }>(
    `SELECT ref_id, kind FROM thread_items WHERE workspace_id = ?`,
    [free.workspaceId],
  );
  const refs = rows.map((r) => r.ref_id);
  check(!refs.includes(staleFree), "an item naming a swept run is gone with it");
  check(!refs.includes(edgeOutside), "...including the one just past the boundary");
  check(refs.includes(freshFree), "an item naming a run still inside retention stays");
  check(refs.includes(edgeInside), "...including the one just inside the boundary");
  check(refs.includes("prop-1"), "a proposal item is not this sweep's to remove, whatever its id");
  check(!refs.includes("ev-gone"), "an eval item whose eval no longer exists is swept");
  check(
    (await db.all(`SELECT id FROM threads WHERE workspace_id = ?`, [free.workspaceId])).length === 1,
    "...and the thread itself is untouched, which §3.4 requires and test:thread-archive audits for",
  );
  check(freeSweep.threadItemsDeleted === 3, "the report says how many it took");
}

console.log("\nnothing crosses a workspace");
{
  // The free workspace's sweep ran first and deleted two runs. If any statement had been
  // unscoped, the Team workspace's thirty-day-old run would have gone with them.
  check((await store.listRuns(team, 100)).length === 1, "the other workspace's rows are exactly as they were");
  const keys = (await objects.list(workspacePrefix(team.workspaceId))).map((o) => o.key);
  check(keys.every((k) => k.startsWith(`ws/${team.workspaceId}/`)), "...and so are its objects");
}

console.log("\nevery workspace-scoped table is swept or explicitly kept");
{
  // THE AUDIT export.test.ts ALREADY HAS, and the one whose absence let `thread_items` be added by
  // migration 044 and touched by nothing here. Forgetting is the failure mode; a list maintained by
  // remembering is a list that is already wrong.
  const tables = await db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  const scoped: string[] = [];
  for (const t of tables) {
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(${t.name})`);
    if (cols.some((c) => c.name === "workspace_id")) scoped.push(t.name);
  }
  const known = new Set([...RETENTION_SWEPT_TABLES, ...Object.keys(RETENTION_KEPT_TABLES)]);
  const forgotten = scoped.filter((t) => !known.has(t));
  check(
    forgotten.length === 0,
    `every workspace-scoped table is swept or explicitly kept${forgotten.length ? ` — missing: ${forgotten.join(", ")}` : ""}`,
  );
  check(
    Object.values(RETENTION_KEPT_TABLES).every((reason) => reason.length > 20),
    "...and every exemption says why, because an unexplained one is an oversight nobody can tell from a decision",
  );
  check(
    RETENTION_SWEPT_TABLES.includes("thread_items"),
    "...and the join table added by 044 is on the swept side of it",
  );
}

// --- what a sweep wrote down --------------------------------------------------------------------
//
// THE QUESTION THIS ANSWERS IS ASKED MONTHS LATER: "where did my trace from March go". A sweep is
// the one scheduled job in this product that deletes somebody's work on purpose with no undo, and
// without a row nobody can tell a correct sweep from an early one. `audit_log` is the table
// retention itself exempts, which is exactly what makes it the right place to keep this.

console.log("\nthe sweep records what it took");
{
  const freeAudit = audited.find((a) => a.workspaceId === free.workspaceId);
  check(freeAudit !== undefined, "the workspace that lost rows has an audit entry");
  check(
    freeAudit?.sweep.runsDeleted === freeSweep.runsDeleted,
    "...and its figures are the sweep's own rather than a second count",
  );
  check(
    freeAudit?.sweep.retentionDays === PLANS.free.retentionDays,
    "...including the window it was applying, which is the number somebody will ask about",
  );

  // NOTHING IS WRITTEN FOR A SWEEP THAT TOOK NOTHING. A nightly row per workspace saying zero is a
  // log nobody can read: the one entry that matters would be lost in a wall of them.
  check(deleted(teamSweep) === 0, "the workspace on the longer plan lost nothing");
  check(
    !audited.some((a) => a.workspaceId === team.workspaceId),
    "...so it writes no row at all, rather than a nightly row saying zero",
  );

  // And the helper agrees with the sweep it describes, or the condition above is guarding on a
  // different number from the one the audit reports.
  check(
    deleted(freeSweep) > freeSweep.runsDeleted,
    "`deleted` counts every table a sweep touches, not only runs",
  );
}

await db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
