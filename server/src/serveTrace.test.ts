// What a deployed run puts on the wire — and that it is the same thing a local run puts on the
// wire.
//
//   npm run test:serve-trace
//
// §12 asks for the comparison directly: "Diff a local trace against a deployed trace for the
// same agent and input. They should differ in run id and timing and nothing else. If they differ
// in shape, this part is not finished." So the suite runs the SAME agent, on the SAME input,
// against the SAME scripted provider, twice — once through `python -m jaroku_runner` reading
// stdout the way processManager.ts does, and once through a deployed container reading the
// control plane the way index.ts does — and compares the two.
//
// AND THE INGEST'S OWN BOUNDS, against the stub container, because those are the cases a real
// run cannot be made to produce: a batch of things that are not events, and a run pushing far
// more than its share. §7 is explicit that "every bound that applies to a sandbox run applies
// here"; the way that stops being true is nobody ever pushing enough to find out.

import { randomUUID } from "node:crypto";

import {
  deployedProject, dispatch, pythonExecutable, runLocally, startControlPlane,
  startMockProvider, startServe, traceShape, type MockTurn,
} from "../fixtures/deploy/serveHarness.ts";
import { startMockServe } from "../fixtures/deploy/mockServe.ts";
import { DeployDispatcher } from "./deployDispatch.ts";
import { BackpressureTracker, DEFAULT_BACKPRESSURE_LIMITS } from "./sandbox/backpressure.ts";
import type { TraceEvent } from "./types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- the stub half, which needs no Python -----------------------------------------------------
//
// Run first and unconditionally: these are assertions about the SERVER, and a machine with no
// interpreter should still be told whether its control plane refuses a malformed batch.

