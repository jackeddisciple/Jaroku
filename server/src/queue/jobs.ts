// What kind of work the queue moves, as data — same reasoning as auth/capabilities.ts:
// scattering "how many of these may run at once" and "how long before we give up" across
// every call site is how two copies of the same number quietly drift. One table, one place
// that reads it.
//
// EVERY CLASS NAMED HERE IS NOT YET DISPATCHED THROUGH REDIS. `queued: true` marks the three
// this session actually routes through queue/dispatcher.ts: `run.interactive` (commit 6),
// `run.eval` (commit 7) and `judge` (also commit 7, since scoring already shares the eval's
// concurrency budget). `generate`, `plan`, `edit`, `explain` and `mcp.discover` are registered
// here — with real concurrency and timeout numbers, because the classification and the caps
// are worth writing down now — but stay on the synchronous request/response path they are on
// today. They are short, bounded operations a client is actively waiting on, not long-running
// sandboxed executions competing with other workspaces for scarce capacity; forcing them
// through an async queue this session would be a rewrite in search of a problem. Documented
// as a deliberate scope line, not a silent gap — see the Session 5 README section.

export const JOB_CLASSES = [
  "run.interactive",
  "run.eval",
  "judge",
  "generate",
  "plan",
  "edit",
  "explain",
  "mcp.discover",
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
  "mcp.discover": { label: "MCP tool discovery", globalConcurrency: null, retryable: false, queued: false },
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
