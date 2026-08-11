// The local QueueBackend. One process, one Map, the exact same admit semantics as
// RedisQueueBackend expressed as plain synchronous JS instead of a Lua script — correct for
// the same reason the Lua script is: nothing here `await`s inside the critical section, so
// there is no interleaving for two admits to race inside.
//
// This is what a suite gets by default with nothing installed, same posture SqliteDb and
// FsObjectStore already hold. It is also genuinely useful beyond tests: a single-process
// deployment that wants fair per-workspace dispatch without standing up Redis can use this
// directly — the fairness and reservation PROPERTIES don't depend on which backend enforces
// them, only cross-process visibility does.

import type { JobClass, QueueJob } from "./jobs.ts";
import type { AdmitOptions, QueueBackend } from "./backend.ts";

interface ClassState {
  lists: Map<string, QueueJob[]>; // workspaceId -> FIFO queue
  ring: string[]; // rotation order of workspaces with pending work
  leases: Map<string, { job: QueueJob; expiresAtMs: number }>; // leaseId -> reservation
}

export class InMemoryQueueBackend implements QueueBackend {
  private classes = new Map<JobClass, ClassState>();
  /** Semaphores are named counters independent of any class's ring — see backend.ts. */
  private semaphores = new Map<string, Map<string, number>>(); // key -> leaseId -> expiresAtMs

  private state(jobClass: JobClass): ClassState {
    let s = this.classes.get(jobClass);
    if (!s) {
      s = { lists: new Map(), ring: [], leases: new Map() };
      this.classes.set(jobClass, s);
    }
    return s;
  }

  async enqueue(job: QueueJob): Promise<void> {
    const s = this.state(job.class);
    let list = s.lists.get(job.workspaceId);
    if (!list) {
      list = [];
      s.lists.set(job.workspaceId, list);
    }
    list.push(job);
    if (list.length === 1) s.ring.push(job.workspaceId);
  }

  async tryAdmit(jobClass: JobClass, opts: AdmitOptions): Promise<QueueJob | null> {
    const s = this.state(jobClass);
    const now = Date.now();

    if (opts.maxGlobalInFlight !== null) {
      if (this.liveLeaseCount(s, now) >= opts.maxGlobalInFlight) return null;
    }

    const attempts = s.ring.length;
    for (let i = 0; i < attempts; i++) {
      const candidate = s.ring.shift();
      if (candidate === undefined) return null;
      const list = s.lists.get(candidate);
      if (!list || list.length === 0) continue; // stale ring entry; drop it, keep looking
      const job = list.shift()!;
      if (list.length > 0) s.ring.push(candidate); // still has work: rotate to the back
      // else: leave it out of the ring until something re-enqueues into it
      s.leases.set(opts.leaseId, { job, expiresAtMs: now + opts.leaseTtlMs });
      return job;
    }
    return null;
  }

  async ack(jobClass: JobClass, leaseId: string): Promise<void> {
    this.state(jobClass).leases.delete(leaseId);
  }

  async reapExpired(jobClass: JobClass): Promise<QueueJob[]> {
    const s = this.state(jobClass);
    const now = Date.now();
    const reclaimed: QueueJob[] = [];
    for (const [leaseId, lease] of [...s.leases]) {
      if (lease.expiresAtMs > now) continue;
      s.leases.delete(leaseId);
      reclaimed.push(lease.job);
    }
    for (const job of reclaimed) await this.enqueue(job);
    return reclaimed;
  }

  async pendingCount(jobClass: JobClass, workspaceId: string): Promise<number> {
    return this.state(jobClass).lists.get(workspaceId)?.length ?? 0;
  }

  async ringOrder(jobClass: JobClass): Promise<string[]> {
    return [...this.state(jobClass).ring];
  }

  async inFlightCount(jobClass: JobClass): Promise<number> {
    return this.liveLeaseCount(this.state(jobClass), Date.now());
  }

  /** Expired leases stop counting against the cap even before reapExpired() gets around to
   *  putting their job back on the queue — otherwise a crashed worker's dead lease would
   *  quietly hold capacity hostage until the next reap sweep runs. Deliberately read-only: it
   *  must NOT delete an expired lease itself, or its job would never reach reapExpired() and
   *  would simply vanish. Only reapExpired() is allowed to remove one, and only alongside
   *  putting its job back on the queue. */
  private liveLeaseCount(s: ClassState, now: number): number {
    let n = 0;
    for (const lease of s.leases.values()) if (lease.expiresAtMs > now) n++;
    return n;
  }

  async acquireSemaphore(key: string, max: number, leaseId: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    let holders = this.semaphores.get(key);
    if (!holders) {
      holders = new Map();
      this.semaphores.set(key, holders);
    }
    let live = 0;
    for (const expiresAtMs of holders.values()) if (expiresAtMs > now) live++;
    if (live >= max) return false;
    holders.set(leaseId, now + ttlMs);
    return true;
  }

  async releaseSemaphore(key: string, leaseId: string): Promise<void> {
    this.semaphores.get(key)?.delete(leaseId);
  }

  async semaphoreCount(key: string): Promise<number> {
    const holders = this.semaphores.get(key);
    if (!holders) return 0;
    const now = Date.now();
    let live = 0;
    for (const expiresAtMs of holders.values()) if (expiresAtMs > now) live++;
    return live;
  }

  async purgePending(jobClass: JobClass, workspaceId: string, idempotencyKeys: Set<string>): Promise<number> {
    const s = this.state(jobClass);
    const list = s.lists.get(workspaceId);
    if (!list || !list.length) return 0;
    const before = list.length;
    const kept = list.filter((j) => !idempotencyKeys.has(j.idempotencyKey));
    s.lists.set(workspaceId, kept);
    if (kept.length === 0) {
      const idx = s.ring.indexOf(workspaceId);
      if (idx >= 0) s.ring.splice(idx, 1);
    }
    return before - kept.length;
  }
}
