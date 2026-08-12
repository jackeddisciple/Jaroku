// What Session 5 promised under load, asserted under load.
//
// evalDispatch.test.ts proves the admit -> execute -> exit cycle is CORRECT with a handful of
// jobs. This one asks what happens with five hundred, with a backend that fails, and with the
// same eval cancelled underneath a run that is still going — the three shapes the doc's own
// acceptance criterion ("one workspace submitting a 500-job eval measurably does not increase
// another workspace's interactive run latency") actually depends on.
//
//   npm run test:eval-stress

import { EventEmitter } from "node:events";
import { openTestSqlite, testContext } from "./db/testDb.ts";
import { TraceStore } from "./store.ts";
import { EvalStore } from "./evalStore.ts";
import { EvalRunner } from "./evalRunner.ts";
import { Dispatcher } from "./queue/dispatcher.ts";
import { InMemoryQueueBackend } from "./queue/inMemoryBackend.ts";
import type { AdmitOptions, QueueBackend } from "./queue/backend.ts";
import type { JobClass, QueueJob } from "./queue/jobs.ts";
import type { RunPool, RunPoolEvents, PoolRunOptions } from "./runPool.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Anything that reaches here is a promise nobody was awaiting — under Node's default
 *  --unhandled-rejections=throw it is not a warning, it is the gateway process ending. */
const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));

class FakePool extends EventEmitter<RunPoolEvents> {
  started: PoolRunOptions[] = [];
  private active = new Set<string>();
  constructor(private capacity: number) {
    super();
  }
  get freeSlots(): number {
    return this.capacity - this.active.size;
  }
  get busy(): boolean {
    return this.active.size > 0;
  }
  tryStart(opts: PoolRunOptions): boolean {
    if (this.freeSlots <= 0) return false;
    this.active.add(opts.runId);
    this.started.push(opts);
    return true;
  }
  stop(runId: string): void {
    if (this.active.has(runId)) this.finish(runId, { spawnError: "stopped" });
  }
  activeRunIds(): string[] {
    return [...this.active];
  }
  finish(runId: string, result: { timedOut?: boolean; spawnError?: string } = {}): void {
    if (!this.active.delete(runId)) return;
    if (result.spawnError) this.emit("spawnError", { runId, error: new Error(result.spawnError) });
    // `elapsedMs` is what a real pool reports so sandbox time can be metered. A fake run
    // took no wall clock, and saying 0 is truer than inventing a duration.
    else this.emit("exit", { runId, code: 0, signal: null, timedOut: result.timedOut ?? false, elapsedMs: 0 });
  }
}

/** Wraps a real backend and counts what the runner asks it to do, so "how much work did draining
 *  cost" is a number rather than an impression. */
class CountingBackend implements QueueBackend {
  admits = 0;
  enqueues = 0;
  constructor(private inner: QueueBackend) {}
  enqueue(job: QueueJob): Promise<void> {
    this.enqueues++;
    return this.inner.enqueue(job);
  }
  tryAdmit(jobClass: JobClass, opts: AdmitOptions): Promise<QueueJob | null> {
    this.admits++;
    return this.inner.tryAdmit(jobClass, opts);
  }
  ack(jobClass: JobClass, leaseId: string): Promise<void> {
    return this.inner.ack(jobClass, leaseId);
  }
  reapExpired(jobClass: JobClass): Promise<QueueJob[]> {
    return this.inner.reapExpired(jobClass);
  }
  pendingCount(jobClass: JobClass, workspaceId: string): Promise<number> {
    return this.inner.pendingCount(jobClass, workspaceId);
  }
  ringOrder(jobClass: JobClass): Promise<string[]> {
    return this.inner.ringOrder(jobClass);
  }
  inFlightCount(jobClass: JobClass): Promise<number> {
    return this.inner.inFlightCount(jobClass);
  }
  acquireSemaphore(key: string, max: number, leaseId: string, ttlMs: number): Promise<boolean> {
    return this.inner.acquireSemaphore(key, max, leaseId, ttlMs);
  }
  releaseSemaphore(key: string, leaseId: string): Promise<void> {
    return this.inner.releaseSemaphore(key, leaseId);
  }
  semaphoreCount(key: string): Promise<number> {
    return this.inner.semaphoreCount(key);
  }
  purgePending(jobClass: JobClass, workspaceId: string, keys: Set<string>): Promise<number> {
    return this.inner.purgePending(jobClass, workspaceId, keys);
  }
  purgeWorkspace(jobClass: JobClass, workspaceId: string): Promise<number> {
    return this.inner.purgeWorkspace(jobClass, workspaceId);
  }
}

