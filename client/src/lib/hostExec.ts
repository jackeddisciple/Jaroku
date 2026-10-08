// Running the server's Python on this machine, and saying whether it can.
//
// THE BACKEND THE SHIPPED APP TALKS TO RUNS NO MODEL-WRITTEN CODE, so an agent's checks and runs
// are handed to the app that asked for them. The server sends `exec` messages on this socket; this
// module hands them to the shell (`src-tauri/src/exec.rs`), collects what comes back and settles
// each one with `execResult`. A run's TRACE does not pass through here — the runner pushes it to
// the server over HTTPS with its own token — so what this relays for a run is its stderr and its
// end, and for a check its whole output.
//
// THE FIFTH FILE THAT KNOWS A HOST MAY EXIST, beside the vault, the deep-link listener, the backend
// status and the provider report, and a no-op in a browser like all of them: nothing is reported,
// and the server tells a browser tab that agents run in the desktop app.

import type { ClientCommand } from "../types.ts";

/** The protocol this page speaks to the shell. Bumped with `exec.rs`'s `PROTOCOL`. */
export const EXEC_PROTOCOL = 1;

/** The most of either stream a check hands back. Matches the shell's own ceiling. */
const MAX_CHECK_OUTPUT = 4 * 1024 * 1024;
/** A run's stderr is a log, not a payload: forwarded in batches, and only this much of it. */
const MAX_RUN_LOG = 1024 * 1024;
const LOG_FLUSH_MS = 250;

export type ExecState = "ready" | "preparing" | "failed" | "unavailable";

export interface ExecHostReport {
  protocol: number;
  state: ExecState;
  detail: string | null;
}

export interface ExecStart {
  execId: string;
  kind: "check" | "run";
  args: string[];
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  files?: { path: string; text?: string; b64?: string }[];
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;

function host(): { invoke: Invoke; listen: Listen } | null {
  const t = (globalThis as {
    __TAURI__?: { core?: { invoke?: Invoke }; event?: { listen?: Listen } };
  }).__TAURI__;
  return t?.core?.invoke && t?.event?.listen ? { invoke: t.core.invoke, listen: t.event.listen } : null;
}

const STATES: readonly ExecState[] = ["ready", "preparing", "failed", "unavailable"];

/** A host report as the shell sent it, or null when it is not one. Validated, never coerced. */
export function __parseExecHost(raw: unknown): ExecHostReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.protocol !== "number" || !Number.isInteger(r.protocol) || r.protocol < 1) return null;
  if (typeof r.state !== "string" || !(STATES as readonly string[]).includes(r.state)) return null;
  const detail = typeof r.detail === "string" ? r.detail.slice(0, 400) : null;
  return { protocol: r.protocol, state: r.state as ExecState, detail };
}

/** What this machine can do right now, or null in a browser. */
export async function readExecHost(): Promise<ExecHostReport | null> {
  const h = host();
  if (!h) return null;
  try {
    return __parseExecHost(await h.invoke("exec_host"));
  } catch {
    return null;
  }
}

/** One event of a running execution, as `exec.rs` emits it. */
interface ExecEvent {
  execId: string;
  stream?: "stdout" | "stderr" | null;
  chunk?: string | null;
  done: boolean;
  code?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
  error?: string | null;
}

function parseEvent(raw: unknown): ExecEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.execId !== "string" || typeof e.done !== "boolean") return null;
  return e as unknown as ExecEvent;
}

