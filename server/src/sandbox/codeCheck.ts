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

export interface CodeCheckSpec {
  runtimeDir: string; // cwd containing the uv project (runtime/)
  /** Positional args to `uv run python`, e.g. ["-c", script] or ["-m", "jaroku_runner.graph", agentId]. */
  args: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface CodeCheckResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  /** Only set when the process could not even be spawned (missing uv, bad cwd, ...). */
  spawnError: string | null;
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
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ stdout, stderr, timedOut: true, exitCode: null, spawnError: null });
      }, spec.timeoutMs);

      const finish = (result: CodeCheckResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err) => finish({ stdout, stderr, timedOut: false, exitCode: null, spawnError: err.message }));
      child.on("exit", (code) => finish({ stdout, stderr, timedOut: false, exitCode: code, spawnError: null }));
    });
  }
}
