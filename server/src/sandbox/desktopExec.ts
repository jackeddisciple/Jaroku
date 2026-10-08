// Running an agent's code on the desktop app of the person who asked for it.
//
// THE SHIPPED APP'S BACKEND RUNS NO MODEL-WRITTEN CODE, and that is the rule rather than a gap:
// `jaroku-api` holds the database, the KMS key and every workspace's secrets, and "no generated
// code executes on the control plane" is the invariant `codeCheck.ts` and `runSandbox.ts` were cut
// to keep. Until this module the consequence was that nothing executed ANYWHERE in production — a
// generation was written and then failed its own import check with `spawn uv ENOENT`, and Run, the
// Graph tab and evals could not start.
//
// SO THE CODE RUNS ON THE USER'S MACHINE, which already carries uv, CPython and the pinned
// dependencies (`src-tauri/src/exec.rs`). This server stays the orchestrator — it decides what to
// check or run, owns the run's row and its trace — and hands ONE execution to ONE app:
//
//   check  `CodeCheckSandbox`, for the validator, graph introspection, live diagnostics and the
//          semantic diff. The project travels in the message; the output comes back in `execResult`.
//   run    `RunSandbox`, for a run, a resume, a branch and an eval's runs. The project travels the
//          same way, but the TRACE does not come back through the socket: the runner pushes it to
//          `controlPlaneRoutes.ts` over HTTPS with a run-scoped token, exactly as a hosted sandbox
//          would, so pause, MCP confirmations and the timeline all work unchanged — and a socket
//          that blips mid-run loses nothing but a few stderr lines.
//
// WHICH APP is the transport's decision (`wsRelay.ts#execTarget`): the socket that asked, or else
// another of the same person's apps in the same workspace. Never a teammate's — running somebody
// else's code on your machine because you happened to be online is not a thing this does.
//
// AN APP THAT CLOSES MID-EXECUTION is given a grace period to come back and claim what it is still
// running (its host report names them). Past it, the execution is settled as failed rather than
// left holding a validation, a Graph tab or a run's slot for ever.
//
//   npm run test:desktop-exec

import { EventEmitter } from "node:events";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { TenantContext } from "../db/tenant.ts";
import { placeProject, type CodeCheckResult, type CodeCheckSandbox, type CodeCheckSpec } from "./codeCheck.ts";
import type { RunEventBus } from "./eventBus.ts";
import type { RunSandbox, SandboxEvents, SandboxSpec } from "./runSandbox.ts";

/** The oldest app protocol this server will hand an execution to. Bumped with `exec.rs`. */
export const DESKTOP_EXEC_PROTOCOL = 1;

/** Replaced by the app with the execution's own directory, where its files were written. */
export const EXEC_DIR_TOKEN = "{{EXEC_DIR}}";

