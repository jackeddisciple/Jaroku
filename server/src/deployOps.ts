// The three things people still open the Railway dashboard for, and the one that gets them back
// in when Jaroku has lost its own way in.
//
// They are small next to the rest of Part 1 and they belong here, on the server, so that Part 2
// is only a screen — a UI that had to know how Railway pages its logs, or what "stopped" means to
// a service, would be a second implementation of this file in a language that cannot be tested
// the same way.
//
//   HEALTH   — a bounded poll of the agent's own /health, cached, with a STATED staleness.
//   LOGS     — Railway's runtime log query, followed as the sliding window it is.
//   KILL     — stop the service. Destructive, capability-gated, and it reports what happened.
//   RECONNECT— mint a fresh serve token, set it, store it. The way back in for every agent
//              deployed before Jaroku kept one.

import { randomBytes } from "node:crypto";

import type { Deployment, DeployStore } from "./deployStore.ts";
import { makeScrubber } from "./deploySecrets.ts";
import { RailwayApi, RailwayError } from "./railwayApi.ts";
import type { TenantContext } from "./db/tenant.ts";

/**
 * How long a health answer is worth reusing.
 *
 * §10 asks for "a bounded poll per deployed agent, cached, with a stated staleness. Not a
 * per-render fetch." Fifteen seconds is short enough that a container that just fell over is red
 * before anybody refreshes twice, and long enough that a grid of twenty agents rendering on every
 * socket frame does not turn into twenty outbound requests a second against URLs Jaroku does not
 * own. The staleness is RETURNED rather than assumed, so the screen can say "as of 12s ago"
 * instead of implying it just checked.
 */
export const HEALTH_CACHE_MS = 15_000;

/** A health check is a liveness probe, not a request worth waiting on. */
const HEALTH_TIMEOUT_MS = 5_000;

/** How many runtime log lines to ask for. Generous, because it is a window onto the END of a
 *  stream and anything that scrolls past between two polls is gone. */
const RUNTIME_LOG_PAGE = 500;

export type HealthState = "healthy" | "unhealthy" | "unreachable" | "no_url";

export interface DeployHealth {
  deploymentId: string;
  state: HealthState;
  /** What the endpoint said about itself, when it said anything. Never a guess. */
  agentId: string | null;
  /** Milliseconds since this answer was actually obtained. Zero on a fresh probe. */
  staleMs: number;
  checkedAt: string;
  detail: string | null;
}

export interface RuntimeLogLine {
  timestamp: string;
  message: string;
  severity: string | null;
}

export interface KillOutcome {
  ok: boolean;
  /** What actually happened, rather than what was asked for. See `kill`. */
  detail: string;
  /** True when the Railway service is gone. False when the row was detached and it is not. */
  serviceRemoved: boolean;
}

export interface ReconnectOutcome {
  ok: boolean;
  detail: string;
  /**
   * WHETHER PRESSING THIS RESTARTS THE USER'S AGENT, and the command returns it rather than
   * leaving Part 2 to know.
   *
   * Setting a variable on a Railway service restarts it. That is not a detail: a restart drops
   * every run in flight in that container and takes its checkpoints with it, so a run somebody
   * paused this morning cannot be resumed afterwards. §8 is explicit — "the command must return
   * that fact so Part 2's UI can warn before the user presses it. A restart nobody was warned
   * about is how a control plane loses trust in one click."
   */
  restartsService: boolean;
  /** The fresh token, once, for the same reason a deploy shows one: so a person can call their
   *  own endpoint. It is stored as well — see storeServeToken. */
  token: string | null;
}

export interface DeployOpsDeps {
  store: DeployStore;
  /** The workspace's Railway token, read at the moment of use and never held. */
  token: () => string | undefined;
  /** Put a fresh serve token where the dispatcher can find it. Returns a warning, or null. */
  storeServeToken: (e: { ctx: TenantContext; serviceId: string; token: string }) => Promise<string | null>;
  /** Whether this caller may destroy things in the user's hosting account. */
  canKill: (ctx: TenantContext) => Promise<boolean> | boolean;
  now?: () => number;
  fetchImpl?: typeof fetch;
  apiFor?: (token: string, scrub: (t: string) => string) => RailwayApi;
}

interface CachedHealth {
  at: number;
  value: Omit<DeployHealth, "staleMs">;
}

