// The LOCAL implementation of RunSandbox (see sandbox/runSandbox.ts): spawn/kill the Python
// LangGraph subprocess on THIS machine, read its stdout stream line-by-line, parse each line as
// a Jaroku trace event. Must survive: non-zero exit, mid-run crash, zombie processes, and
// partial/garbled lines.
//
// This is the trusted-developer's-own-machine path, and per the standing rule it is not deleted
// or degraded by the sandbox migration — `npm run dev` spawns exactly this, unchanged. A hosted
// RunSandbox satisfies the same interface from inside a per-run micro-VM with no shared disk;
// see sandbox/flySandbox.ts.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { RAILWAY_ENV_KEY } from "./railwayApi.ts";
import { BackpressureTracker, describeViolation, type BackpressureViolation } from "./sandbox/backpressure.ts";
import type { RunSandbox, SandboxEvents, SandboxSpec } from "./sandbox/runSandbox.ts";
import { isTraceEvent, type TraceEvent } from "./types.ts";

/** One instance only ever runs one thing at a time (it is a pool slot), so a fixed key —
 *  reset on every start() — is exactly as good as keying by the real run id. */
const BACKPRESSURE_KEY = "current";

// Debug-depth control plane: the runner writes one `@@JAROKU_CTRL@@ {json}` line per node
// boundary (and on pause) to STDERR — deliberately off stdout so the frozen NDJSON trace stream
// stays pure. Must match jaroku_runner/debug.py:CTRL_SENTINEL.
const CTRL_SENTINEL = "@@JAROKU_CTRL@@ ";

export interface AgentRunOptions {
  runtimeDir: string; // cwd containing the uv project (runtime/)
  input?: string; // user input passed to the agent
  env?: NodeJS.ProcessEnv; // extra env (e.g. JAROKU_PROVIDER)
  // A generated project under runtime/agents/. Omitted -> the hand-written fixture agent,
  // which is kept as a spawn path so the original pipeline stays regression-testable.
  agentId?: string;
}

/** Accepts both the pool's existing loose options and a full SandboxSpec — the local path
 *  ignores fields (limits, workspaceId) it has no use enforcing on a developer's own machine. */
export type LocalRunOptions = AgentRunOptions | SandboxSpec;

export class LocalSubprocessSandbox extends EventEmitter<SandboxEvents> implements RunSandbox {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = "";
  private stderrBuf = "";
  private backpressure = new BackpressureTracker();

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  start(opts: LocalRunOptions): void {
    if (this.running) throw new Error("agent already running");

    // Generated agents run through jaroku_runner, which owns all trace wiring; the fixture
    // traces itself. Both emit the identical event stream, so everything downstream of here
    // is unchanged.
    const args = opts.agentId
      ? ["run", "python", "-m", "jaroku_runner", opts.agentId]
      : ["run", "python", "-m", "test_agent.agent"];
    if (opts.input) args.push(opts.input);

    // uv lives in Homebrew's bin; make sure it's on PATH for the spawned process.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`,
      ...opts.env,
    };
    // The Railway token is a deploy-layer credential and no agent has any use for it. An
    // agent's own keys have to be here — a Gmail tool cannot work without them — but this one
    // does not, and generated code runs in this process. Least privilege where it is free.
    delete env[RAILWAY_ENV_KEY];

    const child = spawn("uv", args, { cwd: opts.runtimeDir, env });
    this.child = child;
    this.stdoutBuf = "";
    this.stderrBuf = "";
    this.backpressure.release(BACKPRESSURE_KEY); // a fresh budget for this run, not the last one

    child.on("error", (err) => this.emit("spawnError", err));

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.onStderr(chunk));

    child.on("exit", (code, signal) => {
      this.flushStdout(true); // drain any trailing partial line
      if (this.stderrBuf.trim()) this.emit("stderr", this.stderrBuf.trim());
      this.stderrBuf = "";
      this.child = null;
      this.emit("exit", { code, signal });
    });
  }

  private onStdout(chunk: string): void {
    // Checked on the RAW CHUNK, before it joins the buffer — a write with no newline in it
    // would otherwise accumulate in stdoutBuf forever, since flushStdout only inspects what
    // split("\n") already found. This is what actually stops "10 GB of stdout, no newline".
    const violation = this.backpressure.recordBytes(BACKPRESSURE_KEY, Buffer.byteLength(chunk, "utf8"));
    if (violation) return this.terminateForBackpressure(violation);
    this.stdoutBuf += chunk;
    this.flushStdout(false);
  }

  private terminateForBackpressure(violation: BackpressureViolation): void {
    if (!this.running) return;
    const message = `terminated: ${describeViolation(violation)}`;
    this.emit("stderr", `[jaroku] ${message}`);
    this.stdoutBuf = ""; // whatever is left unparsed is exactly the flood being refused
    this.stop(0); // SIGTERM immediately, SIGKILL with no grace — this is not a run to wait out
  }

  // Emit one event per complete line. When `final`, also process a trailing line
  // (present only if the process died without a terminating newline).
  private flushStdout(final: boolean): void {
    const lines = this.stdoutBuf.split("\n");
    this.stdoutBuf = final ? "" : (lines.pop() ?? "");
    if (final && lines.length === 0) return;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const rateViolation = this.backpressure.recordLine(BACKPRESSURE_KEY);
      if (rateViolation) return this.terminateForBackpressure(rateViolation);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        this.emit("parseError", { line, error: (e as Error).message });
        continue;
      }
      if (isTraceEvent(parsed)) {
        this.emit("event", parsed);
      } else {
        this.emit("parseError", { line, error: "not a recognized trace event" });
      }
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuf += chunk;
    const lines = this.stderrBuf.split("\n");
    this.stderrBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      // Split the debug-depth control plane out of ordinary logs. A control line is JSON after
      // the sentinel; a malformed one falls through to stderr rather than being lost.
      if (line.startsWith(CTRL_SENTINEL)) {
        try {
          this.emit("control", JSON.parse(line.slice(CTRL_SENTINEL.length)) as Record<string, unknown>);
          continue;
        } catch {
          /* fall through to stderr */
        }
      }
      this.emit("stderr", line);
    }
  }

  // Graceful stop: SIGTERM, then SIGKILL if it doesn't exit — avoids zombies.
  stop(graceMs = 2000): void {
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    const t = setTimeout(() => {
      if (this.child === child && child.exitCode === null) child.kill("SIGKILL");
    }, graceMs);
    child.once("exit", () => clearTimeout(t));
  }
}