/** A generated project is source. Past this it is not one, and is not shipped to anybody's machine. */
const MAX_PROJECT_BYTES = 24 * 1024 * 1024;
const MAX_PROJECT_FILES = 3000;
/** Never shipped: caches and environments the app rebuilds, and VCS state that is nobody's business. */
const SKIPPED_DIRS = new Set(["__pycache__", ".venv", "venv", ".git", "node_modules", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
const SKIPPED_FILES = new Set([".DS_Store"]);

/** How long an app that closed may take to come back and claim what it is running. */
const ORPHAN_GRACE_MS = 45_000;
/** Above a check's own timeout: the app's `uv run` start-up and two network legs. */
const CHECK_MARGIN_MS = 15_000;
/** A run's stderr relayed to the log, at most. The trace is what a run is read by. */
const MAX_RUN_LOG_CHARS = 1024 * 1024;
/** A run with no deadline of its own still ends: the app stops it, and so does this. */
const RUN_CEILING_MS = 2 * 60 * 60_000;

export interface ExecFile {
  path: string;
  text?: string;
  b64?: string;
}

export type ExecMessage =
  | {
      channel: "exec";
      type: "start";
      execId: string;
      kind: "check" | "run";
      args: string[];
      env: Record<string, string>;
      stdin?: string;
      timeoutMs: number;
      files: ExecFile[];
    }
  | { channel: "exec"; type: "stop"; execId: string; graceMs?: number };

/** Which app an execution is on: one socket, in one workspace, held by one person. */
export interface ExecHostRef {
  workspaceId: string;
  requestId: string;
  userId: string | null;
}

export interface ExecTransport {
  /** The app this context's code should run on, or the sentence saying why there is none. */
  pick(ctx: TenantContext): ExecHostRef | { refusal: string };
  /** Deliver to exactly that socket. False when it has gone. */
  send(to: ExecHostRef, message: ExecMessage): boolean;
}

/** How an execution ended, as the app reported it. */
export interface ExecOutcome {
  code: number | null;
  timedOut: boolean;
  truncated: boolean;
  /** It never ran, or it was lost: a sentence, never a traceback. */
  error: string | null;
  stdout: string;
  stderr: string;
}

interface Pending {
  execId: string;
  kind: "check" | "run";
  host: ExecHostRef;
  deadline: NodeJS.Timeout | null;
  orphan: NodeJS.Timeout | null;
  logged: number;
  onLog?: (text: string) => void;
  settle: (outcome: ExecOutcome) => void;
}

export function hostRefOf(ctx: TenantContext): ExecHostRef {
  return { workspaceId: ctx.workspaceId, requestId: ctx.requestId, userId: ctx.actorUserId };
}

function failed(error: string, timedOut = false): ExecOutcome {
  return { code: null, timedOut, truncated: false, error, stdout: "", stderr: "" };
}

/**
 * A directory, as the files an app writes back out. Text travels as text and anything else as
 * base64, so a project with a data file in it arrives whole rather than quietly missing one.
 */
export function packProject(dir: string, under: string): ExecFile[] {
  const out: ExecFile[] = [];
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const relPath = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(dir, relPath));
      // A symlink is neither followed nor shipped: following one out of a project is how a packer
      // reads a file it was never given, and the generated projects contain none.
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (!SKIPPED_DIRS.has(name)) walk(relPath);
        continue;
      }
      if (!stat.isFile() || SKIPPED_FILES.has(name)) continue;
      bytes += stat.size;
      if (bytes > MAX_PROJECT_BYTES || out.length >= MAX_PROJECT_FILES) {
        throw new Error("this project is too large to run on a desktop app");
      }
      const raw = readFileSync(join(dir, relPath));
      const path = `${under}/${relPath}`;
      try {
        out.push({ path, text: decoder.decode(raw) });
      } catch {
        out.push({ path, b64: raw.toString("base64") });
      }
    }
  };
  walk("");
  return out;
}

export class DesktopExecBroker {
  private pending = new Map<string, Pending>();

  constructor(
    private transport: ExecTransport,
    private opts: { orphanGraceMs?: number; checkMarginMs?: number } = {},
  ) {}

  /** Null when this context has an app to execute on; otherwise the sentence saying why not. */
  unavailable(ctx: TenantContext): string | null {
    const picked = this.transport.pick(ctx);
    return "refusal" in picked ? picked.refusal : null;
  }

  /** How many executions are in flight. */
  get size(): number {
    return this.pending.size;
  }

  /** Run a short check on the asking app and answer with its whole output. Never rejects. */
  check(ctx: TenantContext, spec: CodeCheckSpec, execId: string): Promise<CodeCheckResult> {
    return new Promise((resolve) => {
      const done = (o: ExecOutcome): void =>
        resolve({
          stdout: o.stdout,
          stderr: o.stderr,
          timedOut: o.timedOut,
          exitCode: o.code,
          spawnError: o.error,
          truncated: o.truncated,
        });
      let files: ExecFile[] = [];
      let args = spec.args;
      let env: NodeJS.ProcessEnv = spec.env ?? {};
      if (spec.project) {
        // Shipped under its own name, because the import check imports it AS that name.
        const name = basename(spec.project);
        try {
          files = packProject(spec.project, name);
        } catch (err) {
          done(failed((err as Error).message));
          return;
        }
        ({ args, env } = placeProject(spec, { project: `${EXEC_DIR_TOKEN}/${name}`, parent: EXEC_DIR_TOKEN }));
      }
      const refusal = this.start(ctx, {
        execId,
        kind: "check",
        args,
        env: stringEnv(env),
        stdin: spec.stdin,
        timeoutMs: spec.timeoutMs,
        files,
        waitMs: spec.timeoutMs + (this.opts.checkMarginMs ?? CHECK_MARGIN_MS),
        settle: done,
      });
      if (refusal) done(failed(refusal));
    });
  }

