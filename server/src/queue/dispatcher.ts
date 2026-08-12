// The fair dispatcher. Everything above this file is storage; this is the API the rest of
// the server actually calls — enqueue work, ask to admit the next piece of it, and let a
// backend answer both fairly.
//
// "Fair" has one meaning here: round-robin BY WORKSPACE, not by job. A workspace that enqueues
// five hundred eval jobs and a workspace that enqueues one both get served in turn — the five
// hundred don't get to occupy every other admit just because they arrived first or in bulk.
// That is the entire point of Session 5 (doc: "many workspaces sharing finite capacity without
// any one of them degrading the others"), and it is enforced by the backend's ring, not by
// this file — this file just gives it a job to enqueue and asks for the next one back.

import { randomUUID } from "node:crypto";
import { jobClassConfig, type JobClass, type QueueJob } from "./jobs.ts";
import type { QueueBackend } from "./backend.ts";
import { InMemoryQueueBackend } from "./inMemoryBackend.ts";
import { RedisQueueBackend } from "./redisBackend.ts";
import { openRedis, redisUrlFromEnv } from "./redis.ts";

export interface Admission<T> {
  job: QueueJob<T>;
  leaseId: string;
}

export interface AdmitOverrides {
  leaseId?: string;
  leaseTtlMs?: number;
  maxGlobalInFlight?: number | null;
}

export class Dispatcher {
  /**
   * @param traceparent Where a job's `traceparent` comes from when the caller does not pass one.
   *
   * INJECTED, so this file still does not know what a span is — it knows that a job belongs to
   * whatever asked for it and that somebody else can name that thing. index.ts supplies the
   * tracer's ambient context; a test supplies a constant; a caller with a span in hand overrides
   * both by passing `opts.traceparent` explicitly.
   *
   * It exists because the alternative did not happen. `QueueJob.traceparent` was optional so
   * that existing enqueues kept working, and every enqueue stayed existing: no caller ever
   * passed one, so every job began a trace of its own and the four tiers this session joined
   * together came apart again at the queue.
   */
  constructor(
    private backendImpl: QueueBackend,
    private traceparent: () => string | undefined = () => undefined,
  ) {}

  /** The underlying storage — exposed for callers that need a generic semaphore too (see
   *  queue/semaphores.ts), so they share the same backend instance rather than opening a
   *  second Redis connection for what is, underneath, the same store. */
  get backend(): QueueBackend {
    return this.backendImpl;
  }

  /** Put one piece of work at the tail of `workspaceId`'s queue for `jobClass`. */
  async enqueue<T>(
    jobClass: JobClass,
    workspaceId: string,
    payload: T,
    opts: { id?: string; idempotencyKey?: string; attempt?: number; traceparent?: string } = {},
  ): Promise<QueueJob<T>> {
    const id = opts.id ?? randomUUID();
    const traceparent = opts.traceparent ?? this.traceparent();
    const job: QueueJob<T> = {
      id,
      class: jobClass,
      workspaceId,
      idempotencyKey: opts.idempotencyKey ?? `${jobClass}:${id}`,
      enqueuedAt: new Date().toISOString(),
      attempt: opts.attempt ?? 1,
      payload,
      // Carried, never generated here. The dispatcher does not know what a span is; it knows
      // that a job belongs to whatever asked for it, and this is that string — passed by a
      // caller that has one, and otherwise asked for. Still absent when there is nothing to
      // carry: a job enqueued by a boot-time sweep or a timer has no parent, and inventing one
      // would join unrelated work into a trace that describes nothing.
      ...(traceparent ? { traceparent } : {}),
    };
    await this.backend.enqueue(job as QueueJob);
    return job;
  }

  /**
   * Admit the next fairly-chosen job of this class, if capacity allows.
   *
   * Lease defaults come from the class's own config: the TTL is the class's timeout plus a
   * margin (so a legitimately slow job doesn't get reaped while a worker is still running it
   * fair and square), and the cap is the class's own global concurrency figure. Both are
   * overridable — commit 4 layers workspace- and provider-scoped caps on top of this same
   * call by passing a tighter `maxGlobalInFlight` per attempt where that makes sense, and the
   * worker passes its own lease TTL when it knows better than the class default.
   */
  async tryAdmit<T>(jobClass: JobClass, overrides: AdmitOverrides = {}): Promise<Admission<T> | null> {
    const cfg = jobClassConfig(jobClass);
    const leaseId = overrides.leaseId ?? randomUUID();
    const leaseTtlMs = overrides.leaseTtlMs ?? (cfg.timeoutMs !== null ? cfg.timeoutMs + 30_000 : 5 * 60_000);
    const maxGlobalInFlight =
      overrides.maxGlobalInFlight !== undefined ? overrides.maxGlobalInFlight : cfg.globalConcurrency;
    const job = await this.backend.tryAdmit(jobClass, { leaseId, leaseTtlMs, maxGlobalInFlight });
    if (!job) return null;
    return { job: job as QueueJob<T>, leaseId };
  }

  ack(jobClass: JobClass, leaseId: string): Promise<void> {
    return this.backend.ack(jobClass, leaseId);
  }

  reapExpired(jobClass: JobClass): Promise<QueueJob[]> {
    return this.backend.reapExpired(jobClass);
  }

  pendingCount(jobClass: JobClass, workspaceId: string): Promise<number> {
    return this.backend.pendingCount(jobClass, workspaceId);
  }

  ringOrder(jobClass: JobClass): Promise<string[]> {
    return this.backend.ringOrder(jobClass);
  }

  inFlightCount(jobClass: JobClass): Promise<number> {
    return this.backend.inFlightCount(jobClass);
  }

  purgePending(jobClass: JobClass, workspaceId: string, idempotencyKeys: Set<string>): Promise<number> {
    return this.backend.purgePending(jobClass, workspaceId, idempotencyKeys);
  }
}

/** JAROKU_REDIS_URL set -> Redis, so a worker process actually shares state with the
 *  gateway. Unset -> in-memory, so `npm run dev` and every suite keep needing nothing
 *  installed. The same default/override shape as openDb() in db/open.ts. */
export function defaultQueueBackend(opts: { url?: string; env?: NodeJS.ProcessEnv } = {}): QueueBackend {
  const url = redisUrlFromEnv(opts);
  if (!url) return new InMemoryQueueBackend();
  return new RedisQueueBackend(openRedis({ url }));
}
