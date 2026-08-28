// A fixture deployed agent — the container half of the production bridge, standing in for a
// real Railway service so the server half can be built and verified without a Railway account,
// without a provider key, and without waiting three minutes for an image to build.
//
//   npm run mock:serve                         # http://127.0.0.1:8932
//   MOCK_SERVE_PORT=9000 npm run mock:serve
//   MOCK_SERVE_TOKEN=sekrit npm run mock:serve # requires Authorization: Bearer sekrit
//   MOCK_SERVE_BEHAVIOUR=cancellable MOCK_SERVE_STEP_MS=4000 npm run mock:serve
//
// WRITTEN AGAINST node:http AND RAW JSON, NOT AGAINST serve.py's SHAPE, and that is the same
// reasoning fixtures/mcp/mockServer.ts gives for not building on the MCP SDK's server half:
//
//   1. A fixture has to be able to do things the real thing never would. Pushing a malformed
//      batch, pushing a hundred thousand events as fast as the socket takes them, stopping
//      halfway through a run, and presenting a token minted for a different run are all
//      behaviours the SERVER exists to handle — so the fixture must be able to produce them,
//      and a stub that shared serve.py's implementation could not.
//
//   2. It means the control plane is tested against a client that does NOT share its
//      implementation. Two halves of one codebase agreeing with each other proves less.
//
// WHAT IT IS NOT. This does not prove serve.py works. The trace it pushes is one this file
// wrote, so a comparison against it says only that the fixture is self-consistent — the
// local-versus-deployed shape equality §12 asks for is asserted against the real Python, in
// the suites that drive it. What this proves is everything on the SERVER side of the wire:
// ingest, tenancy, backpressure, revocation, reconciliation and the confirmation gate.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Run, Step, TraceEvent } from "../../src/types.ts";
import { SCHEMA_VERSION } from "../../src/types.ts";

/**
 * What the stub does with a run once it has answered 202.
 *
 * Every one of these is a real failure mode the deployed path has to survive, named rather
 * than assembled out of flags at the call site — a test that reads `behaviour: "died"` says
 * what it is about, and one that reads `{push: true, finish: false, delayMs: 0}` does not.
 */
export type MockServeBehaviour =
  /** run_start, four steps, run_end. The ordinary case, and the shape everything else is a
   *  deviation from. */
  | "complete"
  /** run_start, then an error run_end — an agent that raised. A 202 was already answered, so
   *  this is what "failure of the run is not failure of the request" looks like on the wire. */
  | "errors"
  /** A batch of things that are not trace events at all. The server must count them as drops
   *  and keep the connection usable rather than failing the run. */
  | "malformed"
  /** As many events as fast as the socket will take them, until the server refuses. */
  | "flood"
  /** run_start and two steps, then silence, forever. The container that died: no run_end, no
   *  exit, nothing to notice except that nothing arrives. */
  | "died"
  /** Blocks on POST /mcp-confirm and reports the verdict it was given as a tool_call step. */
  | "confirm"
  /** Presents its own valid token against a DIFFERENT run's id. Must be a 403, not a 404. */
  | "cross-run"
  /** Runs until told to stop, checking for cancellation only between steps — a node boundary,
   *  never mid-node. */
  | "cancellable";

export interface MockServeOptions {
  port?: number;
  /** The bearer token POST /run and POST /cancel require, or null for a public endpoint. */
  token?: string | null;
  behaviour?: MockServeBehaviour;
  /** The agent id this stub answers as, so a trace it pushes names something. */
  agentId?: string;
  /** How long one simulated node takes. Nonzero is what makes a cancel observable. */
  stepDelayMs?: number;
  /** For "cross-run": the run id this stub addresses instead of its own. */
  otherRunId?: string;
  /** Every push this stub made, in order, so a test can assert what the wire carried. */
  onPush?: (path: string, status: number, body: unknown) => void;
}

export interface MockServeHandle {
  url: string;
  /** Resolves once the run this stub started has stopped pushing, however it stopped. */
  settled: (runId: string) => Promise<"completed" | "error" | "cancelled" | "stalled">;
  /** What this stub was told to cancel, so a test can assert cancel reached the container. */
  cancelled: Set<string>;
  close: () => Promise<void>;
}

