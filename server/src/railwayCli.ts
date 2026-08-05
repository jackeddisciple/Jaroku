// Uploading an agent project to Railway.
//
// The one job the GraphQL API cannot do. Railway's `serviceCreate` takes a source that is a
// git repo or a container image; there is no public mutation for "here is a directory". The
// CLI's `up` tars the directory, uploads it, and streams the build back — which is exactly
// what a local-first tool needs, since it means an agent never has to be pushed to GitHub or
// through a container registry to be deployed.
//
// Two rules this file exists to enforce:
//
//   * THE TOKEN GOES THROUGH THE CHILD'S ENVIRONMENT, NEVER ITS ARGUMENTS. A process table is
//     world-readable — `ps aux` on a shared machine, any local process, a crash reporter. This
//     is the same reason the agent's own credentials are set through the API's request body
//     rather than `railway variables --set`.
//
//   * NOTHING IS LINKED. `railway link` writes a .railway/ directory into whatever it is run
//     in, which here would be the user's agent project: a stateful, untracked directory that
//     Jaroku created inside a project it promises to leave alone. Every id is passed as a
//     flag instead, so the upload is a pure function of its arguments.
//
// The spawn discipline is processManager.ts's, including prepending Homebrew's bin to PATH,
// because the CLI is installed the same way uv is and the server does not inherit a shell rc.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/** Overridable so a fixture can stand in for the real binary. */
export function railwayBin(): string {
  return process.env["JAROKU_RAILWAY_CLI"] || "railway";
}

/**
 * The whole upload, including the build Railway runs after it. Generous, because a cold
 * dependency install genuinely takes minutes — but bounded, because a hung upload with no
 * ceiling is a deploy that never resolves either way.
 */
const UPLOAD_TIMEOUT_MS = Number(process.env["JAROKU_DEPLOY_TIMEOUT_MS"] ?? 15 * 60_000);

export interface CliPresence {
  present: boolean;
  version: string | null;
  /** What to tell the user, when it is missing. Names the fix rather than the failure. */
  message: string | null;
}

/**
 * Is the CLI installed?
 *
 * Checked before any Railway resource is created, so a missing binary costs the user a
 * message rather than an orphaned project in their account that Jaroku then cannot finish
 * deploying to. Same posture as the `spawn uv ENOENT` case, which taught the same lesson.
 */
export function checkRailwayCli(): CliPresence {
  const probe = spawnSync(railwayBin(), ["--version"], {
    env: childEnv(null),
    encoding: "utf8",
    timeout: 10_000,
  });
  if (probe.error || probe.status !== 0) {
    return {
      present: false,
      version: null,
      message:
        "the Railway CLI is not installed, or is not on this server's PATH. Jaroku uses it to " +
        "upload your project — install it with `brew install railway` or " +
        "`npm i -g @railway/cli`, then restart the Jaroku server.",
    };
  }
  return { present: true, version: (probe.stdout || "").trim() || null, message: null };
}

/**
 * PATH the same way processManager does, plus /usr/local/bin for the npm-global install.
 *
 * The token is spread in last and is the ONLY place it appears. Note also what is taken out:
 * the server's own environment carries every provider key and connector credential, and the
 * upload has no business seeing any of them.
 */
