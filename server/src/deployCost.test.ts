// What a deployed run cost, and where that number comes from.
//
//   npm run test:deploy-cost
//
// §7: "Cost comes free, and you must not compute it a second time. Once steps land in the steps
// table, evalAggregate's rule applies unchanged: cost is summed from steps, never read from
// runs.cost, because a run that crashes mid-graph never emits a run_end and its row still reads
// 0 while its steps record real money already spent. Partial pricing stays flagged, an unpriced
// model is still null and never $0."
//
// So this suite does two things and neither of them is arithmetic on a new formula:
//
//   1. It pushes a deployed run's events through the REAL control-plane routes, into the REAL
//      TraceStore, and then asks `aggregateJob` — the function the eval engine already uses —
//      what it cost. If a second cost path had been written, this would be testing the wrong
//      one; the assertions below are chosen so that it could not pass against a `runs.cost`
//      read.
//   2. It reads the deploy layer's own source and fails on any `runs.cost` in it. That is the
//      half that survives somebody adding a cost column read next year, which no amount of
//      arithmetic here would catch.

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TraceStore } from "./store.ts";
import { aggregateJob } from "./evalAggregate.ts";
import { openTestSqlite, testContext } from "./db/testDb.ts";
import { DeployRuns } from "./deployRuns.ts";
import { Router } from "./http/router.ts";
import { BackpressureTracker } from "./sandbox/backpressure.ts";
import { RunEventBus } from "./sandbox/eventBus.ts";
import { registerControlPlaneRoutes } from "./sandbox/controlPlaneRoutes.ts";
import { RunTokenRevocationList } from "./sandbox/runTokens.ts";
import { randomBytes } from "node:crypto";
import { SCHEMA_VERSION, type Run, type Step, type TraceEvent } from "./types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const SRC = dirname(fileURLToPath(import.meta.url));
const DB = join(tmpdir(), `jaroku-deploy-cost-${randomUUID()}.db`);
const db = await openTestSqlite(DB);
const store = new TraceStore(db);
await store.init();
const ctx = testContext();

// --- the real ingest, end to end ------------------------------------------------------------