/** What one execution has said so far, and how to settle it. */
interface Live {
  kind: "check" | "run";
  stdout: string;
  stderr: string;
  /** A run's stderr not yet forwarded. */
  pending: string;
  forwarded: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const live = new Map<string, Live>();
let listening: Promise<void> | null = null;
let sendCommand: ((cmd: ClientCommand) => boolean) | null = null;

/** The executions this page is still running, so a reconnected socket can say they are its. */
export function runningExecs(): string[] {
  return [...live.keys()];
}

function flush(execId: string): void {
  const l = live.get(execId);
  if (!l) return;
  if (l.timer) clearTimeout(l.timer);
  l.timer = null;
  if (!l.pending) return;
  const room = MAX_RUN_LOG - l.forwarded;
  const text = room > 0 ? l.pending.slice(0, room) : "";
  l.pending = "";
  if (!text) return;
  l.forwarded += text.length;
  sendCommand?.({ cmd: "execLog", execId, text });
}

function onEvent(raw: unknown): void {
  const e = parseEvent(raw);
  if (!e) return;
  const l = live.get(e.execId);
  if (!l) return;
  if (!e.done) {
    const chunk = typeof e.chunk === "string" ? e.chunk : "";
    if (!chunk) return;
    if (l.kind === "check") {
      if (e.stream === "stdout" && l.stdout.length < MAX_CHECK_OUTPUT) l.stdout += chunk;
      else if (e.stream === "stderr" && l.stderr.length < MAX_CHECK_OUTPUT) l.stderr += chunk;
    } else if (e.stream === "stderr") {
      l.pending += chunk;
      if (!l.timer) l.timer = setTimeout(() => flush(e.execId), LOG_FLUSH_MS);
    }
    return;
  }
  flush(e.execId);
  live.delete(e.execId);
  sendCommand?.({
    cmd: "execResult",
    execId: e.execId,
    code: typeof e.code === "number" ? e.code : null,
    timedOut: e.timedOut === true,
    truncated: e.truncated === true,
    error: typeof e.error === "string" ? e.error : null,
    ...(l.kind === "check" ? { stdout: l.stdout.slice(0, MAX_CHECK_OUTPUT), stderr: l.stderr.slice(0, MAX_CHECK_OUTPUT) } : {}),
  });
}

function listen(h: { listen: Listen }): Promise<void> {
  if (!listening) {
    listening = h
      .listen("jaroku:exec", (e) => onEvent(e.payload))
      .then(() => undefined)
      .catch(() => {
        listening = null;
      });
  }
  return listening;
}

/**
 * Start what the server asked for, and settle it with `execResult` whichever way it goes.
 *
 * A START THAT FAILS IS STILL SETTLED. The server is waiting on this execution — a validation, a
 * Graph tab, a run's row — and an execution that never answers holds it until its own timeout.
 */
export async function startExec(msg: ExecStart, send: (cmd: ClientCommand) => boolean): Promise<void> {
  sendCommand = send;
  const h = host();
  const refuse = (error: string) =>
    send({ cmd: "execResult", execId: msg.execId, code: null, timedOut: false, truncated: false, error });
  if (!h) {
    refuse("agents run in the Jaroku desktop app, not in a browser");
    return;
  }
  if (live.has(msg.execId)) return;
  await listen(h);
  live.set(msg.execId, { kind: msg.kind, stdout: "", stderr: "", pending: "", forwarded: 0, timer: null });
  try {
    await h.invoke("exec_start", {
      request: {
        execId: msg.execId,
        args: msg.args,
        env: msg.env ?? {},
        stdin: msg.stdin ?? null,
        timeoutMs: msg.timeoutMs,
        files: msg.files ?? [],
        capture: msg.kind === "run" ? "stderr" : "all",
      },
    });
  } catch (err) {
    live.delete(msg.execId);
    refuse(err instanceof Error ? err.message : String(err));
  }
}

/** Stop an execution the server gave up on, or that somebody pressed Stop on. */
export function stopExec(execId: string, graceMs?: number): void {
  const h = host();
  if (!h || !live.has(execId)) return;
  void h.invoke("exec_stop", { execId, graceMs: graceMs ?? null }).catch(() => {});
}

/** Call `cb` whenever this machine's readiness changes. A no-op unsubscribe in a browser. */
export async function onExecHostChange(cb: (report: ExecHostReport) => void): Promise<() => void> {
  const h = host();
  if (!h) return () => {};
  try {
    return await h.listen("jaroku:exec-host", (e) => {
      const report = __parseExecHost(e.payload);
      if (report) cb(report);
    });
  } catch {
    return () => {};
  }
}
