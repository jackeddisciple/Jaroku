// The run that stopped saying anything.
//
// A local run ends because a process exits and something is holding the other end of its pipe.
// A hosted sandbox run ends because the machine reports back. A DEPLOYED run has neither: it
// lives in a container in somebody else's Railway account, and the only evidence it exists is
// what it pushes. So the one failure this path has that the others do not is silence — the
// container died, the network partitioned, the OOM killer took it, Railway restarted the service
// underneath it — and silence looks exactly like a long tool call until somebody decides how long
// is too long.
//
// WITHOUT THIS THE ROW READS "running" FOREVER. It sits in the Activity feed as a live run, it
// keeps its token valid for two hours, and the workspace's health numbers count it as in flight.
// §7 is explicit that Jaroku must not leave one of those, and equally explicit about what it may
// say instead: "a reason that says exactly what is known and what is not — the container stopped
// reporting; it may have completed, and it may have spent money. Never a silent success, never a
// confident failure."
//
// IT IS NOT THE RESTART SWEEP, and the two are complements rather than duplicates.
// `reconcileInterruptedRuns` runs at boot and closes every row still marked running, which
// already covers a deployed run this process was watching when it died. This one covers the
// opposite case: the SERVER is fine and the CONTAINER is gone, which a restart sweep never sees
// because there is no restart.
//
// AND IT SYNTHESISES THE run_end THE CONTAINER SHOULD HAVE SENT, rather than writing to `runs`
// directly. §7's rule about the ingest — "use it, do not fork it" — applies to this write as much
// as to a real one: pushed onto the bus, it goes down the same chain a genuine run_end does, so
// the relay broadcasts it, the thread list refreshes, and the Inbox raises a failed-run card,
// none of which a direct UPDATE would do.

import type { DeployRuns, DeployRunEntry } from "./deployRuns.ts";
import type { RunEventBus } from "./sandbox/eventBus.ts";
import type { TraceStore } from "./store.ts";
import type { TenantContext } from "./db/tenant.ts";
import { SCHEMA_VERSION } from "./types.ts";

/**
 * How long a deployed run may say nothing before Jaroku stops believing it is alive.
 *
 * FIFTEEN MINUTES, AND THE NUMBER IS PICKED FROM THE LONGEST LEGITIMATE SILENCE RATHER THAN FROM
 * TASTE. A run in flight is quiet for as long as its current node takes, and the ceiling has to
 * clear every one of those:
 *
 *   * An MCP confirmation blocks on a HUMAN, and `controlPlaneRoutes.MAX_MCP_CONFIRM_TIMEOUT_MS`
 *     lets that hold for ten minutes. Nothing is pushed while it waits. This is the long one,
 *     and it alone rules out anything under ten.
 *   * A tool call is bounded at sixty seconds (`mcp_bridge.CALL_TIMEOUT_S`).
 *   * A model call with a large thinking budget is minutes, not tens of minutes.
 *
 * So ten is the floor and fifteen is that plus room for a slow node on either side of it. Erring
 * long is the right direction: closing a live run out is a confident failure about a run that is
 * still working, which is the one outcome §7 names twice.
 *
 * A PAUSED RUN IS EXCLUDED ENTIRELY rather than given a longer ceiling — it is silent by design,
 * for as long as a person takes to come back to it, and no number is long enough for that.
 */
export const DEPLOY_SILENCE_CEILING_MS = 15 * 60_000;

/** How often to look. Well under the ceiling, so a run is closed out near the ceiling rather
 *  than up to a full sweep interval after it. */
export const DEPLOY_SWEEP_INTERVAL_MS = 60_000;

/**
 * What Jaroku knows about a run it has stopped hearing from, and what it does not.
 *
 * WRITTEN OUT IN FULL RATHER THAN SUMMARISED, because every shorter version of this sentence is
 * a claim nothing supports. "The run failed" is a confident failure — the agent may have finished
 * its work a millisecond before the container went. "The run was cancelled" is worse, since
 * nobody cancelled it. And the money is the half people most need told: the steps already on this
 * trace really happened, and cost is summed from those, so the figure beside this run is real
 * even though the run's own row never got an ending.
 */
export const STOPPED_REPORTING =
  "the container stopped reporting; it may have completed, and it may have spent money. " +
  "Whatever steps are on this trace really happened — their cost is real — but nothing is known " +
  "about what came after them.";

export interface DeployReconcileDeps {
  runs: DeployRuns;
  bus: RunEventBus;
  store: TraceStore;
  /** The workspace a run belongs to, as a context this sweep may act in. Injected rather than
   *  built here, so this module does not grow a dependency on how contexts are made. */
  contextFor: (workspaceId: string) => TenantContext;
  ceilingMs?: number;
  now?: () => number;
}

