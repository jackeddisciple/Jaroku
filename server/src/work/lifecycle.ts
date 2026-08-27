// From the 202 onwards, THE TRACE DRIVES THE STATE — §6.5, and this is the whole of it.
//
// WHY THERE IS A FILE FOR THIS AT ALL. The dispatcher's job ends the moment the container says
// yes; everything after that arrives on the same ingest chain a local run's events arrive on,
// because Part 1's whole point is that a deployed run IS an ordinary traced run. So the Cockpit
// does not watch anything, poll anything or hold a socket open: it reads the events index.ts is
// already handling and moves one row. This class is what index.ts calls at those four points, and
// keeping it here rather than inline is what stops the Cockpit's rules becoming four more
// branches in an eleven-thousand-line file.
//
// THE FOUR TRANSITIONS, and each one is a fact somebody else established:
//
//   run_end          → the job is over. `completed` is `succeeded`; `error` is `failed`, unless
//                      the runner said it stopped at a boundary, in which case it is `cancelled`.
//   tool_confirm     → a person has to answer something. `running` → `waiting`.
//   confirm resolved → they answered, or it timed out and denied. `waiting` → `running`.
//   stopped reporting→ Part 1's reconciliation gave up, and its synthesised run_end arrives on
//                      the same chain a real one does — recognised by the constant it carries.
//
// EVERY ONE OF THEM IS GUARDED BY THE STORE rather than by a check here, which is why they can be
// called from an at-least-once ingest chain without any bookkeeping. `finish` only moves an item
// that has not ended, `markWaiting` only one that is running, `markResumed` only one that is
// waiting. A redelivered batch replays them and every replay is a no-op that returns false.
//
// A CANCELLATION IS OBSERVED, NOT INFERRED. The frozen schema has three run statuses and a
// cancelled run is stored as `error` with a sentence against it — so the only two ways to tell a
// cancellation from a crash are to match on that sentence, which is another component's prose, or
// to watch for the `ctrl: "cancelled"` line the runner emits at the boundary before it ends. This
// watches for the line. `debug.py` emits it precisely so the boundary is visible, and a string
// match would break silently the first time somebody rewords a log message.

import { STOPPED_REPORTING } from "../deployReconcile.ts";
import { extractAgentOutput } from "../judge/output.ts";
import type { Run, Step } from "../types.ts";
import type { TenantContext } from "../db/tenant.ts";
import type { WorkItem, WorkStore } from "./workStore.ts";

export interface WorkLifecycleDeps {
  work: WorkStore;
  /** The run's steps, for the one thing a run row does not carry: what the agent actually said. */
  steps: (ctx: TenantContext, runId: string) => Promise<Step[]>;
}

export class WorkLifecycle {
  /**
   * Runs the runner told us it stopped at a node boundary.
   *
   * IN MEMORY, AND THAT IS ACCEPTABLE rather than merely convenient. The `ctrl: "cancelled"` line
   * and the `run_end` that follows it are two pushes seconds apart down one connection; a restart
   * between them loses this set AND the run_end, because the bus entry the second push needs is
   * gone with the process. The item is then closed by the reconciliation sweep as
   * `stopped_reporting`, which is the honest answer for a job whose ending nobody witnessed —
   * strictly better than a durable flag that would let it claim `cancelled` on evidence the
   * server never actually received.
   *
   * Bounded by `close`: the entry is dropped the moment the run ends, so a long-lived process
   * accumulates one entry per run currently between its boundary and its ending.
   */
  private cancelledAtBoundary = new Set<string>();

  constructor(private readonly deps: WorkLifecycleDeps) {}

  /** The runner reached a node boundary and stopped because somebody asked it to. */
  noteCancelledAtBoundary(runId: string): void {
    this.cancelledAtBoundary.add(runId);
  }

