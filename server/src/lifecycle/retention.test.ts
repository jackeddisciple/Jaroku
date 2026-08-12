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
import { RetentionSweeper, STAGING_MAX_AGE_MS, describeSweep } from "./retention.ts";

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
const scale = await workspace("scale"); // 365 days

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
const staleScale = await seedRun(scale, 30);

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

const sweeper = new RetentionSweeper({
  db,
  workspaces: async () => [
    { id: free.workspaceId, plan: "free" },
    { id: scale.workspaceId, plan: "scale" },
  ],
  overridesFor: async () => ({}),
  checkpoints,
  objects,
  log: () => {},
  now: () => NOW,
});

console.log("\nsweeping");
const report = await sweeper.sweep();
const freeSweep = report.workspaces.find((w) => w.workspaceId === free.workspaceId)!;
const scaleSweep = report.workspaces.find((w) => w.workspaceId === scale.workspaceId)!;

{
  check(freeSweep.retentionDays === PLANS.free.retentionDays, "each workspace is swept on ITS plan's clock");
  check(scaleSweep.retentionDays === PLANS.scale.retentionDays, "...and a longer plan gets the longer one");

  const remaining = (await store.listRuns(free, 100)).map((r) => r.id);
  check(remaining.includes(freshFree), "a run inside retention is untouched");
  check(remaining.includes(edgeInside), "...including one a day inside the boundary");
  check(!remaining.includes(edgeOutside), "and one a day outside it is gone");
  check(!remaining.includes(staleFree), "...as is one long past");
  check(freeSweep.runsDeleted === 2 && freeSweep.stepsDeleted === 2, "steps go with their runs");

  const scaleRemaining = (await store.listRuns(scale, 100)).map((r) => r.id);
  check(
    scaleRemaining.includes(staleScale),
    "THE SAME DAY-OLD RUN SURVIVES ON A LONGER PLAN — retention is per workspace, not per sweep",
  );
  check(scaleSweep.runsDeleted === 0, "...and that workspace loses nothing");
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
  // outlive a Scale workspace's, which is what making it a plan promise would do.
  const recentStaging = agentStagingKey(scale.workspaceId, randomUUID(), randomUUID(), "agent.py");
  await objects.put(recentStaging, "in flight");
  const second = await sweeper.sweepWorkspace(scale, PLANS.scale.retentionDays);
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

console.log("\nnothing crosses a workspace");
{
  // The free workspace's sweep ran first and deleted two runs. If any statement had been
  // unscoped, the Scale workspace's thirty-day-old run would have gone with them.
  check((await store.listRuns(scale, 100)).length === 1, "the other workspace's rows are exactly as they were");
  const keys = (await objects.list(workspacePrefix(scale.workspaceId))).map((o) => o.key);
  check(keys.every((k) => k.startsWith(`ws/${scale.workspaceId}/`)), "...and so are its objects");
}

await db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
