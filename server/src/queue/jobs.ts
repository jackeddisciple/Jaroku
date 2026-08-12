// What kind of work the queue moves, as data — same reasoning as auth/capabilities.ts:
// scattering "how many of these may run at once" and "how long before we give up" across
// every call site is how two copies of the same number quietly drift. One table, one place
// that reads it.
//
// `queued: true` MARKS WHAT ACTUALLY GOES THROUGH queue/dispatcher.ts. Session 5 routed three:
// `run.interactive`, `run.eval` and `judge`. Session 7 adds a fourth, `mcp.discover`, and the
// reason is the one Session 5's own note anticipated by calling the rest "short, bounded
// operations a client is actively waiting on".
//
// A DISCOVERY IS NOT ONE OF THOSE, and it is the only registered class that never was. It is a
// network round trip to a THIRD PARTY nobody here controls — not a call to a model provider we
// have a contract with, but whatever endpoint a user typed — and its worst case is bounded only
// by the timeouts mcpClient.ts imposes on itself. Thirty seconds of a request handler is fine
// with one user and is a hundred concurrent pending fetches when a popular MCP endpoint has a
// bad afternoon and every workspace that connected it retries at once. See mcpDiscovery.ts.
//
// `generate`, `plan`, `edit` and `explain` stay synchronous, and stay registered here for their
// numbers. They are calls to a provider on a request a client is actively waiting on, and
// forcing them through an async queue would still be a rewrite in search of a problem.

export const JOB_CLASSES = [
  "run.interactive",
  "run.eval",
  "judge",
  "generate",
  "plan",
  "edit",
  "explain",
  "mcp.discover",
  // Session 8. A workspace asking for everything it has: not latency-critical, not retryable in
  // the queue's sense, and the only class whose OUTPUT is an object rather than a trace.
  "workspace.export",
] as const;

export type JobClass = (typeof JOB_CLASSES)[number];

export function isJobClass(v: string): v is JobClass {
  return (JOB_CLASSES as readonly string[]).includes(v);
}

export interface JobClassConfig {
  /** Human-readable, for logs and the load-test report. */
  label: string;
  /** How many of this class may run at once FOR ONE WORKSPACE. The per-workspace reservation
   *  every later commit in this session builds on. */
  perWorkspaceConcurrency: number;
  /** How many of this class may run at once ACROSS EVERY WORKSPACE. `null` means "bounded
   *  only by the worker pool that drains it" — true today of run.eval and judge, whose actual
   *  ceiling is how many pool slots a worker process was started with. */
  globalConcurrency: number | null;
  /** Wall-clock deadline for one attempt. `null` means no default deadline — true only of
   *  run.interactive, for the same reason the pre-Session-5 pool gave the interactive slot
   *  none: a user may be running something genuinely long, and killing it out from under them
   *  is worse than the wedge a deadline prevents. */
  timeoutMs: number | null;
  /** Whether a failed attempt is worth retrying at all. Interactive runs are not: a user who
   *  is watching a run fail wants to see that it failed, not have the platform silently spend
   *  their money again on their behalf. */
  retryable: boolean;
  /** See the file header. Only these three are routed through queue/dispatcher.ts this
   *  session; the rest are registered for their numbers and stay synchronous. */
  queued: boolean;
}

/** `JAROKU_JOB_TIMEOUT_MS_<CLASS>` overrides a class's default, e.g.
 *  `JAROKU_JOB_TIMEOUT_MS_RUN_EVAL=120000`. Falls through to the class's own default, which
 *  itself may be `null` (no deadline). */
