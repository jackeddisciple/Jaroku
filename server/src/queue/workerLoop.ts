// The admit-loop a worker process actually runs, pulled out of worker.ts so it's testable
// without a real database, a real pool, or a real Redis — the same split index.ts itself
// never got, because index.ts wires concrete dependencies and this wires abstract ones.
//
// A HANDLER PER CLASS, not one handler that switches on job.class. Commit 5 (this file)
// builds the loop; commit 7 registers the real run.eval and judge handlers against it. Until
// then a worker configured for a class with no handler registered simply never admits
// anything for it — see the constructor's check — which is the honest state for a producer
// that doesn't exist yet, not a silent no-op.

import type { JobClass, QueueJob } from "./jobs.ts";
import type { Dispatcher } from "./dispatcher.ts";

export type JobHandler<T = unknown> = (job: QueueJob<T>, leaseId: string) => Promise<void>;

export interface WorkerLoopOptions {
  dispatcher: Dispatcher;
  /** Which classes this worker drains. Every one MUST have a handler registered — an
   *  unhandled class is a configuration mistake, not something to silently skip. */
  classes: JobClass[];
  handlers: Partial<Record<JobClass, JobHandler>>;
  /** How long to sleep after a pass that admitted nothing at all, across every configured
   *  class, before trying again. */
  idlePollMs?: number;
  /** How often each configured class is swept for leases nobody acked in time. */
  reapIntervalMs?: number;
  onAdmit?: (jobClass: JobClass, job: QueueJob) => void;
  onHandlerError?: (jobClass: JobClass, job: QueueJob, error: unknown) => void;
  onReaped?: (jobClass: JobClass, jobs: QueueJob[]) => void;
}

const DEFAULT_IDLE_POLL_MS = 250;
const DEFAULT_REAP_INTERVAL_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WorkerLoop {
  private readonly dispatcher: Dispatcher;
  private readonly classes: JobClass[];
  private readonly handlers: Partial<Record<JobClass, JobHandler>>;
  private readonly idlePollMs: number;
  private readonly reapIntervalMs: number;
  private readonly onAdmit: WorkerLoopOptions["onAdmit"];
  private readonly onHandlerError: WorkerLoopOptions["onHandlerError"];
  private readonly onReaped: WorkerLoopOptions["onReaped"];

  private stopping = false;
  private stopped = false;
  private inFlight = new Map<string, Promise<void>>();
  private lastReapAt = 0;
  private runPromise: Promise<void> | null = null;

  constructor(opts: WorkerLoopOptions) {
    for (const c of opts.classes) {
      if (!opts.handlers[c]) {
        throw new Error(`WorkerLoop is configured to drain "${c}" but no handler was registered for it`);
      }
    }
    this.dispatcher = opts.dispatcher;
    this.classes = opts.classes;
    this.handlers = opts.handlers;
    this.idlePollMs = opts.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
    this.reapIntervalMs = opts.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
    this.onAdmit = opts.onAdmit;
    this.onHandlerError = opts.onHandlerError;
    this.onReaped = opts.onReaped;
  }

  /** How many jobs this worker is currently handling — the "how far into a drain window am
   *  I" number shutdown() and its tests watch. */
  get activeCount(): number {
    return this.inFlight.size;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /** Runs until stop() is called (or shutdown() begins). Safe to await — resolves once the
   *  loop has actually exited, not merely been asked to. */
  async run(): Promise<void> {
    if (this.runPromise) return this.runPromise;
    this.runPromise = this.loop();
    return this.runPromise;
  }

  private async loop(): Promise<void> {
    this.stopped = false;
    while (!this.stopping) {
      await this.maybeReap();
      let admittedAny = false;
      for (const jobClass of this.classes) {
        if (this.stopping) break;
        const admission = await this.dispatcher.tryAdmit(jobClass);
        if (!admission) continue;
        admittedAny = true;
        this.onAdmit?.(jobClass, admission.job);
        this.handle(jobClass, admission.job, admission.leaseId);
      }
      if (!admittedAny) await sleep(this.idlePollMs);
    }
    this.stopped = true;
  }

  private handle(jobClass: JobClass, job: QueueJob, leaseId: string): void {
    const handler = this.handlers[jobClass]!;
    const promise = handler(job, leaseId)
      .catch((error) => this.onHandlerError?.(jobClass, job, error))
      .finally(() => {
        this.inFlight.delete(leaseId);
      });
    this.inFlight.set(leaseId, promise);
  }

  private async maybeReap(): Promise<void> {
    const now = Date.now();
    if (now - this.lastReapAt < this.reapIntervalMs) return;
    this.lastReapAt = now;
    for (const jobClass of this.classes) {
      const reclaimed = await this.dispatcher.reapExpired(jobClass);
      if (reclaimed.length) this.onReaped?.(jobClass, reclaimed);
    }
  }

  /**
   * Stop admitting new work, then wait up to `drainMs` for whatever is already in flight to
   * finish before returning. Anything still running when the window closes is left running —
   * this function returns either way, because a worker process exiting out from under a
   * handler is the caller's decision (see worker.ts), not this loop's.
   */
  async shutdown(drainMs: number): Promise<{ drained: number; stillRunning: number }> {
    this.stopping = true;
    const deadline = Date.now() + drainMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([...this.inFlight.values(), sleep(50)]);
    }
    if (this.runPromise) await this.runPromise;
    return { drained: this.classes.length, stillRunning: this.inFlight.size };
  }
}
