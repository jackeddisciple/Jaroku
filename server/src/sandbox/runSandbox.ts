// The seam Session 4 exists to cut: what runs model-written Python, and where.
//
// Until now that question had one answer everywhere in this codebase — a child process on the
// same machine as the control plane — spelled out three times: processManager.ts spawns a run,
// validator.ts imports a staged project to check it, and graphIntrospect.ts imports it again to
// read its topology. Hosted, all three are the same problem: untrusted, model-written code is
// about to execute, and it must not do so with the server's network position, the server's
// filesystem, or the server's view of Postgres and Redis.
//
// RunSandbox is that seam, named once. Anything that needs to execute a project's code depends
// on this interface rather than on a concrete "spawn a subprocess" call. The local implementation
// (see localSandbox.ts) is the same subprocess this codebase has always spawned — development
// keeps working with nothing installed and nothing running, per the standing rule that the local
// path is not deleted. A hosted implementation satisfies the same interface from inside a
// per-run micro-VM with no shared disk and no network access beyond what the run was granted.
//
// The events below are deliberately the same shape processManager.ts already emitted — a
// well-formed trace event, a parse error, a stderr line, a control-plane line, an exit, a spawn
// failure — because that shape was already sandbox-agnostic: nothing in it assumes the process
// is local. What changes hosted is how those events arrive (an NDJSON stream ingested from a
// worker rather than a local pipe), not what they mean.

import type { EventEmitter } from "node:events";
import type { TraceEvent } from "../types.ts";

/** Resource ceilings a sandbox enforces on the code it runs. Every field is required on the
 *  hosted path; the local path is a trusted developer's own machine and does not enforce them. */
export interface SandboxLimits {
  cpuMillis: number;
  memoryMb: number;
  pids: number;
  wallClockSec: number;
  diskMb: number;
}

/**
 * Everything one execution needs, independent of where it runs.
 *
 * `workspaceId`, `env` and `limits` are optional here because the local path — a trusted
 * developer's own machine, run today exactly as it always has been — has no workspace to scope
 * a checkpoint thread to on SQLite and enforces no resource ceiling on itself. A hosted
 * RunSandbox requires all three and refuses to start without them; see flySandbox.ts.
 */
export interface SandboxSpec {
  runId: string;
  workspaceId?: string;
  runtimeDir: string;
  /** A generated project under runtime/agents/. Omitted -> the hand-written fixture agent. */
  agentId?: string;
  input?: string;
  /** Secrets and configuration for this run only. Never inherited ambiently on the hosted path. */
  env?: NodeJS.ProcessEnv;
  limits?: Partial<SandboxLimits>;
  /** Where and how a hosted run reaches its control plane (sandbox/controlPlaneRoutes.ts). Absent
   *  locally — LocalSubprocessSandbox talks over a pipe and a control file, not HTTP. */
  controlPlane?: { url: string; runToken: string };
}

/** Typed events every RunSandbox implementation emits. Identical to what processManager.ts
 *  already produced — see the module comment for why that shape was sandbox-agnostic already. */
export interface SandboxEvents {
  event: [TraceEvent];
  parseError: [{ line: string; error: string }];
  stderr: [string];
  control: [Record<string, unknown>];
  exit: [{ code: number | null; signal: NodeJS.Signals | null; oom?: boolean; timedOut?: boolean }];
  spawnError: [Error];
}

/**
 * One execution of a run's code, wherever it happens.
 *
 * `start`/`stop`/`running` rather than a single `start(): Promise<Handle>` — this codebase's
 * existing consumer (RunPool) is event-driven and slot-based, and the streaming/handle-based
 * shape sketched in the migration spec is what these events already are, addressed by a
 * `runId` the pool assigns rather than by a returned handle. Keeping the existing idiom is what
 * makes this commit behaviour-identical instead of a rewrite of the pool alongside it.
 */
export interface RunSandbox extends EventEmitter<SandboxEvents> {
  start(spec: SandboxSpec): void;
  /** Graceful stop: request shutdown, force it after `graceMs` if the code does not exit. */
  stop(graceMs?: number): void;
  readonly running: boolean;
}

/** Which RunSandbox a server builds. Mirrors JAROKU_DB_DRIVER / JAROKU_OBJECT_STORE: local is
 *  the default and needs nothing installed; a hosted kind is added as Session 4 implements one. */
export type SandboxKind = "local" | "fly";

export function sandboxKind(): SandboxKind {
  const raw = (process.env.JAROKU_RUN_SANDBOX ?? "local").trim().toLowerCase();
  if (raw !== "local" && raw !== "fly") {
    throw new Error(`JAROKU_RUN_SANDBOX must be "local" or "fly", not ${JSON.stringify(raw)}`);
  }
  return raw;
}
