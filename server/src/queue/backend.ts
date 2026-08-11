// The QueueBackend interface — same shape as Db, ObjectStore and SecretStore before it: one
// interface, a local implementation that needs nothing installed, and a Redis one for the
// hosted path. queue/dispatcher.ts is the only thing that talks to this directly.
//
// WHAT "ADMIT" HAS TO DO ATOMICALLY, in one step, or the whole reason a dispatcher exists
// falls apart under concurrency:
//
//   1. pick the next workspace to serve, fairly, among those with pending work in this class
//   2. confirm there is capacity left (this commit: one counter; commit 4 generalises it to
//      several named semaphores checked together)
//   3. remove the job from that workspace's queue
//   4. record that it's now "reserved" under a lease, so a worker that dies before
//      acknowledging it doesn't lose the job — see reapExpired
//
// Splitting these into separate calls reopens the exact race the whole design exists to
// prevent: two workers each check "is there capacity" a moment apart, both see yes, both
// admit, and the cap was never real. Redis's Lua scripting is what makes one round trip do
// all four steps without a lock — see queue/redisBackend.ts. The in-memory backend gets the
// same atomicity for free: one JS process, no `await` inside the critical section.

import type { JobClass, QueueJob } from "./jobs.ts";

export interface AdmitOptions {
  /** Identifies this admission for later ack() or, if the worker holding it dies first,
   *  reapExpired(). Callers mint a fresh one per admit attempt — a run id or a random uuid,
   *  anything unique for the lease's lifetime. */
  leaseId: string;
  /** How long an admitted-but-unacknowledged job may sit reserved before reapExpired() is
   *  allowed to give it back to the queue. Set well past the job's own timeout, so a
   *  legitimately slow job doesn't get reaped out from under the worker still running it. */
  leaseTtlMs: number;
  /** How many leases of this class may be outstanding across every workspace at once.
   *  `null` means this layer imposes no cap of its own — true when the only real ceiling is
   *  how many pool slots a worker process was started with, and admission is bounded there
   *  instead. */
  maxGlobalInFlight: number | null;
}

export interface QueueBackend {
  /** Append to the tail of `workspaceId`'s list for this class, and put the workspace in the
   *  rotation if it wasn't already pending. */
  enqueue(job: QueueJob): Promise<void>;

  /** Atomically rotate to the next workspace with pending work, confirm capacity, pop its
   *  oldest job, and reserve it under `opts.leaseId`. `null` when nothing is admittable right
   *  now — either every queue for this class is empty, or the cap is saturated. */
  tryAdmit(jobClass: JobClass, opts: AdmitOptions): Promise<QueueJob | null>;

  /** The job finished (however it finished) — release its lease. Idempotent: acking a lease
   *  that was already reaped or already acked is a no-op, not an error. */
  ack(jobClass: JobClass, leaseId: string): Promise<void>;

  /** Find every lease of this class whose TTL has passed and nobody has acked, atomically
   *  claim each one (so two reapers racing each other never both re-enqueue the same job),
   *  and put its job back on its workspace's queue. Returns what was reclaimed, for logging
   *  and for the chaos test in commit 11 to assert against. */
  reapExpired(jobClass: JobClass): Promise<QueueJob[]>;

  /** How many jobs of this class are waiting (not yet admitted) for one workspace. */
  pendingCount(jobClass: JobClass, workspaceId: string): Promise<number>;

  /** The current rotation order — which workspace is served next, and after that, and after
   *  that. Exposed for the fairness tests; not something a caller needs in production. */
  ringOrder(jobClass: JobClass): Promise<string[]>;

  /** How many leases of this class are currently outstanding, globally. */
  inFlightCount(jobClass: JobClass): Promise<number>;

  // --- generic named semaphores, independent of any job class's ring --------------------
  //
  // tryAdmit's own cap (above) has to be atomic WITH the pop, because which workspace it
  // will serve isn't known until the rotation runs — checking capacity a moment earlier or
  // later is exactly the race that makes a cap not real. A per-workspace or per-provider
  // cap doesn't have that problem: the caller already knows which workspace or provider a
  // job is for before it asks. So these are plain leased counters, checked as an ADDITIONAL
  // step after a fair admit, not fused into it — see queue/semaphores.ts for why that
  // composition is deliberate rather than a shortcut.

  /** Reserve one slot of `key`, good for `ttlMs`, if fewer than `max` are currently held.
   *  Returns whether it was granted. */
  acquireSemaphore(key: string, max: number, leaseId: string, ttlMs: number): Promise<boolean>;
  /** Release a slot early. Idempotent — releasing one already expired or already released
   *  is a no-op. */
  releaseSemaphore(key: string, leaseId: string): Promise<void>;
  /** How many slots of `key` are currently held. */
  semaphoreCount(key: string): Promise<number>;

  /**
   * Pull specific not-yet-admitted jobs back out of one workspace's queue, identified by
   * idempotencyKey. Best-effort, not the safety mechanism: a job admitted a moment before this
   * runs is unaffected — the caller (evalRunner.ts's cancel()) still has to check its own
   * cancelled flag at execution time regardless. This exists to free the ring and the
   * workspace's list promptly rather than leaving a cancelled eval's jobs to sit until
   * something eventually pops and drops each one. Returns how many were actually removed.
   */
  purgePending(jobClass: JobClass, workspaceId: string, idempotencyKeys: Set<string>): Promise<number>;
}
