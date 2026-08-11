// The control-plane HTTP surface, driven over a real socket — auth, scoping, the long-poll,
// and the blocking MCP confirmation.
//
//   npm run test:control-plane-routes

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { Router } from "../http/router.ts";
import { RunEventBus } from "./eventBus.ts";
import { mintRunToken, RunTokenRevocationList } from "./runTokens.ts";
import { registerControlPlaneRoutes } from "./controlPlaneRoutes.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const signingKey = randomBytes(32);
const bus = new RunEventBus();
const revocations = new RunTokenRevocationList();
const confirmRequests: Array<{ runId: string; payload: Record<string, unknown> }> = [];

const router = new Router({ log: () => {}, quiet: () => true });
registerControlPlaneRoutes(router, {
  bus,
  signingKey,
  revocations,
  onMcpConfirmRequested: (runId, payload) => confirmRequests.push({ runId, payload }),
});

const http = createServer((req, res) => {
  void router.handle(req, res).then((handled) => {
    if (!handled) res.writeHead(404).end();
  });
});
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}

bus.register("run-1");
const token1 = mintRunToken(signingKey, "run-1", "ws-1", 3600);

// --- auth --------------------------------------------------------------------------------

{
  const r = await call("POST", "/v1/runs/run-1/control", null, { ctrl: { ctrl: "boundary" } });
  check("no bearer token is refused with 401", r.status === 401);
}
{
  const r = await call("POST", "/v1/runs/run-1/control", "garbage", { ctrl: { ctrl: "boundary" } });
  check("a malformed token is refused with 401", r.status === 401);
}
{
  bus.register("run-2");
  const tokenForOtherRun = mintRunToken(signingKey, "run-2", "ws-1", 3600);
  const r = await call("POST", "/v1/runs/run-1/control", tokenForOtherRun, { ctrl: { ctrl: "boundary" } });
  check("a token scoped to a different run is refused with 403, not 200", r.status === 403);
}
{
  const wrongKey = mintRunToken(randomBytes(32), "run-1", "ws-1", 3600);
  const r = await call("POST", "/v1/runs/run-1/control", wrongKey, { ctrl: { ctrl: "boundary" } });
  check("a token signed with the wrong key is refused", r.status === 401);
}

// --- trace push ----------------------------------------------------------------------------

{
  let received: unknown = null;
  bus.register("run-1");
  const emitter = bus.register("run-1");
  emitter.once("event", (e) => (received = e));
  const validEvent = {
    kind: "run_start",
    schema_version: 1,
    run: { id: "run-1", agent_id: "a", provider: "fake", model: "fake", status: "running", started_at: new Date().toISOString(), ended_at: null, cost: null, tokens: null, error: null },
  };
  const r = await call("POST", "/v1/runs/run-1/trace", token1, { events: [validEvent, { garbage: true }] });
  check("a batch of one valid and one invalid event reports 1 accepted, 1 dropped", (r.json as { accepted: number; dropped: number })?.accepted === 1 && (r.json as { dropped: number })?.dropped === 1);
  check("the valid event reached the bus", (received as { run?: { id?: string } })?.run?.id === "run-1");
}
{
  const r = await call("POST", "/v1/runs/run-1/trace", token1, { notEvents: true });
  check("a malformed batch body is refused with 400", r.status === 400);
}

// --- control push + long-poll ----------------------------------------------------------------

{
  let received: unknown = null;
  const emitter = bus.register("run-1");
  emitter.once("control", (c) => (received = c));
  await call("POST", "/v1/runs/run-1/control", token1, { ctrl: { ctrl: "paused", run_id: "run-1" } });
  check("a pushed control line reaches the bus", (received as { ctrl?: string })?.ctrl === "paused");
}
{
  bus.signal("run-1", { action: "pause" });
  const r = await call("GET", "/v1/runs/run-1/control", token1);
  check("a long-poll returns a queued action", r.status === 200 && (r.json as { action: string })?.action === "pause");
}
{
  const before = Date.now();
  const pending = call("GET", "/v1/runs/run-1/control", token1);
  setTimeout(() => bus.signal("run-1", { action: "resume" }), 30);
  const r = await pending;
  check("a long-poll wakes immediately once signalled while in flight", (r.json as { action: string })?.action === "resume" && Date.now() - before < 1000);
}

// --- mcp-confirm -----------------------------------------------------------------------------

{
  const pending = call("POST", "/v1/runs/run-1/mcp-confirm", token1, { nonce: "abc123", server: "mock", tool: "send_message", timeout_s: 5 });
  await new Promise((r) => setTimeout(r, 50)); // let the request land before resolving
  bus.resolveMcpConfirm("run-1", "abc123", "once");
  const r = await pending;
  check("resolveMcpConfirm answers a blocked mcp-confirm POST", (r.json as { verdict: string })?.verdict === "once");
  check("onMcpConfirmRequested was told about the request", confirmRequests.some((c) => c.runId === "run-1" && c.payload.nonce === "abc123"));
}
{
  const before = Date.now();
  const r = await call("POST", "/v1/runs/run-1/mcp-confirm", token1, { nonce: "never-answered", timeout_s: 0.2 });
  check("an unanswered mcp-confirm denies on its own timeout, never allows", (r.json as { verdict: string })?.verdict === "deny");
  check("the timeout was actually honoured, not returned instantly", Date.now() - before >= 150);
}
{
  const r = await call("POST", "/v1/runs/run-1/mcp-confirm", token1, { notNonce: true });
  check("a missing nonce is refused with 400", r.status === 400);
}

// --- revocation --------------------------------------------------------------------------

{
  bus.register("revoke-me");
  const revokedToken = mintRunToken(signingKey, "revoke-me", "ws-1", 3600);
  revocations.revoke("revoke-me", Date.now() + 3600_000);
  const r = await call("POST", "/v1/runs/revoke-me/control", revokedToken, { ctrl: { ctrl: "boundary" } });
  check("a revoked run's token is refused even though it has not expired", r.status === 401);
}

http.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
