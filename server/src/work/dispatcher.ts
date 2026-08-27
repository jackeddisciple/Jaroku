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
  /**
   * An agent's SLUG, from its uuid, or null for one this workspace does not have.
   *
   * THE SEAM BETWEEN TWO SPELLINGS OF "WHICH AGENT". `work_items.agent_id` is a uuid because it is
   * a real foreign key; `deployments.agent_id` is a slug because that column predates agent uuids
   * and `DeployManager` still writes one. See `liveDeployment` for what conflating them costs.
   *
   * A FUNCTION RATHER THAN THE REPOSITORY, so this module keeps importing no repository — the same
   * posture every other dependency here takes.
   */
  agentSlug: (ctx: TenantContext, agentUuid: string) => Promise<string | null>;
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
  /**
   * The clock and the wait, injected together so the retry budget can be exercised in a
   * millisecond rather than in forty-five seconds.
   *
   * BOTH OR NEITHER, and a suite that replaces one must replace the other: the budget is measured
   * against `now` and consumed by `sleep`, so a fake sleep with a real clock spends no time and
   * retries forever, and a real sleep with a fake clock waits for a budget that never runs out.
   */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
   * `deployments.agent_id` IS THE AGENT'S SLUG, NOT ITS UUID, and that is the whole reason this
   * method resolves one before it looks anything up. The column is `text` from migration 002,
   * which predates agent uuids entirely; `DeployManager` writes `req.agentId` into it and proves
   * what that is one line earlier by calling `agents.bySlug(ctx, req.agentId)`. Everything else
   * that reads deployments per agent — the Agents grid, `currentByAgent` — is keyed by slug too.
   *
   * `work_items.agent_id` IS THE UUID, because it is a real foreign key to `agents(id)` and §4
   * wanted one. So the Cockpit is the first thing in this codebase that holds both spellings at
   * once, and this is the seam. Passing the uuid straight to `listForAgent` compares a uuid
   * against a slug, matches nothing, and refuses every dispatch with "this agent is not live" —
   * which looks exactly like a deployment problem and is not one.
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
  async liveDeployment(ctx: TenantContext, agentUuid: string): Promise<Deployment | null> {
    const slug = await this.deps.agentSlug(ctx, agentUuid);
    if (!slug) return null;
    const rows = await this.deps.deployments.listForAgent(ctx, slug);
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
    const { outcome: started } = await this.send(ctx, item.id, {
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

  /**
   * `POST /run`, with §6's bounded, DISCRIMINATING retry in front of it.
   *
   * DISCRIMINATING IS THE WHOLE OF IT. A 401 or a 400 fails identically every time — the token is
   * wrong, or Jaroku sent something the agent refuses — so a retry there multiplies nothing but
   * the bill and the time before somebody is told what to fix. Only two answers are worth trying
   * again, and both are about the moment rather than the request: a 429, which says "not now", and
   * a connection transient, which says nothing at all. `RETRYABLE` is that list and it is
   * deliberately short.
   *
   * BOUNDED BY BOTH AN ATTEMPT COUNT AND A WALL-CLOCK BUDGET, because either alone has a hole. An
   * attempt count with no budget honours a `Retry-After: 3600` twice and holds a dispatch open for
   * two hours; a budget with no count spins against a container refusing instantly. The two
   * together mean a dispatch either succeeds, or fails with the container's own last word, inside
   * a bounded time — which is what makes it safe to do this inline rather than in a queue.
   *
   * THE CONTAINER'S OWN `Retry-After` WINS OVER THE BACKOFF when it sent one, clamped to what is
   * left of the budget. Ignoring it is how a control plane turns one overloaded container into a
   * retry storm, and `serve.py` is the thing that actually knows how long its own slots are held.
   */
  private async send(
    ctx: TenantContext,
    itemId: string,
    input: {
      deploymentId: string;
      workspaceId: string;
      agentId: string;
      runId: string;
      input: string;
      provider?: string;
      model?: string;
      controlPlaneUrl: string;
    },
  ): Promise<{ outcome: Awaited<ReturnType<DeployDispatcher["start"]>>; runId: string }> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = (): number => this.deps.now?.() ?? Date.now();
    const deadline = now() + RETRY_BUDGET_MS;

    let runId = input.runId;
    let outcome = await this.deps.dispatch.start(input);

    for (let attempt = 1; attempt < MAX_DISPATCH_ATTEMPTS; attempt++) {
      if (outcome.ok || !RETRYABLE.has(outcome.reason)) break;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const asked = outcome.retryAfterMs ?? RETRY_BASE_MS * 2 ** (attempt - 1);
      // A WAIT LONGER THAN WHAT IS LEFT IS NOT TRUNCATED, it ends the attempt. The container asked
      // for a specific amount of time; coming back early is the thing `Retry-After` exists to stop,
      // and waiting the remainder and then giving up spends the budget to learn nothing.
      if (asked > remaining) break;
      await sleep(asked);

      // A FRESH RUN ID PER ATTEMPT, AND THIS IS NOT COSMETIC. `DeployDispatcher` closes the run on
      // every answer that is not a 202, and `DeployRuns.close` REVOKES the token — and the
      // revocation list is keyed by RUN ID rather than by the token's own value. So a retry that
      // reused the id would get its 202, mark the item running, and then have every push the
      // container made refused for the life of the run: a job that reads as executing and produces
      // no trace, no cost and no ending. The failure would be silent and would only ever appear
      // under load, which is the only condition a 429 arrives in.
      //
      // The row is repointed before the request goes out, so a crash between the two leaves the
      // item naming the run that is about to exist rather than the one that is already dead.
      runId = randomUUID();
      await this.deps.work.attachRun(ctx, itemId, runId);
      outcome = await this.deps.dispatch.start({ ...input, runId });
    }
    return { outcome, runId };
  }
}

/**
 * The two answers worth sending the same request again for.
 *
 * `busy` IS A 429 AND `unreachable` IS A CONNECTION THAT DID NOT COMPLETE — a refused socket, a
 * reset, a container still waking a cold interpreter past the acceptance timeout. Neither says
 * anything about the request; both say something about the moment.
 *
 * EVERY OTHER KIND IS DELIBERATELY ABSENT and each absence is a decision. `unauthorised` and
 * `no_credential` fail identically until somebody reconnects. `refused` is Jaroku's own bug on a
 * 4xx and the agent's own crash on a 5xx, and neither is fixed by asking twice — a crashing graph
 * asked twice is a graph that crashes twice, on somebody's provider key. `no_checkpoint` is state
 * that is gone. `no_deployment` means there is nothing at the address any more.
 */
const RETRYABLE: ReadonlySet<DispatchFailure> = new Set<DispatchFailure>(["busy", "unreachable"]);

/** Including the first. Three is one real try and two second chances. */
export const MAX_DISPATCH_ATTEMPTS = 3;
/** The first backoff, doubling. Short, because a job somebody just pressed is being waited on. */
export const RETRY_BASE_MS = 1_000;
/**
 * The wall-clock ceiling on all of it.
 *
 * Forty-five seconds, which is a little more than the thirty a single acceptance is allowed —
 * because a dispatch that has already burnt one full acceptance timeout has told us what we needed
 * to know, and the operator pressing the button is still watching. Longer belongs to a queue,
 * which is what Part 3's scheduler is for.
 */
export const RETRY_BUDGET_MS = 45_000;

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
