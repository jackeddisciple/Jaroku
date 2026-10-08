// Executing the server's Python on this machine, from the page's side.
//
// THE PAGE IS A RELAY HERE, AND EVERY WAY A RELAY FAILS IS SILENT. A start the shell refused that is
// never settled holds the server's validation until its deadline; a check whose output is dropped
// on the floor fails as "the check printed nothing"; a run's stdout forwarded through the socket is
// the whole trace a second time over a channel that was never meant to carry it. Each is asserted
// against a fake shell, so no Tauri and no Python is needed.
//
//   npm run test:host-exec

import { __parseExecHost, readExecHost, runningExecs, startExec, stopExec } from "./hostExec.ts";
import type { ClientCommand } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Listener = (e: { payload: unknown }) => void;

/**
 * ONE shell for the whole suite, as there is one per page: the page subscribes to its events once and
 * keeps that subscription, so a second fake shell would be a second machine nobody listens to.
 */
const shellOptions: { refuseStart?: string } = {};
const invoked: { cmd: string; args?: Record<string, unknown> }[] = [];
const listeners = new Map<string, Listener[]>();
function installShell(opts: { refuseStart?: string } = {}) {
  shellOptions.refuseStart = opts.refuseStart;
  invoked.length = 0;
  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        invoked.push({ cmd, args });
        if (cmd === "exec_host") return { protocol: 1, state: "ready", detail: null };
        if (cmd === "exec_start" && shellOptions.refuseStart) throw new Error(shellOptions.refuseStart);
        return null;
      },
    },
    event: {
      listen: async (event: string, cb: Listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), cb]);
        return () => {};
      },
    },
  };
  return {
    invoked,
    emit(payload: unknown) {
      for (const cb of listeners.get("jaroku:exec") ?? []) cb({ payload });
    },
  };
}

function recorder() {
  const sent: ClientCommand[] = [];
  return { sent, send: (cmd: ClientCommand) => { sent.push(cmd); return true; } };
}

console.log("\nwhat the shell says about itself is validated, not believed");
check("a well-formed report is taken", __parseExecHost({ protocol: 1, state: "preparing", detail: "unpacking" })?.state === "preparing");
check("an unknown state is refused", __parseExecHost({ protocol: 1, state: "maybe" }) === null);
check("a protocol that is not a positive integer is refused", __parseExecHost({ protocol: "1", state: "ready" }) === null && __parseExecHost({ protocol: 0, state: "ready" }) === null);
check("a long detail is cut, not carried whole", (__parseExecHost({ protocol: 1, state: "failed", detail: "x".repeat(2000) })?.detail?.length ?? 0) === 400);

console.log("\nin a browser there is no shell, and a start is still answered");
{
  delete (globalThis as Record<string, unknown>).__TAURI__;
  check("no host report in a browser", (await readExecHost()) === null);
  const r = recorder();
  await startExec({ execId: "e-browser", kind: "check", args: ["-c", "1"], timeoutMs: 1000 }, r.send);
  const settled = r.sent[0];
  check("the server is told why, at once", settled?.cmd === "execResult" && settled.error?.includes("desktop app") === true);
}

console.log("\na check's whole output comes back in its result");
{
  const shell = installShell();
  const r = recorder();
  await startExec({ execId: "e-check", kind: "check", args: ["-c", "print(1)"], timeoutMs: 1000, files: [{ path: "a/agent.py", text: "x" }] }, r.send);
  const started = shell.invoked.find((i) => i.cmd === "exec_start");
  const request = started?.args?.request as Record<string, unknown> | undefined;
  check("the shell is asked to start it, with its files", request?.execId === "e-check" && Array.isArray(request?.files) && (request!.files as unknown[]).length === 1);
  check("...capturing both streams", request?.capture === "all");
  check("it is known to be running, for a reconnect to claim", runningExecs().includes("e-check"));
  shell.emit({ execId: "e-check", stream: "stdout", chunk: "[\"a\",", done: false });
  shell.emit({ execId: "e-check", stream: "stdout", chunk: "\"b\"]", done: false });
  shell.emit({ execId: "e-check", stream: "stderr", chunk: "warn", done: false });
  shell.emit({ execId: "someone-else", stream: "stdout", chunk: "nope", done: false });
  check("nothing is sent before it ends", r.sent.length === 0);
  shell.emit({ execId: "e-check", done: true, code: 0, timedOut: false, truncated: false });
  const result = r.sent[0];
  check("one result, carrying all of stdout and stderr",
    result?.cmd === "execResult" && result.stdout === "[\"a\",\"b\"]" && result.stderr === "warn" && result.code === 0,
    JSON.stringify(result));
  check("...and it is no longer running", !runningExecs().includes("e-check"));
}

console.log("\na run's stderr is relayed in batches, and its stdout is not relayed at all");
{
  const shell = installShell();
  const r = recorder();
  await startExec({ execId: "e-run", kind: "run", args: ["-m", "jaroku_runner", "a"], timeoutMs: 1000 }, r.send);
  const request = shell.invoked.find((i) => i.cmd === "exec_start" && (i.args?.request as { execId?: string })?.execId === "e-run")?.args?.request as Record<string, unknown>;
  check("the shell drains a run's stdout itself — the trace already went over HTTP", request?.capture === "stderr");
  shell.emit({ execId: "e-run", stream: "stderr", chunk: "one\n", done: false });
  shell.emit({ execId: "e-run", stream: "stderr", chunk: "two\n", done: false });
  check("lines are batched rather than sent one by one", r.sent.length === 0);
  await sleep(300);
  const logs = r.sent.filter((c) => c.cmd === "execLog");
  check("...and arrive together", logs.length === 1 && logs[0]?.cmd === "execLog" && logs[0].text === "one\ntwo\n", JSON.stringify(r.sent));
  shell.emit({ execId: "e-run", stream: "stderr", chunk: "last\n", done: false });
  shell.emit({ execId: "e-run", done: true, code: 1, timedOut: false, truncated: false });
  const tail = r.sent.slice(1);
  check("what is pending goes out before the end", tail[0]?.cmd === "execLog" && tail[0].text === "last\n");
  check("the end of a run carries no output of its own", tail[1]?.cmd === "execResult" && tail[1].code === 1 && tail[1].stdout === undefined);
}

console.log("\na start the shell refuses is settled with the shell's reason");
{
  installShell({ refuseStart: "Jaroku is still preparing Python on this Mac — try again in a minute." });
  const r = recorder();
  await startExec({ execId: "e-refused", kind: "check", args: ["-c", "1"], timeoutMs: 1000 }, r.send);
  check("the refusal is the result", r.sent[0]?.cmd === "execResult" && r.sent[0].error?.includes("preparing Python") === true);
  check("...and nothing is left running", !runningExecs().includes("e-refused"));
}

console.log("\nStop reaches the shell only for what this page is running");
{
  const shell = installShell();
  const r = recorder();
  await startExec({ execId: "e-stop", kind: "run", args: ["-m", "x"], timeoutMs: 1000 }, r.send);
  stopExec("e-stop", 250);
  stopExec("not-mine");
  await sleep(10);
  const stops = shell.invoked.filter((i) => i.cmd === "exec_stop");
  check("one stop, for the execution this page holds", stops.length === 1 && stops[0]?.args?.execId === "e-stop" && stops[0]?.args?.graceMs === 250);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
