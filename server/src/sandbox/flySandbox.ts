// The hosted RunSandbox: one Fly Machine per run, torn down the moment it exits.
//
// Everything this module adds on top of flyApi.ts's raw calls: turning a SandboxSpec into a
// machine config (the image pinned by digest, resources from SandboxLimits, the run's control-
// plane credentials and project archive URL as env and nothing else), piping what the runner
// pushes through RunEventBus back out as this instance's own RunSandbox events (so RunPool's
// existing per-slot listeners need not know or care that nothing here is a local pipe), and
// polling Fly for the one thing it cannot be pushed — the machine's own exit, including
// whether it was OOM-killed, which only the host supervising the VM can know.

import { EventEmitter } from "node:events";
import {
  createMachine,
  destroyMachine,
  getLastExit,
  getMachine,
  signalMachine,
  waitForState,
  type FlyMachineConfig,
} from "./flyApi.ts";
import type { RunEventBus } from "./eventBus.ts";
import { requireDigestPinnedImage } from "./image.ts";
import type { RunSandbox, SandboxEvents, SandboxSpec } from "./runSandbox.ts";

const DEFAULT_LIMITS = { cpuMillis: 1000, memoryMb: 512, pids: 256, wallClockSec: 600, diskMb: 0 };

/** How often to ask Fly whether the machine has stopped, by default. Not a long-poll — the
 *  Machines API has none for state changes beyond the boot wait, so this is an ordinary poll. */
const DEFAULT_EXIT_POLL_MS = 2_000;

export interface FlySandboxOptions {
  app: string;
  bus: RunEventBus;
  image: string; // digest-pinned — checked here too, not just trusted from the caller
  /** Overridable so a test can detect an exit in milliseconds rather than racing a real
   *  operator-facing poll cadence against the wall clock. */
  exitPollMs?: number;
}

export class FlyMachinesSandbox extends EventEmitter<SandboxEvents> implements RunSandbox {
  private machineId: string | null = null;
  private runId: string | null = null;
  private polling: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Set when stop() is called before createMachine() has even resolved — there is no machine
   *  id yet to signal. Provisioning still finishes (a machine mid-creation cannot be cancelled
   *  through this API), but launch() checks this the moment an id exists and signals it
   *  immediately instead of silently doing nothing, which is what stop() calling into a still-
   *  null machineId used to mean. */
  private stopRequested = false;

  constructor(private opts: FlySandboxOptions) {
    super();
    requireDigestPinnedImage(opts.image);
  }

  get running(): boolean {
    return this.machineId !== null && !this.stopped;
  }

  start(spec: SandboxSpec): void {
    if (this.running) throw new Error("this sandbox is already running a machine");
    this.stopped = false;
    this.stopRequested = false;
    void this.launch(spec).catch((err) => {
      this.stopped = true;
      if (this.polling) {
        clearInterval(this.polling);
        this.polling = null;
      }
      this.emit("spawnError", err instanceof Error ? err : new Error(String(err)));
    });
  }

  private async launch(spec: SandboxSpec): Promise<void> {
    this.runId = spec.runId;
    // The bus is what a hosted run's control-plane HTTP routes push INTO; this sandbox
    // instance is what RunPool listens ON. Piping one onto the other is the whole of how a
    // pushed trace event, control line or parse error reaches the pool identically to how a
    // local pipe's data would.
    const emitter = this.opts.bus.register(spec.runId);
    emitter.on("event", (e) => this.emit("event", e));
    emitter.on("control", (c) => this.emit("control", c));
    emitter.on("stderr", (l) => this.emit("stderr", l));
    emitter.on("parseError", (e) => this.emit("parseError", e));

    const limits = { ...DEFAULT_LIMITS, ...spec.limits };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.env ?? {})) if (v !== undefined) env[k] = v;
    env.JAROKU_RUN_ID = spec.runId;
    if (spec.workspaceId) env.JAROKU_WORKSPACE_ID = spec.workspaceId;
    if (spec.controlPlane) {
      env.JAROKU_CONTROL_PLANE_URL = spec.controlPlane.url;
      env.JAROKU_RUN_TOKEN = spec.controlPlane.runToken;
    }
    if (spec.files) env.JAROKU_PROJECT_TAR_URL = spec.files.presignedTarUrl;

    const command = spec.agentId
      ? ["uv", "run", "python", "-m", "jaroku_runner", spec.agentId, ...(spec.input ? [spec.input] : [])]
      : ["uv", "run", "python", "-m", "test_agent.agent", ...(spec.input ? [spec.input] : [])];

    const config: FlyMachineConfig = {
      image: this.opts.image,
      guest: {
        cpu_kind: "shared",
        cpus: Math.max(1, Math.ceil(limits.cpuMillis / 1000)),
        memory_mb: limits.memoryMb,
      },
      // boot.py is the image's fixed ENTRYPOINT (sandbox/Dockerfile); everything after "--" is
      // the command it execs once the project archive is extracted. See boot.py's own argv
      // handling for why the separator is required rather than inferred.
      init: { cmd: ["--", ...command] },
      env,
      restart: { policy: "no" }, // a crashed run is a finished run, not one Fly should retry
      auto_destroy: true, // Fly itself reclaims the machine once stopped — belt and braces
      stop_config: { timeout: `${limits.wallClockSec}s` },
    };

    const machine = await createMachine(this.opts.app, `jaroku-run-${spec.runId}`, config);
    this.machineId = machine.id;
    this.pollForExit(machine.id); // started before the stop check, so an exit is still reported
    // A stop() that arrived while createMachine() was still in flight had no id to signal and
    // recorded the request instead of silently doing nothing — honour it now that one exists,
    // rather than letting a stop issued a moment too early boot and run to completion anyway.
    if (this.stopRequested) {
      this.stop();
      return;
    }
    await waitForState(this.opts.app, machine, "started");
  }

  private pollForExit(machineId: string): void {
    this.polling = setInterval(() => {
      void (async () => {
        try {
          const machine = await getMachine(this.opts.app, machineId);
          if (machine.state !== "stopped" && machine.state !== "destroyed") return;
          if (this.polling) clearInterval(this.polling);
          this.polling = null;
          this.stopped = true;
          const exit = await getLastExit(this.opts.app, machineId).catch(() => null);
          this.emit("exit", {
            code: exit?.exit_code ?? null,
            signal: null,
            oom: exit?.oom_killed ?? false,
            timedOut: false,
          });
          if (this.runId) this.opts.bus.unregister(this.runId);
          void destroyMachine(this.opts.app, machineId).catch(() => {
            /* auto_destroy already asked Fly to do this; a failed explicit destroy is not fatal */
          });
        } catch {
          // A transient Fly API hiccup mid-poll is not this run's failure — try again next tick
          // rather than reporting an exit nobody actually observed.
        }
      })();
    }, this.opts.exitPollMs ?? DEFAULT_EXIT_POLL_MS);
  }

  stop(graceMs = 5_000): void {
    if (this.stopped) return;
    const id = this.machineId;
    if (!id) {
      // createMachine() is still in flight — there is no id yet to signal. launch() checks
      // this the moment one exists and calls stop() again itself; see its own note on why a
      // stop issued in this narrow window must not silently do nothing.
      this.stopRequested = true;
      return;
    }
    void signalMachine(this.opts.app, id, "SIGTERM").catch(() => {});
    setTimeout(() => {
      if (!this.stopped) void signalMachine(this.opts.app, id, "SIGKILL").catch(() => {});
    }, graceMs);
  }
}
