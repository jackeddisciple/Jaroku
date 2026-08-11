// Run pool — lets more than one agent process run at once, which is the precondition for
// evals (doc §5.5: "same agent × N providers × M examples simultaneously IS a distributed
// job system").
//
// Before this, the server owned exactly one ProcessManager and `runAgent` silently dropped
// any second request. That is correct for the interactive loop and useless for fan-out.
//
// The pool is a fixed set of slots, each a plain ProcessManager. Nothing about how a single
// run executes changes — same spawn, same NDJSON parsing, same control plane. What's new is
// that there are N of them, that each carries its run id on every event (a bare
// ProcessManager's `stderr`/`exit` don't say which run they came from, which was fine with
// one and ambiguous with twelve), and that a run can be given a deadline.
//
// SLOT 0 IS RESERVED FOR THE INTERACTIVE RUN. Pause/resume/branch all assume a single
// addressable run the user is driving: `pauseRun` writes a control file for it, `resumeRun`
// refuses if a run is active, branching forks its checkpoint. Reserving a slot means a
// running eval can never occupy the interactive path, and those semantics are untouched.
//
// TIMEOUTS ARE OPT-IN, and eval jobs are the reason they exist. A Python subprocess that
// hangs on a network call holds its slot forever; with a bounded pool that's a stuck eval
// with no way out. Interactive runs deliberately get NO default deadline — a user may be
// running something genuinely long, and killing it out from under them would be worse than
// the wedge it prevents.

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { LocalSubprocessSandbox, type AgentRunOptions } from "./processManager.ts";
import { RunEventBus } from "./sandbox/eventBus.ts";
import { mintRunToken, RunTokenRevocationList } from "./sandbox/runTokens.ts";
import type { RunSandbox } from "./sandbox/runSandbox.ts";
import type { TraceEvent } from "./types.ts";

/** Builds the RunSandbox a slot drives. Local by default (see sandbox/runSandbox.ts); a hosted
 *  kind is injected by the caller once one exists, so the pool never hardcodes which it runs. */
export type SandboxFactory = () => RunSandbox;
const defaultSandboxFactory: SandboxFactory = () => new LocalSubprocessSandbox();

/** How long a run token lives, once a run needs one. Not the run's own timeoutMs (an eval job's
 *  deadline) — this only has to outlast the run, so it is set generously rather than computed. */
const RUN_TOKEN_TTL_S = 60 * 60 * 2;

export interface PoolRunOptions extends AgentRunOptions {
  /** Server-minted run id, so the caller can address the run before run_start races back. */
  runId: string;
  /**
   * Which workspace this run belongs to. Optional for backward compatibility with callers that
   * have no hosted control plane to scope a token to (every existing test, and the local path);
   * REQUIRED to actually get a run token minted and registered on the event bus — see launch().
   */
  workspaceId?: string;
  /**
   * Wall-clock cap. On expiry the run is SIGTERMed, then SIGKILLed if it doesn't go, and
   * its `exit` reports `timedOut: true`. Omit for no deadline (the interactive path).
   */
  timeoutMs?: number;
  /** Set by launch() when a run token was minted — never by a caller. See RunPoolOptions. */
  controlPlane?: { url: string; runToken: string };
}

export interface RunPoolOptions {
  sandbox?: SandboxFactory;
  /** The hosted control plane's own base URL, e.g. "https://api.jaroku.example.com". Absent
   *  means no run tokens are minted at all — the local path has nothing to scope one to. */
  controlPlaneUrl?: string;
  bus?: RunEventBus;
  signingKey?: Buffer;
  revocations?: RunTokenRevocationList;
}

/** Everything the pool emits carries `runId` — with N concurrent runs, an unattributed
 *  stderr line or exit code is not actionable. */
export interface RunPoolEvents {
  event: [{ runId: string; event: TraceEvent }];
  control: [{ runId: string; ctrl: Record<string, unknown> }];
  stderr: [{ runId: string; line: string }];
  parseError: [{ runId: string; line: string; error: string }];
  exit: [{ runId: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }];
  spawnError: [{ runId: string; error: Error }];
}

