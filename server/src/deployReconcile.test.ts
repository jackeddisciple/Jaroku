// A container that stops reporting is closed out as errored, with the honest reason.
//
//   npm run test:deploy-reconcile
//
// §7: "If a deployed run stops pushing — container died, network partition, OOM — Jaroku must not
// leave a row claiming to be in flight forever... closed out as errored with a reason that says
// exactly what is known and what is not. Never a silent success, never a confident failure."
//
// The assertions split along that sentence. Half are about a run that really did go silent being
// closed; the other half are about runs that MUST NOT BE — a paused one, a slow one, one that
// finished a moment ago — because a sweep that closes those out is worse than no sweep at all: it
// ends runs that were working, and it does it invisibly.
//
// Driven with the stub container for the silence itself, because "stops pushing halfway and never
// pushes again" is a behaviour a real runner cannot be asked for, and with an injected clock,
// because the alternative to injecting one is a suite that sleeps for fifteen minutes.

import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMockServe } from "../fixtures/deploy/mockServe.ts";
import { DeployRuns } from "./deployRuns.ts";
import { DeployReconciler, DEPLOY_SILENCE_CEILING_MS, STOPPED_REPORTING } from "./deployReconcile.ts";
import { Router } from "./http/router.ts";
import { BackpressureTracker } from "./sandbox/backpressure.ts";
import { RunEventBus } from "./sandbox/eventBus.ts";
import { registerControlPlaneRoutes } from "./sandbox/controlPlaneRoutes.ts";
import { RunTokenRevocationList } from "./sandbox/runTokens.ts";
import { TraceStore } from "./store.ts";
import { aggregateJob } from "./evalAggregate.ts";
import { openTestSqlite, testContext } from "./db/testDb.ts";
import type { TraceEvent } from "./types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const DB = join(tmpdir(), `jaroku-deploy-reconcile-${randomUUID()}.db`);
const db = await openTestSqlite(DB);
const store = new TraceStore(db);
await store.init();
const ctx = testContext();

