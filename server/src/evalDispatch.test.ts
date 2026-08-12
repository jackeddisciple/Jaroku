// The actual admit -> execute -> exit -> (retry | finish) cycle, end to end, through the
// real Dispatcher and a fake pool that can succeed or fail on command.
//
// evalOwnership.test.ts and evalRetry.test.ts both predate the queue (or deliberately use a
// pool that never starts anything) — neither one exercises drainAvailable(), executeAdmitted()
// or the lease release in onRunExit actually running. This does, with InMemoryQueueBackend so
// it needs nothing installed.
//
//   npm run test:eval-dispatch

import { EventEmitter } from "node:events";
import { openTestSqlite, testContext } from "./db/testDb.ts";
import { TraceStore } from "./store.ts";
import { EvalStore } from "./evalStore.ts";
import { EvalRunner, type EvalProgress } from "./evalRunner.ts";
import { Dispatcher } from "./queue/dispatcher.ts";
import { InMemoryQueueBackend } from "./queue/inMemoryBackend.ts";
import type { RunPool, RunPoolEvents, PoolRunOptions } from "./runPool.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A pool that actually "runs" something: tryStart() records the call and returns true up to
 * `capacity` times concurrently; the test drives completion explicitly by calling
 * `finish(runId, ...)`, which is what a real ProcessManager's 'exit' event corresponds to.
 */
class FakePool extends EventEmitter<RunPoolEvents> {
  started: PoolRunOptions[] = [];
  private active = new Set<string>();
  constructor(private capacity: number) {
    super();
  }
  get freeSlots(): number {
    return this.capacity - this.active.size;
  }
  tryStart(opts: PoolRunOptions): boolean {
    if (this.freeSlots <= 0) return false;
    this.active.add(opts.runId);
    this.started.push(opts);
    return true;
  }
  stop(): void {}
  finish(runId: string, result: { timedOut?: boolean; spawnError?: string } = {}): void {
    this.active.delete(runId);
    if (result.spawnError) this.emit("spawnError", { runId, error: new Error(result.spawnError) });
    // `elapsedMs` is what a real pool reports so sandbox time can be metered. A fake run
    // took no wall clock, and saying 0 is truer than inventing a duration.
    else this.emit("exit", { runId, code: 0, signal: null, timedOut: result.timedOut ?? false, elapsedMs: 0 });
  }
}

const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();
const evalStore = new EvalStore(store.database());
await evalStore.init();
const ctx = testContext();

console.log("\nthe happy path: enqueue, admit, run, succeed");
{
  const pool = new FakePool(4);
  const dispatcher = new Dispatcher(new InMemoryQueueBackend());
  const progress: EvalProgress[] = [];
  const finished: string[] = [];

  const runner = new EvalRunner({
    pool: pool as unknown as RunPool,
    store,
    dispatcher,
    evalStore,
    runtimeDir: ".",
    context: () => ctx,
    markEvalRun: () => {},
    onStarted: () => {},
    onProgress: (p) => progress.push(p),
    onFinished: (e) => finished.push(e.evalId),
  });

  const ds = await evalStore.createDataset(ctx, "agent_happy", "happy path");
  await evalStore.addExample(ctx, ds.id, "hello", null, null);
  const rubric = await evalStore.putRubric(ctx, { dataset_id: null, name: "r", criteria: [] });

  const started = await runner.start({
    ctx, datasetId: ds.id, agentId: "agent_happy", rubricId: rubric.id,
    targets: [{ provider: "fake", model: "fake" }], budgetUsd: null,
  });
  if ("error" in started) { check(false, `start failed: ${started.error}`); }
  else {
    for (let i = 0; i < 40 && pool.started.length < 1; i++) await sleep(15);
    check(pool.started.length === 1, "the job reached the pool - dispatch -> queue -> admit -> tryStart all worked");
    const launch = pool.started[0];
    check(launch?.agentId === "agent_happy", "with the right agent id");
    check(launch?.env?.JAROKU_PROVIDER === "fake", "and the right provider in its env");

    const runId = launch!.runId;
    await store.upsertRun(ctx, {
      id: runId, agent_id: "agent_happy", provider: "fake", model: "fake", status: "completed",
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(), cost: 0, tokens: 0, error: null,
    });
    pool.finish(runId);

    for (let i = 0; i < 40 && finished.length < 1; i++) await sleep(15);
    check(finished.length === 1, "the eval reports finished");
    const job = (await evalStore.jobsForEval(ctx, started.evalId))[0];
    check(job?.status === "succeeded", `the job is recorded succeeded (was ${job?.status})`);
  }
}

