// Running a SHORT-LIVED check against untrusted, model-written code — the import check
// (validator.ts) and graph introspection (graphIntrospect.ts) both need exactly this, and
// neither is "run an agent": there is no trace, no control plane, no egress beyond nothing at
// all. Both used to reach straight for node:child_process.spawn, which is the exact thing the
// migration spec's new invariant refuses: "No generated code executes on the control plane —
// not for validation, not for graph introspection, not for the import check."
//
// CodeCheckSandbox is that seam, the same way RunSandbox is one for a full agent run. Naming it
// separately from RunSandbox rather than forcing this through the same interface is deliberate:
// a check has no runId to attribute events to, produces one stdout blob and an exit code rather
// than a stream of trace events, and is done in twenty seconds — trying to describe it with
// SandboxSpec's controlPlane/egress/limits fields would be describing a shape that does not fit.
//
// THE LOCAL IMPLEMENTATION IS BYTE-IDENTICAL TO WHAT validator.ts AND graphIntrospect.ts
// ALREADY DID. This commit's whole point is the interface, not a behaviour change — `npm run
// dev` still runs the check as a `uv run python` subprocess on this machine, unchanged. A
// hosted implementation runs the identical command inside the same reviewed sandbox image
// (sandbox/Dockerfile already ships jaroku_runner and Python) rather than on the control plane;
// building that concrete Fly-backed executor is the one piece of this invariant left as a
// documented follow-up rather than shipped here — see the sandbox escape suite's own note on
// what it does and does not yet prove.

import { spawn } from "node:child_process";

/**
 * The most either stream may produce before the check is killed.
 *
 * A check runs UNTRUSTED, MODEL-WRITTEN CODE — that is the whole premise of this module — and
 * "10 GB stdout" is one of the named cases in the sandbox escape suite. A run's stdout has had a
 * cap since backpressure.ts; a check's did not, and it accumulates straight into a string on the
 * control plane, so `print("x" * 10**10)` inside a file being VALIDATED took the server down
 * before the validator ever got to reject it. Generous next to any real check: the largest thing
 * either caller reads is a graph topology of a few kilobytes, or a Python traceback.
 */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface CodeCheckSpec {
  runtimeDir: string; // cwd containing the uv project (runtime/)
  /** Positional args to `uv run python`, e.g. ["-c", script] or ["-m", "jaroku_runner.graph", agentId]. */
  args: string[];
  timeoutMs: number;
  /**
   * Text to write to the check's stdin, then close it.
   *
   * ADDED FOR §B.3'S LIVE DIAGNOSTICS, which analyse a BUFFER rather than a directory — and a
   * buffer is up to 200 KB of arbitrary text, which is not a thing to put in argv. Every operating
   * system this runs on caps a command line well below that, the failure is a spawn error rather
   * than a truncation, and the text in question is a person's half-written source with whatever
   * quoting characters they have typed so far.
   *
   * CLOSED IMMEDIATELY AFTER WRITING, always, including when this is absent. A check that reads
   * stdin and is never given an EOF waits forever and is killed by the timeout, which turns a
   * script's bug into a three-second stall on every keystroke pause.
   */
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  /** Override MAX_OUTPUT_BYTES. Exists so the test can cross the cap without producing four
   *  megabytes; no caller in the server sets it. */
  maxOutputBytes?: number;
}

export interface CodeCheckResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  /** Only set when the process could not even be spawned (missing uv, bad cwd, ...). */
  spawnError: string | null;
  /** The check was killed for writing more than it is allowed to. What is in `stdout`/`stderr` is
   *  the prefix that arrived before the cap; both callers treat it as a failure, since a truncated
   *  graph topology will not parse and a truncated traceback is still a traceback. */
  truncated: boolean;
}

export interface CodeCheckSandbox {
  run(spec: CodeCheckSpec): Promise<CodeCheckResult>;
}

/** The trusted-developer's-own-machine implementation — see the module comment for why this is
 *  exactly what validator.ts and graphIntrospect.ts already did, just named and shared now. */
export class LocalCodeCheckSandbox implements CodeCheckSandbox {
  run(spec: CodeCheckSpec): Promise<CodeCheckResult> {
    return new Promise((resolve) => {
      const child = spawn("uv", ["run", "python", ...spec.args], {
        cwd: spec.runtimeDir,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`,
          ...spec.env,
        },
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let truncated = false;
      const cap = spec.maxOutputBytes ?? MAX_OUTPUT_BYTES;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ stdout, stderr, timedOut: true, exitCode: null, spawnError: null, truncated });
      }, spec.timeoutMs);

      const finish = (result: CodeCheckResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      // Measured and enforced per chunk, not per line: a single write with no newline in it is
      // exactly how a flood avoids anything that only inspects completed lines — the same
      // reasoning processManager.ts's onStdout follows for a run's own stdout.
      const collect = (which: "out" | "err") => (d: Buffer) => {
        if (settled || truncated) return;
        const text = d.toString("utf8");
        if (which === "out") stdout += text;
        else stderr += text;
        if (stdout.length + stderr.length <= cap) return;
        truncated = true;
        stdout = stdout.slice(0, cap);
        stderr = stderr.slice(0, cap);
        child.kill("SIGKILL");
        finish({ stdout, stderr, timedOut: false, exitCode: null, spawnError: null, truncated: true });
      };

      // Written and closed before anything is read, and the error handler is not optional: a check
      // that exits before consuming its input gives us EPIPE on this stream, which is an unhandled
      // 'error' event and therefore a process-level crash rather than a failed check.
      child.stdin.on("error", () => {});
      if (spec.stdin !== undefined) child.stdin.write(spec.stdin);
      child.stdin.end();

      child.stdout.on("data", collect("out"));
      child.stderr.on("data", collect("err"));
      child.on("error", (err) =>
        finish({ stdout, stderr, timedOut: false, exitCode: null, spawnError: err.message, truncated }),
      );
      child.on("exit", (code) => finish({ stdout, stderr, timedOut: false, exitCode: code, spawnError: null, truncated }));
    });
  }
}