function timeoutFromEnv(jobClass: JobClass, fallbackMs: number | null): number | null {
  const key = `JAROKU_JOB_TIMEOUT_MS_${jobClass.toUpperCase().replace(/[.\-]/g, "_")}`;
  const raw = process.env[key];
  if (raw === undefined) return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

function concurrencyFromEnv(jobClass: JobClass, fallback: number): number {
  return positiveFromEnv(`JAROKU_WORKSPACE_CONCURRENCY_${jobClass.toUpperCase().replace(/[.\-]/g, "_")}`, fallback);
}

/** How a numeric env override is read, everywhere in this file. Rejecting NaN, zero and negatives
 *  alike matters: `Number(undefined)` and `Number("")` and `Number("lots")` all have to fall
 *  through to the default rather than becoming a concurrency of zero, which admits nothing ever. */
function positiveFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Static defaults. Env overrides are resolved lazily by jobClassConfig() below so tests can
 *  vary process.env without re-importing the module — which is why the per-class tables here
 *  are FUNCTIONS of the environment rather than values read at import. Three of them used to be
 *  values (`JAROKU_JUDGE_CONCURRENCY`, `JAROKU_JOB_TIMEOUT_MS`, `JAROKU_MCP_DISCOVERY_MS`), so
 *  those three alone were frozen at the first import in the process, contradicting the sentence
 *  immediately above them. */
const DEFAULTS: Record<JobClass, Omit<JobClassConfig, "perWorkspaceConcurrency" | "timeoutMs">> = {
  "run.interactive": {
    label: "an interactive run",
    globalConcurrency: null,
    retryable: false,
    queued: true,
  },
  "run.eval": {
    label: "an eval fan-out job",
    globalConcurrency: null,
    retryable: true,
    queued: true,
  },
  judge: {
    label: "a judge scoring call",
    globalConcurrency: null,
    retryable: true,
    queued: true,
  },
  generate: { label: "agent generation", globalConcurrency: null, retryable: false, queued: false },
  plan: { label: "the plan gate", globalConcurrency: null, retryable: false, queued: false },
  edit: { label: "the fix loop", globalConcurrency: null, retryable: false, queued: false },
  explain: { label: "an explain answer", globalConcurrency: null, retryable: false, queued: false },
  // NOT RETRYABLE, and that is not an oversight about a network call. `mcpClient.discover`
  // classifies every failure and RETURNS rather than throwing — an unreachable server is a
  // recorded status, not an exception — so there is nothing here for a queue-level retry to
  // improve. A user pressing Re-discover is the retry, and it is the one that knows whether the
  // server has been fixed.
  "mcp.discover": { label: "MCP tool discovery", globalConcurrency: null, retryable: false, queued: true },
  // NOT RETRYABLE, for a different reason from mcp.discover's: an export reads a workspace's
  // whole history and writes one object, so a retry is not a cheap second attempt — it is the
  // same expensive read again, and the failure that killed the first is almost always the
  // database being unavailable, which a retry moments later shares. The person asked for it and
  // can ask again. GLOBALLY CAPPED at four, because this is the only class that can read
  // millions of rows on one connection, and a platform where every workspace exports at once is
  // a platform where nothing else gets a connection.
  "workspace.export": { label: "a workspace export", globalConcurrency: 4, retryable: false, queued: true },
};

const PER_WORKSPACE_DEFAULT: Record<JobClass, () => number> = {
  // The descendant of slot 0: one interactive run per workspace by default, same as today's
  // single reserved slot, just no longer a single GLOBAL slot every workspace contends for.
  "run.interactive": () => 1,
  // Free-tier-shaped default. A paid workspace overriding this is Session 6's plan-driven
  // concurrency (doc §S6); this session's caps are flat and env-overridable, not plan-aware.
  "run.eval": () => 2,
  judge: () => positiveFromEnv("JAROKU_JUDGE_CONCURRENCY", 4),
  generate: () => 1,
  plan: () => 2,
  edit: () => 1,
  explain: () => 4,
  "mcp.discover": () => 2,
  // One at a time per workspace. Two exports of the same workspace produce two copies of the
  // same bytes, and the second is always the one somebody actually waits for.
  "workspace.export": () => 1,
};

const TIMEOUT_DEFAULT_MS: Record<JobClass, () => number | null> = {
  "run.interactive": () => null,
  "run.eval": () => positiveFromEnv("JAROKU_JOB_TIMEOUT_MS", 180_000),
  judge: () => 60_000,
  generate: () => 120_000,
  plan: () => 60_000,
  edit: () => 120_000,
  explain: () => 30_000,
  "mcp.discover": () => positiveFromEnv("JAROKU_MCP_DISCOVERY_MS", 30_000),
  // Ten minutes. An export of a workspace with a year of traces is genuinely slow, and the
  // deadline is here to catch a wedge rather than to bound the work.
  "workspace.export": () => positiveFromEnv("JAROKU_EXPORT_TIMEOUT_MS", 600_000),
};

export function jobClassConfig(jobClass: JobClass): JobClassConfig {
  const base = DEFAULTS[jobClass];
  return {
    ...base,
    perWorkspaceConcurrency: concurrencyFromEnv(jobClass, PER_WORKSPACE_DEFAULT[jobClass]()),
    timeoutMs: timeoutFromEnv(jobClass, TIMEOUT_DEFAULT_MS[jobClass]()),
  };
}

/** One unit of work on the queue. `payload` is opaque to the dispatcher — it exists to get a
 *  job admitted and back to whoever enqueued it, not to interpret it. */
export interface QueueJob<T = unknown> {
  id: string;
  class: JobClass;
  workspaceId: string;
  /** See buildIdempotencyKey. Two enqueues with the same key are the same unit of work. */
  idempotencyKey: string;
  enqueuedAt: string;
  attempt: number;
  payload: T;
  /**
   * The W3C `traceparent` of whatever enqueued this, or absent.
   *
   * ON THE JOB RATHER THAN IN THE PAYLOAD, because it is not part of the work — it is how the
   * work is joined to the request that asked for it. A worker in another process has nothing
   * else to go on: no socket, no request, no memory of the gateway that took the call, and four
   * unrelated log streams describing one second of somebody's afternoon. See obs/trace.ts.
   *
   * Optional, so every existing enqueue and every job already sitting in a queue when this
   * deploys keeps working — a job with no traceparent starts a trace of its own rather than
   * failing to be admitted.
   */
  traceparent?: string;
}

/**
 * A deterministic key for "this is the same piece of work, however many times it's enqueued."
 *
 * Needed because at-least-once dispatch is the only kind that survives a crash between
 * "admitted" and "acknowledged" (see queue/dispatcher.ts's reserved-key reliability pattern):
 * a worker that dies mid-job leaves its lease to expire, and whatever reclaims it re-enqueues
 * the SAME job rather than a new one. `parts` is whatever makes an attempt unique within its
 * class — an eval job's id and attempt number, a run's id — never anything that changes on
 * every retry of the same conceptual work.
 */
export function buildIdempotencyKey(jobClass: JobClass, ...parts: string[]): string {
  return [jobClass, ...parts].join(":");
}