{
  const control = await startControlPlane();
  const stub = await startMockServe({ token: "stub-token", behaviour: "malformed" });
  const runId = randomUUID();
  const opened = control.runs.open({ runId, workspaceId: control.workspaceId, deploymentId: "d", agentId: "a" });

  const res = await fetch(`${stub.url}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub-token" },
    body: JSON.stringify({ input: "x", run_id: runId, run_token: opened.runToken, control_plane_url: control.url }),
  });
  check("the stub container answers 202 before it pushes anything", res.status === 202, String(res.status));
  await res.json();
  await stub.settled(runId);

  const events = control.eventsFor(runId);
  const errors = control.parseErrorsFor(runId);
  check("a malformed batch does not fail the run — the good events in it are still ingested",
    events.some((e) => e.kind === "run_start") && events.some((e) => e.kind === "step") &&
      events.some((e) => e.kind === "run_end"),
    traceShape(events).join(" "));
  // COUNTED AS DROPS, NOT SWALLOWED. A batch half of which is unrecognisable is a bug somebody
  // needs to be able to find, and the only evidence of it is this count and the parse errors
  // beside it.
  check("...and every unrecognisable entry is reported as a drop rather than ignored",
    errors.length === 4, `${errors.length} parse error(s): ${errors.map((e) => e.error).join(" | ")}`);
  check("...naming what was wrong with each",
    errors.every((e) => e.error.includes("not a recognized trace event")),
    errors.map((e) => e.error).join(" | "));
  check("...and the drop counter agrees", control.metrics.droppedFor(runId) === 4,
    String(control.metrics.droppedFor(runId)));

  await stub.close();
  await control.close();
}

{
  // BACKPRESSURE, AND THE PART THAT MATTERS MORE THAN THE REFUSAL: tripping it does not merely
  // reject the batch, it asks production to STOP THE RUN. A limiter that refuses writes while
  // the run keeps spending is a limiter on the database, not on the run.
  const backpressure = new BackpressureTracker({ ...DEFAULT_BACKPRESSURE_LIMITS, maxBytesPerRun: 64 * 1024 });
  const control = await startControlPlane({ backpressure });
  const stub = await startMockServe({ token: "stub-token", behaviour: "flood" });
  const runId = randomUUID();
  const opened = control.runs.open({ runId, workspaceId: control.workspaceId, deploymentId: "d", agentId: "a" });

  await (await fetch(`${stub.url}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stub-token" },
    body: JSON.stringify({ input: "x", run_id: runId, run_token: opened.runToken, control_plane_url: control.url }),
  })).json();
  await stub.settled(runId);

  check("a run pushing far too much, too fast, is refused",
    control.stopped.some((s) => s.runId === runId), JSON.stringify(control.stopped));
  check("...and the refusal says which bound it broke",
    control.stopped.some((s) => s.runId === runId && s.reason.length > 0),
    control.stopped.map((s) => s.reason).join(" | "));
  // AND IT IS NOT MORE TRUSTED THAN A SANDBOX RUN. The same tracker, the same three caps, the
  // same `onBackpressureViolation` production wires to `pool.stop`.
  check("...before it could write an unbounded amount into somebody's trace",
    control.eventsFor(runId).length < 16_000, String(control.eventsFor(runId).length));

  // AND THE BOUND IN FRONT OF IT, which is the router's own and is the first thing a flood meets.
  // Worth asserting because it is what makes the backpressure cap the SECOND line rather than the
  // only one: a single enormous batch never reaches the trace route at all.
  const huge = await fetch(`${control.url}/v1/runs/${runId}/trace`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opened.runToken}` },
    body: JSON.stringify({ events: [{ kind: "step", schema_version: 1, step: { pad: "x".repeat(200_000) } }] }),
  });
  await huge.text();
  check("a single batch larger than the request cap never reaches the trace route",
    huge.status === 413, String(huge.status));

  await stub.close();
  await control.close();
}

// --- the real half ------------------------------------------------------------------------------

if (!pythonExecutable()) {
  console.error(
    "no runtime/.venv — the local-versus-deployed comparison drives the real runner and cannot run without it.\n" +
    "  Run `uv sync` in runtime/ first. CI's `runtime` job does exactly that.",
  );
  process.exitCode = 1;
} else {

// The same script for both runs, so the two graphs take the same path through the same nodes.
// Two provider instances rather than one, because the script is consumed in order: sharing one
// would give the second run the tail of the first's script and produce a different graph, which
// is the one difference that would make this comparison meaningless.
const SCRIPT: MockTurn[] = [
  { kind: "tool_use", name: "current_time" },
  { kind: "tool_use", name: "word_count", input: { text: "one two three four" } },
  { kind: "text", text: "It is time, and there are four words." },
];
const INPUT = "what time is it, and how many words are in 'one two three four'?";

const project = deployedProject();

const localProvider = await startMockProvider(SCRIPT);
const local = await runLocally(project, localProvider, INPUT);
await localProvider.close();

const control = await startControlPlane();
const hostedProvider = await startMockProvider(SCRIPT);
const served = await startServe({ project, provider: hostedProvider });
const runId = randomUUID();
const opened = control.runs.open({
  runId, workspaceId: control.workspaceId, deploymentId: "dep-1", agentId: project.agentId,
});
await dispatch(served, {
  input: INPUT, run_id: runId, run_token: opened.runToken, control_plane_url: control.url,
});
{
  const deadline = Date.now() + 120_000;
  while (!control.eventsFor(runId).some((e) => e.kind === "run_end") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
}
const deployed = control.eventsFor(runId);

// --- schema v1, unchanged -------------------------------------------------------------------

{
  check("a deployed run produces a trace at all", deployed.length > 0, served.logs.slice(-6).join(" | "));
  check("...every event of which declares schema_version 1",
    deployed.length > 0 && deployed.every((e) => (e as { schema_version?: number }).schema_version === 1),
    JSON.stringify(deployed.map((e) => (e as { schema_version?: number }).schema_version)));
  // NOTHING IN THIS PART ADDS A FIELD, A KIND OR A STEP TYPE. §9's first line, asserted as an
  // absence: a deployed run's events carry exactly the keys events.md names and no more, so a
  // "deployment_id" or an "is_hosted" added here in a hurry fails on the way past.
  const RUN_KEYS = ["agent_id", "cost", "ended_at", "error", "id", "model", "provider", "started_at", "status", "tokens"];
  const STEP_KEYS = ["cost", "error", "id", "input", "latency_ms", "name", "output", "parent_step_id",
    "run_id", "seq", "started_at", "state_after", "state_before", "tokens", "type"];
  const extraneous: string[] = [];
  for (const e of deployed) {
    if (e.kind === "step") {
      for (const k of Object.keys(e.step)) if (!STEP_KEYS.includes(k)) extraneous.push(`step.${k}`);
    } else {
      for (const k of Object.keys(e.run)) if (!RUN_KEYS.includes(k)) extraneous.push(`run.${k}`);
    }
    for (const k of Object.keys(e)) if (!["kind", "schema_version", "run", "step"].includes(k)) extraneous.push(k);
  }
  check("...and carries not one field the frozen schema does not name",
    extraneous.length === 0, [...new Set(extraneous)].join(", "));
  check("...and no step type outside the four",
    deployed.every((e) => e.kind !== "step" || ["llm_call", "tool_call", "state_update", "router"].includes(e.step.type)));
}

// --- and it is the SAME trace a local run produces -------------------------------------------

{
  const localShape = traceShape(local.events);
  const deployedShape = traceShape(deployed);

  check("the local run produced a trace to compare against", localShape.length > 0,
    `${local.code} :: ${local.stderr.slice(-300)}`);
  // THE ASSERTION §12 NAMES. Kinds, step types, step names and seq, in order — everything a
  // reader of the Graph tab sees. Not "both have steps": a deployed run that emitted its tool
  // call before its llm_call, or that lost the router steps the conditional edge produces, would
  // pass a presence check and be a different trace.
  check("a deployed trace and a local trace are the same shape, step for step, in order",
    localShape.join("\n") === deployedShape.join("\n"),
    `local:    ${localShape.join(" ")}\n         deployed: ${deployedShape.join(" ")}`);

  const localRuns = local.events.filter((e) => e.kind !== "step");
  const deployedRuns = deployed.filter((e) => e.kind !== "step");
  const runOf = (e: TraceEvent) => (e.kind === "step" ? null : e.run);
  check("...on the same agent, provider and model",
    localRuns.length === deployedRuns.length &&
      localRuns.every((e, i) => {
        const a = runOf(e)!, b = runOf(deployedRuns[i]!)!;
        return a.agent_id === b.agent_id && a.provider === b.provider && a.model === b.model;
      }));
  check("...reaching the same status", runOf(localRuns.at(-1)!)!.status === runOf(deployedRuns.at(-1)!)!.status,
    `${runOf(localRuns.at(-1)!)!.status} vs ${runOf(deployedRuns.at(-1)!)!.status}`);
  // THE TWO THINGS THAT ARE ALLOWED TO DIFFER, asserted as differing — because a comparison that
  // would also pass if the deployed run were literally the local one proves nothing.
  check("...and differ in run id, which is the point",
    runOf(localRuns[0]!)!.id !== runOf(deployedRuns[0]!)!.id);

  // Cost and tokens are the same because the scripted provider reported the same usage twice —
  // which is exactly the claim that a deployed run is priced by the same table, in the same
  // place, as a local one.
  check("...and are priced identically, because the pricing table travelled with the interceptor",
    runOf(localRuns.at(-1)!)!.cost === runOf(deployedRuns.at(-1)!)!.cost &&
      runOf(localRuns.at(-1)!)!.tokens === runOf(deployedRuns.at(-1)!)!.tokens,
    `local ${runOf(localRuns.at(-1)!)!.cost}/${runOf(localRuns.at(-1)!)!.tokens} vs ` +
    `deployed ${runOf(deployedRuns.at(-1)!)!.cost}/${runOf(deployedRuns.at(-1)!)!.tokens}`);
  check("...and a real cost was actually computed, not a zero standing in for an unpriced model",
    (runOf(deployedRuns.at(-1)!)!.cost ?? 0) > 0, String(runOf(deployedRuns.at(-1)!)!.cost));
}

// --- and the run is over, on both sides --------------------------------------------------------

{
  check("the container reported the run closed", served.logs.some((l) => l.includes("run_closed")),
    served.logs.slice(-4).join(" | "));
  const closed = control.controlFor(runId).find((c) => c["ctrl"] === "run_closed");
  check("...over the control plane as well as into its own log", closed !== undefined,
    control.controlFor(runId).map((c) => String(c["ctrl"])).join(", "));
  check("...saying which way it ended", closed?.["status"] === "completed", JSON.stringify(closed));
}

await served.stop();
await hostedProvider.close();
await control.close();

// --- pause and resume, through the actions the control plane already had -----------------------
//
// A deployed run pauses because `controlplane_http.poll_control` asks at every node boundary and
// `bus.signal` answers — the same two halves a hosted sandbox run has always had, finally being
// used. Nothing here is a new mechanism; the only thing Part 1 added is that something now sends
// the action and something now dispatches the continuation.

{
  const pauseControl = await startControlPlane();
  const pauseProject = deployedProject();
  const pauseProvider = await startMockProvider(SCRIPT);
  // Slow enough at each boundary that there is a boundary to pause AT. The delay is a debug aid
  // the runner already has, not something added for this.
  const paused = await startServe({
    project: pauseProject, provider: pauseProvider, env: { JAROKU_STEP_DELAY_MS: "1200" },
  });
  const dispatcher = new DeployDispatcher({
    runs: pauseControl.runs,
    endpoint: async () => ({ url: paused.url, serveToken: paused.token }),
  });
  const pausedRunId = randomUUID();

  const started = await dispatcher.start({
    deploymentId: "dep-1", workspaceId: pauseControl.workspaceId, agentId: pauseProject.agentId,
    runId: pausedRunId, input: INPUT, controlPlaneUrl: pauseControl.url,
  });
  check("a deployed run can be dispatched by the server that will watch it", started.ok, JSON.stringify(started));

  {
    const deadline = Date.now() + 120_000;
    while (!pauseControl.eventsFor(pausedRunId).some((e) => e.kind === "step") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  pauseControl.bus.signal(pausedRunId, { action: "pause" });
  {
    const deadline = Date.now() + 90_000;
    while (!pauseControl.controlFor(pausedRunId).some((c) => c["ctrl"] === "run_closed") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const pauseCtrl = pauseControl.controlFor(pausedRunId).find((c) => c["ctrl"] === "paused");
  check("a pause reaches the container and is honoured at a node boundary", pauseCtrl !== undefined,
    pauseControl.controlFor(pausedRunId).map((c) => String(c["ctrl"])).join(", "));
  check("...leaving a durable checkpoint to continue from",
    typeof pauseCtrl?.["checkpoint_id"] === "string" && String(pauseCtrl["checkpoint_id"]).length > 0,
    JSON.stringify(pauseCtrl));
  // A PAUSED RUN IS NOT A FINISHED RUN. run_end is what closes a run out, and emitting one here
  // would make a run somebody is about to resume read as over — with a cost, a status and a
  // place in the Activity feed it has not earned yet.
  check("...and NOT a run_end, because a paused run is not over",
    !pauseControl.eventsFor(pausedRunId).some((e) => e.kind === "run_end"),
    traceShape(pauseControl.eventsFor(pausedRunId)).join(" "));
  check("...which the container says out loud rather than leaving to be inferred",
    pauseControl.controlFor(pausedRunId).find((c) => c["ctrl"] === "run_closed")?.["status"] === "paused");

  const stepsAtPause = pauseControl.eventsFor(pausedRunId).filter((e) => e.kind === "step");
  const seqOffset = Math.max(...stepsAtPause.map((e) => (e.kind === "step" ? e.step.seq : -1))) + 1;

  const resumed = await dispatcher.resume({
    deploymentId: "dep-1", workspaceId: pauseControl.workspaceId, agentId: pauseProject.agentId,
    runId: pausedRunId, seqOffset, controlPlaneUrl: pauseControl.url,
  });
  check("a paused deployed run can be resumed", resumed.ok, JSON.stringify(resumed));
  {
    const deadline = Date.now() + 120_000;
    while (!pauseControl.eventsFor(pausedRunId).some((e) => e.kind === "run_end") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const whole = pauseControl.eventsFor(pausedRunId);
  const seqs = whole.filter((e) => e.kind === "step").map((e) => (e.kind === "step" ? e.step.seq : -1));
  check("...and finishes", whole.at(-1)?.kind === "run_end" &&
    (whole.at(-1) as { run: { status: string } }).run.status === "completed",
    traceShape(whole).join(" "));
  // ONE RUN, ONE TIMELINE. A resumed segment that restarted its seq at zero would overwrite the
  // steps it is meant to follow — the run would end up shorter than it was before it was
  // resumed, with the paused half silently replaced.
  check("...as ONE run with one ascending timeline, not two runs stitched together",
    whole.filter((e) => e.kind === "run_start").length === 1 &&
      new Set(seqs).size === seqs.length &&
      Math.min(...seqs) === 0,
    seqs.join(","));
  check("...continuing from where the pause stopped rather than re-running what was done",
    seqs.filter((s) => s >= seqOffset).length > 0 && seqs.length > stepsAtPause.length,
    `paused at ${stepsAtPause.length} steps, finished with ${seqs.length}`);

  // AND THE REFUSAL THE EPHEMERAL FILESYSTEM MAKES NECESSARY. A container's checkpoints do not
  // survive a restart, and a resume that found none would start the graph over under the same
  // run id, re-spending what it already spent, with nothing anywhere saying so.
  const ghost = await dispatcher.resume({
    deploymentId: "dep-1", workspaceId: pauseControl.workspaceId, agentId: pauseProject.agentId,
    runId: randomUUID(), seqOffset: 0, controlPlaneUrl: pauseControl.url,
  });
  check("a resume with no checkpoint left in the container is refused, never restarted",
    !ghost.ok && ghost.reason === "no_checkpoint", JSON.stringify(ghost));

  await paused.stop();
  await pauseProvider.close();
  await pauseControl.close();
  pauseProject.cleanup();
}

project.cleanup();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;

}
