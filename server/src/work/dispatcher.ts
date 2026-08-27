// Giving a live agent a real job — the five steps §6 names, in the order it names them.
//
// THE ORDER IS THE DESIGN, not a style. Each step can fail, and where a failure lands decides
// whether the operator ends up with a record of it:
//
//   1. RESOLVE THE DEPLOYMENT. No live deployment is a refusal BEFORE anything is written, because
//      there is nothing to record — nobody was asked to do anything and no money can have been
//      spent. The sentence names the Deploy panel, because that is the fix.
//   2. WRITE THE ROW, as `queued`, before anything leaves the process. Same discipline the eval
//      engine holds: a dispatch creates work in somebody else's account and can be interrupted at
//      any point, so a record that only appears on success turns a crash into a container spending
//      money with nothing in Jaroku knowing it was asked to.
//   3. RESOLVE THE CREDENTIAL, by RAILWAY SERVICE ID rather than by `deployments.id`. Part 1 keyed
//      it that way for two reasons worth knowing before touching this file — see `SecretStore
//      .getServeToken` — and the one that bites here is that a redeploy overwrites the same
//      variable rather than accumulating one dead secret per deploy.
//   4. POST /run AND EXPECT 202. From this point the container owns the job.
//   5. NOTHING ELSE. The trace drives the state from here: `run_end` closes the item, a
//      confirmation request moves it to `waiting`, Part 1's reconciliation closes out a container
//      that went quiet. This file does not wait for any of it — that is what the 202 is FOR.
//
// A FAILURE AFTER STEP 2 FAILS THE ROW RATHER THAN UNWINDING IT. Deleting the row would be the
// tidier-looking choice and it is the wrong one: between the POST leaving and the answer arriving,
// the container may have started the job. An operator who pressed dispatch and sees nothing at all
// has no way to find out; one who sees a failed job with `unreachable` against it knows exactly
// what to check.
//
// IT DOES NOT TALK TO THE CONTAINER ITSELF. `deployDispatch.ts` is the one place in this codebase
// that calls out to an agent's own URL, and Part 1 put a great deal of care into how it treats the
// answer as untrusted text. A second HTTP client here would be a second copy of that care.

import { randomUUID } from "node:crypto";

import type { DeployDispatcher, DispatchFailure } from "../deployDispatch.ts";
import type { Deployment, DeployStore } from "../deployStore.ts";
import { EgressPolicyError, resolveAndPin, type Resolver } from "../sandbox/egressPolicy.ts";
import type { TenantContext } from "../db/tenant.ts";
import {
  WorkInputTooLarge, WorkStore, type WorkFailureKind, type WorkItem,
} from "./workStore.ts";

/**
 * Why a dispatch never got as far as a row.
 *
 * SEPARATE FROM `WorkFailureKind`, and the difference is exactly whether anything happened. A
 * failure kind describes a job that exists and went wrong; these describe a request that was
 * refused, with nothing recorded and nothing spent. Collapsing them would put rows on the board
 * for jobs nobody ever started, which is the opposite of what the board is for.
 */
export type WorkRefusal =
  /** The agent has no live deployment. The fix is the Deploy panel. */
  | "no_deployment"
  /** This workspace already has as many jobs in flight as it may. */
  | "at_capacity"
  /** Over `MAX_WORK_INPUT_BYTES`. Refused at the composer, not at the container — §4. */
  | "input_too_large"
  /** The deployment's URL is not one this server may call. */
  | "egress";

export type WorkDispatchOutcome =
  | { ok: true; item: WorkItem }
  /** Nothing was written and nothing was spent. */
  | { ok: false; stage: "refused"; refusal: WorkRefusal; detail: string }
  /** The row exists and reads `failed`. Something MAY have been spent — see the header. */
  | { ok: false; stage: "failed"; item: WorkItem; failureKind: WorkFailureKind; detail: string };

export interface WorkDispatcherDeps {
  work: WorkStore;
  deployments: DeployStore;
  /** Part 1's client. The one thing in this codebase that calls an agent's own URL. */
  dispatch: DeployDispatcher;
  /** The stored serve token for a Railway SERVICE — never for a deployment row. See step 3. */
  serveToken: (ctx: TenantContext, serviceId: string) => Promise<string | null>;
  /** Where the container pushes its trace back to. Absent means this server cannot be called home to. */
  controlPlaneUrl: () => string | undefined;
  /** How many jobs one workspace may have in flight. See `WORK_CONCURRENCY`. */
  concurrency?: () => number;
  /** Injected so the private-address refusal is exercised without a live network. */
  resolver?: Resolver;
}

/**
 * How many jobs one workspace may have in flight at once.
 *
 * FOUR, MATCHING THE CONTAINER'S OWN, and that is the whole reason there is a cap here at all:
 * `serve.py` refuses past its own limit with a 429, and a control plane that dispatched freely
 * would manufacture the 429s it then has to retry — spending a request, a retry budget and an
 * operator's attention on a refusal it caused. The cap is per WORKSPACE rather than per agent
 * because that is the unit the container is deployed per and the unit the bill arrives per.
 */
