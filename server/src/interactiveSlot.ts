// The per-workspace interactive reservation — Session 5's descendant of the single reserved
// slot 0, lifted out of index.ts so the one thing that has to be got right about it can be
// tested.
//
// THE THING THAT HAS TO BE GOT RIGHT: a reservation is taken BEFORE the run starts and released
// by the run's own `exit` event. If the start does not happen, there is no exit event coming, so
// nothing releases it — and the interactive cap is ONE per workspace with a lease measured in
// hours, deliberately generous because it is only a crash safety net rather than the real
// release path. That combination means a single failed start locks a workspace out of running
// anything interactively for the rest of the lease.
//
// index.ts had the acquire and the start as two statements at three call sites, with
// `pool.tryStart(...)`'s boolean discarded at all three. `tryStart` returns false whenever every
// slot is taken, and while the process-wide `interactivePool.busy` check upstream makes that
// unlikely today, it is not the same check: two workspaces' runAgent calls interleave freely
// (wsRelay dispatches concurrently), they take DIFFERENT workspace semaphores so neither refuses
// the other, and they then contend for the same single pool slot. The loser reserved a slot it
// never used.
//
// So the two steps are one call here, and undoing a reservation whose start did not happen is
// not something a call site can forget.

import type { QueueBackend } from "./queue/backend.ts";
import { workspaceSemaphore } from "./queue/semaphores.ts";

/**
 * Generous on purpose: this lease is NOT how a reservation is normally released — the run's exit
 * event is. It only bounds how long one survives a process that died holding it, and a run a user
 * is driving may legitimately be long.
 */
const DEFAULT_LEASE_TTL_MS = 60 * 60 * 1000;

export type StartOutcome =
  /** Reserved and started. The run's exit event releases the reservation. */
  | "started"
  /** The workspace already has its allowed number of interactive runs going. */
  | "no-reservation"
  /** Reserved, but no pool slot was free. The reservation has already been handed back. */
  | "no-slot";

export class InteractiveSlots {
  private leaseByRun = new Map<string, string>();

  constructor(
    private backend: QueueBackend,
    private newLeaseId: () => string,
    private leaseTtlMs: number = DEFAULT_LEASE_TTL_MS,
  ) {}

  /** How many reservations this process is tracking. For assertions and for logging. */
  get held(): number {
    return this.leaseByRun.size;
  }

  private semaphore(workspaceId: string) {
    return workspaceSemaphore(this.backend, "run.interactive", workspaceId);
  }

  /** Take a reservation for `runId`, if this workspace has one to spare. */
  async reserve(workspaceId: string, runId: string): Promise<boolean> {
    const leaseId = this.newLeaseId();
    const granted = await this.semaphore(workspaceId).acquire(leaseId, this.leaseTtlMs);
    if (granted) this.leaseByRun.set(runId, leaseId);
    return granted;
  }

  /** Hand back `runId`'s reservation. A no-op for a run that never had one — an eval job's run,
   *  or a run whose reservation was already released. */
  async release(workspaceId: string, runId: string): Promise<void> {
    const leaseId = this.leaseByRun.get(runId);
    if (!leaseId) return;
    this.leaseByRun.delete(runId);
    await this.semaphore(workspaceId).release(leaseId);
  }

  /**
   * Reserve, then start — and hand the reservation straight back if the start did not happen.
   *
   * `start` is the caller's `pool.tryStart(...)`, kept as a callback so this module never needs
   * to know what a run's options look like. Its boolean is the whole point: a false that goes
   * unread is a reservation with nothing coming to release it.
   */
  async reserveAndStart(workspaceId: string, runId: string, start: () => boolean): Promise<StartOutcome> {
    if (!(await this.reserve(workspaceId, runId))) return "no-reservation";
    let started = false;
    try {
      started = start();
    } finally {
      if (!started) await this.release(workspaceId, runId);
    }
    return started ? "started" : "no-slot";
  }
}
