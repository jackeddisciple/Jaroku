// Asking a deployed container to do something — the one place Jaroku calls OUT to an agent's
// own URL.
//
// EVERYTHING ELSE IN THE DEPLOY PATH TALKS TO RAILWAY. This talks to the agent: `POST /run` to
// start a job, `POST /run` again with a resume, `POST /cancel` to stop one. The endpoint belongs
// to the user, is on the public internet, and answers with whatever it likes — so every response
// here is treated as untrusted text, every call is bounded, and nothing about the run is learned
// from the reply. What a run did is on its trace, which arrives by the other direction.
//
// THE CREDENTIALS ARE RESOLVED PER CALL, NEVER HELD. `endpoint` is a function for the same
// reason `DeployManagerDeps.token` is: a deployment's URL and its serve token are workspace
// state that can change under a long-lived process, and a value captured at construction is a
// value that goes stale silently. Neither is stored on this class and neither reaches a log.
//
// THE RUN TOKEN GOES INWARD IN THE BODY. It is minted per dispatch by `DeployRuns`, scoped to
// one run, expiring, revocable — see runTokens.ts. The container puts it into the environment of
// the run it starts and never stores it. That is a strictly better credential than the
// deployment's own bearer, and the container holds nothing long-lived that reaches Jaroku.

import type { DeployRuns } from "./deployRuns.ts";

/** Where a deployed agent is, and what gets past its front door. Both may be absent. */
export interface DeployEndpoint {
  url: string;
  /** Null for a deployment the user chose to serve publicly. */
  serveToken: string | null;
}

export interface DeployDispatchDeps {
  runs: DeployRuns;
  /**
   * The live endpoint for a deployment, or null when there is not one to call.
   *
   * Null covers three genuinely different situations and the caller is told which: no
   * deployment, a deployment with no URL yet, and — the one that needs its own message — a
   * deployment made before Jaroku kept the serve token, which has to be reconnected before
   * anything can reach it.
   */
  endpoint: (deploymentId: string) => Promise<DeployEndpoint | null>;
  /** How long to wait for the container to ACCEPT a job. Never for it to finish one. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type DispatchOutcome =
  | { ok: true; runId: string; acceptedAt: string }
  | {
      ok: false;
      reason: DispatchFailure;
      detail: string;
      status?: number;
      /**
       * What the container's own `Retry-After` asked for, in milliseconds, when it sent one.
       *
       * CARRIED RATHER THAN OBEYED HERE, because this class does not retry — it makes one request
       * and reports what came back, which is what keeps it usable for a dispatch, a resume and a
       * cancel alike. Whoever is deciding whether to try again is the one that has a budget, and
       * a header parsed at the point it arrives is a header nobody downstream has to re-fetch.
       *
       * Both forms of the header are accepted, because both are legal and `serve.py` is not the
       * only thing that can answer this endpoint: a number of seconds, or an HTTP date. A date in
       * the past is zero rather than negative, and anything unparseable is absent rather than
       * guessed at.
       */
      retryAfterMs?: number;
    };

/**
 * Why a dispatch did not happen, as a value rather than a sentence.
 *
 * Named cases because they are acted on differently and Part 2 renders them differently: a
 * `busy` is worth retrying in five seconds, an `unreachable` is worth showing the deployment's
 * health beside, and `no_credential` is the only one with a button attached — reconnect.
 */
export type DispatchFailure =
  | "no_deployment"
  | "no_credential"
  | "busy"
  | "unauthorised"
  | "no_checkpoint"
  | "refused"
  | "unreachable";

/** Generous enough for a container waking a cold interpreter, and finite because a public URL
 *  that never answers must not hold a request handler open. It bounds ACCEPTANCE only — the run
 *  itself is unbounded by design, which is the whole point of the 202. */
const DEFAULT_TIMEOUT_MS = 30_000;

export class DeployDispatcher {
  constructor(private readonly deps: DeployDispatchDeps) {}