export const WORK_CONCURRENCY_ENV = "JAROKU_WORK_CONCURRENCY";
export const DEFAULT_WORK_CONCURRENCY = 4;

export function workConcurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[WORK_CONCURRENCY_ENV]);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_WORK_CONCURRENCY;
}

export class WorkDispatcher {
  constructor(private readonly deps: WorkDispatcherDeps) {}

  /**
   * The latest LIVE deployment for an agent, or null.
   *
   * `created_at DESC, created_seq DESC` IS THE STORE'S OWN ORDER, so this filters rather than
   * re-sorts: `listForAgent` already returns newest-first with the tie broken, and a second
   * ordering here would be a second answer to "which deployment is current" that could disagree
   * with the one the Deploy panel shows.
   *
   * LIVE ONLY. A deploy that is still building has no URL to call and one that failed has nothing
   * behind it; `currentForAgent` deliberately prefers an in-flight row because the panel wants to
   * show what is happening, and this wants the opposite — what can actually run a job.
   */
  async liveDeployment(ctx: TenantContext, agentId: string): Promise<Deployment | null> {
    const rows = await this.deps.deployments.listForAgent(ctx, agentId);
    return rows.find((d) => d.status === "live" && d.url) ?? null;
  }

  /** §6's five steps. */
  async dispatch(ctx: TenantContext, input: { agentId: string; input: string }): Promise<WorkDispatchOutcome> {
    // --- 1. validate -------------------------------------------------------------------------
    const deployment = await this.liveDeployment(ctx, input.agentId);
    if (!deployment?.url) {
      return {
        ok: false,
        stage: "refused",
        refusal: "no_deployment",
        detail: "this agent is not live — deploy it from the Deploy panel before giving it a job",
      };
    }

    const cap = this.deps.concurrency?.() ?? DEFAULT_WORK_CONCURRENCY;
    const inFlight = await this.deps.work.inFlight(ctx);
    if (inFlight >= cap) {
      return {
        ok: false,
        stage: "refused",
        refusal: "at_capacity",
        detail:
          `this workspace already has ${inFlight} job${inFlight === 1 ? "" : "s"} in flight, which is ` +
          `the limit — wait for one to finish, or raise ${WORK_CONCURRENCY_ENV}`,
      };
    }

    // THE URL, THROUGH THE SAME REFUSAL THE SANDBOX POLICY USES — §6's Bounds, "egress through
    // sandbox/egressPolicy.ts, reused not rewritten".
    try {
      await checkEndpointAddress(deployment.url, this.deps.resolver);
    } catch (err) {
      const detail = err instanceof EgressPolicyError
        ? err.message
        : `could not check the deployment's address: ${(err as Error).message}`;
      return { ok: false, stage: "refused", refusal: "egress", detail };
    }

    const controlPlaneUrl = this.deps.controlPlaneUrl();
    if (!controlPlaneUrl) {
      return {
        ok: false,
        stage: "refused",
        refusal: "no_deployment",
        detail:
          "this server has no public address for a container to report back to — set " +
          "JAROKU_CONTROL_PLANE_URL before dispatching to a deployed agent",
      };
    }

    // --- 2. write the row, before anything leaves the process ---------------------------------
    //
    // The run id is minted HERE and written with the row, so the item is joinable to its trace
    // from the instant it exists rather than after a patch that a crash could land between.
    const runId = randomUUID();
    let item: WorkItem;
    try {
      item = await this.deps.work.create(ctx, {
        agentId: input.agentId,
        deploymentId: deployment.id,
        runId,
        input: input.input,
      });
    } catch (err) {
      if (err instanceof WorkInputTooLarge) {
        return { ok: false, stage: "refused", refusal: "input_too_large", detail: err.message };
      }
      throw err;
    }

    // --- 3. the credential, by SERVICE id --------------------------------------------------
    //
    // AN ABSENT TOKEN FAILS THE ROW AS `unauthorised`, which looks like the wrong word and is the
    // only one available and the right one anyway. §4's closed set has six kinds and none of them
    // is "unconnected" — that word is a FLEET state in §9, describing a deployment rather than a
    // job — and `unauthorised`'s own definition is "the stored serve token is wrong. Offer
    // Reconnect", which is exactly what the operator has to do here. The detail sentence is what
    // distinguishes "there is no token" from "the token was refused"; the KIND is what decides
    // which button the card offers, and it is the same button.
    //
    // BY RAILWAY SERVICE ID AND NOT BY `deployments.id`. A deployment made before Part 1 has no
    // stored token at all, and a redeploy of one that has reuses the same service — so keying by
    // the row would leave one dead secret per deploy and would make a reconnect after a redeploy
    // write a token the dispatcher never reads.
    const serviceId = deployment.railway_service_id;
    const serveToken = serviceId ? await this.deps.serveToken(ctx, serviceId) : null;
    if (!serveToken) {
      const detail = serviceId
        ? "Jaroku has no credential for this deployment — reconnect it to mint a fresh one"
        : "this deployment never reached Railway, so there is nothing to authenticate against";
      await this.deps.work.finish(ctx, item.id, {
        status: "failed",
        error: detail,
        failureKind: "unauthorised",
      });
      return { ok: false, stage: "failed", item, failureKind: "unauthorised", detail };
    }

    // --- 4. POST /run, and expect 202 --------------------------------------------------------
    const started = await this.deps.dispatch.start({
      deploymentId: deployment.id,
      workspaceId: ctx.workspaceId,
      agentId: input.agentId,
      runId,
      input: input.input,
      provider: deployment.provider,
      model: deployment.model,
      controlPlaneUrl,
    });

    if (!started.ok) {
      const failureKind = failureKindFor(started.reason, started.status);
      await this.deps.work.finish(ctx, item.id, {
        status: "failed",
        error: started.detail,
        failureKind,
      });
      return { ok: false, stage: "failed", item, failureKind, detail: started.detail };
    }

    // --- 5. from here the trace drives the state ---------------------------------------------
    //
    // `markRunning` is guarded on `queued`, which is what makes this safe against the race it
    // looks like it has: a container fast enough to push its `run_start` — or a confirmation
    // request — before this line runs has already moved the item, and an unguarded UPDATE here
    // would drag it back to `running` and lose the fact that somebody is being asked something.
    await this.deps.work.markRunning(ctx, item.id, started.acceptedAt);
    return { ok: true, item: (await this.deps.work.get(ctx, item.id)) ?? item };
  }
}

