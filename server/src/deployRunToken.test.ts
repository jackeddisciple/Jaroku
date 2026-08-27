// The credential a deployed run authenticates with, driven against the real control-plane
// routes on a real port.
//
//   npm run test:run-token-deploy
//
// §7 is explicit that "a deployed run is not more trusted than a sandboxed one — every bound
// that applies to a sandbox run applies here, and the tenancy check is the same one: a run
// token minted for run A presented against run B is a 403, not a 404." That sentence is three
// claims, and all three are asserted here THROUGH THE HTTP SURFACE rather than against
// `verifyRunToken` directly: the check that matters is the one `authenticate` makes on the way
// into a route, and a unit test of the verifier passes just as happily with the route not
// calling it.

import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { Router } from "./http/router.ts";
import { BackpressureTracker } from "./sandbox/backpressure.ts";
import { RunEventBus } from "./sandbox/eventBus.ts";
import { registerControlPlaneRoutes } from "./sandbox/controlPlaneRoutes.ts";
import { mintRunToken, RunTokenRevocationList, MAX_RUN_TOKEN_TTL_S } from "./sandbox/runTokens.ts";
import { DeployRuns, DEPLOY_RUN_TOKEN_TTL_S } from "./deployRuns.ts";
import { SCHEMA_VERSION, type TraceEvent } from "./types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const signingKey = randomBytes(32);
const revocations = new RunTokenRevocationList();
const bus = new RunEventBus();
const router = new Router({ log: () => {}, quiet: () => true });
registerControlPlaneRoutes(router, {
  bus, signingKey, revocations, backpressure: new BackpressureTracker(),
});

const http = createServer((req, res) => {
  void router.handle(req, res).then((handled) => { if (!handled) res.writeHead(404).end(); });
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

const WORKSPACE = randomUUID();
const runStart = (runId: string): TraceEvent => ({
  kind: "run_start",
  schema_version: SCHEMA_VERSION,
  run: {
    id: runId, agent_id: "a_deployed_agent", provider: "anthropic", model: "claude-haiku-4-5",
    status: "running", started_at: new Date().toISOString(), ended_at: null,
    cost: 0, tokens: 0, error: null,
  },
});

/** One trace push, exactly as a container makes it: bearer run token, batched events. */
async function pushTrace(runId: string, token: string, events: unknown[]): Promise<number> {
  const res = await fetch(`${base}/v1/runs/${runId}/trace`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  });
  await res.text();
  return res.status;
}

const runs = new DeployRuns({ signingKey, revocations, bus });

// --- the ordinary case, so the refusals below mean something -----------------------------

const runA = randomUUID();
const a = runs.open({ runId: runA, workspaceId: WORKSPACE, deploymentId: "dep-1", agentId: "a_deployed_agent" });

check(
  "a dispatch registers the run on the bus before the token exists",
  bus.has(runA),
);
check(
  "...and mints a token at the policy ceiling rather than a second number beside it",
  DEPLOY_RUN_TOKEN_TTL_S === MAX_RUN_TOKEN_TTL_S,
  `${DEPLOY_RUN_TOKEN_TTL_S} vs ${MAX_RUN_TOKEN_TTL_S}`,
);
check(
  "a deployed run's own token reaches its own trace",
  (await pushTrace(runA, a.runToken, [runStart(runA)])) === 200,
);

// --- a token for run A, presented against run B -------------------------------------------

const runB = randomUUID();
const b = runs.open({ runId: runB, workspaceId: WORKSPACE, deploymentId: "dep-1", agentId: "a_deployed_agent" });

{
  const status = await pushTrace(runB, a.runToken, [runStart(runB)]);
  // 403 AND NOT 404. The distinction is the whole assertion: 404 would read as "maybe try a
  // different id", which turns the route into a way to discover which run ids are real.
  check("run A's token against run B is a 403, not a 404", status === 403, `got ${status}`);
}
{
  // AND THE SAME REFUSAL WITHIN ONE WORKSPACE, which is the case that is easy to get wrong. Both
  // runs belong to the same tenant here, so nothing about tenancy stops this — only the run
  // scope does, which is exactly what runTokens.ts's header says a run-scoped token is for.
  const status = await pushTrace(runA, b.runToken, [runStart(runA)]);
  check("...even when both runs are in the same workspace", status === 403, `got ${status}`);
}
{
  const status = await pushTrace(runA, "not-a-token-at-all", [runStart(runA)]);
  check("a malformed token is refused", status === 401, `got ${status}`);
}
{
  // A well-formed token this server did not sign.
  const forged = mintRunToken(randomBytes(32), runA, WORKSPACE, 600);
  const status = await pushTrace(runA, forged, [runStart(runA)]);
  check("a token signed with another key is refused", status === 401, `got ${status}`);
}
{
  const res = await fetch(`${base}/v1/runs/${runA}/trace`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [] }),
  });
  await res.text();
  check("no token at all is refused", res.status === 401, `got ${res.status}`);
}

