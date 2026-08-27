// POST /run answers before the graph finishes — and everything the old synchronous handler got
// right about framing still does.
//
//   npm run test:serve-async
//
// Against the REAL serve.py, the REAL runner and the REAL example agent, with only the model
// provider replaced by a fixture — see fixtures/deploy/serveHarness.ts on why that is the one
// substitution worth making.
//
// HALF THIS SUITE IS ABOUT CODE NOBODY TOUCHED, and that is deliberate. §6 says the framing
// discipline in `do_POST` "is preserved exactly. That code exists because of a real desync bug.
// Do not rewrite it while you are in there." A rule like that is worth what it can be broken by,
// and the way it gets broken is somebody reorganising the handler around the new 202 and moving
// the read past the refusal. So the 413, the 401, the short-body case and the keep-alive
// behaviour are asserted here, on raw sockets, where a desync is visible as the NEXT response
// being wrong rather than as this one failing.

import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import {
  deployedProject, dispatch, killRunnerChildren, pythonExecutable,
  startControlPlane, startMockProvider, startServe,
} from "../fixtures/deploy/serveHarness.ts";
import type { TraceEvent } from "./types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

if (!pythonExecutable()) {
  // Loud rather than green. This suite's whole subject is a Python file, so a machine with no
  // interpreter has not passed it — it has not run it, and saying "ALL CORRECT" would be the
  // most misleading thing available.
  console.error(
    "no runtime/.venv — this suite drives the real serve.py and cannot run without it.\n" +
    "  Run `uv sync` in runtime/ first. CI's `runtime` job does exactly that.",
  );
  process.exitCode = 1;
} else {

const project = deployedProject();
// A script long enough that the run cannot possibly be over when /run answers: the fixture's
// last turn repeats, so the graph loops through the tool node twice before finishing.
const provider = await startMockProvider([
  { kind: "tool_use", name: "current_time" },
  { kind: "tool_use", name: "word_count", input: { text: "one two three" } },
  { kind: "text", text: "done" },
]);
const served = await startServe({
  project,
  provider,
  concurrency: 1,
  // The connection timeout, turned down from its thirty-second default. It is what turns a
  // client that stops mid-request into a closed connection instead of a held thread, and the
  // only way to observe that is to wait for it — thirty seconds of one assertion doing nothing
  // is thirty seconds nobody will keep. Turned down rather than skipped, because a ceiling that
  // is never exercised is a ceiling nobody notices the removal of.
  env: { JAROKU_SERVE_TIMEOUT_S: "5" },
});

/** One raw HTTP/1.1 exchange, so framing is observable rather than normalised by fetch. */
function raw(request: string, opts: { expectResponses?: number } = {}): Promise<string> {
  return new Promise((done, reject) => {
    const { hostname, port } = new URL(served.url);
    const sock = connect({ host: hostname, port: Number(port) }, () => sock.write(request));
    let buf = "";
    const want = opts.expectResponses ?? 1;
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      buf += d;
      if ((buf.match(/HTTP\/1\.[01] /g) ?? []).length >= want) {
        // A short grace so the tail of the last body lands before the socket is dropped.
        setTimeout(() => { sock.destroy(); done(buf); }, 120);
      }
    });
    sock.on("error", reject);
    sock.setTimeout(20_000, () => { sock.destroy(); done(buf); });
  });
}

const bodyOf = (input: unknown) => JSON.stringify(input);
const post = (path: string, body: string, headers: string[] = []) =>
  [
    `POST ${path} HTTP/1.1`,
    `Host: 127.0.0.1`,
    `Authorization: Bearer ${served.token}`,
    `Content-Type: application/json`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...headers,
    "",
    body,
  ].join("\r\n");

// --- 202, and before the run is over -------------------------------------------------------

