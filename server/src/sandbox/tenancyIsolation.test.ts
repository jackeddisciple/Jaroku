// The tenancy suite's own promise — "for every command, with two workspaces A and B populated,
// assert that A's context cannot read, mutate, or enumerate any of B's rows" — extended onto
// the surface Session 4 added: a hosted run's control-plane calls.
//
// Kept as its own file rather than folded into tenancy.test.ts's SCOPED_API: that suite's
// fixtures are two Db-backed workspaces with rows in them, and none of what is asserted here —
// a run token's scope, a control-plane route's authorisation — touches the tenant database at
// all. Forcing it through tenancy.test.ts's migration-and-Db harness would test the same claim
// through infrastructure it does not need, in a file already the length of a small module.
//
//   npm run test:tenancy-isolation

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { Router } from "../http/router.ts";
import { BackpressureTracker } from "./backpressure.ts";
import { RunEventBus } from "./eventBus.ts";
import { mintRunToken, RunTokenRevocationList, verifyRunToken } from "./runTokens.ts";
import { registerControlPlaneRoutes } from "./controlPlaneRoutes.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const signingKey = randomBytes(32);
const bus = new RunEventBus();
const mcpRequests: Array<{ runId: string }> = [];
const router = new Router({ log: () => {}, quiet: () => true });
registerControlPlaneRoutes(router, {
  bus,
  signingKey,
  revocations: new RunTokenRevocationList(),
  backpressure: new BackpressureTracker(),
  onMcpConfirmRequested: (runId) => mcpRequests.push({ runId }),
});

const http = createServer((req, res) => {
  void router.handle(req, res).then((handled) => {
    if (!handled) res.writeHead(404).end();
  });
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}

// --- workspace A and workspace B, each with their own run -----------------------------------

bus.register("run-a");
bus.register("run-b");
const tokenA = mintRunToken(signingKey, "run-a", "workspace-A", 3600);
const tokenB = mintRunToken(signingKey, "run-b", "workspace-B", 3600);

{
  const r = await call("POST", "/v1/runs/run-b/control", tokenA, { ctrl: { ctrl: "boundary" } });
  check("workspace A's token cannot push a control line onto workspace B's run", r.status === 403);
}
{
  const r = await call("POST", "/v1/runs/run-a/control", tokenB, { ctrl: { ctrl: "boundary" } });
  check("...and the refusal holds in the other direction too", r.status === 403);
}
{
  const validEvent = { kind: "run_start", schema_version: 1, run: { id: "run-b" } };
  const r = await call("POST", "/v1/runs/run-b/trace", tokenA, { events: [validEvent] });
  check("workspace A's token cannot push a trace event onto workspace B's run", r.status === 403);
}
{
  const r = await call("GET", "/v1/runs/run-b/control", tokenA);
  check("workspace A's token cannot long-poll for workspace B's run's control actions", r.status === 403);
}
{
  const r = await call("POST", "/v1/runs/run-b/mcp-confirm", tokenA, { nonce: "stolen-attempt" });
  check("workspace A's token cannot raise or answer an MCP confirmation on workspace B's run", r.status === 403);
}

// --- a forged workspace id inside an otherwise-valid-shaped token is still just a forgery ----

{
  const forged = mintRunToken(signingKey, "run-a", "workspace-B", 3600); // wrong workspace, right run+signature
  const claims = verifyRunToken(signingKey, forged);
  check(
    "a token minted with a forged workspaceId still verifies (the signature is honest about what was minted)",
    claims.ok,
  );
  check(
    "...but it carries the WORKSPACE ITS MINTER CHOSE — the mint call site is what must be trusted, not the token's shape",
    claims.ok && claims.claims.workspaceId === "workspace-B",
  );
  // This is why runPool.ts mints tokens itself, from ctx.workspaceId, rather than accepting one
  // from a caller: a token's workspace claim is only as trustworthy as whoever minted it, and
  // the only minter in this codebase is the pool acting on a resolved TenantContext.
}

// --- own-workspace access still works normally ------------------------------------------

{
  // 204: handleControlPush returns no body on success — see controlPlaneRoutes.ts.
  const r = await call("POST", "/v1/runs/run-a/control", tokenA, { ctrl: { ctrl: "boundary" } });
  check("workspace A's token DOES work against its own run", r.status === 204);
}
{
  const r = await call("POST", "/v1/runs/run-b/control", tokenB, { ctrl: { ctrl: "boundary" } });
  check("workspace B's token DOES work against its own run", r.status === 204);
}

// A short pause before closing lets `fetch`'s keep-alive sockets settle — closing the server
// out from under one mid-teardown is what the libuv assertion below was actually catching.
await new Promise((r) => setTimeout(r, 100));
await new Promise<void>((r) => http.close(() => r()));
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