// --- an expired one ------------------------------------------------------------------------

{
  // Minted a full TTL in the past, so it is expired the moment it exists. Asserted against the
  // ROUTE rather than the verifier, because an expiry the verifier reports and the route does
  // not act on is an expiry that does not exist.
  const expired = mintRunToken(signingKey, runA, WORKSPACE, 60, Date.now() - 120_000);
  const status = await pushTrace(runA, expired, [runStart(runA)]);
  check("an expired token is refused", status === 401, `got ${status}`);
}

// --- revocation on run_end -------------------------------------------------------------------

{
  const before = await pushTrace(runA, a.runToken, [runStart(runA)]);
  const closed = runs.close(runA, "ended");
  const after = await pushTrace(runA, a.runToken, [runStart(runA)]);
  check("a run's token works right up to the moment the run ends", before === 200, `got ${before}`);
  check("closing a run revokes it", closed);
  // THIS IS THE ONE THAT MATTERS. A self-contained token cannot be un-minted, so revocation IS
  // the mechanism that stops a finished container pushing — for the remaining hour and fifty
  // minutes of a token it still physically holds.
  check("...and every later push from that container is refused", after === 401, `got ${after}`);
  check("...and the bus entry goes with it", !bus.has(runA));
  check("closing twice is not an error", runs.close(runA, "ended") === false);
}

{
  // AND THE OTHER TWO WAYS OUT. §7 says "revoke on abandon and on cancel too", and the failure
  // mode of forgetting either is silent: a container nobody has heard from, still able to write
  // into a workspace's trace for as long as its token lives.
  const cancelled = randomUUID();
  const c = runs.open({ runId: cancelled, workspaceId: WORKSPACE, deploymentId: "dep-1", agentId: "a" });
  runs.close(cancelled, "cancelled");
  check("a cancelled run's token is revoked", (await pushTrace(cancelled, c.runToken, [runStart(cancelled)])) === 401);

  const abandoned = randomUUID();
  const d = runs.open({ runId: abandoned, workspaceId: WORKSPACE, deploymentId: "dep-1", agentId: "a" });
  runs.close(abandoned, "abandoned");
  check("an abandoned run's token is revoked", (await pushTrace(abandoned, d.runToken, [runStart(abandoned)])) === 401);
}

// --- what the registry knows, for the sweep that reads it later --------------------------------

{
  let clock = 1_000_000;
  const timed = new DeployRuns({ signingKey, revocations, bus, now: () => clock });
  const runId = randomUUID();
  timed.open({ runId, workspaceId: WORKSPACE, deploymentId: "dep-2", agentId: "a" });

  check("a run just dispatched is not stale", timed.stale(60_000).length === 0);
  clock += 30_000;
  timed.heard(runId);
  clock += 45_000;
  check("...and a run that pushed 45s ago is not stale against a 60s ceiling", timed.stale(60_000).length === 0);
  clock += 30_000;
  check("...but one that has said nothing for 75s is", timed.stale(60_000).map((e) => e.runId).join() === runId);
  // MEASURED FROM DISPATCH, NOT FROM THE FIRST PUSH. A container that crashed on boot never
  // pushes at all, and a clock that only started on the first push would leave that run in
  // flight forever — which is the exact row §7 says must never exist.
  const never = randomUUID();
  timed.open({ runId: never, workspaceId: WORKSPACE, deploymentId: "dep-2", agentId: "a" });
  clock += 120_000;
  check(
    "a container that never said a word is stale from when it was dispatched",
    timed.stale(60_000).some((e) => e.runId === never),
  );
  for (const e of timed.entries()) timed.close(e.runId, "abandoned");
}

http.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
// `process.exitCode` and let the loop drain, rather than `process.exit` — the same choice
// billing/usageReporter.test.ts makes and for the same reason. A suite that stood an HTTP
// server up and then exits while it is still closing trips a libuv assertion on Windows
// (`!(handle->flags & UV_HANDLE_CLOSING)`) AFTER printing ALL CORRECT, which looks exactly like
// a regression and is not one.
process.exitCode = fail === 0 ? 0 : 1;
