// The HTTP surface a hosted sandbox's runner actually talks to. Four routes, all scoped by a
// run token to exactly the run it names — see runTokens.ts for why that scope is a run rather
// than a workspace.
//
//   POST /v1/runs/:runId/trace        <- batched NDJSON trace events, pushed
//   POST /v1/runs/:runId/control      <- one @@JAROKU_CTRL@@-shaped control line, pushed
//   GET  /v1/runs/:runId/control      -> long-poll: {action:"pause"|"resume"|"mcp-confirm"|"none"}
//   POST /v1/runs/:runId/mcp-confirm  -> blocks until a human answers, or timeoutS elapses
//
// Everything a local run already does over a pipe and a control file, a hosted run does here —
// the shapes match processManager.ts's and mcp_bridge.py's on purpose, so the runner-side
// change (see jaroku_runner/controlplane_http.py) is "which transport", never "what the
// message means".

import { badRequest, forbidden, notFound, unauthorized, type HttpRequest, type Router } from "../http/router.ts";
import { isTraceEvent, runIdOf, type TraceEvent } from "../types.ts";
import { BackpressureTracker, describeViolation } from "./backpressure.ts";
import { RunEventBus } from "./eventBus.ts";
import { verifyRunToken, type RunTokenRevocationList } from "./runTokens.ts";
import type { TraceIngestMetrics } from "./traceIngestMetrics.ts";

/** Per the spec: "the timeout still denies." 120s matches mcp_bridge.py's own default so a
 *  hosted run's confirmation gate behaves identically to the local one. */
const DEFAULT_MCP_CONFIRM_TIMEOUT_MS = 120_000;
/** Bounded independently of the timeout a caller requests — see the trace-push route for the
 *  same reasoning applied to a batch instead of a wait. */
const MAX_MCP_CONFIRM_TIMEOUT_MS = 10 * 60_000;

export interface ControlPlaneDeps {
  bus: RunEventBus;
  signingKey: Buffer;
  revocations: RunTokenRevocationList;
  /** Surfaced to the UI/relay as an ordinary control line ("ctrl":"tool_confirm"), exactly the
   *  shape mcp_bridge.py already emits — see index.ts's existing resolveMcpConfirm handler. */
  onMcpConfirmRequested?: (runId: string, payload: Record<string, unknown>) => void;
  /**
   * The ask is over — answered, or denied by its own timeout. The mirror of the hook above.
   *
   * WITHOUT IT A HOSTED ASK THAT TIMED OUT LEFT THE DIALOG ON SCREEN FOREVER. `awaitMcpConfirm`
   * deletes its own waiter and answers the container `deny`, which is all the CONTAINER needs —
   * but the server's `pendingConfirms` still held the ask, so no `confirmResolved` ever went out
   * and every open tab kept a modal counting down past 0:00 over a run that had already ended.
   * A local run does not have this hole: its runner emits `ctrl: "tool_confirm_closed"` and that
   * path already clears. A container has no such line, so the route has to say so itself.
   */
  onMcpConfirmSettled?: (runId: string, nonce: string, verdict: "run" | "once" | "deny") => void;
  /** Counts what the trace route drops rather than ingests — see traceIngestMetrics.ts. */
  metrics?: TraceIngestMetrics;
  /** Bytes/lines/rate caps on the trace push — see backpressure.ts. Required rather than
   *  defaulted, the same way signingKey and revocations are: a shared module-level default
   *  would let two unrelated callers of this module (two test files, or two servers in one
   *  process) silently share one run's usage counters with another's. */
  backpressure: BackpressureTracker;
  /** A hostile run is not merely refused further pushes — it is stopped. Wired to
   *  `pool.stop(runId)` in production; a no-op default is fine for a caller that has no
   *  sandbox to reach (e.g. a test exercising the route in isolation). */
  onBackpressureViolation?: (runId: string, reason: string) => void;
}

/** The run token this request is bearing, checked against the :runId in the path and against
 *  the revocation list. Every route below starts with this — there is no route here a bare
 *  bearer token without this specific run's scope may reach. */
