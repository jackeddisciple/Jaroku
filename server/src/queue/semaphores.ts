// Named, leased concurrency caps — the generalisation of the single global counter
// tryAdmit's own Lua script has carried since commit 3, now reusable for anything that needs
// "at most N of these at once" without needing to be fused into a fair admit.
//
// THE OLD CAPS GENERALISE, THEY DON'T DISAPPEAR (doc §S5). JAROKU_EVAL_CONCURRENCY,
// JAROKU_LIMIT_<PROVIDER> and the single reserved interactive slot were the single-user
// version of exactly this problem. `providerLimit` below is the same function evalRunner.ts
// has always had — moved here so commit 7 can import one copy instead of keeping its own —
// and `workspaceSemaphore` is the descendant of the reserved slot, now scoped per workspace
// instead of being one slot the whole server contends for.
//
// WHY THESE ARE NOT INSIDE tryAdmit's ATOMIC SCRIPT: which workspace a job belongs to is
// known before it's ever enqueued, so a workspace or provider cap can be checked by the
// caller — no race to close. tryAdmit's OWN cap is different only because which workspace it
// will serve isn't decided until the ring rotates; that decision and that check have to be
// the same atomic step, or the cap isn't real. Composing "fair admit, then a named
// semaphore" costs one extra round trip when a cap is tight; it buys a much smaller, much
// more obviously correct Lua script for every cap that doesn't have that timing problem.

import type { JobClass } from "./jobs.ts";
import { jobClassConfig } from "./jobs.ts";
import type { QueueBackend } from "./backend.ts";

export type SemaphoreScope =
  | { kind: "global" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "provider"; provider: string };

export function semaphoreKey(jobClass: JobClass, scope: SemaphoreScope): string {
  switch (scope.kind) {
    case "global":
      return `${jobClass}:global`;
    case "workspace":
      return `${jobClass}:ws:${scope.workspaceId}`;
    case "provider":
      return `${jobClass}:provider:${scope.provider}`;
  }
}

/** Per-provider ceiling on simultaneous runs. Providers rate-limit independently; eight
 *  simultaneous calls to one provider earns 429s that look like that provider being
 *  unreliable — exactly the wrong conclusion for a tool whose job is comparing providers. */
export function providerLimit(provider: string): number {
  const env = Number(process.env[`JAROKU_LIMIT_${provider.toUpperCase()}`]);
  if (Number.isFinite(env) && env > 0) return env;
  // `fake` is local and free, bounded only by the pool. Real providers default low: the
  // cost of being conservative is a slower eval, the cost of being greedy is rate-limit
  // errors misread as provider unreliability.
  return provider === "fake" ? 16 : 2;
}

/** A single named cap, bound to one backend. Thin — it exists so callers pass a `Semaphore`
 *  around instead of repeating `(backend, key, max)` at every call site. */
export class Semaphore {
  constructor(
    private backend: QueueBackend,
    readonly key: string,
    readonly max: number,
  ) {}

  acquire(leaseId: string, ttlMs: number): Promise<boolean> {
    return this.backend.acquireSemaphore(this.key, this.max, leaseId, ttlMs);
  }

  release(leaseId: string): Promise<void> {
    return this.backend.releaseSemaphore(this.key, leaseId);
  }

  count(): Promise<number> {
    return this.backend.semaphoreCount(this.key);
  }
}

/** The descendant of the single reserved interactive slot (doc §S5, commit 6): one workspace
 *  may have at most `jobClassConfig(jobClass).perWorkspaceConcurrency` of this class in
 *  flight, independent of what any other workspace is doing. */
export function workspaceSemaphore(
  backend: QueueBackend,
  jobClass: JobClass,
  workspaceId: string,
  max: number = jobClassConfig(jobClass).perWorkspaceConcurrency,
): Semaphore {
  return new Semaphore(backend, semaphoreKey(jobClass, { kind: "workspace", workspaceId }), max);
}

/** The descendant of JAROKU_LIMIT_<PROVIDER> (doc §S5, commit 7): at most `providerLimit`
 *  calls to one provider in flight across every workspace, for this job class. */
export function providerSemaphore(backend: QueueBackend, jobClass: JobClass, provider: string): Semaphore {
  return new Semaphore(backend, semaphoreKey(jobClass, { kind: "provider", provider }), providerLimit(provider));
}