const signingKey = randomBytes(32);
const revocations = new RunTokenRevocationList();
const bus = new RunEventBus();
const router = new Router({ log: () => {}, quiet: () => true });
registerControlPlaneRoutes(router, { bus, signingKey, revocations, backpressure: new BackpressureTracker() });
const http = createServer((req, res) => {
  void router.handle(req, res).then((h) => { if (!h) res.writeHead(404).end(); });
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const controlPlaneUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

// An injected clock, so fifteen minutes of silence costs a variable assignment rather than
// fifteen minutes. Both the registry and the sweep read it, so they cannot disagree about now.
let clock = Date.UTC(2026, 7, 27, 12, 0, 0);
const deployRuns = new DeployRuns({ signingKey, revocations, bus, now: () => clock });

// The ingest chain, as index.ts wires it — persist what arrives, attributed by the entry that
// registered it. The sweep pushes its synthesised run_end onto the same bus, so if it wrote
// straight to the table instead, none of these assertions about the ROW would pass.
const persisted: Promise<unknown>[] = [];
deployRuns.on("event", ({ runId, event }) => {
  const claimed = event.kind === "step" ? event.step.run_id : event.run.id;
  if (claimed !== runId) return;
  persisted.push(event.kind === "step" ? store.insertStep(ctx, event.step) : store.upsertRun(ctx, event.run));
});
const broadcast: TraceEvent[] = [];
deployRuns.on("event", ({ event }) => broadcast.push(event));

const reconciler = new DeployReconciler({
  runs: deployRuns, bus, store, contextFor: () => ctx, now: () => clock,
});

/** Start a stub container with one behaviour and let it push whatever it is going to push. */
async function runStub(behaviour: "died" | "complete", runId: string) {
  const stub = await startMockServe({ token: "t", behaviour, agentId: "a_deployed_agent" });
  const opened = deployRuns.open({ runId, workspaceId: ctx.workspaceId, deploymentId: "dep-1", agentId: "a_deployed_agent" });
  const res = await fetch(`${stub.url}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify({ input: "x", run_id: runId, run_token: opened.runToken, control_plane_url: controlPlaneUrl }),
  });
  await res.text();
  await stub.settled(runId);
  await Promise.all(persisted.splice(0));
  await stub.close();
  return opened;
}

// --- 1. the container that stopped halfway --------------------------------------------------

const dead = randomUUID();
{
  const deadToken = (await runStub("died", dead)).runToken;
  const row = await store.getRun(ctx, dead);
  check("a container that stopped halfway leaves a run that reads as still running",
    row?.status === "running", String(row?.status));
  check("...with the steps it managed to push already on the trace",
    (await store.stepsForRun(ctx, dead)).length === 2, String((await store.stepsForRun(ctx, dead)).length));

  // NOT YET. A run that has been quiet for a minute is a run doing something, and closing it out
  // would be the confident failure the module refuses. The sweep's whole design lives in this
  // assertion and the next one.
  clock += 60_000;
  check("a run quiet for a minute is left alone", (await reconciler.sweep()).length === 0);
  clock += 9 * 60_000;
  // TEN MINUTES IS STILL NOT ENOUGH, and the reason is a real ceiling elsewhere in the product:
  // an MCP confirmation blocks on a human for up to ten minutes and pushes nothing while it
  // waits. A sweep that fired at ten would close out every run somebody was thinking about.
  check("...and so is one quiet for ten, because a confirmation can hold a human that long",
    (await reconciler.sweep()).length === 0);

  clock += DEPLOY_SILENCE_CEILING_MS;
  const closed = await reconciler.sweep();
  await Promise.all(persisted.splice(0));
  check("a run past the silence ceiling is closed out", closed.length === 1 && closed[0]!.runId === dead,
    JSON.stringify(closed));
  check("...and reported as having been closed out rather than merely released",
    closed[0]?.closedOut === true);

  const after = await store.getRun(ctx, dead);
  check("...so the row no longer claims to be in flight", after?.status === "error", String(after?.status));
  // NEVER A SILENT SUCCESS. "completed" would tell a user their agent did its job.
  check("...never as completed", after?.status !== "completed");
  // NEVER A CONFIDENT FAILURE. The reason is the whole assertion: it says the container stopped
  // reporting, that the run MAY have completed, and that it MAY have spent money — three claims
  // about what is not known, which is what is actually known.
  check("...with a reason that says what is known and what is not", after?.error === STOPPED_REPORTING,
    after?.error ?? "(none)");
  check("...naming the money explicitly, because that is the half people need told",
    (after?.error ?? "").includes("may have spent money") && (after?.error ?? "").includes("cost is real"),
    after?.error ?? "(none)");

  // AND THE MONEY IS STILL RIGHT. `runs.cost` is left at the zero run_start wrote — deliberately,
  // because nobody witnessed an ending — and the real figure comes from the steps, as always.
  const metrics = await aggregateJob(ctx, store, dead, "claude-haiku-4-5");
  check("the cost of what it did before it went is still readable from its steps",
    (metrics.cost_usd ?? 0) > 0, String(metrics.cost_usd));
  check("...while the run's own cost column is still the zero nobody witnessed a change to",
    after?.cost === 0, String(after?.cost));

  // THROUGH THE BUS, NOT INTO THE TABLE. If the sweep had written directly, this run_end would
  // never have reached the relay, the thread list or the Inbox — a correct row and a silent one.
  check("the synthesised ending went down the same chain a real one does",
    broadcast.some((e) => e.kind === "run_end" && e.run.id === dead && e.run.error === STOPPED_REPORTING));

  check("...and the run's token is revoked, so the container cannot come back to life",
    !deployRuns.has(dead));
  const late = await fetch(`${controlPlaneUrl}/v1/runs/${dead}/trace`, {
    method: "POST",
    // WITH THE TOKEN THE CONTAINER ACTUALLY HOLDS, not a blank one — an empty bearer is refused
    // by the shape check before revocation is ever consulted, so this would pass against a sweep
    // that revoked nothing at all.
    headers: { "content-type": "application/json", authorization: `Bearer ${deadToken}` },
    body: JSON.stringify({ events: [] }),
  });
  await late.text();
  check("...which a late push finds out about", late.status === 401, String(late.status));

  check("a second sweep has nothing left to do", (await reconciler.sweep()).length === 0);
}

// --- 2. every run that must NOT be closed out ------------------------------------------------

{
  // A RUN THAT FINISHED. Its own `run_closed` released it, so the sweep never sees it — but if
  // the entry lingered for any reason, the sweep must not rewrite a completed run as an error.
  const done = randomUUID();
  await runStub("complete", done);
  clock += 2 * DEPLOY_SILENCE_CEILING_MS;
  const closed = await reconciler.sweep();
  await Promise.all(persisted.splice(0));
  const row = await store.getRun(ctx, done);
  check("a run that completed is not rewritten as an error by a later sweep",
    row?.status === "completed" && row.error === null,
    `${row?.status} ${row?.error}`);
  check("...and is not reported as closed out", !closed.some((c) => c.runId === done && c.closedOut));
}

{
  // A PAUSED RUN IS SILENT BY DESIGN, for as long as a person takes to come back to it. There is
  // no ceiling long enough for that, so it is excluded rather than given a bigger number.
  const paused = randomUUID();
  deployRuns.open({ runId: paused, workspaceId: ctx.workspaceId, deploymentId: "dep-1", agentId: "a" });
  await store.upsertRun(ctx, {
    id: paused, agent_id: "a", provider: "anthropic", model: "claude-haiku-4-5",
    status: "running", started_at: new Date(clock).toISOString(), ended_at: null,
    cost: 0, tokens: 0, error: null,
  });
  await store.setRunStatus(ctx, paused, "paused");

  clock += 10 * DEPLOY_SILENCE_CEILING_MS;
  const closed = await reconciler.sweep();
  const row = await store.getRun(ctx, paused);
  check("a paused run is never closed out, however long it stays paused",
    !closed.some((c) => c.runId === paused) && (row?.status as string) === "paused",
    `${JSON.stringify(closed)} :: ${row?.status}`);
  check("...and keeps its entry, because a resume needs it", deployRuns.has(paused));
  deployRuns.close(paused, "ended");
}

{
  // A DISPATCH THE CONTAINER NEVER ACKNOWLEDGED. There is no row to mark errored, and a sweep
  // that invented one would put a run in somebody's history that never existed.
  const ghost = randomUUID();
  deployRuns.open({ runId: ghost, workspaceId: ctx.workspaceId, deploymentId: "dep-1", agentId: "a" });
  clock += 2 * DEPLOY_SILENCE_CEILING_MS;
  const closed = await reconciler.sweep();
  await Promise.all(persisted.splice(0));
  check("a dispatch that never produced a run is released, not invented into one",
    closed.some((c) => c.runId === ghost && !c.closedOut) && !(await store.getRun(ctx, ghost)),
    JSON.stringify(closed));
  check("...and its token is revoked all the same", !deployRuns.has(ghost));
}

{
  // AND ONE THAT IS STILL TALKING. `heard` moves on every push, so a long run that reports
  // steadily is never stale however long it lasts — the ceiling is on SILENCE, not on duration.
  const chatty = randomUUID();
  deployRuns.open({ runId: chatty, workspaceId: ctx.workspaceId, deploymentId: "dep-1", agentId: "a" });
  for (let i = 0; i < 6; i++) {
    clock += DEPLOY_SILENCE_CEILING_MS - 60_000;
    deployRuns.heard(chatty);
    check(`a run still pushing after ${(i + 1) * 14} minutes is not stale`,
      (await reconciler.sweep()).filter((c) => c.runId === chatty).length === 0);
  }
  deployRuns.close(chatty, "ended");
}

http.close();
await db.close();
try { rmSync(DB, { force: true }); } catch { /* the OS will get it */ }
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
