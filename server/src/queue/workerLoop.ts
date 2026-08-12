// The admit-loop a worker process actually runs, pulled out of worker.ts so it's testable
// without a real database, a real pool, or a real Redis — the same split index.ts itself
// never got, because index.ts wires concrete dependencies and this wires abstract ones.
//
// A HANDLER PER CLASS, not one handler that switches on job.class. This file builds the
// loop; worker.ts's own default handler registry stays empty until a class genuinely needs a
// SEPARATE process — see worker.ts's own header for why run.eval and judge ended up drained
// in-process by evalRunner.ts's drainAvailable() instead, which is a hand-written equivalent
// of this same admit/execute/ack shape rather than a WorkerLoop instance. A worker configured
// for a class with no handler registered refuses outright at construction — see below — which
// is the honest state for a producer that doesn't exist yet, not a silent no-op.
//
// THE HANDLER OWNS ITS OWN ack(). This loop calls tryAdmit() and invokes the handler; it
// never acks on the handler's behalf, because "done" is not always the same moment as
// "handler function returned" — evalRunner's real admit/execute logic acks only once a run's
// process has actually exited, well after the call that started it returns. A handler that
// forgets to ack leaks its lease (and whatever semaphore it holds) until reapExpired's TTL
// eventually reclaims it — see chaos.test.ts for that recovery path, and workerLoop.test.ts
// for the explicit hand-back a graceful shutdown does instead of waiting for it.

import type { JobClass, QueueJob } from "./jobs.ts";
import type { Dispatcher } from "./dispatcher.ts";

/** Handles one admitted job. MUST call `dispatcher.ack(jobClass, leaseId)` itself once the
 *  work is truly settled — see the file header on why this loop cannot do it automatically. */
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
  /**
   * Wrap one job's execution in a span, continuing whatever trace enqueued it.
   *
   * A hook rather than an import, exactly as the router's is: the worker loop knows when a job
   * starts and stops, and `obs/trace.ts` knows what a span is. `job.traceparent` is the whole of
   * the context — a worker in another process has no socket and no request to inherit from.
   */
  trace?: (job: QueueJob, run: () => Promise<void>) => Promise<void>;
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
  private readonly trace: WorkerLoopOptions["trace"];

  private stopping = false;
  private stopped = false;
  private inFlight = new Map<string, { jobClass: JobClass; job: QueueJob; promise: Promise<void> }>();
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
    this.trace = opts.trace;
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
    const run = (): Promise<void> => handler(job, leaseId);
    const promise = (this.trace ? this.trace(job, run) : run())
      .catch((error) => this.onHandlerError?.(jobClass, job, error))
      .finally(() => {
        this.inFlight.delete(leaseId);
      });
    this.inFlight.set(leaseId, { jobClass, job, promise });
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
   * finish before returning.
   *
   * Anything STILL running when the window closes is handed back to the queue explicitly —
   * acked (so its lease and any semaphore it holds free up right away, not after the reaper
   * eventually notices) and re-enqueued verbatim, same attempt, no backoff, because it didn't
   * fail, it just didn't finish before this process had to go. This is what makes the
   * recovery immediate rather than dependent on some other worker's periodic reap sweep
   * eventually running — the passive lease-TTL path (queue/backend.ts's reapExpired) still
   * exists underneath this for the case this process never gets to run this code at all
   * (a kill -9, a crash) — see workerLoop.chaos.test.ts for that harder case.
   *
   * The handler itself is NOT cancelled — Node has no way to abort an arbitrary in-flight
   * Promise — so it keeps running to whatever end it reaches, harmlessly orphaned: its own
   * ack() or dispatcher call against a lease this method has already released is a documented
   * no-op (see backend.ts), never a double-execution, because the JOB has already moved on to
   * whoever admits the re-enqueued copy.
   */
  async shutdown(drainMs: number): Promise<{ drained: number; stillRunning: number }> {
    this.stopping = true;
    const deadline = Date.now() + drainMs;
    const atStart = this.inFlight.size;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([...[...this.inFlight.values()].map((e) => e.promise), sleep(50)]);
    }
    let handedBack = 0;
    // A SNAPSHOT, RE-CHECKED. Handing one job back awaits two round trips, and a handler that
    // finishes during them removes itself from inFlight — but the loop was iterating entries it
    // had already read, so it re-enqueued work that had just completed and acked. That is a
    // duplicate this method manufactured, in the one place whose whole purpose is losing nothing
    // and duplicating nothing. Re-checking membership immediately before each step closes the
    // gap the awaits opened. What remains is the instant between the last check and the enqueue
    // landing, which Node offers no way to close — a handler cannot be cancelled — and which the
    // at-least-once contract covers.
    for (const [leaseId, entry] of [...this.inFlight]) {
      if (!this.inFlight.has(leaseId)) continue;
      await this.dispatcher.ack(entry.jobClass, leaseId);
      if (!this.inFlight.has(leaseId)) continue; // it finished while the ack was in flight
      await this.dispatcher.enqueue(entry.jobClass, entry.job.workspaceId, entry.job.payload, {
        id: entry.job.id,
        idempotencyKey: entry.job.idempotencyKey,
        attempt: entry.job.attempt,
      });
      handedBack++;
    }
    if (this.runPromise) await this.runPromise;
    // Both numbers are JOBS. `drained` used to report `classes.length` — how many classes this
    // worker was configured for, which is not a fact about this shutdown at all.
    return { drained: atStart - handedBack, stillRunning: handedBack };
  }
}
