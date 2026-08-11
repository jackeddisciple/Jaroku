// jaroku_runner/controlplane_http.py, driven for real against the real HTTP routes — the same
// "drive the real Python against the real server" pattern the debug-depth suites already use,
// proving the runner-side client and the server-side routes actually agree on the wire shape
// rather than each side's tests independently believing they do.
//
//   npm run test:controlplane-http-python

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "../http/router.ts";
import { RunEventBus } from "./eventBus.ts";
import { mintRunToken } from "./runTokens.ts";
import { registerControlPlaneRoutes } from "./controlPlaneRoutes.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const RUNTIME_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runtime"));

const signingKey = randomBytes(32);
const bus = new RunEventBus();
const router = new Router({ log: () => {}, quiet: () => true });
registerControlPlaneRoutes(router, { bus, signingKey, revocations: new (await import("./runTokens.ts")).RunTokenRevocationList() });

const http = createServer((req, res) => {
  void router.handle(req, res).then((handled) => {
    if (!handled) res.writeHead(404).end();
  });
});
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

function runPython(script: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn("uv", ["run", "python", "-c", script], {
      cwd: RUNTIME_DIR,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolveRun({ code, stdout, stderr }));
    child.on("error", () => resolveRun({ code: -1, stdout, stderr: "spawn failed" }));
  });
}

try {
  {
    const r = await runPython(
      "from jaroku_runner import controlplane_http as c; print(c.configured())",
      {},
    );
    check("configured() is False with neither env var set", r.stdout.trim() === "False", r.stderr.slice(0, 200));
  }

  bus.register("run-py-1");
  const token = mintRunToken(signingKey, "run-py-1", "ws-1", 3600);
  const commonEnv = {
    JAROKU_CONTROL_PLANE_URL: base,
    JAROKU_RUN_TOKEN: token,
    JAROKU_RUN_ID: "run-py-1",
  };

  {
    const r = await runPython(
      "from jaroku_runner import controlplane_http as c; print(c.configured())",
      commonEnv,
    );
    check("configured() is True once both env vars are set", r.stdout.trim() === "True", r.stderr.slice(0, 200));
  }

  {
    let received: unknown = null;
    const emitter = bus.register("run-py-1");
    emitter.once("event", (e) => (received = e));
    const r = await runPython(
      "from jaroku_runner import controlplane_http as c\n" +
        "c.push_trace_event({'kind':'run_start','schema_version':1,'run':{'id':'run-py-1'}})",
      commonEnv,
    );
    check("push_trace_event exits cleanly", r.code === 0, r.stderr.slice(0, 300));
    check("the event reached the real bus over real HTTP", (received as { kind?: string })?.kind === "run_start");
  }

  {
    let received: unknown = null;
    const emitter = bus.register("run-py-1");
    emitter.once("control", (c) => (received = c));
    const r = await runPython(
      "from jaroku_runner import controlplane_http as c\n" + "c.push_control_line({'ctrl':'boundary','run_id':'run-py-1'})",
      commonEnv,
    );
    check("push_control_line exits cleanly", r.code === 0, r.stderr.slice(0, 300));
    check("the control line reached the real bus", (received as { ctrl?: string })?.ctrl === "boundary");
  }

  {
    const r = await runPython(
      "from jaroku_runner import controlplane_http as c; print(c.poll_control())",
      commonEnv,
    );
    check("poll_control() with nothing queued returns Python None", r.stdout.trim() === "None", r.stderr.slice(0, 200));
  }

  {
    bus.signal("run-py-1", { action: "pause" });
    const r = await runPython(
      "from jaroku_runner import controlplane_http as c; print(c.poll_control())",
      commonEnv,
    );
    check("poll_control() returns a queued pause", r.stdout.trim() === "pause", r.stderr.slice(0, 200));
  }

  {
    // Batching: 40 queued events is under the 50-event threshold, so nothing should have been
    // sent until an explicit flush.
    const received: unknown[] = [];
    const emitter = bus.register("run-py-1");
    const onEvent = (e: unknown) => received.push(e);
    emitter.on("event", onEvent);
    const r = await runPython(
      "from jaroku_runner import controlplane_http as c\n" +
        "for i in range(40):\n" +
        "    c.queue_trace_event({'kind':'step','schema_version':1,'step':{'id':str(i),'seq':i}})\n" +
        "print('queued')",
      commonEnv,
    );
    emitter.off("event", onEvent);
    check("queueing 40 events under the batch size sends nothing on its own", r.stdout.trim() === "queued" && received.length === 0, `received=${received.length} ${r.stderr.slice(0, 200)}`);
  }

  {
    // 60 events crosses the 50-event threshold mid-loop, so one batch of 50 should already have
    // landed by the time the process exits — proving this is threshold-driven, not merely "the
    // final flush caught everything".
    const received: unknown[] = [];
    const emitter = bus.register("run-py-1");
    const onEvent = (e: unknown) => received.push(e);
    emitter.on("event", onEvent);
    await runPython(
      "from jaroku_runner import controlplane_http as c\n" +
        "for i in range(60):\n" +
        "    c.queue_trace_event({'kind':'step','schema_version':1,'step':{'id':'b-'+str(i),'seq':i}})\n" +
        "import time; time.sleep(0.3)\n" +  // give the flush's own HTTP round trip time to land
        "print('done')",
      commonEnv,
    );
    emitter.off("event", onEvent);
    check("crossing the 50-event threshold flushes a batch without waiting for the process to exit", received.length >= 50, `received=${received.length}`);
  }

  {
    // flush_trace_events() at run end (wired into __main__.py's finally block) must not lose a
    // small, never-thresholded tail.
    const received: unknown[] = [];
    const emitter = bus.register("run-py-1");
    const onEvent = (e: unknown) => received.push(e);
    emitter.on("event", onEvent);
    await runPython(
      "from jaroku_runner import controlplane_http as c\n" +
        "c.queue_trace_event({'kind':'run_start','schema_version':1,'run':{'id':'run-py-1'}})\n" +
        "c.flush_trace_events()\n" +
        "print('flushed')",
      commonEnv,
    );
    emitter.off("event", onEvent);
    check("an explicit flush sends a partial, under-threshold batch", received.length === 1);
  }

  {
    const pending = runPython(
      "from jaroku_runner import controlplane_http as c\n" +
        "print(c.request_mcp_confirm('py-nonce-1', {'server':'mock','tool':'send_message'}, 20))",
      commonEnv,
    );
    // `uv run python -c ...` pays real interpreter/venv startup cost before a single line of
    // the script runs — long enough on a cold cache that a short wait here is a race against
    // the subprocess rather than against the network call it is about to make.
    let resolved = false;
    for (let i = 0; i < 100 && !resolved; i++) {
      await new Promise((r) => setTimeout(r, 100));
      resolved = bus.resolveMcpConfirm("run-py-1", "py-nonce-1", "once");
    }
    check("the server saw the Python client's blocking confirm request", resolved);
    const r = await pending;
    check("request_mcp_confirm returns the resolved verdict", r.stdout.trim() === "once", r.stderr.slice(0, 300));
  }

  {
    const r = await runPython(
      "from jaroku_runner import controlplane_http as c\n" +
        "print(c.request_mcp_confirm('py-nonce-2', {}, 0.2))",
      commonEnv,
    );
    check("an unanswered confirm denies rather than allowing", r.stdout.trim() === "deny", r.stderr.slice(0, 300));
  }
} catch (e) {
  check("the Python control-plane client suite ran to completion", false, (e as Error).message);
} finally {
  http.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
