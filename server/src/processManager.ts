// Process manager (doc §8, 🔴): spawn/kill the Python LangGraph subprocess, read its
// stdout stream line-by-line, parse each line as a Jaroku trace event. Must survive: non-zero
// exit, mid-run crash, zombie processes, and partial/garbled lines.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { RAILWAY_ENV_KEY } from "./railwayApi.ts";
import { isTraceEvent, type TraceEvent } from "./types.ts";

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

// Typed events emitted by the manager.
export interface ProcessManagerEvents {
  event: [TraceEvent]; // a well-formed trace event
  parseError: [{ line: string; error: string }]; // a stdout line that wasn't valid JSON/event
  stderr: [string]; // human logs from the agent
  control: [Record<string, unknown>]; // debug-depth boundary/paused control event (off stdout)
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
  spawnError: [Error];
}

export class ProcessManager extends EventEmitter<ProcessManagerEvents> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = "";
  private stderrBuf = "";

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  start(opts: AgentRunOptions): void {
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
    this.stdoutBuf += chunk;
    this.flushStdout(false);
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