export interface ReconciledRun {
  runId: string;
  workspaceId: string;
  deploymentId: string;
  /** How long the run had been silent when it was closed out. Logged, so a ceiling that is too
   *  short shows up as a cluster of runs closed at exactly the ceiling. */
  silentForMs: number;
  /** False when the row had already ended under its own power between the stale check and the
   *  write — nothing was synthesised, the entry was simply released. */
  closedOut: boolean;
}

export class DeployReconciler {
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: DeployReconcileDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private get ceiling(): number {
    return this.deps.ceilingMs ?? DEPLOY_SILENCE_CEILING_MS;
  }

  /** One pass. Returns what it closed, so a caller can log it and Part 2 can show it. */
  async sweep(): Promise<ReconciledRun[]> {
    const out: ReconciledRun[] = [];
    for (const entry of this.deps.runs.stale(this.ceiling)) {
      const result = await this.reconcile(entry);
      if (result) out.push(result);
    }
    return out;
  }

  private async reconcile(entry: DeployRunEntry): Promise<ReconciledRun | null> {
    const ctx = this.deps.contextFor(entry.workspaceId);
    const silentForMs = this.now() - entry.lastHeardAtMs;
    let run;
    try {
      run = await this.deps.store.getRun(ctx, entry.runId);
    } catch (err) {
      // A read that failed says nothing about the run, and closing it out on that basis would be
      // exactly the confident failure this module refuses. Leave it; the next sweep asks again.
      console.error(`[deploy] could not read run ${entry.runId} to reconcile it:`, (err as Error).message);
      return null;
    }

    // THE THREE CASES WHERE THERE IS NOTHING TO CLOSE, and each is a release rather than a write:
    //
    //   No row at all — a dispatch the container never acknowledged and never started. There is
    //   nothing to mark errored, and inventing a run row from a sweep would put a run in somebody's
    //   history that never existed.
    //
    //   Already ended — it finished between the stale check and this read, or its `run_closed`
    //   was lost while its `run_end` arrived. The trace is complete; only the entry is stale.
    //
    //   Paused — silent by design, for as long as a person takes. Closing one out would end a run
    //   somebody is about to resume, which is a worse outcome than leaving it open. It is skipped
    //   here rather than filtered in `stale()` because "is it paused" is a question about the
    //   STORE, and `stale()` is arithmetic over what this process has heard.
    const status = (run?.status as string | undefined) ?? null;
    if (status === "paused") return null;
    if (!run || status !== "running") {
      this.deps.runs.close(entry.runId, "abandoned");
      return {
        runId: entry.runId,
        workspaceId: entry.workspaceId,
        deploymentId: entry.deploymentId,
        silentForMs,
        closedOut: false,
      };
    }

    // ONTO THE BUS, NOT INTO THE TABLE. Everything a real run_end triggers has to happen for this
    // one: the row is written, the relay broadcasts it, the thread list refreshes, the Inbox
    // raises the failed-run card somebody will actually see. A direct UPDATE would produce a
    // correct row and a silent one, which is a different flavour of the same problem.
    this.deps.bus.pushTrace(entry.runId, {
      kind: "run_end",
      schema_version: SCHEMA_VERSION,
      run: {
        ...run,
        status: "error",
        ended_at: new Date(this.now()).toISOString(),
        // THE RUN'S OWN COST COLUMN IS LEFT AS THE ZERO run_start WROTE, deliberately, and the
        // error above says why in words: cost is summed from `steps` and never read from here,
        // precisely because a run that ends like this never reported one. Writing a number here
        // would be inventing a total for a run whose end nobody witnessed.
        error: STOPPED_REPORTING,
      },
    });
    this.deps.runs.close(entry.runId, "abandoned");
    return {
      runId: entry.runId,
      workspaceId: entry.workspaceId,
      deploymentId: entry.deploymentId,
      silentForMs,
      closedOut: true,
    };
  }

  /** Sweep on a timer. Unref'd: closing rows out must never hold a process open. */
  start(intervalMs = DEPLOY_SWEEP_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().then((closed) => {
        for (const c of closed) {
          if (c.closedOut) {
            console.warn(
              `[deploy] run ${c.runId} stopped reporting ${Math.round(c.silentForMs / 1000)}s ago — closed out as errored`,
            );
          }
        }
      }).catch((err) => console.error("[deploy] reconciliation sweep failed:", (err as Error).message));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
