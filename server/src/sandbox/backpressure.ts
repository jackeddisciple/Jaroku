// A hostile or merely buggy agent can write arbitrarily fast and arbitrarily much — the trace
// pipeline has no way to tell "a chatty tool" from "a fork bomb writing to stdout in a loop"
// until it has already read gigabytes trying to find out. Three caps, matching the migration
// spec's own list: bytes per run, a single line's own length, and lines per second. Exceeding
// any one of them is a terminal run error, deliberately — not a slowdown, not a silent drop.
//
// THE SAME LIMITER SERVES BOTH TRANSPORTS. A local run's stdout and a hosted run's HTTP push
// are the same risk wearing two shapes, and a violation should mean the same thing regardless
// of which one carried it — see processManager.ts's flushStdout and
// controlPlaneRoutes.ts's handleTrace, the two call sites.

const DEFAULT_MAX_BYTES_PER_RUN = 64 * 1024 * 1024; // 64 MB — generous for any real trace
const DEFAULT_MAX_LINE_BYTES = 1 * 1024 * 1024; // 1 MB — no single event legitimately needs more
const DEFAULT_MAX_LINES_PER_SECOND = 200;

export interface BackpressureLimits {
  maxBytesPerRun: number;
  maxLineBytes: number;
  maxLinesPerSecond: number;
}

export const DEFAULT_BACKPRESSURE_LIMITS: BackpressureLimits = {
  maxBytesPerRun: DEFAULT_MAX_BYTES_PER_RUN,
  maxLineBytes: DEFAULT_MAX_LINE_BYTES,
  maxLinesPerSecond: DEFAULT_MAX_LINES_PER_SECOND,
};

export type BackpressureViolation =
  | { kind: "line_too_long"; bytes: number; limit: number }
  | { kind: "bytes_per_run_exceeded"; bytes: number; limit: number }
  | { kind: "rate_exceeded"; linesInWindow: number; limit: number };

interface RunUsage {
  totalBytes: number;
  windowStartMs: number;
  linesInWindow: number;
}

/** Tracks byte/line/rate usage per run and refuses once any cap is crossed. Once a run has been
 *  refused it stays refused — see `record`'s note on why a violator does not get to recover. */
export class BackpressureTracker {
  private usage = new Map<string, RunUsage>();
  private violated = new Set<string>();

  constructor(private limits: BackpressureLimits = DEFAULT_BACKPRESSURE_LIMITS) {}

  private now(): number {
    return Date.now();
  }

  private usageFor(runId: string): RunUsage {
    let usage = this.usage.get(runId);
    if (!usage) {
      usage = { totalBytes: 0, windowStartMs: this.now(), linesInWindow: 0 };
      this.usage.set(runId, usage);
    }
    return usage;
  }

  /**
   * Check one write of `bytes` for `runId` — a raw stdout chunk locally, or one HTTP request's
   * declared body size hosted. Catches both a single oversized write AND sustained flooding
   * across many small ones, which is why it is called on every write rather than only on a
   * completed line: a 10 GB write with no newline in it would otherwise never reach the line
   * parser at all.
   */
  recordBytes(runId: string, bytes: number): BackpressureViolation | null {
    // A run that has already violated stays refused for its own remaining lifetime. Without
    // this, a caller that keeps writing after the first violation (a stdout stream that does
    // not stop just because this function said no) would report the SAME violation once and
    // then quietly start admitting again the moment the one-second rate window rolled over —
    // which is not "capped", it is "capped for one second".
    if (this.violated.has(runId)) {
      return { kind: "bytes_per_run_exceeded", bytes, limit: this.limits.maxBytesPerRun };
    }
    if (bytes > this.limits.maxLineBytes) {
      this.violated.add(runId);
      return { kind: "line_too_long", bytes, limit: this.limits.maxLineBytes };
    }
    const usage = this.usageFor(runId);
    usage.totalBytes += bytes;
    if (usage.totalBytes > this.limits.maxBytesPerRun) {
      this.violated.add(runId);
      return { kind: "bytes_per_run_exceeded", bytes: usage.totalBytes, limit: this.limits.maxBytesPerRun };
    }
    return null;
  }

  /** Check one parsed line/event against the lines-per-second cap. Separate from recordBytes
   *  because chunks and lines are different units — a raw stdout read rarely lines up with one
   *  logical line, so rate has to be measured on the thing actually being rate-limited. */
  recordLine(runId: string): BackpressureViolation | null {
    if (this.violated.has(runId)) {
      return { kind: "rate_exceeded", linesInWindow: this.limits.maxLinesPerSecond + 1, limit: this.limits.maxLinesPerSecond };
    }
    const usage = this.usageFor(runId);
    const elapsed = this.now() - usage.windowStartMs;
    if (elapsed >= 1000) {
      usage.windowStartMs = this.now();
      usage.linesInWindow = 0;
    }
    usage.linesInWindow++;
    if (usage.linesInWindow > this.limits.maxLinesPerSecond) {
      this.violated.add(runId);
      return { kind: "rate_exceeded", linesInWindow: usage.linesInWindow, limit: this.limits.maxLinesPerSecond };
    }
    return null;
  }

  hasViolated(runId: string): boolean {
    return this.violated.has(runId);
  }

  /** Called once a run is over — local and stopped, or removed from the bus. Without this a
   *  long-lived server accumulates one entry per run forever. */
  release(runId: string): void {
    this.usage.delete(runId);
    this.violated.delete(runId);
  }
}

export function describeViolation(v: BackpressureViolation): string {
  switch (v.kind) {
    case "line_too_long":
      return `a single line was ${v.bytes} bytes, over the ${v.limit}-byte cap`;
    case "bytes_per_run_exceeded":
      return `this run has written ${v.bytes} bytes total, over the ${v.limit}-byte-per-run cap`;
    case "rate_exceeded":
      return `this run wrote ${v.linesInWindow} lines in one second, over the ${v.limit}/s cap`;
  }
}
