// The scenarios both QueueBackend implementations must pass, identically — same idea as
// db/conformance.ts. Run once against InMemoryQueueBackend (always, nothing installed needed)
// and once against RedisQueueBackend when a real Redis is reachable.

import { randomUUID } from "node:crypto";
import type { QueueBackend } from "./backend.ts";
import type { QueueJob } from "./jobs.ts";

/** Admits and immediately acks everything left in this class, across every workspace, so one
 *  scenario's leftovers can never change which workspace the next scenario's first admit
 *  picks. The ring is shared per-class state, not per-scenario - a scenario that stops early
 *  (the cap test never admits its third enqueued job) has to hand back a genuinely empty
 *  queue, not just an untouched one. */
async function drainAll(backend: QueueBackend, jobClass: "run.eval"): Promise<void> {
  for (;;) {
    const leaseId = randomUUID();
    const admitted = await backend.tryAdmit(jobClass, { leaseId, leaseTtlMs: 60_000, maxGlobalInFlight: null });
    if (!admitted) break;
    await backend.ack(jobClass, leaseId);
  }
}

function makeJob(jobClass: "run.eval", workspaceId: string, tag: string): QueueJob<{ tag: string }> {
  return {
    id: randomUUID(),
    class: jobClass,
    workspaceId,
    idempotencyKey: `run.eval:${workspaceId}:${tag}`,
    enqueuedAt: new Date().toISOString(),
    attempt: 1,
    payload: { tag },
  };
}

export async function runQueueConformance(
  label: string,
  backend: QueueBackend,
  jobClass: "run.eval" = "run.eval",
): Promise<{ failures: number }> {
  let failures = 0;
  const check = (ok: boolean, msg: string): void => {
    if (ok) console.log(`  ok   [${label}] ${msg}`);
    else {
      failures++;
      console.log(`  FAIL [${label}] ${msg}`);
    }
  };

  await drainAll(backend, jobClass); // a clean slate, regardless of what ran on this backend before

  // --- perfect round-robin interleaving when backlogs are equal --------------------------
  {
    const A = `ws-a-${randomUUID()}`;
    const B = `ws-b-${randomUUID()}`;
    for (const tag of ["a1", "a2", "a3"]) await backend.enqueue(makeJob(jobClass, A, tag));
    for (const tag of ["b1", "b2", "b3"]) await backend.enqueue(makeJob(jobClass, B, tag));

    const served: string[] = [];
    for (let i = 0; i < 6; i++) {
      const leaseId = randomUUID();
      const admitted = await backend.tryAdmit(jobClass, { leaseId, leaseTtlMs: 60_000, maxGlobalInFlight: null });
      if (!admitted) break;
      served.push(admitted.workspaceId);
      await backend.ack(jobClass, leaseId); // "completed" immediately - only the admit order matters here
    }
    check(served.length === 6, "six jobs across two equal backlogs are all admitted");
    check(
      served[0] !== served[1] && served[1] !== served[2] && served[2] !== served[3] && served[3] !== served[4],
      "no workspace is served twice in a row while the other still has work",
    );
    check(
      served.filter((w) => w === A).length === 3 && served.filter((w) => w === B).length === 3,
      "each workspace gets exactly its fair share",
    );
    await drainAll(backend, jobClass);
  }

  // --- starvation: a huge backlog does not block a latecomer with one job -----------------
  {
    const BIG = `ws-big-${randomUUID()}`;
    const SMALL = `ws-small-${randomUUID()}`;
    for (let i = 0; i < 50; i++) await backend.enqueue(makeJob(jobClass, BIG, `bulk-${i}`));
    await backend.enqueue(makeJob(jobClass, SMALL, "the-one-job"));

    const servedBeforeSmall: string[] = [];
    let smallServedAt = -1;
    for (let i = 0; i < 10; i++) {
      const leaseId = randomUUID();
      const admitted = await backend.tryAdmit(jobClass, { leaseId, leaseTtlMs: 60_000, maxGlobalInFlight: null });
      if (!admitted) break;
      await backend.ack(jobClass, leaseId);
      if (admitted.workspaceId === SMALL) {
        smallServedAt = i;
        break;
      }
      servedBeforeSmall.push(admitted.workspaceId);
    }
    check(
      smallServedAt >= 0 && smallServedAt <= 1,
      `the small workspace is served within the first two admits, not after the big one's 50 (was admit #${smallServedAt})`,
    );
    await drainAll(backend, jobClass);
  }

  // --- thundering herd: N workspaces arriving at once are each served exactly once -------
  {
    const workspaces = Array.from({ length: 20 }, () => `ws-herd-${randomUUID()}`);
    for (const ws of workspaces) await backend.enqueue(makeJob(jobClass, ws, "only-job"));

    const served = new Set<string>();
    for (let i = 0; i < workspaces.length; i++) {
      const leaseId = randomUUID();
      const admitted = await backend.tryAdmit(jobClass, { leaseId, leaseTtlMs: 60_000, maxGlobalInFlight: null });
      if (!admitted) break;
      await backend.ack(jobClass, leaseId);
      served.add(admitted.workspaceId);
    }
    check(served.size === workspaces.length, "every workspace in the herd is admitted exactly once, none twice");
    const extra = await backend.tryAdmit(jobClass, { leaseId: randomUUID(), leaseTtlMs: 60_000, maxGlobalInFlight: null });
    check(extra === null, "and nothing is left to over-admit once the herd is drained");
    await drainAll(backend, jobClass);
  }

  // --- the global cap is honoured, and releasing a lease frees it back up -----------------
  {
    const ws = `ws-cap-${randomUUID()}`;
    for (let i = 0; i < 3; i++) await backend.enqueue(makeJob(jobClass, ws, `cap-${i}`));

    const lease1 = randomUUID();
    const a1 = await backend.tryAdmit(jobClass, { leaseId: lease1, leaseTtlMs: 60_000, maxGlobalInFlight: 1 });
    check(a1 !== null, "the first admit succeeds under a cap of one");
    const a2 = await backend.tryAdmit(jobClass, { leaseId: randomUUID(), leaseTtlMs: 60_000, maxGlobalInFlight: 1 });
    check(a2 === null, "a second admit is refused while the cap is saturated");
    await backend.ack(jobClass, lease1);
    const lease3 = randomUUID();
    const a3 = await backend.tryAdmit(jobClass, { leaseId: lease3, leaseTtlMs: 60_000, maxGlobalInFlight: 1 });
    check(a3 !== null, "acking the first lease frees the slot for a third");
    if (a3) await backend.ack(jobClass, lease3);
    // one of the three enqueued jobs was never admitted - only the cap was being tested.
    await drainAll(backend, jobClass);
  }

  // --- a lease nobody acks eventually gives its job back, exactly once -------------------
  {
    const ws = `ws-reap-${randomUUID()}`;
    await backend.enqueue(makeJob(jobClass, ws, "orphaned"));
    const leaseId = randomUUID();
    const admitted = await backend.tryAdmit(jobClass, { leaseId, leaseTtlMs: -1, maxGlobalInFlight: null });
    check(admitted !== null, "the orphan job is admitted");
    check((await backend.pendingCount(jobClass, ws)) === 0, "and removed from the pending list while leased");

    const reclaimed = await backend.reapExpired(jobClass);
    check(reclaimed.length === 1 && reclaimed[0]!.workspaceId === ws, "reapExpired recovers exactly the orphaned job");
    check((await backend.pendingCount(jobClass, ws)) === 1, "and it is back on the queue");

    const reclaimedAgain = await backend.reapExpired(jobClass);
    check(reclaimedAgain.length === 0, "reaping twice does not duplicate the job");

    await drainAll(backend, jobClass);
  }

  return { failures };
}

