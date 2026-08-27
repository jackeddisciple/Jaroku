// The two things an operator does to a job that already exists: stop it, and ask again.
//
// NEITHER IS A NEW MECHANISM. Cancel is Part 1's control action, which asks the container to stop
// and lets the run emit its own `run_end`; retry is the dispatcher, called a second time. What is
// here is the part that is genuinely about the Cockpit — which items each verb may act on, and
// what "again" means for a job whose agent has been redeployed since.
//
// CANCEL DOES NOT END THE JOB, AND THAT IS THE WHOLE DESIGN OF IT. Part 1 is explicit: a cancel is
// a REQUEST, not an outcome — the run stops at its next node boundary, finishes the node it was in,
// emits `ctrl: "cancelled"` and then a `run_end`, and THAT is what closes the item. Writing
// `cancelled` here the moment the button is pressed would be a control that claims something it
// cannot deliver: the graph is still executing, still spending, and the row would already say it
// had stopped. The one honest thing to report immediately is that the request was accepted.
//
// A RETRY IS A NEW ROW, NEVER A REWRITTEN ONE, and §12 is what makes that non-negotiable rather
// than tidy: "work_items.id must be stable and citable, because Part 3's answers cite it and the
// citation is clickable". A retry that rewrote the row would move a job somebody had already been
// told about, and the failure it is a retry OF would stop existing — which is the record an
// operator needs most when the second attempt fails the same way.
//
// AND IT RETRIES ONTO WHAT IS LIVE NOW, not onto the deployment the original ran on. Somebody
// retrying a job has almost always just fixed something — reconnected a token, redeployed a fix —
// and re-running against the deployment that failed would be a control that reproduces the failure
// on purpose. The old row keeps naming the old deployment, because that is the history of what
// actually ran.

import type { DeployDispatcher } from "../deployDispatch.ts";
import type { TenantContext } from "../db/tenant.ts";
import type { WorkDispatcher, WorkDispatchOutcome } from "./dispatcher.ts";
import { WORK_IN_FLIGHT, type WorkItem, type WorkStore } from "./workStore.ts";

export interface WorkActionsDeps {
  work: WorkStore;
  dispatcher: WorkDispatcher;
  /** Part 1's client, for the one call this file makes that is not a dispatch. */
  dispatch: DeployDispatcher;
}

export type CancelOutcome =
  /** The container took the request. The job stops at its next node boundary. */
  | { ok: true; kind: "requested"; item: WorkItem; detail: string }
  /** Nothing was executing, so the item was closed here rather than asked about. */
  | { ok: true; kind: "closed"; item: WorkItem; detail: string }
  | { ok: false; detail: string };

export type RetryOutcome =
  | { ok: true; item: WorkItem; detail: string }
  | { ok: false; detail: string };

export class WorkActions {
  constructor(private readonly deps: WorkActionsDeps) {}

  /**
   * Ask the container to stop a job at its next node boundary.
   *
   * THREE CASES, AND THE MIDDLE ONE IS THE INTERESTING ONE:
   *
   *   A JOB THAT HAS ENDED is refused. There is nothing to stop, and the refusal names the state
   *   it is in — a control that silently did nothing to a finished job would leave somebody
   *   pressing it.
   *
   *   A `queued` JOB IS CLOSED HERE, without asking anybody. It has no run in a container: either
   *   the dispatch has not left yet or it never landed, and there is nothing at the other end to
   *   receive a request. This is the one path that writes `cancelled` directly, and it is honest
   *   because nothing was executing.
   *
   *   A `running` OR `waiting` JOB IS ASKED, and the answer is that the request was accepted —
   *   never that the job stopped. See the header.
   *
   * A `waiting` JOB IS ASKED ALL THE SAME, and what it costs is worth stating: the container is
   * parked inside a node on the confirmation gate, and a cancel is read BETWEEN nodes — so nothing
   * happens until somebody answers the confirmation or it times out and denies. Refusing the
   * cancel instead would be worse: the operator would have to answer a question about a job they
   * have already decided to stop, in order to be allowed to stop it.
   */
  async cancel(ctx: TenantContext, itemId: string): Promise<CancelOutcome> {
    const item = await this.deps.work.get(ctx, itemId);
    if (!item) return { ok: false, detail: "no such job in this workspace" };
    if (!WORK_IN_FLIGHT.has(item.status)) {
      return { ok: false, detail: `this job has already ${item.status === "succeeded" ? "finished" : item.status}` };
    }

    if (item.status === "queued" || !item.run_id) {
      await this.deps.work.finish(ctx, item.id, {
        status: "cancelled",
        error: "cancelled before it reached the agent",
      });
      return {
        ok: true,
        kind: "closed",
        item: (await this.deps.work.get(ctx, item.id)) ?? item,
        detail: "the job was cancelled before it reached the agent",
      };
    }

    // THE WORKSPACE TRAVELS WITH THE REQUEST, because reading the deployment's endpoint is a SCOPED
    // read and the only honest source of the scope is the context that is cancelling.
    const asked = await this.deps.dispatch.cancel(item.deployment_id, item.run_id, ctx.workspaceId);
    if (!asked.ok) {
      // THE JOB IS LEFT ALONE. Jaroku could not reach the container, which says nothing about
      // whether the job is still running — and closing the row on a failed request would claim a
      // stop that did not happen. The reconciliation sweep is what settles a container nobody can
      // reach any more, and it settles it as `stopped_reporting`, which is the honest word.
      return { ok: false, detail: `could not ask the agent to stop: ${asked.detail}` };
    }

    return {
      ok: true,
      kind: "requested",
      item,
      detail:
        item.status === "waiting"
          ? "the agent has been asked to stop — it will do so once the confirmation in front of it is answered"
          : "the agent has been asked to stop at its next node boundary",
    };
  }

  /**
   * Ask the same thing again, as a new job.
   *
   * ONLY A FINISHED JOB MAY BE RETRIED, and that is the guard rather than a nicety: retrying one
   * that is still running would put two containers on the same work, both spending, with no way to
   * tell afterwards which of the two answers was which.
   *
   * THE INPUT IS COPIED FROM THE ROW rather than re-supplied by the client, which is what makes
   * this a retry rather than a second dispatch that happens to be similar. It also means the input
   * cap cannot be walked around by retrying: the stored value has already been through it.
   *
   * THE ACTOR IS WHOEVER PRESSED RETRY, not whoever dispatched the original. `create` takes it from
   * the context and there is no parameter for it — see `WorkStore.create`. That is correct: the
   * new job is a decision this person made, and "who gave this agent a job" has to name them.
   */
  async retry(ctx: TenantContext, itemId: string): Promise<RetryOutcome> {
    const item = await this.deps.work.get(ctx, itemId);
    if (!item) return { ok: false, detail: "no such job in this workspace" };
    if (WORK_IN_FLIGHT.has(item.status)) {
      return { ok: false, detail: "this job is still running — cancel it before asking again" };
    }

    const out: WorkDispatchOutcome = await this.deps.dispatcher.dispatch(ctx, {
      agentId: item.agent_id,
      input: item.input,
    });
    if (out.ok) return { ok: true, item: out.item, detail: "asked again" };
    // THE ORIGINAL IS UNTOUCHED EITHER WAY. A retry that failed is a fact about the retry; the row
    // it came from still records what happened the first time, and rewriting it would lose the
    // history somebody is retrying BECAUSE of.
    return { ok: false, detail: out.detail };
  }
}
