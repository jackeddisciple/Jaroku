// mcp_bridge.py's confirmation gate over a hosted control plane — driven against the real HTTP
// routes, the same "drive the real Python" discipline mcpIsolation.test.ts already uses for the
// bridge's other behaviour. No live MCP server needed: _confirm is exercised directly, since the
// gate's logic has nothing to do with what a tool call itself does.
//
//   npm run test:mcp-confirm-http

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "../http/router.ts";
import { RunEventBus } from "./eventBus.ts";
import { mintRunToken, RunTokenRevocationList } from "./runTokens.ts";
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
// The nonce is minted inside the Python process and cannot be predicted from here — learned
// instead from the same callback production wiring would use to raise the confirmation dialog,
// which is the server-side notification path for a POSTed /mcp-confirm request, NOT the
// separate /control push (mcp_bridge.py's own stderr @@JAROKU_CTRL@@ line is local-only; only
// debug.py's boundary/pause lines are additionally pushed over HTTP — see controlplane_http.py).
const noncesByRun = new Map<string, string>();
registerControlPlaneRoutes(router, {
  bus,
  signingKey,
  revocations: new RunTokenRevocationList(),
  onMcpConfirmRequested: (runId, payload) => {
    if (typeof payload.nonce === "string") noncesByRun.set(runId, payload.nonce);
  },
});

const http = createServer((req, res) => {
  void router.handle(req, res).then((handled) => {
    if (!handled) res.writeHead(404).end();
  });
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

/**
 * Run mcp_bridge.py's `_confirm` for one high-impact call against the real control plane, and
 * — unless `verdict === "timeout"` — answer it as soon as the pushed "tool_confirm" control
 * line reveals the nonce the Python process minted (it cannot be predicted from here).
 */
async function confirmWith(
  mode: undefined | string,
  timeoutS: number,
  verdict: "run" | "once" | "deny" | "timeout",
): Promise<{ stdout: string; stderr: string }> {
  const runId = `mcp-${Math.random().toString(36).slice(2)}`;
  bus.register(runId);
  const token = mintRunToken(signingKey, runId, "ws-1", 3600);

  const script = `
import sys, os
sys.path.insert(0, ${JSON.stringify(RUNTIME_DIR)})
os.environ["JAROKU_MCP_CONFIRM_TIMEOUT_S"] = ${JSON.stringify(String(timeoutS))}
from tool_templates import mcp_bridge as B
try:
    B._confirm("mock", "send_message", {"channel": "eng"}, "starts with send")
    print("PROCEEDED")
except B.ToolNotApproved as e:
    print(f"DENIED: {e}")
`.trim();
  const env: Record<string, string> = { JAROKU_CONTROL_PLANE_URL: base, JAROKU_RUN_TOKEN: token, JAROKU_RUN_ID: runId };
  if (mode) env.JAROKU_MCP_CONFIRM = mode;

  const pending = new Promise<{ stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn("uv", ["run", "python", "-c", script], {
      cwd: RUNTIME_DIR,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", () => resolveRun({ stdout, stderr }));
  });

  if (verdict !== "timeout") {
    // uv's own startup cost, again — see controlPlaneHttp.python.test.ts's identical note.
    let nonce: string | undefined;
    for (let i = 0; i < 150 && !nonce; i++) {
      await new Promise((r) => setTimeout(r, 100));
      nonce = noncesByRun.get(runId);
    }
    if (nonce) bus.resolveMcpConfirm(runId, nonce, verdict);
  }
  return pending;
}

{
  const r = await confirmWith(undefined, 20, "run");
  check("a resolved 'run' verdict proceeds", r.stdout.includes("PROCEEDED"), r.stderr.slice(0, 300));
}
{
  const r = await confirmWith(undefined, 20, "once");
  check("a resolved 'once' verdict proceeds", r.stdout.includes("PROCEEDED"), r.stderr.slice(0, 300));
}
{
  const r = await confirmWith(undefined, 20, "deny");
  check("a resolved 'deny' verdict raises ToolNotApproved", r.stdout.startsWith("DENIED:"), r.stderr.slice(0, 300));
}
{
  const r = await confirmWith(undefined, 1, "timeout");
  check("no answer within the server's own timeout denies, never proceeds", r.stdout.startsWith("DENIED:"), r.stderr.slice(0, 300));
}
{
  const r = await confirmWith("skip", 20, "timeout");
  check("JAROKU_MCP_CONFIRM=skip bypasses the HTTP gate entirely", r.stdout.includes("PROCEEDED"), r.stderr.slice(0, 300));
}

http.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