  /**
   * Start a run on the asking app. Null when it was handed over; the refusal otherwise. Its end —
   * however it comes, including the app vanishing — arrives exactly once through `onEnd`.
   */
  run(
    ctx: TenantContext,
    req: { execId: string; args: string[]; env: Record<string, string>; files: ExecFile[]; timeoutMs?: number },
    handlers: { onLog: (text: string) => void; onEnd: (outcome: ExecOutcome) => void },
  ): string | null {
    const timeoutMs = Math.min(req.timeoutMs ?? RUN_CEILING_MS, RUN_CEILING_MS);
    return this.start(ctx, {
      execId: req.execId,
      kind: "run",
      args: req.args,
      env: req.env,
      timeoutMs,
      files: req.files,
      waitMs: timeoutMs + 60_000,
      onLog: handlers.onLog,
      settle: handlers.onEnd,
    });
  }

  /** Ask the app running this to stop it: a polite signal, then the whole tree after `graceMs`. */
  stop(execId: string, graceMs?: number): void {
    const p = this.pending.get(execId);
    if (!p) return;
    this.transport.send(p.host, { channel: "exec", type: "stop", execId, ...(graceMs !== undefined ? { graceMs } : {}) });
  }

  /** An app saying how an execution ended. Only the app it is on may. */
  result(from: ExecHostRef, cmd: { execId: string } & Partial<ExecOutcome>): void {
    const p = this.pending.get(cmd.execId);
    if (!p || !sameSocket(p.host, from)) return;
    this.finish(p, {
      code: typeof cmd.code === "number" ? cmd.code : null,
      timedOut: cmd.timedOut === true,
      truncated: cmd.truncated === true,
      error: typeof cmd.error === "string" && cmd.error ? cmd.error.slice(0, 800) : null,
      stdout: typeof cmd.stdout === "string" ? cmd.stdout : "",
      stderr: typeof cmd.stderr === "string" ? cmd.stderr : "",
    });
  }

  /** A run's stderr, relayed. Bounded, because a log is not a payload. */
  log(from: ExecHostRef, execId: string, text: string): void {
    const p = this.pending.get(execId);
    if (!p || !p.onLog || !sameSocket(p.host, from) || p.logged >= MAX_RUN_LOG_CHARS) return;
    const room = MAX_RUN_LOG_CHARS - p.logged;
    const kept = text.slice(0, room);
    p.logged += kept.length;
    p.onLog(kept);
  }

  /**
   * An app reporting itself, with what it is still running. A reconnected socket is a new socket,
   * and this is how what the old one was running finds its way back to it — for the same person,
   * in the same workspace, and nobody else.
   */
  hostReport(from: ExecHostRef, running: readonly string[]): void {
    if (!from.userId) return;
    for (const execId of running) {
      const p = this.pending.get(execId);
      if (!p || p.host.workspaceId !== from.workspaceId || p.host.userId !== from.userId) continue;
      p.host = { ...from };
      if (p.orphan) clearTimeout(p.orphan);
      p.orphan = null;
    }
  }

  /** A socket closed. What it was running waits for it to come back, for a while. */
  socketClosed(from: ExecHostRef): void {
    for (const p of this.pending.values()) {
      if (!sameSocket(p.host, from) || p.orphan) continue;
      const timer = setTimeout(() => {
        if (this.pending.get(p.execId) !== p) return;
        this.finish(p, failed("the Jaroku app running this closed before it finished"));
      }, this.opts.orphanGraceMs ?? ORPHAN_GRACE_MS);
      timer.unref?.();
      p.orphan = timer;
    }
  }

