// Cancel acts at a node boundary, never mid-node — and a cancelled run still emits run_end.
//
//   npm run test:serve-cancel
//
// §13 asks the question this suite is the answer to: "If cancel cannot be made honest at a node
// boundary in this shape, say so rather than shipping a button that stops nothing." So the
// assertions are about honesty rather than about the button working:
//
//   AT A BOUNDARY. The node that was running when the cancel arrived is FINISHED — its step is
//   on the trace, priced, counted. A kill would abandon it, and the trace would end in the
//   middle of something with no record of what that something cost.
//
//   AND STILL EMITS run_end. A cancelled run is over, and a run that is over says so. Stopping
//   the process instead produces a row that reads "running" until a sweep notices, which is the
//   silence the whole of §6's bracketing exists to prevent.
//
// Both are driven against the real serve.py, the real runner and the real example agent, through
// both ways in: the control plane (Jaroku cancelling a run it dispatched) and POST /cancel
// (somebody holding the deployment's own bearer token, who cannot reach Jaroku's control plane).

import { randomUUID } from "node:crypto";

import {
  deployedProject, dispatch, pythonExecutable, startControlPlane, startMockProvider, startServe,
  traceShape,
} from "../fixtures/deploy/serveHarness.ts";
import { DeployDispatcher } from "./deployDispatch.ts";
import type { MockTurn } from "../fixtures/deploy/serveHarness.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

