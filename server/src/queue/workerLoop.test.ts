// WorkerLoop against InMemoryQueueBackend - fast, deterministic, nothing installed. The Lua
// scripts underneath a real Redis are already covered by dispatcher.test.ts and
// semaphores.test.ts; this is about the loop's own behaviour: which handler runs for which
// class, that a rejecting handler doesn't wedge anything, and that shutdown actually waits.
//
//   npm run test:worker-loop

import { randomUUID } from "node:crypto";
import { InMemoryQueueBackend } from "./inMemoryBackend.ts";
import { Dispatcher } from "./dispatcher.ts";
import { WorkerLoop } from "./workerLoop.ts";
import type { QueueJob } from "./jobs.ts";

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

console.log("\na class with no handler is refused at construction, not at admit time");
{
  const dispatcher = new Dispatcher(new InMemoryQueueBackend());
  try {
    new WorkerLoop({ dispatcher, classes: ["run.eval"], handlers: {} });
    check(false, "constructing with an unhandled class should throw");
  } catch (err) {
    check((err as Error).message.includes("run.eval"), "the refusal names the unhandled class");
  }
}

console.log("\nadmitted jobs reach the right handler");
{
  const backend = new InMemoryQueueBackend();
  const dispatcher = new Dispatcher(backend);
  const ws = `ws-${randomUUID()}`;
  const seen: QueueJob[] = [];

  await dispatcher.enqueue("run.eval", ws, { tag: "one" });
  await dispatcher.enqueue("judge", ws, { tag: "two" });

  const loop = new WorkerLoop({
    dispatcher,
    classes: ["run.eval", "judge"],
    handlers: {
      "run.eval": async (job) => { seen.push(job); },
      judge: async (job) => { seen.push(job); },
    },
    idlePollMs: 20,
  });
  const running = loop.run();
  for (let i = 0; i < 50 && seen.length < 2; i++) await sleep(20);
  await loop.shutdown(1000);
  await running;

  check(seen.length === 2, "both enqueued jobs were handled");
  check(seen.some((j) => j.class === "run.eval") && seen.some((j) => j.class === "judge"), "each by its own class's handler");
  check((await backend.pendingCount("run.eval", ws)) === 0, "and nothing is left pending");
}

console.log("\na handler that throws doesn't wedge the loop");
{
  const backend = new InMemoryQueueBackend();
  const dispatcher = new Dispatcher(backend);
  const ws = `ws-${randomUUID()}`;
  const errors: unknown[] = [];
  let handledOk = 0;

  await dispatcher.enqueue("run.eval", ws, { tag: "boom" });
  await dispatcher.enqueue("run.eval", ws, { tag: "fine" });

  const loop = new WorkerLoop({
    dispatcher,
    classes: ["run.eval"],
    handlers: {
      "run.eval": async (job) => {
        if ((job.payload as { tag: string }).tag === "boom") throw new Error("simulated failure");
        handledOk++;
      },
    },
    idlePollMs: 20,
    onHandlerError: (_c, _j, err) => errors.push(err),
  });
  const running = loop.run();
  for (let i = 0; i < 50 && (errors.length < 1 || handledOk < 1); i++) await sleep(20);
  await loop.shutdown(1000);
  await running;

  check(errors.length === 1, "the throwing job's error is reported, not swallowed silently or crashing the loop");
  check(handledOk === 1, "the other job still gets handled");
  check(loop.activeCount === 0, "nothing is left dangling in-flight after both settle");
}

console.log("\nshutdown waits for in-flight work up to its drain window");
{
  const backend = new InMemoryQueueBackend();
  const dispatcher = new Dispatcher(backend);
  const ws = `ws-${randomUUID()}`;
  let finishedAt = 0;
  const startedAt = { t: 0 };

  await dispatcher.enqueue("run.eval", ws, {});

  const loop = new WorkerLoop({
    dispatcher,
    classes: ["run.eval"],
    handlers: {
      "run.eval": async () => {
        startedAt.t = Date.now();
        await sleep(150);
        finishedAt = Date.now();
      },
    },
    idlePollMs: 20,
  });
  const running = loop.run();
  for (let i = 0; i < 50 && startedAt.t === 0; i++) await sleep(10);
  const before = Date.now();
  const result = await loop.shutdown(1000);
  await running;

  check(finishedAt > 0 && finishedAt >= before, "shutdown genuinely waited for the handler to finish, not just returned immediately");
  check(result.stillRunning === 0, "and reports nothing still running once it finished inside the window");
}

console.log("\nshutdown stops admitting new work even if it arrives during the drain window");
{
  const backend = new InMemoryQueueBackend();
  const dispatcher = new Dispatcher(backend);
  const ws = `ws-${randomUUID()}`;
  let handledCount = 0;

  await dispatcher.enqueue("run.eval", ws, { tag: "first" });

  const loop = new WorkerLoop({
    dispatcher,
    classes: ["run.eval"],
    handlers: {
      "run.eval": async () => {
        handledCount++;
        await sleep(80);
      },
    },
    idlePollMs: 10,
  });
  const running = loop.run();
  for (let i = 0; i < 50 && handledCount < 1; i++) await sleep(10);

  // shutdown() sets its "stop admitting" flag synchronously, before its first await - so
  // enqueueing right after calling it (not after AWAITING it) deterministically lands after
  // the loop has already been told to stop, with no timing race to get unlucky on.
  const shutdownPromise = loop.shutdown(1000);
  await dispatcher.enqueue("run.eval", ws, { tag: "second" });
  await shutdownPromise;
  await running;

  check(handledCount === 1, "only the first job was admitted and handled");
  check(
    (await backend.pendingCount("run.eval", ws)) === 1,
    "the second job, enqueued after shutdown began, is left on the queue - not lost, not run",
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
