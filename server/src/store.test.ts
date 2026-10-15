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

console.log("\na continued run ends as the whole run");
{
  // Paused after two steps, resumed for a third: the resumed process's run_end is its own.
  const resumed = randomUUID();
  const firstStart = "2026-10-12T15:40:16.000Z";
  await store.upsertRun(A, { ...run(resumed), started_at: firstStart });
  for (const seq of [0, 1, 2]) await store.insertStep(A, step(resumed, seq));
  const whole = await store.wholeRun(A, resumed);
  check(whole?.started_at === firstStart, `its start is the first one written (${whole?.started_at})`);
  check(whole?.tokens === 30 && Math.abs((whole?.cost ?? 0) - 0.003) < 1e-9, `its totals are every segment's (${whole?.tokens}, ${whole?.cost})`);
  // A branch copied seq 0..1 from runA, which runA paid for; its own step is seq 2.
  await store.insertStep(A, step(branchId, 2));
  const branch = await store.wholeRun(A, branchId);
  check(branch?.tokens === 10, `a branch counts only what it ran, not its parent's prefix (${branch?.tokens})`);
  check((await store.wholeRun(B, resumed)) === undefined, "...and another workspace reads nothing");
  const bare = randomUUID();
  await store.upsertRun(A, run(bare));
  const none = await store.wholeRun(A, bare);
  check(none?.tokens === 0 && none?.cost === 0, "a run with no steps yet totals zero, not null");
}

console.log("\na branch's boundaries stamp only its own steps");
{
  // The parent's node step #0 was never stamped; #1 was. The branch copies both, then runs #2.
  const parentRun = randomUUID();
  await store.upsertRun(A, run(parentRun));
  await store.insertStep(A, step(parentRun, 0));
  await store.insertStep(A, step(parentRun, 1));
  await store.setCheckpointUpto(A, parentRun, 1, "ckpt-parent");
  await db.run(`UPDATE steps SET checkpoint_id = NULL WHERE run_id = ? AND seq = 0`, [parentRun]);
  const child = randomUUID();
  await store.copyRunPrefix(A, parentRun, child, 1, 1);
  await store.insertStep(A, step(child, 2));
  await store.setCheckpointUpto(A, child, 2, "ckpt-branch");
  const stamps = Object.fromEntries((await store.stepsForRun(A, child)).map((s) => [s.seq, (s as unknown as { checkpoint_id: string | null }).checkpoint_id]));
  check(stamps[2] === "ckpt-branch", `its own step takes its boundary (${stamps[2]})`);
  check(stamps[1] === "ckpt-parent", `an inherited step keeps the checkpoint it was copied with (${stamps[1]})`);
  check(stamps[0] === null, `...and one copied without any is not handed the branch's (${stamps[0]})`);
}

console.log("\na run keeps what it was started with");
{
  const asked = randomUUID();
  await store.upsertRun(A, run(asked));
  check((await store.runInput(A, asked)) === null, "a run with nothing kept says null, not empty");
  await store.setRunInput(A, asked, "Do not return JSON… banana");
  check((await store.runInput(A, asked)) === "Do not return JSON… banana", "its input is kept");
  await store.setRunInput(A, asked, "something else");
  check((await store.runInput(A, asked)) === "Do not return JSON… banana", "...once: a run starts once");
  check((await store.runInput(B, asked)) === undefined, "...and another workspace reads nothing");
  const row = (await store.listRuns(A, 500)).find((r) => r.id === asked) as unknown as Record<string, unknown>;
  check(row?.["has_input"] === true && !("input" in row), "the history says one was kept, and does not carry it");
  const bare = randomUUID();
  await store.upsertRun(A, run(bare));
  const bareRow = (await store.listRuns(A, 500)).find((r) => r.id === bare);
  check(bareRow?.has_input === false, "...and says when none was");
  await store.insertStep(A, step(asked, 0));
  await store.setCheckpointUpto(A, asked, 0, "ck-asked");
  const forked = randomUUID();
  await store.copyRunPrefix(A, asked, forked, 0, 0);
  check((await store.runInput(A, forked)) === "Do not return JSON… banana", "a branch was started with its parent's input");
}