console.log("\na transient failure retries through the queue, and the retry succeeds");
{
  const pool = new FakePool(4);
  const dispatcher = new Dispatcher(new InMemoryQueueBackend());

  const runner = new EvalRunner({
    pool: pool as unknown as RunPool,
    store,
    dispatcher,
    evalStore,
    runtimeDir: ".",
    context: () => ctx,
    markEvalRun: () => {},
    onStarted: () => {},
    onProgress: () => {},
    onFinished: () => {},
  });

  const ds = await evalStore.createDataset(ctx, "agent_retry", "retry path");
  await evalStore.addExample(ctx, ds.id, "hello", null, null);
  const rubric = await evalStore.putRubric(ctx, { dataset_id: null, name: "r", criteria: [] });

  const started = await runner.start({
    ctx, datasetId: ds.id, agentId: "agent_retry", rubricId: rubric.id,
    targets: [{ provider: "fake", model: "fake" }], budgetUsd: null,
  });
  if ("error" in started) { check(false, `start failed: ${started.error}`); }
  else {
    for (let i = 0; i < 40 && pool.started.length < 1; i++) await sleep(15);
    const firstRunId = pool.started[0]!.runId;
    // A run that never even got a row is what "the process couldn't spawn" looks like -
    // isTransientFailure(null, false) is false, so use a message that IS transient.
    pool.finish(firstRunId, { spawnError: "ECONNRESET while spawning" });

    // Backoff means the retry won't be enqueued instantly; wait past RETRY_BASE_MS.
    for (let i = 0; i < 200 && pool.started.length < 2; i++) await sleep(25);
    check(pool.started.length === 2, `the job was retried through the dispatcher (started ${pool.started.length} time(s))`);

    if (pool.started.length === 2) {
      const secondRunId = pool.started[1]!.runId;
      check(secondRunId !== firstRunId, "the retry gets its own run id");
      await store.upsertRun(ctx, {
        id: secondRunId, agent_id: "agent_retry", provider: "fake", model: "fake", status: "completed",
        started_at: new Date().toISOString(), ended_at: new Date().toISOString(), cost: 0, tokens: 0, error: null,
      });
      pool.finish(secondRunId);
      for (let i = 0; i < 40; i++) {
        const job = (await evalStore.jobsForEval(ctx, started.evalId))[0];
        if (job?.status === "succeeded") break;
        await sleep(15);
      }
      const job = (await evalStore.jobsForEval(ctx, started.evalId))[0];
      check(job?.status === "succeeded", `the retried attempt succeeds (was ${job?.status})`);
      check(job?.attempt === 1, `attempt is recorded as 1 (0-indexed - the second attempt), was ${job?.attempt}`);
    }
  }
}