/**
 * Whether this server may POST a job to that address, reusing the sandbox policy's refusal.
 *
 * WHAT IT IS FOR. `deployments.url` is written from Railway's answer rather than typed by anybody,
 * so reaching it requires already controlling the deploy path — but a row that names an internal
 * address turns dispatch into a request this server makes from INSIDE its own network boundary
 * with a bearer token attached, and the cloud metadata endpoint at 169.254.169.254 is the reason
 * that class of bug is worth a check rather than an argument. `resolveAndPin` is the piece that
 * answers it, and it is deliberately the whole of what is reused: a full egress POLICY describes
 * what a SANDBOX may reach, and this is one outbound call from the control plane.
 *
 * LOOPBACK IS THE ONE EXEMPTION, and it is narrow on purpose. `npm run mock:serve` is in this
 * repository's own package.json and a developer pointing a deployment row at `http://127.0.0.1:8932`
 * is the supported way to work on this feature without a Railway account — so refusing loopback
 * would make the local path unusable to buy nothing, because an address that can only reach the
 * machine Jaroku is already running on is not a way to reach anything Jaroku could not. Every
 * address that makes an SSRF interesting is somewhere else: link-local (the metadata endpoint),
 * RFC1918 neighbours, the container network, and anything a hostname resolves to. All of those
 * still go through `resolveAndPin` and are still refused.
 */
export async function checkEndpointAddress(url: string, resolver?: Resolver): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isLoopback(host)) return;
  await resolveAndPin(host, resolver);
}

function isLoopback(host: string): boolean {
  return host === "::1" || host === "localhost" || /^127\./.test(host);
}

/**
 * Part 1's dispatch failure, as one of §4's six kinds.
 *
 * THE TWO VOCABULARIES ARE NOT THE SAME SHAPE and mapping between them is the whole of this
 * function. `DispatchFailure` describes what happened to an HTTP REQUEST; `WorkFailureKind`
 * describes what an operator has to do about a JOB — which is why `refused` splits by status and
 * `no_deployment` does not appear at all (it is refused before a row exists).
 *
 * A 5xx FROM THE CONTAINER IS `agent_error`, NOT `rejected`, and that distinction is the one worth
 * being careful about: `rejected` is worded as JAROKU's bug — "Jaroku sent something the agent
 * refused" — so filing a crash inside somebody's own agent under it would tell them to report a
 * bug against the wrong product. 4xx is ours, 5xx is theirs, and the trace has the failing step.
 */
export function failureKindFor(reason: DispatchFailure, status?: number): WorkFailureKind {
  switch (reason) {
    case "busy":
      return "busy";
    case "unauthorised":
    // Part 1's word for a deployment made before Jaroku kept a serve token. Step 3 catches that
    // first in every ordinary case, so this arrives only when the endpoint lost its credential
    // between the read and the call — and it is the same fact and the same button either way.
    case "no_credential":
      return "unauthorised";
    case "unreachable":
      return "unreachable";
    // A resume that has no checkpoint to continue from. It is not reachable from a first dispatch
    // — nothing has been paused yet — and it is the agent's own state that is gone, so it is filed
    // with the agent's own failures rather than as something Jaroku sent wrongly.
    case "no_checkpoint":
      return "agent_error";
    case "no_deployment":
      // Reachable only if the deployment was removed between step 1 and step 4, which is a race
      // rather than a state: the row said live a moment ago. `unreachable` is the honest reading —
      // there is nothing at the address any more.
      return "unreachable";
    case "refused":
      return status !== undefined && status >= 400 && status < 500 ? "rejected" : "agent_error";
  }
}
