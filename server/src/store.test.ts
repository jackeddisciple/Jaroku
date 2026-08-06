// The trace store's two tenancy properties.
//
// 1. EVERY READ AND WRITE IS SCOPED. A run belongs to a workspace, and a context for another
//    workspace cannot see it, resume it, stamp it, or branch from it. On Postgres RLS is a
//    second wall behind this one; on SQLite this layer is the only wall, so it is the layer
//    the test aims at.
//
// 2. workspace_id NEVER LEAVES. It is the one documented exception to the frozen event
//    schema — a storage column, not a field of a Run or a Step — and the moment it appears
//    in a payload the exception has stopped being one. That is a `SELECT *` away at all
//    times, which is why it is a test and not a comment.
//
//   npm run test:trace

import { randomUUID } from "node:crypto";
import { openTestSqlite } from "./db/testDb.ts";
import { LOCAL_WORKSPACE_ID, newRequestId, systemContextFor } from "./db/tenant.ts";
import { TraceStore } from "./store.ts";
import type { Run, Step } from "./types.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();

// Two workspaces. A is the local one migration 004 created; B is a second, inserted directly
// because creating one properly is the identity repository's job and not what is under test.
const A = systemContextFor(LOCAL_WORKSPACE_ID, newRequestId());
const workspaceB = randomUUID();
await db.run(
  `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, ?, 'free', ?)`,
  [workspaceB, "other", "Other", "team", new Date().toISOString()],
);
const B = systemContextFor(workspaceB, newRequestId());

const run = (id: string): Run => ({
  id,
  agent_id: "a",
  provider: "fake",
  model: "fake-scripted",
  status: "running",
  started_at: new Date().toISOString(),
  ended_at: null,
  cost: 0,
  tokens: 0,
  error: null,
});

const step = (runId: string, seq: number): Step => ({
  id: randomUUID(), run_id: runId, seq, type: "llm_call", name: "model",
  input: { q: 1 }, output: { a: 2 }, state_before: null, state_after: null,
  tokens: 10, cost: 0.001, latency_ms: 5, error: null, parent_step_id: null,
  started_at: new Date().toISOString(),
});

const runA = randomUUID();
await store.upsertRun(A, run(runA));
await store.insertStep(A, step(runA, 0));
await store.insertStep(A, step(runA, 1));

console.log("\nscoping");

check((await store.getRun(A, runA))?.id === runA, "a run is visible in its own workspace");
check((await store.getRun(B, runA)) === undefined, "...and invisible in another one");

check((await store.listRuns(A)).length === 1, "history lists the workspace's runs");
check((await store.listRuns(B)).length === 0, "...and none of anyone else's");

check((await store.stepsForRun(A, runA)).length === 2, "steps are readable in their workspace");
check((await store.stepsForRun(B, runA)).length === 0, "...and not outside it");

check((await store.maxSeqForRun(A, runA)) === 1, "the resume offset is the run's own high-water mark");
check(
  (await store.maxSeqForRun(B, runA)) === -1,
  "...and another workspace sees no steps at all, so it cannot resume the run",
);

// A run id is a uuid a client sends back. Without the scope on the UPDATE half of the upsert,
// a `run_end` naming somebody else's run would overwrite its status and its cost.
await store.upsertRun(B, { ...run(runA), status: "error", error: "hijacked", cost: 99 });
const afterCrossWrite = await store.getRun(A, runA);
check(
  afterCrossWrite?.status === "running" && afterCrossWrite?.error === null,
  `a run_end from another workspace cannot rewrite the run (${afterCrossWrite?.status})`,
);

await store.setRunStatus(B, runA, "paused");
check((await store.getRun(A, runA))?.status === "running", "nor can a status flip");

await store.setCheckpointUpto(B, runA, 1, "ckpt-hijack");
check(
  (await store.boundaryForStep(A, runA, 0)) === null,
  "nor can a checkpoint stamp — the steps stay unstamped",
);

await store.setCheckpointUpto(A, runA, 1, "ckpt-1");
check(
  (await store.boundaryForStep(A, runA, 0))?.checkpointId === "ckpt-1",
  "...while the owning workspace's stamp lands",
);
check((await store.boundaryForStep(B, runA, 0)) === null, "and the boundary is not readable across");

// Branching from a run you cannot see would be a way to read another tenant's trace one
// branch at a time: the copy would land in YOUR workspace, fully readable.
let branchRefused = false;
try {
  await store.copyRunPrefix(B, runA, randomUUID(), 1, 1);
} catch {
  branchRefused = true;
}
check(branchRefused, "branching from another workspace's run is refused");
check((await store.listRuns(B)).length === 0, "...and copies nothing into the caller's workspace");

const branchId = randomUUID();
await store.copyRunPrefix(A, runA, branchId, 1, 1);
check((await store.stepsForRun(A, branchId)).length === 2, "a branch inside the workspace still works");
check((await store.listRuns(B)).length === 0, "...and is not visible from the other workspace");

console.log("\nthe storage column stays in storage");

// The one documented exception to the frozen schema. `SELECT *` would put it into the object
// that goes onto the wire, so the store names its columns — and this is what proves it.
const runRow = (await store.getRun(A, runA)) as unknown as Record<string, unknown>;
check(!("workspace_id" in runRow), `a Run carries no workspace_id (${Object.keys(runRow).join(", ")})`);

const stepRows = await store.stepsForRun(A, runA);
check(
  stepRows.every((s) => !("workspace_id" in (s as unknown as Record<string, unknown>))),
  "a Step carries no workspace_id",
);

const summaries = await store.listRuns(A);
check(
  summaries.every((r) => !("workspace_id" in (r as unknown as Record<string, unknown>))),
  "nor does a history summary",
);
check(summaries.every((r) => typeof r.step_count === "number"), "...which still carries its step count");

// And the fields the schema DOES promise are all there — a projection that fixed the leak by
// dropping half the payload would pass every assertion above.
const FROZEN_STEP_FIELDS = [
  "id", "run_id", "seq", "type", "name", "input", "output", "state_before",
  "state_after", "tokens", "cost", "latency_ms", "error", "parent_step_id", "started_at",
];
const first = stepRows[0] as unknown as Record<string, unknown>;
const missing = FROZEN_STEP_FIELDS.filter((f) => !(f in first));
check(missing.length === 0, `every schema-v1 Step field survives the projection (missing: ${missing.join(", ") || "none"})`);

const FROZEN_RUN_FIELDS = [
  "id", "agent_id", "provider", "model", "status", "started_at", "ended_at", "cost", "tokens", "error",
];
const missingRun = FROZEN_RUN_FIELDS.filter((f) => !(f in runRow));
check(missingRun.length === 0, `every schema-v1 Run field survives (missing: ${missingRun.join(", ") || "none"})`);

await store.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