console.log("\nthe last run on the same input");
{
  const at = (min: number): string => new Date(Date.UTC(2026, 0, 15, 9, min)).toISOString();
  const mk = async (id: string, min: number, input: string | null, status: Run["status"] = "completed", agent = "a"): Promise<void> => {
    await store.upsertRun(A, { ...run(id), agent_id: agent, started_at: at(min), status });
    if (input !== null) await store.setRunInput(A, id, input);
  };
  const [first, other, failed, latest, later, elsewhere, bare] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await mk(first, 1, "Paris weather");
  await mk(other, 2, "Lisbon weather");
  await mk(failed, 3, "Paris weather", "error");
  await mk(elsewhere, 4, "Paris weather", "completed", "b");
  await mk(latest, 5, "Paris weather");
  await mk(later, 6, "Paris weather");
  await mk(bare, 7, null);
  check((await store.sameInputBefore(A, latest)) === first, "the last earlier finished run of the agent on the same input — not a failed one, nor another agent's");
  check((await store.sameInputBefore(A, later)) === latest, "...the latest such, not the first");
  check((await store.sameInputBefore(A, first)) === null, "...and none for the first run on an input");
  check((await store.sameInputBefore(A, bare)) === null, "...nor for a run that kept no input");
  check((await store.sameInputBefore(B, latest)) === null, "...and another workspace learns nothing");
  await store.insertStep(A, step(later, 0));
  await store.setCheckpointUpto(A, later, 0, "ck-later");
  const rerun = randomUUID();
  await store.copyRunPrefix(A, later, rerun, 0, 0);
  check((await store.sameInputBefore(A, rerun)) === later, "a re-run compares with its original, which ran on its input");
}

console.log("\na model call's tokens, split");
{
  const split = randomUUID();
  await store.upsertRun(A, run(split));
  await store.insertStep(A, { ...step(split, 0), tokens: 150, input_tokens: 120, output_tokens: 30 });
  await store.insertStep(A, { ...step(split, 1), input_tokens: 2.5 as number, output_tokens: -1 });
  await store.insertStep(A, step(split, 2));
  const [a, b, c] = await store.stepsForRun(A, split);
  check(a?.input_tokens === 120 && a.output_tokens === 30, "what the call read and what it wrote come back beside its total");
  check(b?.input_tokens === null && b.output_tokens === null, "...and a count that is not a whole number is kept as none");
  check(c?.input_tokens === null && c.output_tokens === null, "...and a step from an interceptor that sent none has none");
  const forked = randomUUID();
  await store.copyRunPrefix(A, split, forked, 0, 0);
  const [copied] = await store.stepsForRun(A, forked);
  check(copied?.input_tokens === 120 && copied.output_tokens === 30, "a branch's inherited step keeps its split");
  const retuned = randomUUID();
  await store.copyRunPrefix(A, split, retuned, 0, 0, { provider: "anthropic", model: "claude-haiku-4-5", temperature: 0.2, seed: null });
  const row = (await store.getRun(A, retuned)) as (Run & { temperature?: number | null; seed?: number | null }) | undefined;
  check(row?.model === "claude-haiku-4-5" && row.provider === "anthropic" && row.temperature === 0.2 && row.seed === null, "a branch re-run with settings records them on its run");
  const plain = (await store.getRun(A, forked)) as (Run & { temperature?: number | null }) | undefined;
  check(plain?.model === "fake-scripted" && plain.temperature === null, "...and one without keeps its parent's model and no temperature");
}

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