{
  const before = provider.calls;
  const started = Date.now();
  const res = await dispatch(served, { input: "what time is it" });
  const elapsed = Date.now() - started;

  check("POST /run answers 202", res.status === 202, JSON.stringify(res.body));
  check("...with the run id and when it was accepted, and nothing else",
    Object.keys(res.body).sort().join(",") === "accepted_at,run_id", Object.keys(res.body).join(","));
  check("...and no output or state, because the run has not happened",
    !("output" in res.body) && !("state" in res.body));

  // THE ASSERTION THE SUITE IS NAMED FOR. A run of this agent takes seconds — a whole
  // interpreter, a LangGraph import, four model calls. If the response waited for it, this
  // number would be that. The provider having been called ZERO times when the response landed
  // is the same claim from the other side, and it is the one that cannot be satisfied by the
  // machine simply being fast.
  check("...answered before the graph had made its first model call", provider.calls === before,
    `provider was called ${provider.calls - before} time(s) before the response`);
  check("...and in well under the time the run itself takes", elapsed < 3_000, `${elapsed}ms`);

  // And the run really did happen, afterwards.
  const deadline = Date.now() + 90_000;
  while (provider.calls === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  check("...but the run does start, and reaches the model", provider.calls > before);
  while (served.logs.every((l) => !l.includes("run finished")) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
  check("...and finishes, releasing its slot", served.logs.some((l) => l.includes("run finished")),
    served.logs.slice(-6).join(" | "));
}

// --- the bound is still on running graphs, not on open connections -------------------------

{
  // Concurrency is 1, so a second dispatch while the first is still running must be refused.
  const first = await dispatch(served, { input: "hold the slot" });
  check("a dispatch takes the one slot this container has", first.status === 202);
  const second = await dispatch(served, { input: "and this one cannot have it" });
  check("...and the next is 429, not a queue", second.status === 429, `got ${second.status}`);

  const retry = await fetch(`${served.url}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${served.token}` },
    body: bodyOf({ input: "x" }),
  });
  check("...with Retry-After, so a caller is told when to come back", retry.headers.get("retry-after") === "5",
    String(retry.headers.get("retry-after")));
  await retry.text();

  // AND THE SLOT COMES BACK. A slot leaked by the async rewrite is permanent: the container
  // answers 429 forever, healthy, with nothing running — the single worst outcome available
  // from this change, and invisible to every other assertion in this file.
  const deadline = Date.now() + 120_000;
  let recovered = false;
  while (Date.now() < deadline) {
    const probe = await dispatch(served, { input: "is the slot back" });
    if (probe.status === 202) { recovered = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  check("...and the slot is released when the run ends, not when the response is sent", recovered);
}

// --- the framing discipline, unchanged -------------------------------------------------------

{
  const body = bodyOf({ input: "x" });
  const req = [
    "POST /run HTTP/1.1", "Host: 127.0.0.1", `Authorization: Bearer ${served.token}`,
    "Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body) + 200_000}`, "", body,
  ].join("\r\n");
  const out = await raw(req);
  check("an oversized body is refused on the header, before it is buffered", out.includes(" 413 "), out.slice(0, 90));
  check("...and the connection is closed, because the rest of the message is not being read",
    /connection:\s*close/i.test(out), out.slice(0, 200));
}

{
  const out = await raw([
    "POST /run HTTP/1.1", "Host: 127.0.0.1", `Authorization: Bearer ${served.token}`,
    "Content-Length: not-a-number", "", "",
  ].join("\r\n"));
  check("unparseable framing is a 400 that ends the connection", out.includes(" 400 ") && /connection:\s*close/i.test(out),
    out.slice(0, 120));
}

{
  // A 401 IS AN ORDINARY ANSWER ON A CONNECTION THE CLIENT CAN KEEP USING, and that is the
  // whole reason the body is read before the credential is checked. Two requests down one
  // socket: if the body were left unread, the second request line would be parsed out of the
  // first request's JSON and come back as a 414 made of the caller's own body.
  const one = bodyOf({ input: "first" });
  const two = bodyOf({ input: "second" });
  const req =
    ["POST /run HTTP/1.1", "Host: 127.0.0.1", "Authorization: Bearer wrong", "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(one)}`, "", one].join("\r\n") +
    ["POST /health HTTP/1.1", "Host: 127.0.0.1", `Content-Length: 0`, "", ""].join("\r\n");
  const out = await raw(req, { expectResponses: 2 });
  const codes = [...out.matchAll(/HTTP\/1\.[01] (\d{3})/g)].map((m) => m[1]);
  check("a bad credential is a 401", codes[0] === "401", out.slice(0, 120));
  check("...and the request behind it on the same connection is not desynced", codes[1] === "404" || codes[1] === "405",
    `codes: ${codes.join(",")}`);
  void two;
}

{
  const short = bodyOf({ input: "x" });
  const out = await raw([
    "POST /run HTTP/1.1", "Host: 127.0.0.1", `Authorization: Bearer ${served.token}`,
    "Content-Type: application/json", `Content-Length: ${Buffer.byteLength(short) + 50}`, "", short,
  ].join("\r\n"));
  check("a body shorter than its Content-Length is refused rather than waited on forever",
    out.includes(" 400 ") || out.includes(" 408 "), out.slice(0, 120));
}

{
  const out = await raw(post("/run", "{not json"));
  check("a body that is not JSON is a 400", out.includes(" 400 "), out.slice(0, 120));
  const missing = await raw(post("/run", bodyOf({ nope: 1 })));
  check("...and so is one with no input", missing.includes(" 400 "), missing.slice(0, 120));
  const badProvider = await raw(post("/run", bodyOf({ input: "x", provider: "fake" })));
  check("the dry-run provider is refused on a dispatch, not just at startup",
    badProvider.includes(" 400 "), badProvider.slice(0, 120));
}

// --- keep-alive, which the 202 must not have broken --------------------------------------------

{
  const req =
    ["GET /health HTTP/1.1", "Host: 127.0.0.1", "", ""].join("\r\n") +
    ["GET /health HTTP/1.1", "Host: 127.0.0.1", "", ""].join("\r\n");
  const out = await raw(req, { expectResponses: 2 });
  const codes = [...out.matchAll(/HTTP\/1\.[01] (\d{3})/g)].map((m) => m[1]);
  check("two requests down one connection both get answered", codes.join(",") === "200,200", codes.join(","));
  check("...and neither says Connection: close", !/connection:\s*close/i.test(out));
}

// --- and /health is still open, which is what makes it a health check ---------------------------

{
  const res = await fetch(`${served.url}/health`);
  const body = (await res.json()) as { ok?: boolean; agent?: string };
  check("/health needs no credential", res.status === 200 && body.ok === true && body.agent === project.agentId);
  const doc = (await (await fetch(`${served.url}/`)).json()) as { endpoints?: Record<string, string> };
  check("the endpoint doc says /run answers 202, because it does",
    (doc.endpoints?.["POST /run"] ?? "").includes("202"), JSON.stringify(doc.endpoints));
}

await served.stop();

// --- failure of the run is not failure of the request, and the bracket always closes ---------
//
// §6: "The one thing serve.py must guarantee is that run_start and run_end bracket everything,
// in a finally, on every path, so a container OOM or a contract error surfaces as an errored run
// rather than silence." The runner's own finally covers everything the interpreter survives.
// This is about the cases it does not survive, which are the ones that produce silence.

{
  const control = await startControlPlane();
  const deadProject = deployedProject();
  const deadProvider = await startMockProvider([{ kind: "text", text: "never reached" }]);
  const dead = await startServe({ project: deadProject, provider: deadProvider });

  // A CONTRACT ERROR, AFTER THE CONTAINER IS ALREADY HEALTHY. serve.py checks the contract once
  // at boot, so the only way to reach the runner's own ContractError branch is to break the
  // project after that check has passed — which is also the realistic case: a file that went
  // missing under a running service. §6 names this alongside the OOM: both must surface as an
  // errored run rather than as silence, and they close the bracket at different levels.
  rmSync(join(deadProject.projectDir, "agent.py"), { force: true });

  const runId = randomUUID();
  const opened = control.runs.open({
    runId, workspaceId: control.workspaceId, deploymentId: "dep", agentId: deadProject.agentId,
  });
  const seen: TraceEvent[] = [];
  control.bus.register(runId).on("event", (e) => seen.push(e));

  const res = await dispatch(dead, {
    input: "this run cannot load its agent",
    run_id: runId,
    run_token: opened.runToken,
    control_plane_url: control.url,
  });
  check("a run whose agent cannot load is still ACCEPTED — the request already succeeded",
    res.status === 202, `${res.status} ${JSON.stringify(res.body)}`);

  const deadline = Date.now() + 90_000;
  while (!seen.some((e) => e.kind === "run_end") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
  const start = seen.find((e) => e.kind === "run_start");
  const end = seen.find((e) => e.kind === "run_end");
  // STEPS 3 AND 6 OF __main__.py's ORDER OF OPERATIONS, and the reason they are load-bearing:
  // run_start is emitted BEFORE the agent is loaded, so a project that cannot be imported is
  // still a run somebody can see failing rather than a dispatch that vanished.
  check("...and appears as a run before its agent is even loaded", start !== undefined,
    dead.logs.slice(-5).join(" | "));
  check("...then surfaces as an errored run rather than as silence", end !== undefined,
    dead.logs.slice(-5).join(" | "));
  if (end && end.kind === "run_end") {
    check("...with the run id Jaroku dispatched, so the row it creates is the one it was watching",
      end.run.id === runId);
    check("...marked error, never completed", end.run.status === "error", end.run.status);
    check("...naming the contract failure rather than a generic one",
      (end.run.error ?? "").includes("ContractError"), end.run.error ?? "(no error)");
  }
  check("...and the slot the failed run held comes back",
    (await dispatch(dead, { input: "the slot is free" })).status === 202);

  await dead.stop();
  await deadProvider.close();
  await control.close();
  deadProject.cleanup();
}

{
  // AND THE KILL, which is the case §6 names first. A container that runs out of memory does not
  // get to finish its `finally` — so this removes the runner the way the kernel would, between
  // two nodes, and the same outer bracket has to close it.
  const control = await startControlPlane();
  const killProject = deployedProject();
  const killProvider = await startMockProvider([
    { kind: "tool_use", name: "current_time" },
    { kind: "tool_use", name: "word_count", input: { text: "a b c" } },
    { kind: "text", text: "done" },
  ]);
  // A pause at every node boundary, so there is a window to kill in. It is a debug aid the
  // runner already has (JAROKU_STEP_DELAY_MS), not something added for this.
  const killed = await startServe({
    project: killProject, provider: killProvider, env: { JAROKU_STEP_DELAY_MS: "1500" },
  });

  const runId = randomUUID();
  const opened = control.runs.open({
    runId, workspaceId: control.workspaceId, deploymentId: "dep", agentId: killProject.agentId,
  });
  const seen: TraceEvent[] = [];
  control.bus.register(runId).on("event", (e) => seen.push(e));

  await dispatch(killed, {
    input: "this run is about to be killed",
    run_id: runId,
    run_token: opened.runToken,
    control_plane_url: control.url,
  });

  // Wait until it has genuinely started and pushed something, so the kill lands MID-RUN rather
  // than before the run existed — the two are different assertions and only one is this one.
  const startDeadline = Date.now() + 90_000;
  while (!seen.some((e) => e.kind === "step") && Date.now() < startDeadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
  const stepsBefore = seen.filter((e) => e.kind === "step").length;
  check("a run that is about to be killed had really started", stepsBefore > 0);
  const victims = killRunnerChildren(killed);
  check("...and the runner process was killed out from under it", victims > 0, `${victims} killed`);

  const deadline = Date.now() + 60_000;
  while (!seen.some((e) => e.kind === "run_end") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
  const end = seen.find((e) => e.kind === "run_end");
  check("...and the container closes the run out rather than leaving it in flight forever",
    end !== undefined, killed.logs.slice(-6).join(" | "));
  if (end && end.kind === "run_end") {
    check("...as an error", end.run.status === "error", end.run.status);
    check("...naming what a reader needs: the steps that landed really did spend money",
      (end.run.error ?? "").includes("really happened") && (end.run.error ?? "").includes("cost money"),
      `${end.run.error ?? "(no error)"} :: ${killed.logs.slice(-8).join(" | ")}`);
  }
  check("...and the steps it managed to push are still on the trace",
    seen.filter((e) => e.kind === "step").length >= stepsBefore);

  await killed.stop();
  await killProvider.close();
  await control.close();
  killProject.cleanup();
}

await provider.close();
project.cleanup();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;

}