const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();
const evalStore = new EvalStore(store.database());
await evalStore.init();
const ctx = testContext();

async function datasetOf(agentId: string, n: number): Promise<{ datasetId: string; rubricId: string }> {
  const ds = await evalStore.createDataset(ctx, agentId, `${n} examples`);
  for (let i = 0; i < n; i++) await evalStore.addExample(ctx, ds.id, `input ${i}`, null, null);
  const rubric = await evalStore.putRubric(ctx, { dataset_id: null, name: "r", criteria: [] });
  return { datasetId: ds.id, rubricId: rubric.id };
}

function makeRunner(pool: FakePool, dispatcher: Dispatcher): EvalRunner {
  return new EvalRunner({
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
}

// --- a deep queue must not cost work proportional to its depth ----------------------------
//
// drainAvailable() admits in a loop, checking pool.freeSlots between admissions — but starting
// an admitted job is asynchronous, so freeSlots does not move until several awaits later. A
// loop that only reads freeSlots therefore keeps seeing room that is already spoken for, and
// walks the WHOLE queue: every job admitted, its provider semaphore taken and given back, and
// re-enqueued, for two slots' worth of actual progress. That is not a slow path, it is a queue
// rewriting itself once per drain, and it repeats on the 500 ms timer for as long as there is
// a backlog.

console.log("\nfive hundred queued jobs, two slots");
{
  const pool = new FakePool(2);
  const counting = new CountingBackend(new InMemoryQueueBackend());
  const dispatcher = new Dispatcher(counting);
  const runner = makeRunner(pool, dispatcher);

  const { datasetId, rubricId } = await datasetOf("agent_deep", 500);
  const started = await runner.start({
    ctx, datasetId, agentId: "agent_deep", rubricId,
    targets: [{ provider: "fake", model: "fake" }], budgetUsd: null,
  });
  if ("error" in started) check(false, `start failed: ${started.error}`);
  else {
    for (let i = 0; i < 100 && pool.started.length < 2; i++) await sleep(10);
    check(pool.started.length === 2, `both slots filled (started ${pool.started.length})`);

    // What it COST to fill two slots out of a five-hundred-deep queue.
    const admits = counting.admits;
    const requeues = counting.enqueues - 500;
    check(
      admits <= 40,
      `filling 2 slots took ${admits} admit attempts, not one per queued job (500-deep queue)`,
    );
    check(
      requeues <= 40,
      `and put ${requeues} jobs back on the queue, rather than churning the whole backlog`,
    );
    await runner.cancel(started.evalId);
    for (const runId of pool.activeRunIds()) pool.finish(runId, { spawnError: "cancelled" });
    await sleep(50);
  }
}

// --- the provider cap is tighter than the pool, which is the ordinary case ------------------
//
// A real provider's cap is two (queue/semaphores.ts's providerLimit); the eval pool defaults to
// four slots. So an eval of any size against a real provider reaches a state where there is a
// free slot and no provider slot — and a job admitted into that state is put straight BACK on
// the queue. The drain loop kept admitting anyway, because freeSlots was still above zero and
// the queue never emptied: admit, refuse, requeue, admit the same job again, forever.
//
// Every step of that resolves as a microtask, so the loop never yields — no timer fires, no
// socket is read. The assertion that matters here is not "few admits", it is THAT THIS TEST
// FINISHES AT ALL: a setTimeout has to get a turn.

console.log("\nmore queued jobs than the provider allows at once");
{
  const pool = new FakePool(4); // four slots
  const counting = new CountingBackend(new InMemoryQueueBackend());
  const dispatcher = new Dispatcher(counting);
  const runner = makeRunner(pool, dispatcher);

  const { datasetId, rubricId } = await datasetOf("agent_capped", 20);
  const started = await runner.start({
    ctx, datasetId, agentId: "agent_capped", rubricId,
    targets: [{ provider: "anthropic", model: "claude-x" }], // providerLimit 2
    budgetUsd: null,
  });
  if ("error" in started) check(false, `start failed: ${started.error}`);
  else {
    let timerRan = false;
    setTimeout(() => (timerRan = true), 50);
    await sleep(600);
    check(timerRan, "the event loop still runs timers while a capped eval drains");
    check(pool.started.length === 2, `exactly the provider's cap started (${pool.started.length} of 20)`);
    check(
      counting.admits < 2_000,
      `draining a capped queue is bounded work (${counting.admits} admits in 600 ms)`,
    );
    await runner.cancel(started.evalId);
    for (const runId of pool.activeRunIds()) pool.finish(runId, { spawnError: "cancelled" });
    await sleep(50);
  }
}

// --- a backend that fails must not take the process with it -------------------------------
//
// drainAvailable() runs on an unref'd 500 ms interval and executeAdmitted() is launched with
// `void`. Neither had a rejection handler, so one failed backend call — a Redis blip, SQLITE_BUSY
// under exactly the load this session is about — became an unhandledRejection, which Node has
// terminated the process for since v15. The gateway is what dies.

console.log("\na backend that throws mid-drain");
{
  const inner = new InMemoryQueueBackend();
  let failNextAdmits = 0;
  const flaky: QueueBackend = {
    ...(new CountingBackend(inner) as unknown as QueueBackend),
    enqueue: (job) => inner.enqueue(job),
    tryAdmit: (jobClass, opts) => {
      if (failNextAdmits > 0) {
        failNextAdmits--;
        return Promise.reject(new Error("READONLY: the queue backend went away"));
      }
      return inner.tryAdmit(jobClass, opts);
    },
    ack: (c, l) => inner.ack(c, l),
    reapExpired: (c) => inner.reapExpired(c),
    pendingCount: (c, w) => inner.pendingCount(c, w),
    ringOrder: (c) => inner.ringOrder(c),
    inFlightCount: (c) => inner.inFlightCount(c),
    acquireSemaphore: (k, m, l, t) => inner.acquireSemaphore(k, m, l, t),
    releaseSemaphore: (k, l) => inner.releaseSemaphore(k, l),
    semaphoreCount: (k) => inner.semaphoreCount(k),
    purgePending: (c, w, k) => inner.purgePending(c, w, k),
    purgeWorkspace: (c, w) => inner.purgeWorkspace(c, w),
  };
  const pool = new FakePool(2);
  const dispatcher = new Dispatcher(flaky);
  const runner = makeRunner(pool, dispatcher);

  unhandled.length = 0;
  const { datasetId, rubricId } = await datasetOf("agent_flaky", 4);
  failNextAdmits = 10;
  const started = await runner.start({
    ctx, datasetId, agentId: "agent_flaky", rubricId,
    targets: [{ provider: "fake", model: "fake" }], budgetUsd: null,
  });
  check(!("error" in started), "start survives a backend that is refusing admits");

  // Let the periodic drain fire into the failure a few times, then recover.
  await sleep(700);
  check(unhandled.length === 0, `no unhandled rejection escaped the drain loop (saw ${unhandled.length})`);

  failNextAdmits = 0;
  for (let i = 0; i < 200 && pool.started.length < 2; i++) await sleep(10);
  check(pool.started.length >= 1, "and the runner recovers once the backend comes back");
  if (!("error" in started)) {
    await runner.cancel(started.evalId);
    for (const runId of pool.activeRunIds()) pool.finish(runId, { spawnError: "cancelled" });
    await sleep(50);
  }
}

// --- cancelling an eval must give its capacity back ---------------------------------------
//
// A run that exits after its eval is no longer live returned from onRunExit BEFORE releasing the
// dispatcher lease and the provider semaphore it was holding. The provider cap defaults to 2 for
// a real provider, so a couple of cancels leaked it away entirely and the next eval sat waiting
// on a semaphore held by runs that ended minutes ago.

console.log("\ncancel, then the run exits");
{
  const pool = new FakePool(4);
  const backend = new InMemoryQueueBackend();
  const dispatcher = new Dispatcher(backend);
  const runner = makeRunner(pool, dispatcher);

  const { datasetId, rubricId } = await datasetOf("agent_cancel", 2);
  const started = await runner.start({
    ctx, datasetId, agentId: "agent_cancel", rubricId,
    targets: [{ provider: "fake", model: "fake" }], budgetUsd: null,
  });
  if ("error" in started) check(false, `start failed: ${started.error}`);
  else {
    for (let i = 0; i < 100 && pool.started.length < 2; i++) await sleep(10);
    check(pool.started.length === 2, "two jobs running");

    await runner.cancel(started.evalId);
    for (const runId of pool.activeRunIds()) pool.finish(runId, { spawnError: "cancelled" });
    await sleep(200);

    const held = await backend.semaphoreCount("run.eval:provider:fake");
    check(held === 0, `every provider slot was handed back (${held} still held)`);
    const inFlight = await backend.inFlightCount("run.eval");
    check(inFlight === 0, `and every dispatcher lease too (${inFlight} still leased)`);
  }
}

// --- a job that never starts must give back what it took ----------------------------------
//
// executeAdmitted takes a dispatcher lease and a provider slot, then writes markJobRunning, then
// starts the process. There is no exit event coming for a run that never started, so a throw in
// between leaves both reservations held with nothing to release them. A real provider's cap is
// two; a handful of SQLITE_BUSY under load used to retire it permanently.

console.log("\nthe store throws between reserving and starting");
{
  const pool = new FakePool(4);
  const backend = new InMemoryQueueBackend();
  const dispatcher = new Dispatcher(backend);

  let breakMarkRunning = true;
  const realMarkJobRunning = evalStore.markJobRunning.bind(evalStore);
  (evalStore as unknown as { markJobRunning: typeof evalStore.markJobRunning }).markJobRunning = async (...args) => {
    if (breakMarkRunning) throw new Error("SQLITE_BUSY: database is locked");
    return realMarkJobRunning(...args);
  };

  const runner = makeRunner(pool, dispatcher);
  unhandled.length = 0;
  const { datasetId, rubricId } = await datasetOf("agent_busy", 3);
  const started = await runner.start({
    ctx, datasetId, agentId: "agent_busy", rubricId,
    targets: [{ provider: "anthropic", model: "claude-x" }], budgetUsd: null,
  });
  check(!("error" in started), "start survives a store that is refusing writes");
  await sleep(400);

  check(unhandled.length === 0, `the failed write did not escape as an unhandled rejection (${unhandled.length})`);
  const heldWhileBroken = await backend.semaphoreCount("run.eval:provider:anthropic");
  check(heldWhileBroken === 0, `no provider slot was stranded by the failure (${heldWhileBroken} held)`);

  breakMarkRunning = false;
  for (let i = 0; i < 200 && pool.started.length < 1; i++) await sleep(10);
  check(pool.started.length >= 1, "and the job runs once the store recovers — the slot was still there to take");

  if (!("error" in started)) {
    await runner.cancel(started.evalId);
    for (const runId of pool.activeRunIds()) pool.finish(runId, { spawnError: "cancelled" });
    await sleep(100);
  }
  (evalStore as unknown as { markJobRunning: typeof evalStore.markJobRunning }).markJobRunning = realMarkJobRunning;
}

// --- two startEval commands arriving together ---------------------------------------------
//
// "One eval at a time" is not a preference here, it is what makes the runner's context correct:
// index.ts resolves the workspace as contextForEval(activeEvalIds()[0]), so a SECOND live eval
// has every read and write attributed to the FIRST one's workspace. Its jobs are looked up in
// the wrong tenancy scope and its rows are written there.
//
// The guard was `if (evalRunner.active)` in the WebSocket handler, followed by five awaits before
// anything became live — and wsRelay dispatches commands concurrently (`void authorized().then(
// dispatch)`), so two startEval commands genuinely overlap. Both saw `active === false`.

console.log("\ntwo evals started at the same instant");
{
  const pool = new FakePool(4);
  const dispatcher = new Dispatcher(new InMemoryQueueBackend());
  const runner = makeRunner(pool, dispatcher);

  const a = await datasetOf("agent_race_a", 2);
  const b = await datasetOf("agent_race_b", 2);

  const [first, second] = await Promise.all([
    runner.start({
      ctx, datasetId: a.datasetId, agentId: "agent_race_a", rubricId: a.rubricId,
      targets: [{ provider: "fake", model: "fake" }], budgetUsd: null,
    }),
    runner.start({
      ctx, datasetId: b.datasetId, agentId: "agent_race_b", rubricId: b.rubricId,
      targets: [{ provider: "fake", model: "fake" }], budgetUsd: null,
    }),
  ]);

  const accepted = [first, second].filter((r) => !("error" in r));
  check(accepted.length === 1, `exactly one of two simultaneous starts is accepted (${accepted.length} were)`);
  check(
    runner.activeEvalIds().length === 1,
    `and only one eval is live, so context() answers for the eval it belongs to (${runner.activeEvalIds().length} live)`,
  );
  const refused = [first, second].find((r) => "error" in r) as { error: string } | undefined;
  check(!!refused?.error.includes("already running"), `the other is told why (got ${JSON.stringify(refused?.error)})`);

  for (const r of accepted) if (!("error" in r)) await runner.cancel(r.evalId);
  for (const runId of pool.activeRunIds()) pool.finish(runId, { spawnError: "cancelled" });
  await sleep(100);
}

check(unhandled.length === 0, `nothing rejected unhandled across the whole suite (${unhandled.length})`);

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
