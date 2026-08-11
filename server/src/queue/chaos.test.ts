// The scenario worker.ts's graceful shutdown exists to make rare, not impossible: a worker
// that never gets to run any shutdown code at all — killed outright, crashed, the machine
// lost power. workerLoop.test.ts already proves the GRACEFUL path (shutdown() hands a
// straggler back explicitly, immediately). This proves the path underneath it: nobody
// explicitly hands anything back, and the system still recovers, exactly once, on its own.
//
// BOTH BACKENDS. The recovery under test is a lease TTL and an atomic claim, and on the hosted
// path both live in Lua (redisBackend.ts's CLAIM_EXPIRED_SCRIPT is the whole of "two reapers
// racing the same expired lease still only claim it once"). Running this against the in-memory
// backend alone proved that property for the implementation that does not have to survive two
// processes. fixtures/redis/mockRedis.ts runs the real script, so both do now.
//
//   npm run test:chaos

import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { MockRedis } from "../../fixtures/redis/mockRedis.ts";
import type { QueueBackend } from "./backend.ts";
import { InMemoryQueueBackend } from "./inMemoryBackend.ts";
import { RedisQueueBackend } from "./redisBackend.ts";
import { Dispatcher } from "./dispatcher.ts";
import { WorkerLoop } from "./workerLoop.ts";

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

const BACKENDS: Array<[string, () => QueueBackend]> = [
  ["in-memory", () => new InMemoryQueueBackend()],
  ["redis-lua", () => new RedisQueueBackend(new MockRedis() as unknown as Redis)],
];

for (const [label, makeBackend] of BACKENDS) {
console.log(`\n[${label}] a worker that vanishes mid-job, with no chance to shut down at all`);
{
  const backend = makeBackend();
  const dispatcher = new Dispatcher(backend);
  const ws = `ws-chaos-${randomUUID()}`;

  await dispatcher.enqueue("run.eval", ws, { tag: "orphaned-by-a-crash" });

  // "Worker A" — admits the job and then, standing in for a kill -9 or a power loss, simply
  // never calls ack(), never enqueues a replacement, never runs another line of code. There
  // is deliberately no WorkerLoop instance representing it after this line; a real crash
  // leaves nothing behind to call either.
  const deadLeaseId = randomUUID();
  const admitted = await dispatcher.tryAdmit("run.eval", { leaseId: deadLeaseId, leaseTtlMs: 60 });
  check(admitted !== null, "worker A admits the job");
  check((await dispatcher.pendingCount("run.eval", ws)) === 0, "and it leaves the pending list while leased");
  check((await dispatcher.inFlightCount("run.eval")) === 1, "one lease outstanding, worker A's");

  // "Worker B" — a completely independent process (a fresh WorkerLoop, a fresh reap timer),
  // with no knowledge that worker A ever existed. Its only advantage is a short reap
  // interval, standing in for however long a real deployment's sweep actually runs.
  let handled = 0;
  const seenJobIds: string[] = [];
  const loopB = new WorkerLoop({
    dispatcher,
    classes: ["run.eval"],
    handlers: {
      // Acking is the HANDLER's job, not the loop's — a handler decides when its work is
      // truly settled (evalRunner.ts's real handler acks deep inside onRunExit, well after
      // the admitted call returns), so WorkerLoop never acks on a handler's behalf.
      "run.eval": async (job, leaseId) => {
        handled++;
        seenJobIds.push(job.id);
        await dispatcher.ack("run.eval", leaseId);
      },
    },
    idlePollMs: 20,
    reapIntervalMs: 50, // short only so the test doesn't sit for real production timings
  });
  const runningB = loopB.run();

  // Worker A's lease expires at 60ms; worker B reaps on a 50ms cadence, so recovery should
  // land within roughly two sweeps. Poll well past that before concluding it never came.
  for (let i = 0; i < 100 && handled < 1; i++) await sleep(20);

  check(handled === 1, `worker B recovers and runs the orphaned job exactly once (handled ${handled} time(s))`);
  check(new Set(seenJobIds).size === handled, "no job id was ever seen more than once");

  await loopB.shutdown(1000);
  await runningB;

  // The lease worker A held is long gone by now (reaped), and worker B's own lease for its
  // successful run was acked normally - nothing should still be outstanding.
  check((await dispatcher.inFlightCount("run.eval")) === 0, "no lease left outstanding once it's all settled");
  check((await dispatcher.pendingCount("run.eval", ws)) === 0, "and nothing left pending either");
}

console.log(`\n[${label}] two workers racing the same expired lease still only run it once`);
{
  const backend = makeBackend();
  const dispatcher = new Dispatcher(backend);
  const ws = `ws-chaos-race-${randomUUID()}`;

  await dispatcher.enqueue("run.eval", ws, { tag: "contested" });
  const deadLeaseId = randomUUID();
  await dispatcher.tryAdmit("run.eval", { leaseId: deadLeaseId, leaseTtlMs: 60 });
  await sleep(80); // let the lease actually lapse before either reaper gets a turn

  // Two reap calls issued back-to-back, as if two live workers' sweep timers both fired at
  // nearly the same moment - the exact interleaving reapExpired's atomic claim step exists
  // to make safe.
  const [a, b] = await Promise.all([dispatcher.reapExpired("run.eval"), dispatcher.reapExpired("run.eval")]);
  const totalReclaimed = a.length + b.length;
  check(totalReclaimed === 1, `exactly one of the two racing reap calls claims the job (claimed ${totalReclaimed})`);
}
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