export class DeployOps {
  private health_ = new Map<string, CachedHealth>();
  /** One probe per deployment in flight at a time. Ten sockets opening at once against a cold
   *  cache would otherwise make ten identical requests to somebody's container — the same
   *  in-flight-promise fix the Activity cache already makes, for the same reason. */
  private inFlight = new Map<string, Promise<Omit<DeployHealth, "staleMs">>>();
  private readonly now: () => number;

  constructor(private readonly deps: DeployOpsDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private api(scrub: (t: string) => string = (t) => t): RailwayApi {
    const token = this.deps.token();
    if (!token) throw new RailwayError("auth", "no Railway token is configured for this workspace", "deployOps");
    return this.deps.apiFor?.(token, scrub) ?? new RailwayApi({ token, scrub });
  }

  /**
   * Is the deployed agent answering?
   *
   * ASKS THE AGENT, NOT RAILWAY. Railway will happily report a service as deployed while the
   * process inside it is crash-looping — `GET /health` is the only thing that knows whether the
   * agent itself came up. It is unauthenticated by design (serve.py's own note: "a health check
   * that needs a credential is a health check the platform cannot make"), so this needs no token
   * and works for a deployment Jaroku has lost the serve token for, which is exactly the
   * deployment somebody is most likely to be looking at.
   */
  async health(ctx: TenantContext, deploymentId: string, opts: { force?: boolean } = {}): Promise<DeployHealth> {
    const cached = this.health_.get(deploymentId);
    if (!opts.force && cached && this.now() - cached.at < HEALTH_CACHE_MS) {
      return { ...cached.value, staleMs: this.now() - cached.at };
    }
    const existing = this.inFlight.get(deploymentId);
    if (existing) return { ...(await existing), staleMs: 0 };

    const probe = this.probe(ctx, deploymentId).finally(() => this.inFlight.delete(deploymentId));
    this.inFlight.set(deploymentId, probe);
    const value = await probe;
    this.health_.set(deploymentId, { at: this.now(), value });
    return { ...value, staleMs: 0 };
  }

  /**
   * The last answer, if anything has asked recently. NEVER a probe.
   *
   * §10 asks for "a bounded poll per deployed agent, cached, with a stated staleness. Not a
   * per-render fetch", and this is the half that makes the second sentence enforceable: the fleet
   * strip is rebuilt on every job transition and on every connect, so a builder that could reach
   * `health()` would turn a grid of twenty agents into twenty outbound requests to URLs Jaroku does
   * not own, several times a second, on somebody else's infrastructure.
   *
   * `undefined` MEANS NOBODY HAS ASKED, which is a third state and not "unhealthy". A card that
   * reported red because it had never been probed would be the product accusing a working agent.
   *
   * IT DOES NOT CHECK THE CACHE'S AGE. Staleness is REPORTED rather than enforced here for the
   * reason the return value carries it at all: a fifty-second-old answer is still the last thing
   * the agent said about itself, and the screen saying "as of 50s ago" is more use than the screen
   * saying nothing. What must never happen is it implying the check just ran.
   */
  cachedHealth(deploymentId: string): { state: HealthState; staleMs: number } | undefined {
    const cached = this.health_.get(deploymentId);
    return cached ? { state: cached.value.state, staleMs: this.now() - cached.at } : undefined;
  }

  private async probe(ctx: TenantContext, deploymentId: string): Promise<Omit<DeployHealth, "staleMs">> {
    const at = new Date(this.now()).toISOString();
    const row = await this.deps.store.get(ctx, deploymentId);
    if (!row?.url) {
      return {
        deploymentId, state: "no_url", agentId: null, checkedAt: at,
        detail: row ? "this deployment has no public URL" : "no such deployment",
      };
    }
    const doFetch = this.deps.fetchImpl ?? fetch;
    try {
      const res = await doFetch(`${row.url.replace(/\/+$/, "")}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) {
        return {
          deploymentId, state: "unhealthy", agentId: null, checkedAt: at,
          detail: `the endpoint answered ${res.status}`,
        };
      }
      // WHAT IT SAID ABOUT ITSELF, parsed defensively. This is somebody else's container on the
      // public internet answering an unauthenticated route; a body that is not the shape serve.py
      // sends is a service that is not this agent, and reporting it healthy would be worse than
      // reporting nothing.
      let agentId: string | null = null;
      try {
        const parsed = JSON.parse(text) as { ok?: unknown; agent?: unknown };
        if (parsed.ok !== true) {
          return {
            deploymentId, state: "unhealthy", agentId: null, checkedAt: at,
            detail: "the endpoint answered, but not as a healthy Jaroku agent",
          };
        }
        agentId = typeof parsed.agent === "string" ? parsed.agent : null;
      } catch {
        return {
          deploymentId, state: "unhealthy", agentId: null, checkedAt: at,
          detail: "the endpoint answered with something that is not a health response",
        };
      }
      return { deploymentId, state: "healthy", agentId, checkedAt: at, detail: null };
    } catch (err) {
      const aborted = (err as { name?: string }).name === "TimeoutError" || (err as { name?: string }).name === "AbortError";
      return {
        deploymentId, state: "unreachable", agentId: null, checkedAt: at,
        detail: aborted
          ? `the endpoint did not answer within ${HEALTH_TIMEOUT_MS / 1000}s`
          : `could not reach the endpoint: ${(err as Error).message}`,
      };
    }
  }

  /**
   * The container's own log pane, as Railway holds it.
   *
   * FOLLOWED AS A SLIDING WINDOW, NEVER PAGED BY OFFSET, and §10 names this as a bug already in
   * the changelog for build logs that must not be reintroduced here. Railway's log query answers
   * with the most recent N lines of a stream that is still being written — so asking for "the
   * next page" by advancing an offset walks BACKWARDS through a moving window and returns lines
   * that have already scrolled, or skips ones that arrived in between. The cursor that works is a
   * TIMESTAMP: ask for the window, drop what is not newer than the last line already shown.
   *
   * THROUGH THE SAME SCRUBBER THE BUILD LOG USES, because a runtime log is somebody else's text
   * echoed back at us — an agent that prints its own environment, a library that logs a
   * connection string — and this one is read from a process that has every credential the deploy
   * gave it.
   */
  async runtimeLogs(
    ctx: TenantContext,
    deploymentId: string,
    opts: { since?: string | null; limit?: number } = {},
  ): Promise<{ lines: RuntimeLogLine[]; cursor: string | null }> {
    const row = await this.deps.store.get(ctx, deploymentId);
    if (!row?.railway_deployment_id) return { lines: [], cursor: opts.since ?? null };

    const token = this.deps.token();
    const scrub = makeScrubber([token ?? ""].filter(Boolean));
    const raw = await this.api(scrub).deploymentLogs(row.railway_deployment_id, opts.limit ?? RUNTIME_LOG_PAGE);

    const since = opts.since ?? null;
    const lines = raw
      // STRICTLY NEWER, so a line whose timestamp equals the cursor is not shown twice. Railway
      // timestamps to the microsecond, so collisions are rare and duplication is the visible
      // symptom when they happen.
      .filter((l) => !since || l.timestamp > since)
      .map((l) => ({ timestamp: l.timestamp, message: scrub(l.message), severity: l.severity ?? null }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // THE CURSOR IS THE NEWEST LINE ACTUALLY SHOWN, and it does not move when nothing arrived —
    // returning "now" instead would silently skip anything Railway had not flushed yet.
    return { lines, cursor: lines.at(-1)?.timestamp ?? since };
  }

  /**
   * Stop the agent for good.
   *
   * CAPABILITY-GATED, because this destroys something in the user's own hosting account and
   * cannot be undone from here. §10 asks for the gate by name.
   *
   * AND IT REPORTS WHAT ACTUALLY HAPPENED rather than what was asked for. Railway can refuse:
   * the token may have been rotated, the service may already be gone, the account may have been
   * suspended. In every one of those the local row still has to be settled — leaving it reading
   * "live" for a service that is not there is the same silence the reconciliation sweep exists to
   * end — but the sentence the user gets must say which of the two happened. "Removed from
   * Jaroku, still running on Railway" and "stopped" are different facts about somebody's bill.
   */
  async kill(ctx: TenantContext, deploymentId: string): Promise<KillOutcome> {
    if (!(await this.deps.canKill(ctx))) {
      return { ok: false, detail: "you do not have permission to stop a deployed agent", serviceRemoved: false };
    }
    const row = await this.deps.store.get(ctx, deploymentId);
    if (!row) return { ok: false, detail: "no such deployment", serviceRemoved: false };
    if (!row.railway_service_id) {
      await this.deps.store.patch(ctx, deploymentId, { status: "removed" });
      return {
        ok: true,
        detail: "this deployment never reached Railway — the record has been removed",
        serviceRemoved: false,
      };
    }

    try {
      await this.api().deleteService(row.railway_service_id);
    } catch (err) {
      const message = err instanceof RailwayError ? err.message : (err as Error).message;
      // SETTLED ANYWAY, AND SAID PLAINLY. The user asked to stop it and Jaroku could not; leaving
      // the row live would claim the agent is serving, and claiming it was stopped would be worse.
      await this.deps.store.patch(ctx, deploymentId, { status: "removed", error: message });
      return {
        ok: false,
        detail:
          `Railway would not remove the service (${message}). It has been detached from Jaroku, ` +
          `but it may still be running and still costing money — check your Railway dashboard.`,
        serviceRemoved: false,
      };
    }

    await this.deps.store.patch(ctx, deploymentId, { status: "removed", url: null });
    this.health_.delete(deploymentId);
    return { ok: true, detail: "the Railway service has been deleted and the agent is no longer serving", serviceRemoved: true };
  }

  /**
   * Mint a fresh serve token, set it on Railway, and store it.
   *
   * THE WAY BACK IN FOR EVERY AGENT DEPLOYED BEFORE PART 1. Their token was minted, shown once
   * and thrown away, and it is unrecoverable — so there is nothing to migrate and no cleverness
   * available. A new one is the only route, and this is it.
   *
   * IT RESTARTS THE SERVICE, AND SAYS SO IN ITS RETURN VALUE. Setting a variable on Railway
   * restarts the container: every run in flight in it dies, and its checkpoints die with them, so
   * a run somebody paused this morning cannot be resumed afterwards. That fact travels with the
   * command so Part 2 can warn before the button is pressed rather than after.
   */
  async reconnect(ctx: TenantContext, deploymentId: string): Promise<ReconnectOutcome> {
    const row = await this.deps.store.get(ctx, deploymentId);
    if (!row) return { ok: false, detail: "no such deployment", restartsService: false, token: null };
    const target = railwayTarget(row);
    if (!target) {
      return {
        ok: false,
        detail: "this deployment has no Railway service to set a variable on",
        restartsService: false,
        token: null,
      };
    }

    // The same shape a deploy mints. Not derived from anything — a token that could be
    // recomputed from the deployment id would be a token anybody holding the id could compute.
    const token = randomBytes(24).toString("base64url");
    const scrub = makeScrubber([token, this.deps.token() ?? ""].filter(Boolean));
    try {
      await this.api(scrub).upsertVariables(target, { JAROKU_SERVE_TOKEN: token });
    } catch (err) {
      const message = err instanceof RailwayError ? err.message : (err as Error).message;
      return { ok: false, detail: `could not set the new token on Railway: ${scrub(message)}`, restartsService: false, token: null };
    }

    // STORED AFTER IT IS SET, NOT BEFORE. If the store fails, the container now expects a token
    // Jaroku does not have — which is the state this command exists to fix — so the failure has
    // to be reported rather than swallowed, and the fresh token is still returned so the user can
    // keep their own copy of what their endpoint now wants.
    const warning = await this.deps.storeServeToken({ ctx, serviceId: target.serviceId, token });
    if (warning) {
      return {
        ok: false,
        detail:
          `the new token was set on Railway but Jaroku could not store its own copy (${warning}). ` +
          `The endpoint now expects the token shown here; try reconnecting again.`,
        restartsService: true,
        token,
      };
    }
    return {
      ok: true,
      detail: "a fresh token was set on Railway and stored — the service is restarting to pick it up",
      restartsService: true,
      token,
    };
  }
}

/** The three ids a variables mutation needs, or null when the row has not got them. */
function railwayTarget(row: Deployment): { projectId: string; environmentId: string; serviceId: string } | null {
  if (!row.railway_project_id || !row.railway_environment_id || !row.railway_service_id) return null;
  return {
    projectId: row.railway_project_id,
    environmentId: row.railway_environment_id,
    serviceId: row.railway_service_id,
  };
}