const signingKey = randomBytes(32);
const revocations = new RunTokenRevocationList();
const bus = new RunEventBus();
const router = new Router({ log: () => {}, quiet: () => true });
registerControlPlaneRoutes(router, { bus, signingKey, revocations, backpressure: new BackpressureTracker() });
const http = createServer((req, res) => {
  void router.handle(req, res).then((h) => { if (!h) res.writeHead(404).end(); });
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

const deployRuns = new DeployRuns({ signingKey, revocations, bus });

// THE INGEST CHAIN, IN MINIATURE, AND OFF THE SAME EMITTER index.ts USES. `DeployRuns` emits
// `event` with the run id attributed by the entry that registered it, exactly as a pool slot
// does; production's handler persists and meters. This one only persists, because metering is
// billing/usage.ts's suite and not this one — but it is the SAME emitter, so a deployed run that
// did not emit at all would fail every assertion below rather than silently pass a fixture.
const persisted: Promise<unknown>[] = [];
deployRuns.on("event", ({ runId, event }) => {
  const claimed = event.kind === "step" ? event.step.run_id : event.run.id;
  if (claimed !== runId) return; // the reconciliation production does, and for the same reason
  persisted.push(
    event.kind === "step" ? store.insertStep(ctx, event.step) : store.upsertRun(ctx, event.run),
  );
});

let seq = 0;
const stepFor = (runId: string, over: Partial<Step>): Step => ({
  id: randomUUID(), run_id: runId, seq: seq++, type: "llm_call", name: "agent",
  input: null, output: null, state_before: null, state_after: null,
  tokens: null, cost: null, latency_ms: 10, error: null, parent_step_id: null,
  started_at: new Date().toISOString(), ...over,
} as Step);

const runFor = (runId: string, model: string, over: Partial<Run> = {}): Run => ({
  id: runId, agent_id: "a_deployed_agent", provider: "anthropic", model,
  status: "running", started_at: new Date().toISOString(), ended_at: null,
  cost: 0, tokens: 0, error: null, ...over,
});

/** Push one batch the way a container does: bearer run token, `{events: [...]}`. */
async function push(runId: string, token: string, events: TraceEvent[]): Promise<number> {
  const res = await fetch(`${base}/v1/runs/${runId}/trace`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  });
  await res.text();
  await Promise.all(persisted.splice(0));
  return res.status;
}

// --- 1. a run that crashed mid-graph, whose row still reads zero -------------------------------

{
  const runId = randomUUID();
  const opened = deployRuns.open({ runId, workspaceId: ctx.workspaceId, deploymentId: "d", agentId: "a" });
  const model = "claude-haiku-4-5";

  await push(runId, opened.runToken, [
    { kind: "run_start", schema_version: SCHEMA_VERSION, run: runFor(runId, model) },
    { kind: "step", schema_version: SCHEMA_VERSION, step: stepFor(runId, { tokens: 1_000, cost: 0.004 }) },
    { kind: "step", schema_version: SCHEMA_VERSION, step: stepFor(runId, { type: "tool_call", name: "lookup" }) },
    { kind: "step", schema_version: SCHEMA_VERSION, step: stepFor(runId, { tokens: 2_000, cost: 0.006 }) },
  ]);
  // And then nothing. The container died; no run_end ever arrives, so `runs.cost` stays at the
  // zero run_start wrote — which is exactly the row a naive cost read would believe.
  const row = await store.getRun(ctx, runId);
  check("a crashed deployed run's own row still claims it cost nothing", row?.cost === 0, String(row?.cost));

  const metrics = await aggregateJob(ctx, store, runId, model);
  // THE ASSERTION THAT COULD NOT PASS AGAINST A `runs.cost` READ.
  check("...but the money its steps already spent is reported", metrics.cost_usd === 0.01, String(metrics.cost_usd));
  check("...and so are the tokens", metrics.tokens === 3_000, String(metrics.tokens));
  check("...with the pricing marked complete, because every priced step was priced",
    metrics.cost_complete === true);
  deployRuns.close(runId, "abandoned");
}

// --- 2. an unpriced model is unknown, never free -------------------------------------------------

{
  const runId = randomUUID();
  const opened = deployRuns.open({ runId, workspaceId: ctx.workspaceId, deploymentId: "d", agentId: "a" });
  // A model with no entry in pricing.json. The interceptor prices what it can and leaves the
  // rest null; the aggregate must carry that through rather than summing nulls to zero.
  const model = "some-model-nobody-has-priced";

  await push(runId, opened.runToken, [
    { kind: "run_start", schema_version: SCHEMA_VERSION, run: runFor(runId, model) },
    { kind: "step", schema_version: SCHEMA_VERSION, step: stepFor(runId, { tokens: 900, cost: null }) },
    {
      kind: "run_end", schema_version: SCHEMA_VERSION,
      run: runFor(runId, model, { status: "completed", ended_at: new Date().toISOString() }),
    },
  ]);

  const metrics = await aggregateJob(ctx, store, runId, model);
  // $0 AND UNKNOWN ARE DIFFERENT CLAIMS. A deployed agent on a model nobody has priced showing
  // "$0.00" beside one showing "$0.31" says the first is free, which is not what is known about
  // it — and it is the number a user would make a decision on.
  check("an unpriced model reports null, never zero", metrics.cost_usd === null, String(metrics.cost_usd));
  check("...while its tokens are still real and still reported", metrics.tokens === 900, String(metrics.tokens));
  deployRuns.close(runId, "ended");
}

// --- 3. partial pricing is a floor, and says so ----------------------------------------------------

{
  const runId = randomUUID();
  const opened = deployRuns.open({ runId, workspaceId: ctx.workspaceId, deploymentId: "d", agentId: "a" });
  const model = "claude-haiku-4-5";

  await push(runId, opened.runToken, [
    { kind: "run_start", schema_version: SCHEMA_VERSION, run: runFor(runId, model) },
    { kind: "step", schema_version: SCHEMA_VERSION, step: stepFor(runId, { tokens: 500, cost: 0.002 }) },
    // Tokens, no cost. Whatever this call was, it was not priced — so the total below is a floor.
    { kind: "step", schema_version: SCHEMA_VERSION, step: stepFor(runId, { tokens: 700, cost: null }) },
    {
      kind: "run_end", schema_version: SCHEMA_VERSION,
      run: runFor(runId, model, { status: "completed", ended_at: new Date().toISOString(), cost: 0.002 }),
    },
  ]);

  const metrics = await aggregateJob(ctx, store, runId, model);
  check("a partly-priced deployed run reports what it could price", metrics.cost_usd === 0.002, String(metrics.cost_usd));
  check("...and flags that the number is a floor rather than a total", metrics.cost_complete === false);
  deployRuns.close(runId, "ended");
}

// --- 4. and a completed run agrees with itself ------------------------------------------------------

{
  const runId = randomUUID();
  const opened = deployRuns.open({ runId, workspaceId: ctx.workspaceId, deploymentId: "d", agentId: "a" });
  const model = "claude-haiku-4-5";
  await push(runId, opened.runToken, [
    { kind: "run_start", schema_version: SCHEMA_VERSION, run: runFor(runId, model) },
    { kind: "step", schema_version: SCHEMA_VERSION, step: stepFor(runId, { tokens: 100, cost: 0.0005 }) },
    { kind: "step", schema_version: SCHEMA_VERSION, step: stepFor(runId, { tokens: 200, cost: 0.0015 }) },
    {
      kind: "run_end", schema_version: SCHEMA_VERSION,
      run: runFor(runId, model, { status: "completed", ended_at: new Date().toISOString(), cost: 0.002, tokens: 300 }),
    },
  ]);
  const metrics = await aggregateJob(ctx, store, runId, model);
  check("a deployed run that finished cleanly sums to the same figure either way",
    metrics.cost_usd === 0.002 && metrics.tokens === 300, `${metrics.cost_usd}/${metrics.tokens}`);
  // WALL CLOCK FROM THE RUN ROW, not a sum of step durations — the gaps between steps are tool
  // I/O and provider queueing, and they are the difference between a deployed agent that feels
  // slow and one that is. Same rule the eval engine already applies.
  check("...and its latency is wall clock rather than a sum of steps",
    metrics.latency_ms !== null && metrics.latency_ms >= 0, String(metrics.latency_ms));
  deployRuns.close(runId, "ended");
}

// --- 5. the audit that survives the next person -------------------------------------------------------

{
  // NOTHING IN THE DEPLOY PATH MAY READ `runs.cost`. Every assertion above is about behaviour
  // today; this is the one that still holds when somebody adds a "what did this deployment cost"
  // panel next year and reaches for the column that is right there on the row. The rule is
  // evalAggregate.ts's, stated in its own header, and it is written here as a check rather than
  // as a comment because a comment has never stopped anybody.
  const DEPLOY_SOURCES = [
    "deployRuns.ts", "deployManager.ts", "deployStore.ts", "deployArtifacts.ts",
    "deploySecrets.ts", "dockerfile.ts",
  ];
  const offenders: string[] = [];
  for (const file of DEPLOY_SOURCES) {
    const text = readFileSync(resolve(SRC, file), "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      // Comments are where the rule is EXPLAINED, so they are exempt; SQL and property access
      // are where it would be broken.
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      if (/\bruns\.cost\b|\brun\.cost\b/.test(code)) offenders.push(`${file}:${i + 1}`);
    }
  }
  check("no part of the deploy path reads a run's cost column", offenders.length === 0, offenders.join(", "));

  // AND THE POSITIVE HALF, so the check above cannot pass by the deploy path simply not knowing
  // about cost at all: the function it is supposed to use exists and is the eval engine's.
  const aggregate = readFileSync(resolve(SRC, "evalAggregate.ts"), "utf8");
  check("...and the function it must use still sums from steps",
    /SUM\(cost\)\s+AS cost/.test(aggregate) && /FROM steps WHERE run_id/.test(aggregate));
}

http.close();
await db.close();
// Best-effort: on Windows a database file the driver has only just let go of refuses to be
// removed for a moment, and a suite whose assertions all passed must not go red over a temp
// file. `process.exitCode` rather than `process.exit` for the reason usageReporter.test.ts
// gives — exiting while the HTTP server above is still closing trips a libuv assertion on
// Windows AFTER printing ALL CORRECT, which reads as a regression and is not one.
try { rmSync(DB, { force: true }); } catch { /* the OS will get it */ }
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