// Runs a restart interrupted. Nothing used to close them, so a crash mid-run left a row
// spinning in the sidebar forever — while interrupted evals and deployments were both
// already reconciled at boot.
console.log("\ninterrupted runs are closed out at boot");
{
  const stuck = randomUUID();
  const paused = randomUUID();
  const finished = randomUUID();
  await store.upsertRun(A, run(stuck));
  // `paused` is a STORAGE-ONLY status, cast exactly as index.ts casts it. Schema v1 names
  // only running/completed/error, so widening RunStatus to admit it here would quietly
  // change the frozen event contract to make a test compile.
  await store.upsertRun(A, { ...run(paused), status: "paused" as Run["status"] });
  await store.upsertRun(A, { ...run(finished), status: "completed", ended_at: new Date().toISOString() });
  // Another workspace's interrupted run, to prove the sweep is scoped like everything else.
  const otherStuck = randomUUID();
  await store.upsertRun(B, run(otherStuck));

  const closed = await store.reconcileInterruptedRuns(A);
  check(closed.includes(stuck), "the interrupted run is reported");
  check(!closed.includes(paused) && !closed.includes(finished),
    "the paused and finished ones are not");
  check(!closed.includes(otherStuck), "another workspace's interrupted run is NOT touched");

  const after = new Map((await store.listRuns(A, 500)).map((r) => [r.id, r]));
  const s = after.get(stuck);
  check(s?.status === "error", `it is marked errored (${s?.status})`);
  check(Boolean(s?.ended_at), "and given an end time, so the sidebar can stop spinning");
  check(s?.error === "interrupted by a server restart", `with a reason (${JSON.stringify(s?.error)})`);

  // A paused run is halted at a boundary and keeps its checkpoint so it can be branched from.
  // Failing it here would destroy the only reason it was kept.
  check((after.get(paused)?.status as string) === "paused",
    `a paused run survives (${after.get(paused)?.status})`);
  check(after.get(finished)?.status === "completed", "a finished run is untouched");
  check((await store.getRun(B, otherStuck))?.status === "running", "and B's run is still B's business");

  // Idempotent: booting twice must not rewrite what the first boot already closed.
  check((await store.reconcileInterruptedRuns(A)).length === 0, "a second boot finds nothing left");
}

console.log("\na cancel changes only a run that has not ended");
{
  const live = randomUUID();
  await store.upsertRun(A, run(live));
  check(await store.markRunCancelled(A, live), "a running run is cancelled, and says so");
  const after = await store.getRun(A, live);
  check(after?.status === "error" && after.error === TraceStore.CANCELLED_BY_USER, `as cancelled by user (${after?.status}, ${after?.error})`);

  const paused = randomUUID();
  await store.upsertRun(A, run(paused));
  await store.setRunStatus(A, paused, "paused");
  check(await store.markRunCancelled(A, paused), "a paused run is cancelled too");

  // Stop pressed on a run that had just finished: Runs listed it as failed, cancelled by user.
  const finished = randomUUID();
  await store.upsertRun(A, { ...run(finished), status: "completed", ended_at: new Date().toISOString() });
  check(!(await store.markRunCancelled(A, finished)), "a finished run is not cancelled");
  check((await store.getRun(A, finished))?.status === "completed", "...and is still completed");

  // A failed run had its own error replaced by "cancelled by user".
  const failed = randomUUID();
  await store.upsertRun(A, { ...run(failed), status: "error", error: "ValueError: no", ended_at: new Date().toISOString() });
  check(!(await store.markRunCancelled(A, failed)), "a failed run is not cancelled");
  check((await store.getRun(A, failed))?.error === "ValueError: no", "...and keeps its own error");

  check(!(await store.markRunCancelled(B, live)), "and another workspace cannot cancel this one's run");

  // The app tells a stopped run from a failed one by this reason, and holds its own copy of it.
  const { readFileSync } = await import("node:fs");
  const clientStore = readFileSync(new URL("../../client/src/store/traceStore.ts", import.meta.url), "utf8");
  check(clientStore.includes(`export const CANCELLED_BY_USER = "${TraceStore.CANCELLED_BY_USER}";`),
    "the app's copy of the cancel reason is the server's");
}

await store.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