/** The scenarios both backends' generic semaphore methods must pass identically. Independent
 *  of any job class's ring, so this needs no jobClass argument at all - just a key nobody
 *  else in the same test run happens to be using. */
export async function runSemaphoreConformance(label: string, backend: QueueBackend): Promise<{ failures: number }> {
  let failures = 0;
  const check = (ok: boolean, msg: string): void => {
    if (ok) console.log(`  ok   [${label}] ${msg}`);
    else {
      failures++;
      console.log(`  FAIL [${label}] ${msg}`);
    }
  };

  {
    const key = `test:sem:${randomUUID()}`;
    const l1 = randomUUID();
    check(await backend.acquireSemaphore(key, 2, l1, 60_000), "the first of two slots is granted");
    check((await backend.semaphoreCount(key)) === 1, "count reflects one held slot");
    const l2 = randomUUID();
    check(await backend.acquireSemaphore(key, 2, l2, 60_000), "the second of two slots is granted");
    const l3 = randomUUID();
    check(!(await backend.acquireSemaphore(key, 2, l3, 60_000)), "a third is refused once both are held");
    await backend.releaseSemaphore(key, l1);
    check((await backend.semaphoreCount(key)) === 1, "releasing one drops the count back down");
    const l4 = randomUUID();
    check(await backend.acquireSemaphore(key, 2, l4, 60_000), "a slot freed by release can be re-acquired");
    await backend.releaseSemaphore(key, l2);
    await backend.releaseSemaphore(key, l4);
    check((await backend.semaphoreCount(key)) === 0, "fully released settles back to zero");
  }

  {
    // A negative TTL means "already expired" - the same trick the reap scenario above uses.
    const key = `test:sem:expiry:${randomUUID()}`;
    const l1 = randomUUID();
    check(await backend.acquireSemaphore(key, 1, l1, -1), "a slot can be acquired with an already-past TTL");
    check((await backend.semaphoreCount(key)) === 0, "and does not count once it has expired");
    const l2 = randomUUID();
    check(
      await backend.acquireSemaphore(key, 1, l2, 60_000),
      "so a saturated-looking cap admits again once the old holder has expired, with no explicit release needed",
    );
    await backend.releaseSemaphore(key, l2);
  }

  {
    // Releasing something that was never held, or already released, must not throw or go
    // negative - a worker that acks twice (a retry of its own cleanup after a network blip)
    // is a real shape, not a hypothetical one.
    const key = `test:sem:idempotent:${randomUUID()}`;
    const leaseId = randomUUID();
    await backend.releaseSemaphore(key, leaseId); // never acquired
    await backend.releaseSemaphore(key, leaseId); // released twice
    check((await backend.semaphoreCount(key)) === 0, "releasing a slot nobody holds is a harmless no-op");
  }

  return { failures };
}