interface Slot {
  index: number;
  manager: RunSandbox;
  runId: string | null;
  timer: NodeJS.Timeout | null;
  timedOut: boolean;
  /** Set only when a run token was minted for this slot's occupant, so release() knows both
   *  whether to revoke one and, since a self-contained token cannot be un-minted, until when
   *  the revocation entry itself needs to be kept around. */
  tokenExpiresAtMs: number | null;
}

/** Slot 0 is the interactive run's. Everything else is available to the eval fan-out. */
const INTERACTIVE_SLOT = 0;

export class RunPool extends EventEmitter<RunPoolEvents> {
  private slots: Slot[] = [];
  private sandbox: SandboxFactory;
  private controlPlaneUrl: string | undefined;
  private bus: RunEventBus;
  private signingKey: Buffer;
  private revocations: RunTokenRevocationList;

  /**
   * @param concurrency how many runs may execute at once IN ADDITION to the interactive
   *   one. Kept modest by default: each slot is a Python subprocess with a LangGraph import,
   *   and oversubscribing the machine makes every run slower and its latency numbers — which
   *   the comparison dashboard reports — meaningless.
   * @param opts what a slot actually runs on, and the control-plane wiring a hosted sandbox
   *   needs a run token for. Every field defaults to something that keeps the local, no-hosted-
   *   control-plane path working exactly as it did before this existed — see PoolRunOptions on
   *   why omitting `workspaceId` is what actually opts a run out of getting a token at all.
   */
  constructor(concurrency: number, opts: RunPoolOptions = {}) {
    super();
    this.sandbox = opts.sandbox ?? defaultSandboxFactory;
    this.controlPlaneUrl = opts.controlPlaneUrl;
    this.bus = opts.bus ?? new RunEventBus();
    this.signingKey = opts.signingKey ?? randomBytes(32);
    this.revocations = opts.revocations ?? new RunTokenRevocationList();
    const total = Math.max(1, concurrency) + 1; // +1 for the reserved interactive slot
    for (let i = 0; i < total; i++) this.slots.push(this.makeSlot(i));
  }

  /** The bus a hosted sandbox's control-plane routes push into — exposed so the server can wire
   *  registerControlPlaneRoutes(router, { bus: pool.eventBus, ... }) at startup. */
  get eventBus(): RunEventBus {
    return this.bus;
  }

  private makeSlot(index: number): Slot {
    const slot: Slot = {
      index,
      manager: this.sandbox(),
      runId: null,
      timer: null,
      timedOut: false,
      tokenExpiresAtMs: null,
    };

    // Attribute every event to the run that produced it. Listeners are permanent — the
    // slot's runId at emit time is the attribution, so a slot can be reused safely.
    slot.manager.on("event", (event) => {
      if (slot.runId) this.emit("event", { runId: slot.runId, event });
    });
    slot.manager.on("control", (ctrl) => {
      if (slot.runId) this.emit("control", { runId: slot.runId, ctrl });
    });
    slot.manager.on("stderr", (line) => {
      if (slot.runId) this.emit("stderr", { runId: slot.runId, line });
    });
    slot.manager.on("parseError", ({ line, error }) => {
      if (slot.runId) this.emit("parseError", { runId: slot.runId, line, error });
    });
    slot.manager.on("spawnError", (error) => {
      const runId = slot.runId;
      this.release(slot);
      if (runId) this.emit("spawnError", { runId, error });
    });
    slot.manager.on("exit", ({ code, signal }) => {
      const runId = slot.runId;
      const timedOut = slot.timedOut;
      this.release(slot);
      if (runId) this.emit("exit", { runId, code, signal, timedOut });
    });

    return slot;
  }