interface Dispatch {
  runId: string;
  token: string;
  controlPlaneUrl: string;
  input: string;
  provider: string;
  model: string;
}

const nowIso = () => new Date().toISOString();

function baseRun(d: Dispatch, agentId: string): Run {
  return {
    id: d.runId,
    agent_id: agentId,
    provider: d.provider,
    model: d.model,
    status: "running",
    started_at: nowIso(),
    ended_at: null,
    cost: 0,
    tokens: 0,
    error: null,
  };
}

/**
 * The four steps a one-tool LangGraph agent produces, in the order a real one produces them.
 *
 * The ORDER is the point, not the contents: `test:serve-trace` asserts that a deployed run's
 * step types and their sequence match a local run's, and a fixture that emitted them in some
 * other order would make that assertion pass against a lie.
 */
const STEP_SHAPE: Array<{ type: Step["type"]; name: string; tokens: number | null; cost: number | null }> = [
  { type: "llm_call", name: "agent", tokens: 120, cost: 0.00012 },
  { type: "tool_call", name: "lookup", tokens: null, cost: null },
  { type: "state_update", name: "agent", tokens: null, cost: null },
  { type: "llm_call", name: "agent", tokens: 240, cost: 0.00031 },
];

function stepAt(d: Dispatch, seq: number): Step {
  const shape = STEP_SHAPE[seq % STEP_SHAPE.length]!;
  return {
    id: randomUUID(),
    run_id: d.runId,
    seq,
    type: shape.type,
    name: shape.name,
    input: { seq },
    output: { seq },
    state_before: { messages: seq },
    state_after: { messages: seq + 1 },
    tokens: shape.tokens,
    cost: shape.cost,
    latency_ms: 20,
    error: null,
    parent_step_id: null,
    started_at: nowIso(),
  };
}