function childEnv(token: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env["PATH"] ?? ""}`,
    // The CLI reads this to mean "no prompts, stream and exit". Belt and braces with --ci: a
    // prompt in a spawned child with no tty is a deploy that hangs until the deadline.
    CI: "true",
  };
  if (token) env["RAILWAY_API_TOKEN"] = token;
  else delete env["RAILWAY_API_TOKEN"];
  // A project-scoped token in the operator's shell would otherwise take precedence over the
  // account token being passed here, and deploy to whatever it happens to point at.
  delete env["RAILWAY_TOKEN"];
  return env;
}

export interface UploadOptions {
  token: string;
  projectId: string;
  serviceId: string;
  environmentId: string;
  /** The agent project directory. Its contents become the build context. */
  projectDir: string;
  /** Every line the CLI writes, as it writes it. Already split; never batched to the end. */
  onLine: (stream: "stdout" | "stderr", line: string) => void;
  timeoutMs?: number;
}

export interface UploadResult {
  ok: boolean;
  /** Set when the CLI failed — the last thing it said, for the deploy record. */
  error: string | null;
  /** True when the upload was stopped by cancel() rather than by failing. */
  cancelled: boolean;
  /** True when the deadline fired. Distinct from a plain failure: nothing is known either way. */
  timedOut: boolean;
}

/**
 * One upload. Resolves when the CLI exits; the caller follows the deployment itself from
 * there, because `--ci` returns when the BUILD ends and a build that succeeded is not yet a
 * service that is serving.
 */
export class RailwayUpload {
  private child: ChildProcess | null = null;
  private cancelled = false;
  private timedOut = false;

  get running(): boolean {
    return this.child !== null;
  }

  run(opts: UploadOptions): Promise<UploadResult> {
    if (this.child) throw new Error("this upload is already running");

    // Every id explicit. No `railway link`, so nothing is written into the user's project and
    // the command means the same thing whatever state the machine is in.
    const args = [
      "up",
      "--ci",
      "--project", opts.projectId,
      "--service", opts.serviceId,
      "--environment", opts.environmentId,
      opts.projectDir,
    ];

    return new Promise<UploadResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(railwayBin(), args, {
          // cwd is the project too, so a relative path in any CLI output reads sensibly.
          cwd: opts.projectDir,
          env: childEnv(opts.token),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        resolve({
          ok: false,
          error: `could not start the Railway CLI: ${(err as Error).message}`,
          cancelled: false,
          timedOut: false,
        });
        return;
      }
      this.child = child;

      let lastError = "";
      const buffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
      const emit = (stream: "stdout" | "stderr", raw: string): void => {
        const line = raw.replace(/\r/g, "").trimEnd();
        if (!line) return;
        if (stream === "stderr") lastError = line;
        opts.onLine(stream, line);
      };
      const reader = (stream: "stdout" | "stderr") => (chunk: Buffer): void => {
        buffers[stream] += chunk.toString("utf8");
        const lines = buffers[stream].split("\n");
        buffers[stream] = lines.pop() ?? ""; // a partial line is not a line yet
        for (const raw of lines) emit(stream, raw);
      };
      /** The last line of a build log is usually the reason it failed — do not drop it. */
      const flush = (): void => {
        for (const stream of ["stdout", "stderr"] as const) {
          const tail = buffers[stream];
          buffers[stream] = "";
          if (tail) emit(stream, tail);
        }
      };
      child.stdout?.on("data", reader("stdout"));
      child.stderr?.on("data", reader("stderr"));

      const deadline = setTimeout(() => {
        this.timedOut = true;
        this.stop();
      }, opts.timeoutMs ?? UPLOAD_TIMEOUT_MS);

      child.on("error", (err) => {
        clearTimeout(deadline);
        this.child = null;
        resolve({
          ok: false,
          error: `the Railway CLI failed to run: ${err.message}`,
          cancelled: this.cancelled,
          timedOut: this.timedOut,
        });
      });

      // `exit`, not `close`. `close` waits for every pipe to shut, and a killed shell can
      // leave a grandchild holding stdout open — which would mean the deadline fires, the
      // process dies, and the promise still does not settle until the grandchild does. That
      // is precisely the hang the deadline exists to prevent. processManager.ts is on `exit`
      // for the same reason, and flushes its buffers there too.
      child.on("exit", (code) => {
        clearTimeout(deadline);
        this.child = null;
        flush();
        if (this.timedOut) {
          resolve({
            ok: false,
            cancelled: false,
            timedOut: true,
            // Deliberately not "the deploy failed": the upload may well have landed and be
            // building. Saying so is the difference between a user checking their dashboard
            // and a user deploying a second copy.
            error:
              "the upload did not finish in time. It may still be building — check your " +
              "Railway dashboard before deploying again.",
          });
          return;
        }
        if (this.cancelled) {
          resolve({ ok: false, error: null, cancelled: true, timedOut: false });
          return;
        }
        resolve({
          ok: code === 0,
          error: code === 0 ? null : lastError || `the Railway CLI exited with code ${code}`,
          cancelled: false,
          timedOut: false,
        });
      });
    });
  }

  /** SIGTERM, then SIGKILL on a timer the exit clears. processManager.stop()'s shape. */
  stop(graceMs = 2000): void {
    const child = this.child;
    if (!child) return;
    this.cancelled = this.cancelled || !this.timedOut;
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("exit", () => clearTimeout(kill));
  }
}