  private start(
    ctx: TenantContext,
    req: {
      execId: string;
      kind: "check" | "run";
      args: string[];
      env: Record<string, string>;
      stdin?: string;
      timeoutMs: number;
      files: ExecFile[];
      waitMs: number;
      onLog?: (text: string) => void;
      settle: (outcome: ExecOutcome) => void;
    },
  ): string | null {
    if (this.pending.has(req.execId)) return "that execution is already running";
    const picked = this.transport.pick(ctx);
    if ("refusal" in picked) return picked.refusal;
    const p: Pending = {
      execId: req.execId,
      kind: req.kind,
      host: picked,
      deadline: null,
      orphan: null,
      logged: 0,
      onLog: req.onLog,
      settle: req.settle,
    };
    this.pending.set(req.execId, p);
    const delivered = this.transport.send(picked, {
      channel: "exec",
      type: "start",
      execId: req.execId,
      kind: req.kind,
      args: req.args,
      env: req.env,
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
      timeoutMs: req.timeoutMs,
      files: req.files,
    });
    if (!delivered) {
      this.pending.delete(req.execId);
      return "the Jaroku app that asked for this closed before it could start";
    }
    // THE APP IS TRUSTED TO END IT, AND NOT RELIED ON TO. Its own timeout kills the process; this is
    // what settles an execution whose app never says so — hung, crashed, or a protocol it misread.
    p.deadline = setTimeout(() => {
      if (this.pending.get(req.execId) !== p) return;
      this.stop(req.execId, 0);
      this.finish(p, failed(req.kind === "check" ? "the check did not answer in time" : "the run did not end in time", true));
    }, req.waitMs);
    p.deadline.unref?.();
    return null;
  }

  private finish(p: Pending, outcome: ExecOutcome): void {
    if (this.pending.get(p.execId) !== p) return;
    this.pending.delete(p.execId);
    if (p.deadline) clearTimeout(p.deadline);
    if (p.orphan) clearTimeout(p.orphan);
    p.settle(outcome);
  }
}