export async function startMockServe(opts: MockServeOptions = {}): Promise<MockServeHandle> {
  const token = opts.token === undefined ? null : opts.token;
  const behaviour = opts.behaviour ?? "complete";
  const agentId = opts.agentId ?? "a_stub_agent";
  const stepDelayMs = opts.stepDelayMs ?? 0;

  const cancelled = new Set<string>();
  const settlements = new Map<string, { promise: Promise<"completed" | "error" | "cancelled" | "stalled">; settle: (v: "completed" | "error" | "cancelled" | "stalled") => void }>();

  const settlementFor = (runId: string) => {
    let entry = settlements.get(runId);
    if (!entry) {
      let settle!: (v: "completed" | "error" | "cancelled" | "stalled") => void;
      const promise = new Promise<"completed" | "error" | "cancelled" | "stalled">((r) => (settle = r));
      entry = { promise, settle };
      settlements.set(runId, entry);
    }
    return entry;
  };

  /** One push, with the run token on it. Never throws: a control plane that refuses is a thing
   *  the stub has to be able to observe rather than crash on, since half its behaviours exist
   *  precisely to be refused. */
  async function push(d: Dispatch, path: string, body: unknown, runIdOverride?: string): Promise<number> {
    const target = `${d.controlPlaneUrl.replace(/\/+$/, "")}/v1/runs/${runIdOverride ?? d.runId}${path}`;
    try {
      const res = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${d.token}` },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* the body is the evidence either way */ }
      opts.onPush?.(target, res.status, parsed);
      return res.status;
    } catch (err) {
      opts.onPush?.(target, 0, String(err));
      return 0;
    }
  }

  const pushEvents = (d: Dispatch, events: unknown[]) => push(d, "/trace", { events });

  async function runComplete(d: Dispatch, failing: boolean): Promise<void> {
    const run = baseRun(d, agentId);
    await pushEvents(d, [{ kind: "run_start", schema_version: SCHEMA_VERSION, run } satisfies TraceEvent]);
    let cost = 0;
    let tokens = 0;
    for (let seq = 0; seq < STEP_SHAPE.length; seq++) {
      if (stepDelayMs) await new Promise((r) => setTimeout(r, stepDelayMs));
      // THE CANCEL CHECK IS BETWEEN STEPS AND NOWHERE ELSE. That is the whole claim cancel
      // makes — it acts at a node boundary, never mid-node — so the stub has to be able to
      // demonstrate it by not checking anywhere else.
      if (cancelled.has(d.runId)) {
        // THE BOUNDARY IS ANNOUNCED BEFORE THE RUN ENDS, because a cancelled run and a crashed
        // one arrive as the SAME `run_end` — the frozen schema has three run statuses and none
        // of them is `cancelled`, so the ending alone cannot be told apart from a failure. The
        // real runner emits this line at the boundary for exactly that reason (`debug.py`'s
        // `emit_ctrl`), and a stub that pushed only the ending would have the server honestly
        // report `agent_error` for every cancel driven against it — a fixture teaching a bug
        // the product does not have.
        await push(d, "/control", {
          ctrl: {
            ctrl: "cancelled",
            run_id: d.runId,
            seq_high: seq === 0 ? 0 : seq - 1,
            checkpoint_id: `mock-cp-${seq}`,
            next: [STEP_SHAPE[seq % STEP_SHAPE.length]!.name],
          },
        });
        const end: Run = {
          ...run, status: "error", ended_at: nowIso(), cost, tokens,
          error: "Cancelled: the run was stopped at a node boundary",
        };
        await pushEvents(d, [{ kind: "run_end", schema_version: SCHEMA_VERSION, run: end } satisfies TraceEvent]);
        settlementFor(d.runId).settle("cancelled");
        return;
      }
      const step = stepAt(d, seq);
      cost += step.cost ?? 0;
      tokens += step.tokens ?? 0;
      await pushEvents(d, [{ kind: "step", schema_version: SCHEMA_VERSION, step } satisfies TraceEvent]);
    }
    const end: Run = {
      ...run,
      status: failing ? "error" : "completed",
      ended_at: nowIso(),
      cost,
      tokens,
      error: failing ? "RuntimeError: the agent raised" : null,
    };
    await pushEvents(d, [{ kind: "run_end", schema_version: SCHEMA_VERSION, run: end } satisfies TraceEvent]);
    settlementFor(d.runId).settle(failing ? "error" : "completed");
  }

  async function runDied(d: Dispatch): Promise<void> {
    const run = baseRun(d, agentId);
    await pushEvents(d, [{ kind: "run_start", schema_version: SCHEMA_VERSION, run } satisfies TraceEvent]);
    await pushEvents(d, [
      { kind: "step", schema_version: SCHEMA_VERSION, step: stepAt(d, 0) } satisfies TraceEvent,
      { kind: "step", schema_version: SCHEMA_VERSION, step: stepAt(d, 1) } satisfies TraceEvent,
    ]);
    // And nothing else, ever. No run_end, no exit, no error — the container is simply gone, and
    // the only evidence of that is the absence of a next push.
    settlementFor(d.runId).settle("stalled");
  }

  async function runMalformed(d: Dispatch): Promise<void> {
    const run = baseRun(d, agentId);
    await pushEvents(d, [{ kind: "run_start", schema_version: SCHEMA_VERSION, run } satisfies TraceEvent]);
    await pushEvents(d, [
      { kind: "not_a_kind", schema_version: SCHEMA_VERSION },
      "a bare string",
      { kind: "step", schema_version: SCHEMA_VERSION },        // the shape check's own case: no step
      null,
      { kind: "step", schema_version: SCHEMA_VERSION, step: stepAt(d, 0) } satisfies TraceEvent,
    ]);
    const end: Run = { ...run, status: "completed", ended_at: nowIso() };
    await pushEvents(d, [{ kind: "run_end", schema_version: SCHEMA_VERSION, run: end } satisfies TraceEvent]);
    settlementFor(d.runId).settle("completed");
  }

  async function runFlood(d: Dispatch): Promise<void> {
    const run = baseRun(d, agentId);
    await pushEvents(d, [{ kind: "run_start", schema_version: SCHEMA_VERSION, run } satisfies TraceEvent]);
    // MANY SMALL BATCHES, NOT A FEW ENORMOUS ONES, and the size is chosen rather than arbitrary.
    // The router refuses any request body over 64 KB outright, so a batch bigger than that never
    // reaches the trace route at all — it would prove the router's cap and nothing about
    // backpressure. Forty events is comfortably under that ceiling and each one is individually
    // unremarkable, which is precisely the case backpressure.ts's per-run byte cap exists for:
    // "many small, individually-fine events adding up to a flood".
    //
    // Bounded by a round count as well as by the refusal, because a fixture whose only exit is
    // the server behaving correctly is a fixture that hangs forever the day it does not.
    for (let round = 0; round < 400; round++) {
      const events = Array.from({ length: 40 }, (_, i) => ({
        kind: "step", schema_version: SCHEMA_VERSION, step: stepAt(d, round * 40 + i),
      }));
      const status = await pushEvents(d, events);
      if (status !== 200) {
        settlementFor(d.runId).settle("error");
        return;
      }
    }
    settlementFor(d.runId).settle("completed");
  }

  async function runConfirm(d: Dispatch): Promise<void> {
    const run = baseRun(d, agentId);
    await pushEvents(d, [{ kind: "run_start", schema_version: SCHEMA_VERSION, run } satisfies TraceEvent]);
    const nonce = randomUUID().replace(/-/g, "").slice(0, 12);
    // A BLOCKING POST, held open by the server until a human answers or its own timeout denies.
    // The verdict comes back in the response body; nothing else in this exchange carries it.
    let verdict = "deny";
    try {
      const res = await fetch(
        `${d.controlPlaneUrl.replace(/\/+$/, "")}/v1/runs/${d.runId}/mcp-confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${d.token}` },
          body: JSON.stringify({ nonce, server: "stub", tool: "send_email", args: "{}", timeout_s: 30 }),
        },
      );
      const body = (await res.json()) as { verdict?: string };
      if (body.verdict === "run" || body.verdict === "once" || body.verdict === "deny") verdict = body.verdict;
      opts.onPush?.("mcp-confirm", res.status, body);
    } catch (err) {
      opts.onPush?.("mcp-confirm", 0, String(err));
    }
    const step: Step = {
      ...stepAt(d, 0),
      type: "tool_call",
      name: "stub/send_email",
      output: { verdict },
      error: verdict === "deny" ? "ToolNotApproved: stub/send_email was not approved" : null,
    };
    await pushEvents(d, [{ kind: "step", schema_version: SCHEMA_VERSION, step } satisfies TraceEvent]);
    const end: Run = {
      ...run,
      status: verdict === "deny" ? "error" : "completed",
      ended_at: nowIso(),
      error: verdict === "deny" ? "ToolNotApproved" : null,
    };
    await pushEvents(d, [{ kind: "run_end", schema_version: SCHEMA_VERSION, run: end } satisfies TraceEvent]);
    settlementFor(d.runId).settle(verdict === "deny" ? "error" : "completed");
  }

  async function runCrossRun(d: Dispatch): Promise<void> {
    // A VALID TOKEN, THE WRONG RUN. The token verifies, the signature is this server's own, and
    // the run it names is not the one in the path — which is an attempted cross-run write and
    // has to be a 403. A 404 would read as "maybe try a different id".
    const other = opts.otherRunId ?? randomUUID();
    const run = { ...baseRun(d, agentId), id: other };
    await push(d, "/trace", {
      events: [{ kind: "run_start", schema_version: SCHEMA_VERSION, run } satisfies TraceEvent],
    }, other);
    settlementFor(d.runId).settle("error");
  }

  function start(d: Dispatch): void {
    const work =
      behaviour === "errors" ? runComplete(d, true)
        : behaviour === "malformed" ? runMalformed(d)
          : behaviour === "flood" ? runFlood(d)
            : behaviour === "died" ? runDied(d)
              : behaviour === "confirm" ? runConfirm(d)
                : behaviour === "cross-run" ? runCrossRun(d)
                  : runComplete(d, false);
    // Detached on purpose: POST /run answered before this started and nothing is waiting on it.
    void work.catch((err) => {
      opts.onPush?.("internal", 0, String(err));
      settlementFor(d.runId).settle("error");
    });
  }

  const authorised = (req: IncomingMessage): boolean => {
    if (token === null) return true;
    const header = req.headers["authorization"] ?? "";
    return header === `Bearer ${token}`;
  };

  const send = (res: ServerResponse, code: number, body: unknown): void => {
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": raw.length });
    res.end(raw);
  };

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((done) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try { done(raw ? JSON.parse(raw) : {}); } catch { done(null); }
      });
    });

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true, agent: agentId });
    if (req.method === "GET" && path === "/") {
      return send(res, 200, {
        agent: agentId,
        endpoints: {
          "GET /health": "no auth · -> {ok, agent}",
          "POST /run": "bearer · {input, run_id, run_token, control_plane_url} -> 202 {run_id, accepted_at}",
          "POST /cancel": "bearer · {run_id} -> 202 {run_id}",
        },
      });
    }
    if (req.method !== "POST" || (path !== "/run" && path !== "/cancel")) return send(res, 404, { error: "not found" });
    if (!authorised(req)) {
      res.writeHead(401, { "www-authenticate": 'Bearer realm="jaroku"', "content-length": "0" });
      return res.end();
    }
    void readBody(req).then((parsed) => {
      const body = (parsed ?? {}) as Record<string, unknown>;
      const runId = typeof body["run_id"] === "string" ? body["run_id"] : "";
      if (!runId) return send(res, 400, { error: "expected a run_id" });
      if (path === "/cancel") {
        cancelled.add(runId);
        return send(res, 202, { run_id: runId });
      }
      const controlPlaneUrl = typeof body["control_plane_url"] === "string" ? body["control_plane_url"] : "";
      const runToken = typeof body["run_token"] === "string" ? body["run_token"] : "";
      // 202 FIRST, ALWAYS, AND BEFORE ANY WORK. This is the single most important thing the
      // stub reproduces: the response does not wait for the run, so a test asserting "answered
      // before it finished" is asserting something the fixture cannot accidentally satisfy by
      // being fast.
      send(res, 202, { run_id: runId, accepted_at: nowIso() });
      if (!controlPlaneUrl || !runToken) {
        // Configured, never assumed — the same contract controlplane_http.py states. Nothing to
        // report to, so nothing is reported, and the request still succeeded.
        settlementFor(runId).settle("completed");
        return;
      }
      start({
        runId,
        token: runToken,
        controlPlaneUrl,
        input: typeof body["input"] === "string" ? body["input"] : "",
        provider: typeof body["provider"] === "string" ? body["provider"] : "anthropic",
        model: typeof body["model"] === "string" ? body["model"] : "claude-haiku-4-5",
      });
    });
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    settled: (runId: string) => settlementFor(runId).promise,
    cancelled,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

// Run directly: `npm run mock:serve`. Importing it from a test starts nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env["MOCK_SERVE_PORT"] ?? 8932);
  const token = process.env["MOCK_SERVE_TOKEN"] ?? null;
  const behaviour = (process.env["MOCK_SERVE_BEHAVIOUR"] as MockServeBehaviour) ?? "complete";
  // A NODE THAT TAKES NO TIME CANNOT BE CANCELLED BY A PERSON, which is why this is reachable
  // from the command line and not only from a suite. `cancellable` and `confirm` are the two
  // behaviours somebody drives BY HAND — pressing Cancel, answering a confirmation — and a run
  // that is over before the button is drawn demonstrates nothing. Zero stays the default,
  // because every suite wants the run finished by the time the assertion reads it.
  const stepDelayMs = Number(process.env["MOCK_SERVE_STEP_MS"] ?? 0);
  void startMockServe({ port, token, behaviour, stepDelayMs, onPush: (p, s) => console.log(`[mock-serve] -> ${s} ${p}`) }).then(
    (h) => {
      console.log(`[mock-serve] listening on ${h.url} · behaviour ${behaviour}${stepDelayMs ? ` · ${stepDelayMs}ms a node` : ""}`);
      if (token) console.log("[mock-serve] a bearer token is required on /run and /cancel");
    },
  );
}