  private get timeoutMs(): number {
    return this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Start a job on a deployed agent, as an ordinary traced run.
   *
   * THE RUN IS OPENED BEFORE THE REQUEST IS MADE, not after it is accepted — `DeployRuns.open`
   * registers it on the bus and mints its token, and a container that is fast enough to push its
   * `run_start` while this promise is still pending needs the bus entry to already exist. If the
   * dispatch then fails, the run is closed again and its token revoked, so nothing is left
   * holding a credential for a run that never began.
   */
  async start(input: {
    deploymentId: string;
    workspaceId: string;
    agentId: string;
    runId: string;
    input: string;
    provider?: string;
    model?: string;
    controlPlaneUrl: string;
  }): Promise<DispatchOutcome> {
    return this.send(input.deploymentId, input.workspaceId, input.agentId, input.runId, {
      input: input.input,
      provider: input.provider,
      model: input.model,
      controlPlaneUrl: input.controlPlaneUrl,
    });
  }

  /**
   * Continue a paused deployed run from its durable checkpoint.
   *
   * THE SAME RUN, NOT A NEW ONE. `resume_run_id` is what the container puts into the runner's
   * environment, and the runner emits no `run_start` for a continuation — so the timeline stays
   * one timeline and the seq picks up where the paused segment stopped. `seqOffset` is the run's
   * current max seq plus one, computed by the caller from the store, because only the store knows
   * what actually landed.
   *
   * A 409 HERE IS EXPECTED AND MEANINGFUL. A container's checkpoints do not survive a restart,
   * so a run paused before one cannot be continued — and the container says so rather than
   * starting the graph over. See serve.py's own note; it is the difference between "this cannot
   * be resumed" and a run that silently re-spends what it already spent.
   */
  async resume(input: {
    deploymentId: string;
    workspaceId: string;
    agentId: string;
    runId: string;
    seqOffset: number;
    provider?: string;
    model?: string;
    controlPlaneUrl: string;
  }): Promise<DispatchOutcome> {
    return this.send(input.deploymentId, input.workspaceId, input.agentId, input.runId, {
      provider: input.provider,
      model: input.model,
      controlPlaneUrl: input.controlPlaneUrl,
      resumeRunId: input.runId,
      seqOffset: input.seqOffset,
    });
  }

  private async send(
    deploymentId: string,
    workspaceId: string,
    agentId: string,
    runId: string,
    body: {
      input?: string;
      provider?: string;
      model?: string;
      controlPlaneUrl: string;
      resumeRunId?: string;
      seqOffset?: number;
    },
  ): Promise<DispatchOutcome> {
    const endpoint = await this.deps.endpoint(deploymentId);
    if (!endpoint) {
      return {
        ok: false,
        reason: "no_deployment",
        detail: "this agent has no live deployment to run on",
      };
    }

    const opened = this.deps.runs.open({ runId, workspaceId, deploymentId, agentId });
    const doFetch = this.deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await doFetch(`${endpoint.url.replace(/\/+$/, "")}/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(endpoint.serveToken ? { authorization: `Bearer ${endpoint.serveToken}` } : {}),
        },
        body: JSON.stringify({
          input: body.input ?? "",
          run_id: runId,
          run_token: opened.runToken,
          control_plane_url: body.controlPlaneUrl,
          ...(body.provider ? { provider: body.provider } : {}),
          ...(body.model ? { model: body.model } : {}),
          ...(body.resumeRunId ? { resume_run_id: body.resumeRunId, seq_offset: body.seqOffset ?? 0 } : {}),
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.status === 202) {
        let acceptedAt = new Date().toISOString();
        try {
          const parsed = JSON.parse(text) as { accepted_at?: unknown };
          if (typeof parsed.accepted_at === "string") acceptedAt = parsed.accepted_at;
        } catch {
          // A 202 with an unreadable body is still an acceptance. The container said yes; what
          // it said afterwards is not load-bearing, and refusing over it would abandon a run
          // that is already executing.
        }
        return { ok: true, runId, acceptedAt };
      }
      // EVERY OTHER ANSWER CLOSES THE RUN AGAIN, so no token stays valid for a run that never
      // started and no bus entry is left waiting for pushes that will never come.
      this.deps.runs.close(runId, "cancelled");
      return { ok: false, ...describe(res.status, text), ...retryAfter(res.headers) };
    } catch (err) {
      this.deps.runs.close(runId, "cancelled");
      const aborted = (err as { name?: string }).name === "AbortError";
      return {
        ok: false,
        reason: "unreachable",
        detail: aborted
          ? `the deployment did not accept the job within ${Math.round(this.timeoutMs / 1000)}s`
          : `could not reach the deployment: ${(err as Error).message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ask a deployed container to stop a run at its next node boundary.
   *
   * DOES NOT CLOSE THE RUN HERE. Cancel is a request, not an outcome: the run stops at a node
   * boundary and emits its own `run_end`, which is what actually ends it — closing it from this
   * side would revoke the token the container still needs to report that.
   */
  async cancel(deploymentId: string, runId: string): Promise<DispatchOutcome> {
    const endpoint = await this.deps.endpoint(deploymentId);
    if (!endpoint) {
      return { ok: false, reason: "no_deployment", detail: "this agent has no live deployment" };
    }
    const doFetch = this.deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await doFetch(`${endpoint.url.replace(/\/+$/, "")}/cancel`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(endpoint.serveToken ? { authorization: `Bearer ${endpoint.serveToken}` } : {}),
        },
        body: JSON.stringify({ run_id: runId }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.status === 202) return { ok: true, runId, acceptedAt: new Date().toISOString() };
      return { ok: false, ...describe(res.status, text), ...retryAfter(res.headers) };
    } catch (err) {
      return {
        ok: false,
        reason: "unreachable",
        detail: `could not reach the deployment: ${(err as Error).message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * `Retry-After`, in milliseconds, or nothing.
 *
 * BOUNDED AT AN HOUR, because this is a number a container Jaroku does not control chose, and it
 * ends up in a `setTimeout` on the control plane. A header asking for a week is not a request to
 * honour; it is a request to stop and let a person decide, which is what the caller's own attempt
 * budget does with an absent value anyway.
 */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

function retryAfter(headers: Headers): { retryAfterMs?: number } {
  const raw = headers.get("retry-after");
  if (!raw) return {};
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) {
    return { retryAfterMs: Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_AFTER_MS) };
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return {};
  // A DATE IN THE PAST IS ZERO, NOT NEGATIVE. Clocks disagree, and a container whose idea of now
  // is thirty seconds ahead of ours would otherwise produce a negative delay that reads as "never
  // wait" in one caller and throws in another.
  return { retryAfterMs: Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS) };
}

/**
 * What a status code from somebody else's container means here.
 *
 * The body is the container's own text and is TRUNCATED rather than trusted: it is echoed into a
 * message a user reads, and a deployed agent is running code a model wrote on infrastructure
 * Jaroku does not control. Same posture the build-log scrubber takes toward Railway's output.
 */
function describe(status: number, body: string): { reason: DispatchFailure; detail: string; status: number } {
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 300);
  if (status === 429) {
    return { reason: "busy", detail: "the deployment is already running as many jobs as it allows", status };
  }
  if (status === 401 || status === 403) {
    // THE ONE WITH A BUTTON ATTACHED. A deployment made before Jaroku kept the serve token has
    // an unrecoverable credential, and this is what that looks like from here.
    return {
      reason: "unauthorised",
      detail: "the deployment refused Jaroku's credential — reconnect it to mint a fresh one",
      status,
    };
  }
  if (status === 409) {
    return {
      reason: "no_checkpoint",
      detail: snippet || "this run cannot be resumed — its checkpoint is gone",
      status,
    };
  }
  return { reason: "refused", detail: snippet || `the deployment answered ${status}`, status };
}
