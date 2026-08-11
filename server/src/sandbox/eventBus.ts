// The transport a hosted run's control plane actually rides on.
//
// Locally, a run's stdout is a pipe this process reads directly — that is all
// LocalSubprocessSandbox is. Hosted, the sandbox is a micro-VM on another machine with no
// shared disk and, per the egress policy, no route to anything but the control plane itself.
// So the runner PUSHES instead of being read from: trace events and control lines arrive as
// HTTP requests (controlPlane.ts turns them into calls here), and the one thing that flows the
// other way — pause/resume/mcp-confirm — is answered through a long-poll rather than a file a
// remote filesystem cannot share.
//
// RunEventBus is the seam in between: one instance per server process, one entry per run in
// flight, and the exact same shape RunSandbox already emits (event/control/stderr/exit) on the
// way out. A hosted RunSandbox implementation is a thin adapter around this plus the Machines
// API calls that provision and tear down the VM; see flySandbox.ts.

import { EventEmitter } from "node:events";
import type { SandboxEvents } from "./runSandbox.ts";
import type { TraceEvent } from "../types.ts";

/** What the server may tell a waiting runner to do next. `"none"` on a long-poll that simply
 *  timed out with nothing new — the runner asks again, which is the whole of the "poll" part. */
export type ControlAction =
  | { action: "none" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "mcp-confirm"; nonce: string; verdict: "run" | "once" | "deny" };

interface PendingWaiter {
  resolve: (a: ControlAction) => void;
  timer: NodeJS.Timeout;
}

interface RunEntry {
  emitter: EventEmitter<SandboxEvents>;
  /** Actions queued for the runner's NEXT long-poll, drained in order. */
  queue: ControlAction[];
  waiters: PendingWaiter[];
}

const DEFAULT_LONG_POLL_MS = 25_000;

export class RunEventBus {
  private runs = new Map<string, RunEntry>();

  /** Start tracking a run. Idempotent — a duplicate register is a no-op rather than an error,
   *  since a retried provisioning call must not orphan the first entry's listeners. */
  register(runId: string): EventEmitter<SandboxEvents> {
    let entry = this.runs.get(runId);
    if (!entry) {
      entry = { emitter: new EventEmitter<SandboxEvents>(), queue: [], waiters: [] };
      this.runs.set(runId, entry);
    }
    return entry.emitter;
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** Stop tracking a run and release anything still waiting on it. Called once the run has
   *  exited — see the "release everything" note on why an unbounded number of these must not
   *  accumulate for a bus that outlives the server process's whole uptime. */
  unregister(runId: string): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    for (const w of entry.waiters) {
      clearTimeout(w.timer);
      w.resolve({ action: "none" });
    }
    entry.waiters = [];
    this.runs.delete(runId);
  }

  // --- inbound: the runner pushing what it observed -----------------------------------------

  pushTrace(runId: string, event: TraceEvent): void {
    this.runs.get(runId)?.emitter.emit("event", event);
  }

  pushParseError(runId: string, err: { line: string; error: string }): void {
    this.runs.get(runId)?.emitter.emit("parseError", err);
  }

  pushStderr(runId: string, line: string): void {
    this.runs.get(runId)?.emitter.emit("stderr", line);
  }

  pushControlLine(runId: string, ctrl: Record<string, unknown>): void {
    this.runs.get(runId)?.emitter.emit("control", ctrl);
  }

  reportExit(runId: string, exit: { code: number | null; signal: NodeJS.Signals | null; oom?: boolean; timedOut?: boolean }): void {
    this.runs.get(runId)?.emitter.emit("exit", exit);
  }

  // --- outbound: the server telling a waiting runner what to do next ------------------------

  /** Queue an action for the run's next long-poll, waking anyone already waiting immediately —
   *  a pause request must not sit unseen for up to DEFAULT_LONG_POLL_MS just because the
   *  runner's poll happened to already be in flight when it was requested. */
  signal(runId: string, action: ControlAction): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    const waiter = entry.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(action);
      return;
    }
    entry.queue.push(action);
  }

  /**
   * The runner's long-poll: return immediately if something is already queued, otherwise wait
   * up to `timeoutMs` and resolve to `{action:"none"}` if nothing arrives — the runner asks
   * again, which is what keeps this a poll rather than an open-ended hang.
   */
  async waitForControl(runId: string, timeoutMs = DEFAULT_LONG_POLL_MS): Promise<ControlAction> {
    const entry = this.runs.get(runId);
    if (!entry) return { action: "none" };
    const queued = entry.queue.shift();
    if (queued) return queued;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.waiters = entry.waiters.filter((w) => w.resolve !== resolve);
        resolve({ action: "none" });
      }, timeoutMs);
      entry.waiters.push({ resolve, timer });
    });
  }
}