function authenticate(req: HttpRequest, runId: string, deps: ControlPlaneDeps): { workspaceId: string } {
  const header = req.header("authorization") ?? "";
  const raw = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!raw) throw unauthorized("missing bearer run token");
  const result = verifyRunToken(deps.signingKey, raw);
  if (!result.ok) throw unauthorized(`run token ${result.reason}`);
  if (result.claims.runId !== runId) {
    // Not "not found" — a token minted for a different run presented against this one is an
    // attempted cross-run access, exactly the case the tenancy suite (commit 19) asserts never
    // succeeds. 403 says so; 404 would read as "maybe try a different id."
    throw forbidden("this run token is not scoped to this run");
  }
  if (deps.revocations.isRevoked(runId)) throw unauthorized("this run has already ended");
  return { workspaceId: result.claims.workspaceId };
}

export function registerControlPlaneRoutes(router: Router, deps: ControlPlaneDeps): void {
  router.prefixRoute("POST", "/v1/runs/", async (req) => {
    // A prefix route dispatching on the tail rather than N exact routes, because all four share
    // one auth step and Router has no path-parameter syntax (see http/router.ts's own note on
    // why the object route is a prefix match rather than a pattern language).
    const rest = req.path.slice("/v1/runs/".length);
    const slash = rest.indexOf("/");
    if (slash < 0) throw notFound("no such control-plane route");
    const runId = rest.slice(0, slash);
    const tail = rest.slice(slash + 1);

    if (tail === "trace") return handleTrace(req, runId, deps);
    if (tail === "control") return handleControlPush(req, runId, deps);
    if (tail === "mcp-confirm") return handleMcpConfirm(req, runId, deps);
    throw notFound("no such control-plane route");
    // THE CONFIRMATION IS A BLOCKING REQUEST BY DESIGN, so this route states its own deadline
    // rather than taking the router's. A confirmation waits for a HUMAN — up to
    // MAX_MCP_CONFIRM_TIMEOUT_MS of one — and the router's ordinary fifteen seconds would answer
    // it while somebody was still reading the arguments. The margin above the confirm ceiling is
    // what keeps the DENY the timeout produces coming from mcp_bridge's own clock, which is
    // where "timing out denies" is implemented and tested; a router deadline that fired first
    // would turn a denial into a transport error and lose the red tool_call step that records it.
  }, { timeoutMs: MAX_MCP_CONFIRM_TIMEOUT_MS + 15_000 });

  router.prefixRoute("GET", "/v1/runs/", async (req) => {
    const rest = req.path.slice("/v1/runs/".length);
    const slash = rest.indexOf("/");
    if (slash < 0) throw notFound("no such control-plane route");
    const runId = rest.slice(0, slash);
    const tail = rest.slice(slash + 1);
    if (tail !== "control") throw notFound("no such control-plane route");
    return handleControlLongPoll(req, runId, deps);
    // A long-poll holds for MAX_LONG_POLL_MS on purpose — that is the mechanism, not a delay —
    // so it gets a deadline just past its own ceiling. Comfortably inside the router's default
    // in the ordinary case, and the explicit number is what stops a later change to that default
    // from silently capping the poll at something shorter than the wait it exists to perform.
  }, { timeoutMs: MAX_LONG_POLL_MS + 5_000 });
}