function sameSocket(a: ExecHostRef, b: ExecHostRef): boolean {
  return a.workspaceId === b.workspaceId && a.requestId === b.requestId;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

/** The CodeCheckSandbox for one request: its checks run on the app that made it. */
export class DesktopCodeCheckSandbox implements CodeCheckSandbox {
  constructor(
    private broker: DesktopExecBroker,
    private ctx: TenantContext,
    private mintId: () => string,
  ) {}

  run(spec: CodeCheckSpec): Promise<CodeCheckResult> {
    return this.broker.check(this.ctx, spec, this.mintId());
  }
}

/** Must match jaroku_runner/debug.py's CTRL_SENTINEL — and processManager.ts's copy of it. */
const CTRL_SENTINEL = "@@JAROKU_CTRL@@ ";

/**
 * Whether a stderr line from a desktop run belongs in the log.
 *
 * NOT A CONTROL LINE. The runner writes each one to stderr AND pushes it over HTTP; the local pipe
 * turns the stderr copy into a control event and never shows it, and here the HTTP copy is the one
 * acted on — so relaying the stderr copy put raw `@@JAROKU_CTRL@@ {…}` JSON in somebody's run log.
 */
function isLogLine(line: string): boolean {
  return line.trim().length > 0 && !line.startsWith(CTRL_SENTINEL);
}

/** The environment variables a run is handed by path on THIS machine, which mean nothing on another. */
const SERVER_PATHS = ["JAROKU_CONTROL_DIR", "JAROKU_AGENT_DIR", "JAROKU_BRANCH_EDIT_FILE", "JAROKU_CHECKPOINT_DIR"];

/**
 * The RunSandbox whose runs happen on the asking person's desktop app.
 *
 * THE SAME SHAPE AS `FlyMachinesSandbox`, on purpose: the run calls home over HTTP with a run token,
 * what it pushes arrives on the bus, and this re-emits it as the pool's own events. What differs is
 * who starts the process — an app over a socket rather than a Machines API — and that the project
 * travels in the start message rather than as a presigned archive.
 */
export class DesktopRunSandbox extends EventEmitter<SandboxEvents> implements RunSandbox {
  private runId: string | null = null;
  private active = false;

  constructor(private opts: { broker: DesktopExecBroker; bus: RunEventBus }) {
    super();
  }

  get running(): boolean {
    return this.active;
  }

  start(spec: SandboxSpec): void {
    if (this.active) throw new Error("this sandbox is already running a run");
    this.active = true;
    this.runId = spec.runId;
    const runId = spec.runId;
    const fail = (message: string): void => {
      // On the next tick, like a spawn error from a real process: the pool's listeners expect to
      // hear about a start AFTER `tryStart` has returned.
      setImmediate(() => {
        this.active = false;
        this.emit("spawnError", new Error(message));
      });
    };
    if (!spec.host) return fail("this run has nobody's app to run on");
    if (!spec.controlPlane) return fail("a run on a desktop app needs this server's public address (JAROKU_CONTROL_PLANE_URL)");

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.env ?? {})) {
      if (typeof v === "string" && !SERVER_PATHS.includes(k)) env[k] = v;
    }
    env.JAROKU_RUN_ID = runId;
    if (spec.workspaceId) env.JAROKU_WORKSPACE_ID = spec.workspaceId;
    env.JAROKU_CONTROL_PLANE_URL = spec.controlPlane.url;
    env.JAROKU_RUN_TOKEN = spec.controlPlane.runToken;
    // A local file per run on the app's machine: no database credential ever leaves this server.
    env.JAROKU_CHECKPOINTER = "sqlite";

    let files: ExecFile[] = [];
    try {
      if (spec.agentId) {
        const dir = spec.env?.JAROKU_AGENT_DIR ?? join(spec.runtimeDir, "agents", spec.agentId);
        files = packProject(dir, "project");
        env.JAROKU_AGENT_DIR = `${EXEC_DIR_TOKEN}/project`;
      }
      const editFile = spec.env?.JAROKU_BRANCH_EDIT_FILE;
      if (editFile) {
        files.push({ path: "branch.edit.json", text: readFileSync(editFile, "utf8") });
        env.JAROKU_BRANCH_EDIT_FILE = `${EXEC_DIR_TOKEN}/branch.edit.json`;
      }
    } catch (err) {
      return fail(`could not prepare this agent's files: ${(err as Error).message}`);
    }

    const emitter = this.opts.bus.register(runId);
    emitter.on("event", (e) => this.emit("event", e));
    emitter.on("control", (c) => this.emit("control", c));
    emitter.on("stderr", (l) => this.emit("stderr", l));
    emitter.on("parseError", (e) => this.emit("parseError", e));

    let carry = "";
    const refusal = this.opts.broker.run(
      spec.host,
      {
        execId: runId,
        args: spec.agentId
          ? ["-m", "jaroku_runner", spec.agentId, ...(spec.input ? [spec.input] : [])]
          : ["-m", "test_agent.agent", ...(spec.input ? [spec.input] : [])],
        env,
        files,
        timeoutMs: spec.limits?.wallClockSec ? spec.limits.wallClockSec * 1000 : undefined,
      },
      {
        onLog: (text) => {
          const lines = (carry + text).split("\n");
          carry = lines.pop() ?? "";
          for (const line of lines) if (isLogLine(line)) this.emit("stderr", line);
        },
        onEnd: (outcome) => {
          if (isLogLine(carry)) this.emit("stderr", carry);
          carry = "";
          this.active = false;
          if (outcome.error && outcome.code === null && !outcome.timedOut) {
            this.emit("stderr", `[jaroku] ${outcome.error}`);
          }
          this.emit("exit", { code: outcome.code, signal: null, timedOut: outcome.timedOut });
        },
      },
    );
    if (refusal) {
      this.opts.bus.unregister(runId);
      return fail(refusal);
    }
  }

  stop(graceMs = 5_000): void {
    if (this.runId && this.active) this.opts.broker.stop(this.runId, graceMs);
  }
}