console.log("\nattempts exhaust through the queue, and backoff between them grows");
{
  const pool = new FakePool(4);
  const dispatcher = new Dispatcher(new InMemoryQueueBackend());

  const runner = new EvalRunner({
    pool: pool as unknown as RunPool,
    store,
    dispatcher,
    evalStore,
    runtimeDir: ".",
    context: () => ctx,
    markEvalRun: () => {},
    onStarted: () => {},
    onProgress: () => {},
    onFinished: () => {},
  });

  const ds = await evalStore.createDataset(ctx, "agent_exhaust", "exhaustion path");
  await evalStore.addExample(ctx, ds.id, "hello", null, null);
  const rubric = await evalStore.putRubric(ctx, { dataset_id: null, name: "r", criteria: [] });

  const started = await runner.start({
    ctx, datasetId: ds.id, agentId: "agent_exhaust", rubricId: rubric.id,
    targets: [{ provider: "fake", model: "fake" }], budgetUsd: null,
  });
  if ("error" in started) { check(false, `start failed: ${started.error}`); }
  else {
    // JAROKU_JOB_ATTEMPTS defaults to 3 and JAROKU_RETRY_BASE_MS to 2000 - every attempt in
    // this scenario fails, so this exercises the real default backoff schedule (2s, then 4s)
    // rather than a value tuned just to make the test fast.
    const attemptTimestamps: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      for (let i = 0; i < 400 && pool.started.length <= attempt; i++) await sleep(25);
      check(pool.started.length === attempt + 1, `attempt ${attempt + 1} reaches the pool (started ${pool.started.length})`);
      attemptTimestamps.push(Date.now());
      const runId = pool.started[attempt]!.runId;
      pool.finish(runId, { spawnError: "ECONNRESET on attempt" });
    }

    // A fourth attempt must NEVER arrive - MAX_ATTEMPTS is 3, and it must stay 3.
    await sleep(6_000); // past even the second backoff, so a wrongly-scheduled 4th has time to show up
    check(pool.started.length === 3, `no fourth attempt is ever dispatched (started ${pool.started.length})`);

    const job = (await evalStore.jobsForEval(ctx, started.evalId))[0];
    check(job?.status === "failed", `the job is left failed once attempts are exhausted (was ${job?.status})`);
    check(job?.attempt === 2, `attempt is recorded as 2 (0-indexed - the third and final try), was ${job?.attempt}`);

    if (attemptTimestamps.length === 3) {
      const gap1 = attemptTimestamps[1]! - attemptTimestamps[0]!;
      const gap2 = attemptTimestamps[2]! - attemptTimestamps[1]!;
      check(gap1 >= 1_500, `the first backoff is roughly the 2000ms base, not immediate (was ${gap1}ms)`);
      check(gap2 > gap1, `the second backoff is longer than the first - it's exponential, not flat (${gap1}ms -> ${gap2}ms)`);
    }
  }
}

console.log("\ncancelling an eval purges its still-queued jobs from the dispatcher");
{
  const pool = new FakePool(1); // one slot, so most jobs queue instead of dispatching at once
  const dispatcher = new Dispatcher(new InMemoryQueueBackend());

  const runner = new EvalRunner({
    pool: pool as unknown as RunPool,
    store,
    dispatcher,
    evalStore,
    runtimeDir: ".",
    context: () => ctx,
    markEvalRun: () => {},
    onStarted: () => {},
    onProgress: () => {},
    onFinished: () => {},
  });

  const ds = await evalStore.createDataset(ctx, "agent_cancel", "cancel path");
  for (let i = 0; i < 5; i++) await evalStore.addExample(ctx, ds.id, `hello-${i}`, null, null);
  const rubric = await evalStore.putRubric(ctx, { dataset_id: null, name: "r", criteria: [] });

  const started = await runner.start({
    ctx, datasetId: ds.id, agentId: "agent_cancel", rubricId: rubric.id,
    targets: [{ provider: "fake", model: "fake" }], budgetUsd: null,
  });
  if ("error" in started) { check(false, `start failed: ${started.error}`); }
  else {
    // With one pool slot, exactly one of five jobs should have made it through admission -
    // the other four are still sitting in the dispatcher's queue, unadmitted.
    for (let i = 0; i < 40 && pool.started.length < 1; i++) await sleep(15);
    check(pool.started.length === 1, `exactly one job reached the saturated pool (started ${pool.started.length})`);
    check((await dispatcher.pendingCount("run.eval", ctx.workspaceId)) === 4, "four are still queued, unadmitted");

    await runner.cancel(started.evalId);
    check((await dispatcher.pendingCount("run.eval", ctx.workspaceId)) === 0, "cancel purges all four out of the dispatcher");

    // Finish the one that was already running, and confirm nothing further ever dispatches -
    // even once the pool frees up, there's nothing left in the queue to admit.
    await store.upsertRun(ctx, {
      id: pool.started[0]!.runId, agent_id: "agent_cancel", provider: "fake", model: "fake", status: "completed",
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(), cost: 0, tokens: 0, error: null,
    });
    pool.finish(pool.started[0]!.runId);
    await sleep(300);
    check(pool.started.length === 1, "no further job was ever admitted after the cancel");
  }
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