async function handleTrace(req: HttpRequest, runId: string, deps: ControlPlaneDeps) {
  authenticate(req, runId, deps);
  const body = await req.json<{ events?: unknown[] }>();
  if (!Array.isArray(body.events)) throw badRequest("expected {events: [...]}");

  // Bytes AND RATE are checked BEFORE parsing any event out of the batch — a batch that is itself
  // over budget must not get partial credit for the events ahead of the one that tips it over.
  // Per-event size is what recordBytes' own single-write cap catches; the cumulative check is what
  // catches many small, individually-fine events adding up to a flood.
  //
  // recordLine IS THE THIRD CAP AND IT APPLIES HERE TOO. backpressure.ts documents three —
  // bytes per run, single-line length, lines per second — and states that the same limiter serves
  // both transports. This route enforced only the first two, so the rate cap existed on a local
  // subprocess's stdout and nowhere on the hosted path: a run pushing batches of small events as
  // fast as it could open connections was rate-limited by nothing until it eventually walked into
  // the 64 MB per-run ceiling. One event on the wire is one line, so it is counted as one.
  const serialised: string[] = [];
  for (const candidate of body.events) {
    const json = JSON.stringify(candidate) ?? "null";
    serialised.push(json);
    const violation =
      deps.backpressure.recordBytes(runId, Buffer.byteLength(json, "utf8")) ?? deps.backpressure.recordLine(runId);
    if (violation) {
      const reason = describeViolation(violation);
      deps.onBackpressureViolation?.(runId, reason);
      throw badRequest(`run ${runId} exceeded its trace backpressure limit: ${reason}`);
    }
  }

  let accepted = 0;
  let dropped = 0;
  for (const [i, candidate] of body.events.entries()) {
    // THE ROUTE IS SCOPED TO ONE RUN AND SO IS EVERY EVENT ON IT. The header of this file promises
    // "all scoped by a run token to exactly the run it names", and that was true of the envelope
    // and false of the body: `insertStep` binds `step.run_id` verbatim and `upsertRun` is scoped
    // only by workspace, so a sandbox holding its own valid token could name another run in the
    // same workspace and rewrite its trace. Refused here as well as at ingest, because this is the
    // trust boundary and a caller sending one deserves to be told it was dropped.
    if (isTraceEvent(candidate) && runIdOf(candidate) === runId) {
      deps.bus.pushTrace(runId, candidate);
      accepted++;
    } else {
      const line = serialised[i]!.slice(0, 300);
      const why = isTraceEvent(candidate)
        ? `event names run ${runIdOf(candidate)}, not ${runId}`
        : "not a recognized trace event";
      deps.bus.pushParseError(runId, { line, error: why });
      deps.metrics?.recordDropped({ runId, reason: `${why}: ${line}` });
      dropped++;
    }
  }
  return { body: { accepted, dropped } };
}

async function handleControlPush(req: HttpRequest, runId: string, deps: ControlPlaneDeps) {
  authenticate(req, runId, deps);
  const body = await req.json<{ ctrl?: Record<string, unknown> }>();
  if (!body.ctrl || typeof body.ctrl !== "object") throw badRequest("expected {ctrl: {...}}");
  deps.bus.pushControlLine(runId, body.ctrl);
  return {};
}

/** The default when a caller does not say how long it can wait, and the ceiling regardless of
 *  what it asks for. 25s matches the spec's own "long-poll, ≤25s" figure. */
const DEFAULT_LONG_POLL_MS = 25_000;
const MAX_LONG_POLL_MS = 25_000;

async function handleControlLongPoll(req: HttpRequest, runId: string, deps: ControlPlaneDeps) {
  authenticate(req, runId, deps);
  // The caller states its own patience so the server's wait never outlasts the client's socket
  // timeout. Mismatched here, a request that times out client-side abandons a WAITER this
  // module still holds — the next signal() then wakes that dead waiter instead of queuing for
  // the caller's next, live poll, and a real pause silently misses the run it was meant for.
  const requested = Number(req.url.searchParams.get("timeoutMs"));
  const timeoutMs = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LONG_POLL_MS) : DEFAULT_LONG_POLL_MS;
  const action = await deps.bus.waitForControl(runId, timeoutMs);
  return { body: action };
}

async function handleMcpConfirm(req: HttpRequest, runId: string, deps: ControlPlaneDeps) {
  authenticate(req, runId, deps);
  const body = await req.json<{ nonce?: string; timeout_s?: number; [k: string]: unknown }>();
  if (typeof body.nonce !== "string" || !body.nonce) throw badRequest("expected {nonce: string, ...}");

  deps.onMcpConfirmRequested?.(runId, body);

  const requestedMs = Number(body.timeout_s ?? DEFAULT_MCP_CONFIRM_TIMEOUT_MS / 1000) * 1000;
  const timeoutMs = Math.min(
    Number.isFinite(requestedMs) && requestedMs > 0 ? requestedMs : DEFAULT_MCP_CONFIRM_TIMEOUT_MS,
    MAX_MCP_CONFIRM_TIMEOUT_MS,
  );
  const verdict = await deps.bus.awaitMcpConfirm(runId, body.nonce, timeoutMs);
  // WHOEVER SETTLED IT, the ask is over and the screens holding it have to be told. A person
  // answering already clears through the command that answered; this is the other way it ends —
  // the timeout — and it is the one nothing was closing.
  deps.onMcpConfirmSettled?.(runId, body.nonce, verdict);
  return { body: { verdict } };
}