  private release(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    // A finished run's token is worthless to keep valid — revoke it immediately rather than
    // waiting out its own ttl, and drop the bus entry so a long-poll left in flight (a hosted
    // sandbox killed mid-request) resolves to "none" instead of leaking a pending timer.
    if (slot.runId) {
      if (slot.tokenExpiresAtMs !== null) this.revocations.revoke(slot.runId, slot.tokenExpiresAtMs);
      if (this.bus.has(slot.runId)) this.bus.unregister(slot.runId);
    }
    slot.runId = null;
    slot.timedOut = false;
    slot.tokenExpiresAtMs = null;
  }

  private launch(slot: Slot, opts: PoolRunOptions): void {
    slot.runId = opts.runId;
    slot.timedOut = false;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      slot.timer = setTimeout(() => {
        // Flag before killing so the `exit` handler can report WHY it died. Without this a
        // timeout is indistinguishable from an agent that crashed, and a stuck eval would
        // look like a flaky agent.
        slot.timedOut = true;
        slot.manager.stop(); // SIGTERM, then SIGKILL if it doesn't go
      }, opts.timeoutMs);
    }

    // A run token, and a bus entry to receive what a hosted sandbox pushes, only when there is
    // both a workspace to scope one to AND a control plane for it to be presented against —
    // the local path has neither, and PoolRunOptions.workspaceId being optional is exactly what
    // lets every existing caller keep working without minting one it has no use for.
    let spec: PoolRunOptions = opts;
    if (opts.workspaceId && this.controlPlaneUrl) {
      this.bus.register(opts.runId);
      const runToken = mintRunToken(this.signingKey, opts.runId, opts.workspaceId, RUN_TOKEN_TTL_S);
      slot.tokenExpiresAtMs = Date.now() + RUN_TOKEN_TTL_S * 1000;
      spec = { ...opts, controlPlane: { url: this.controlPlaneUrl, runToken } };
    }
    slot.manager.start(spec);
  }

  /**
   * Start the interactive run in its reserved slot. Returns false if one is already
   * running — the same refusal the single-manager path had, so nothing upstream changes.
   */
  startInteractive(opts: PoolRunOptions): boolean {
    const slot = this.slots[INTERACTIVE_SLOT]!;
    if (slot.manager.running) return false;
    this.launch(slot, opts);
    return true;
  }

  /**
   * Start a background run (an eval job) in any free non-interactive slot.
   * Returns false when the pool is saturated — the caller keeps it queued rather than
   * spawning past the cap.
   */
  tryStart(opts: PoolRunOptions): boolean {
    for (let i = INTERACTIVE_SLOT + 1; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (!slot.manager.running && slot.runId === null) {
        this.launch(slot, opts);
        return true;
      }
    }
    return false;
  }

  /** Free background slots right now. The orchestrator's dispatch budget per tick. */
  get freeSlots(): number {
    let n = 0;
    for (let i = INTERACTIVE_SLOT + 1; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (!slot.manager.running && slot.runId === null) n++;
    }
    return n;
  }

  /** Background capacity, excluding the reserved interactive slot. */
  get capacity(): number {
    return this.slots.length - 1;
  }

  /** Whether the interactive run is executing (pause/branch guards read this). */
  get interactiveRunning(): boolean {
    return this.slots[INTERACTIVE_SLOT]!.manager.running;
  }

  /** Whether ANY slot is busy. This is what gates agent edits: mutating an agent's files
   *  while a background eval is reading them would make the trace lie about what ran. */
  get busy(): boolean {
    return this.slots.some((s) => s.manager.running || s.runId !== null);
  }

  activeRunIds(): string[] {
    return this.slots.map((s) => s.runId).filter((id): id is string => id !== null);
  }

  /** Stop one run by id, if it's in the pool. */
  stop(runId: string): void {
    for (const slot of this.slots) {
      if (slot.runId === runId) slot.manager.stop();
    }
  }

  /** Stop everything — shutdown, and cancelling an eval mid-flight. */
  stopAll(): void {
    for (const slot of this.slots) slot.manager.stop();
  }
}