if (!pythonExecutable()) {
  console.error(
    "no runtime/.venv — this suite drives the real runner and cannot run without it.\n" +
    "  Run `uv sync` in runtime/ first. CI's `runtime` job does exactly that.",
  );
  process.exitCode = 1;
} else {

// A script long enough that there are several boundaries to cancel between, so a cancel that
// happened to land at the very end would not pass by accident.
const SCRIPT: MockTurn[] = [
  { kind: "tool_use", name: "current_time" },
  { kind: "tool_use", name: "word_count", input: { text: "one two three four five" } },
  { kind: "tool_use", name: "current_time" },
  { kind: "text", text: "done" },
];

/** Dispatch a slow run, wait until it is genuinely mid-graph, and return the handles. */
async function slowRunInFlight(stepDelayMs = 1500) {
  const control = await startControlPlane();
  const project = deployedProject();
  const provider = await startMockProvider(SCRIPT);
  const served = await startServe({
    project, provider, env: { JAROKU_STEP_DELAY_MS: String(stepDelayMs) },
  });
  const dispatcher = new DeployDispatcher({
    runs: control.runs,
    endpoint: async () => ({ url: served.url, serveToken: served.token }),
  });
  const runId = randomUUID();
  const started = await dispatcher.start({
    deploymentId: "dep-1", workspaceId: control.workspaceId, agentId: project.agentId,
    runId, input: "run for a while", controlPlaneUrl: control.url,
  });
  const deadline = Date.now() + 120_000;
  while (control.eventsFor(runId).filter((e) => e.kind === "step").length < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { control, project, provider, served, dispatcher, runId, started };
}

/** Everything about the run, once it has stopped saying anything. */
async function settle(control: Awaited<ReturnType<typeof startControlPlane>>, runId: string) {
  const deadline = Date.now() + 120_000;
  while (!control.eventsFor(runId).some((e) => e.kind === "run_end") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
  // A short settle so a step pushed just after the run_end — there should be none — would be
  // caught rather than raced past.
  await new Promise((r) => setTimeout(r, 1_500));
  return control.eventsFor(runId);
}

// --- 1. cancelled through the control plane, which is how Jaroku does it ------------------------

{
  const h = await slowRunInFlight();
  check("a deployed run is dispatched and gets under way", h.started.ok, JSON.stringify(h.started));

  const before = h.control.eventsFor(h.runId).filter((e) => e.kind === "step");
  const providerCallsAtCancel = h.provider.calls;
  h.control.bus.signal(h.runId, { action: "cancel" });

  const events = await settle(h.control, h.runId);
  const steps = events.filter((e) => e.kind === "step");
  const end = events.find((e) => e.kind === "run_end");

  check("a cancelled run still emits run_end", end !== undefined, traceShape(events).join(" "));
  if (end && end.kind === "run_end") {
    // THE FROZEN SCHEMA HAS THREE STATUSES AND THIS PART ADDS NONE. "error" with a reason is the
    // honest fit: the run did not complete, and the reason field is the one built to say why.
    check("...with status error, which is what the frozen schema has for a run that did not finish",
      end.run.status === "error", end.run.status);
    check("...saying it was cancelled rather than that something went wrong",
      (end.run.error ?? "").startsWith("Cancelled:"), end.run.error ?? "(none)");
    check("...and carrying the cost of what it actually did before stopping",
      end.run.tokens > 0, `${end.run.cost}/${end.run.tokens}`);
  }

  // AT A BOUNDARY, NEVER MID-NODE. Two things establish it, and neither is "the run stopped":
  //
  //   The last step on the trace is COMPLETE — it has an end, a latency and (for an llm_call) a
  //   cost. A kill mid-node leaves the step that was in flight unemitted entirely, because a
  //   step is emitted when it finishes.
  //
  //   And the trace ends after a whole node rather than between a node's start and its end,
  //   which is the same claim from the other side: `cancelled` is reported from the boundary
  //   check, with the boundary's own checkpoint id on it.
  const last = steps.at(-1);
  check("the node that was running when the cancel arrived finished",
    last?.kind === "step" && last.step.latency_ms >= 0 && steps.length >= before.length,
    `${before.length} steps at cancel, ${steps.length} at the end`);
  const cancelled = h.control.controlFor(h.runId).find((c) => c["ctrl"] === "cancelled");
  check("...and the stop is reported FROM a node boundary, with that boundary's checkpoint",
    cancelled !== undefined && typeof cancelled["checkpoint_id"] === "string",
    h.control.controlFor(h.runId).map((c) => String(c["ctrl"])).join(", "));
  check("...and no further node was started after it",
    h.provider.calls <= providerCallsAtCancel + 1,
    `${providerCallsAtCancel} model calls at cancel, ${h.provider.calls} at the end`);

  // AND IT IS OVER, not merely stopped. A cancelled run is not resumable and must not be left
  // holding a token or a bus entry — its run_closed is terminal, unlike a pause's.
  check("a cancelled run is closed out, not left open like a paused one",
    !h.control.runs.has(h.runId));
  check("...and says so on the way out",
    h.control.controlFor(h.runId).find((c) => c["ctrl"] === "run_closed")?.["status"] === "error",
    JSON.stringify(h.control.controlFor(h.runId).find((c) => c["ctrl"] === "run_closed")));

  await h.served.stop();
  await h.provider.close();
  await h.control.close();
  h.project.cleanup();
}

// --- 2. cancelled through POST /cancel, which is how anyone else does it --------------------------

{
  const h = await slowRunInFlight();
  const res = await dispatch(h.served, { run_id: h.runId }, "/cancel");
  check("POST /cancel answers 202, because the run has not stopped yet", res.status === 202,
    `${res.status} ${JSON.stringify(res.body)}`);
  check("...naming the run it was asked about", res.body["run_id"] === h.runId, JSON.stringify(res.body));

  const events = await settle(h.control, h.runId);
  const end = events.find((e) => e.kind === "run_end");
  check("a run cancelled through the container's own endpoint ends the same way",
    end?.kind === "run_end" && end.run.status === "error" &&
      (end.run.error ?? "").startsWith("Cancelled:"),
    traceShape(events).join(" "));

  // IDEMPOTENT, AND 202 FOR A RUN IT HAS NEVER HEARD OF. A caller cannot know whether the run
  // finished a millisecond before they pressed the button, and answering 404 would make a
  // successful cancel and an already-finished run look like different outcomes.
  const again = await dispatch(h.served, { run_id: h.runId }, "/cancel");
  check("cancelling twice is not an error", again.status === 202, String(again.status));
  const unknown = await dispatch(h.served, { run_id: randomUUID() }, "/cancel");
  check("...and cancelling a run this container never had is not either", unknown.status === 202,
    String(unknown.status));

  const noId = await dispatch(h.served, {}, "/cancel");
  check("a cancel with no run id is refused", noId.status === 400, String(noId.status));

  // The same credential gate as /run — this stops somebody else's job.
  const unauthorised = await fetch(`${h.served.url}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run_id: h.runId }),
  });
  await unauthorised.text();
  check("...and a cancel with no credential is a 401", unauthorised.status === 401, String(unauthorised.status));

  await h.served.stop();
  await h.provider.close();
  await h.control.close();
  h.project.cleanup();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;

}