  /**
   * A run ended. Close the item it belongs to, if it belongs to one.
   *
   * RETURNS THE ITEM IT MOVED, OR UNDEFINED, and undefined is the ordinary case rather than an
   * error: every local run, every eval job and every build in the product ends through this same
   * handler, and none of them is a work item. The read is by run id and it is scoped, so a run
   * that is not this workspace's does not resolve either.
   */
  async onRunEnd(ctx: TenantContext, run: Run): Promise<WorkItem | undefined> {
    const item = await this.deps.work.byRun(ctx, run.id);
    if (!item) return undefined;
    const cancelled = this.cancelledAtBoundary.delete(run.id);

    if (run.status === "completed") {
      // WHAT CAME BACK, through the same extraction the judge scores. Reusing it is what makes
      // "the answer" one thing in this product rather than two: a work item whose output was
      // pulled out of the last step by its own rule would show something different from what an
      // eval of the same agent was graded on, and neither would be wrong exactly.
      const { text } = extractAgentOutput(await this.deps.steps(ctx, run.id));
      await this.deps.work.finish(ctx, item.id, {
        status: "succeeded",
        output: text,
        at: run.ended_at ?? undefined,
      });
      return this.deps.work.get(ctx, item.id);
    }

    if (cancelled) {
      // NO FAILURE KIND ON A CANCELLATION. The six kinds all answer "what went wrong"; nothing
      // went wrong here — somebody pressed stop, and the run ended where they can see it ended.
      // The error text the runner wrote is kept anyway, because "stopped at a node boundary" is
      // the sentence that explains why the last node ran to completion.
      await this.deps.work.finish(ctx, item.id, {
        status: "cancelled",
        error: run.error,
        at: run.ended_at ?? undefined,
      });
      return this.deps.work.get(ctx, item.id);
    }

    // AN ERRORED RUN IS `agent_error` AND NOT `rejected`. §4's table is explicit that `rejected`
    // is Jaroku's bug and is worded that way; a graph that raised is the agent's own, and the
    // trace has the failing step — which is what the detail panel links to.
    //
    // UNLESS THE ENDING WAS SYNTHESISED. Part 1's reconciliation pushes its run_end ONTO THE BUS
    // rather than into the table, deliberately, so that everything a real ending triggers happens
    // for this one — which means it arrives here looking exactly like a crash. Recognising it by
    // the exported constant rather than by matching prose is what makes that exact: `error` is a
    // free-form column and the sentence is the only thing that distinguishes the two, so the
    // comparison has to be against the identity the reconciler actually writes.
    //
    // The distinction is worth this much care because the two say opposite things to an operator.
    // A crash means the agent ran and failed and the trace says where. This means nobody knows: it
    // MAY have completed, and it MAY have spent money.
    const failureKind = run.error === STOPPED_REPORTING ? "stopped_reporting" : "agent_error";
    await this.deps.work.finish(ctx, item.id, {
      status: "failed",
      error: run.error,
      failureKind,
      at: run.ended_at ?? undefined,
    });
    return this.deps.work.get(ctx, item.id);
  }

  /**
   * A high-impact tool is waiting on a person. `running` → `waiting`.
   *
   * THIS IS THE STATE THE WHOLE STATUS SET EXISTS FOR. §4: "`waiting` means a person has to answer
   * something. It exists because Part 1 made it reachable; if it were not reachable, it would not
   * be here." It is also the only thing the sidebar badge counts, because it is the only state
   * where a human is the blocker.
   *
   * IT IS NOT CALLED FOR A CALL THE SHIELD AUTO-APPROVES. index.ts decides that first — a
   * read-only tool under Fast is approved without interrupting anybody — and a job that flickered
   * through `waiting` for the eighty milliseconds that took would put a badge on the sidebar for
   * a question nobody was ever asked.
   */
  async onConfirmRequested(ctx: TenantContext, runId: string): Promise<WorkItem | undefined> {
    const item = await this.deps.work.byRun(ctx, runId);
    if (!item) return undefined;
    return (await this.deps.work.markWaiting(ctx, item.id))
      ? this.deps.work.get(ctx, item.id)
      : undefined;
  }

  /**
   * The question was answered. `waiting` → `running`.
   *
   * WHATEVER THE VERDICT WAS, AND WHETHER OR NOT A PERSON GAVE IT. Allow, deny and the timeout
   * that denies all put the graph back in motion — a denied tool call is an answer, the agent
   * continues with the refusal, and the run is executing again. What ends the job is `run_end`.
   *
   * Returning undefined when nothing moved is what makes this safe to call from every path that
   * closes a confirmation: the resolve, the expiry sweep and the runner's own
   * `tool_confirm_closed` all arrive for the same nonce, and only one of them finds a waiting row.
   */
  async onConfirmResolved(ctx: TenantContext, runId: string): Promise<WorkItem | undefined> {
    const item = await this.deps.work.byRun(ctx, runId);
    if (!item) return undefined;
    return (await this.deps.work.markResumed(ctx, item.id))
      ? this.deps.work.get(ctx, item.id)
      : undefined;
  }
}
