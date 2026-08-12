// Keeping a plan's promise about how long data lives, and then actually taking it away.
//
// A TRACE IS REGULATED DATA. It contains the body of somebody's email, rows out of somebody's
// database, and what was said in somebody's Slack channel — because that is what the agent read,
// and recording exactly what the agent read is the product. `billing/plans.ts` has carried a
// `retentionDays` per plan since Session 6, with a note saying Session 8 would enforce it. This
// is that, and until this commit the number was a promise nothing kept.
//
// FOUR THINGS EXPIRE, and they are in different places for different reasons:
//
//   STEPS, then RUNS. Steps first because they are the bulk — hundreds per run, four JSON
//   payloads each — and because a run row with no steps is a harmless stub while a step with no
//   run is an orphan nothing can render. Order matters here in a way it rarely does.
//
//   CHECKPOINTS, which are the pause/resume machinery and are not the trace. They are swept
//   through the same CheckpointStore interface `evalCleanup.ts` uses, which is what keeps
//   "an interactive run's checkpoint is never swept by the eval sweeper" and "every checkpoint
//   expires eventually" from being two rules fighting over one directory.
//
//   STAGED OBJECTS, which are not retention at all and are here because this is the sweeper.
//   A staging copy belongs to a generation or an edit proposal that is in flight; one that is a
//   day old belongs to a process that died. Its lifetime is hours, on every plan, and making it
//   a plan promise would mean a free workspace's dead staging outliving a Scale workspace's.
//
//   EXPORTS, which are a convenience copy of data the trace already holds. They expire on the
//   plan's own clock: an export is a snapshot of exactly the regulated content above, and a CSV
//   that outlives the trace it was made from would be the retention promise defeated by a
//   download button.
//
// THE PARTITION DROP IS AN OPTIMISATION OVER THE DELETE, NOT A REPLACEMENT FOR IT, and the
// reason is worth stating because it is the one thing about this design that surprises people: a
// partition is a MONTH, and a month contains every workspace's steps. It can only be dropped
// once it is past the LONGEST retention any live workspace has — 365 days on Scale — so a free
// workspace's fourteen-day promise is kept by a scoped DELETE inside a partition that will not
// be droppable for a year. The drop is what stops the table growing forever; the delete is what
// keeps the promise.
//
// EVERYTHING IS PER WORKSPACE, one at a time, and never one unscoped statement. Under RLS as the
// application role an unscoped DELETE matches nothing at all — the same trap the eval and hold
// reconciliations documented at length — so a "platform-wide sweep" would silently do nothing in
// the one deployment that needs it. The partition drop is the single exception, and it is
// deliberately not workspace-scoped because a month is not a workspace's to drop.

import type { Db } from "../db/db.ts";
import type { AnyContext, SystemContext, TenantContext } from "../db/tenant.ts";
import { newRequestId, systemContext, systemContextFor } from "../db/tenant.ts";
import { limitsFor } from "../billing/plans.ts";
import type { CheckpointStore } from "../checkpoints/store.ts";
import type { ObjectStore } from "../storage/objectStore.ts";
import { workspacePrefix } from "../storage/keys.ts";
import { describePartitions, droppableMonths, dropPartition } from "./partitions.ts";

/** How long a staging copy is allowed to be abandoned before it is somebody's dead process. */
export const STAGING_MAX_AGE_MS = 24 * 3_600_000;

export interface RetentionDeps {
  db: Db;
  /** Every live workspace, and what plan each is on. */
  workspaces: (ctx: SystemContext) => Promise<{ id: string; plan: string }[]>;
  /** A workspace's negotiated exceptions, which may include a longer retention. */
  overridesFor: (ctx: TenantContext) => Promise<Record<string, unknown>>;
  checkpoints: CheckpointStore;
  objects: ObjectStore;
  log?: (line: string) => void;
  now?: () => number;
}

export interface WorkspaceSweep {
  workspaceId: string;
  retentionDays: number;
  runsDeleted: number;
  stepsDeleted: number;
  checkpointsSwept: number;
  exportsDeleted: number;
  stagingDeleted: number;
}

export interface RetentionReport {
  workspaces: WorkspaceSweep[];
  /** Whole months removed from the catalogue. Empty on SQLite, and empty most days. */
  partitionsDropped: string[];
}

export class RetentionSweeper {
  private log: (line: string) => void;
  private now: () => number;

  constructor(private deps: RetentionDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
    this.now = deps.now ?? Date.now;
  }

  /** Sweep every workspace, then drop whatever whole months nobody may still hold. */
  async sweep(): Promise<RetentionReport> {
    const sys = systemContext(newRequestId());
    const workspaces = await this.deps.workspaces(sys);
    const report: RetentionReport = { workspaces: [], partitionsDropped: [] };
    let longestDays = 0;

    for (const ws of workspaces) {
      const ctx = systemContextFor(ws.id, newRequestId());
      const overrides = await this.deps.overridesFor(ctx).catch(() => ({}));
      const limits = limitsFor(ws.plan, overrides);
      longestDays = Math.max(longestDays, limits.retentionDays);
      try {
        report.workspaces.push(await this.sweepWorkspace(ctx, limits.retentionDays));
      } catch (err) {
        // One workspace's failure must not stop the others. A sweeper that gives up on the first
        // error is a sweeper that stops running entirely the week somebody's object store has a
        // bad afternoon, and retention silently stops being enforced for everybody.
        this.log(`[retention] ${ws.id} could not be swept: ${(err as Error)?.message ?? err}`);
      }
    }

    report.partitionsDropped = await this.dropExpiredPartitions(longestDays);
    return report;
  }

  /** One workspace, in the order the header describes: steps, runs, checkpoints, objects. */
  async sweepWorkspace(ctx: TenantContext, retentionDays: number): Promise<WorkspaceSweep> {
    const cutoff = new Date(this.now() - retentionDays * 86_400_000).toISOString();
    const out: WorkspaceSweep = {
      workspaceId: ctx.workspaceId,
      retentionDays,
      runsDeleted: 0,
      stepsDeleted: 0,
      checkpointsSwept: 0,
      exportsDeleted: 0,
      stagingDeleted: 0,
    };

    // WHICH RUNS ARE PAST IT — read before anything is deleted, because they are also the list
    // of checkpoint threads to sweep, and a run row deleted first is a checkpoint nobody can
    // find. An expired run whose checkpoint survived would be a resumable pointer into a trace
    // that no longer exists.
    const expired = await this.deps.db.forWorkspace(ctx.workspaceId).all<{ id: string }>(
      `SELECT id FROM runs WHERE workspace_id = ? AND started_at < ?`,
      [ctx.workspaceId, cutoff],
    );
    if (expired.length === 0) return { ...out, ...(await this.sweepObjects(ctx, cutoff)) };

    const runIds = expired.map((r) => r.id);

    // Steps first. In batches by run rather than one statement with an IN list of ten thousand
    // ids: a parameter list has a limit on both drivers, and a DELETE that fails at scale is a
    // sweeper that works until the first workspace that needed it.
    for (const chunk of batches(runIds, 200)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const res = await this.deps.db.scoped(ctx.workspaceId, async (tx) =>
        tx.run(
          `DELETE FROM steps WHERE workspace_id = ? AND run_id IN (${placeholders})`,
          [ctx.workspaceId, ...chunk],
        ),
      );
      out.stepsDeleted += res.changes;
    }

    // The checkpoints belonging to those runs, before the run rows go.
    const swept = await this.deps.checkpoints.sweepRuns(ctx, runIds).catch(() => ({ removed: 0, bytesFreed: 0, failed: 0 }));
    out.checkpointsSwept = swept.removed;

    for (const chunk of batches(runIds, 200)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const res = await this.deps.db.scoped(ctx.workspaceId, async (tx) =>
        tx.run(`DELETE FROM runs WHERE workspace_id = ? AND id IN (${placeholders})`, [ctx.workspaceId, ...chunk]),
      );
      out.runsDeleted += res.changes;
    }

    const objects = await this.sweepObjects(ctx, cutoff);
    return { ...out, ...objects };
  }

  /**
   * Exports past the plan's clock, and staging past its own.
   *
   * `modifiedAt` from the store rather than a row, because these objects have no row: an export
   * is a file named for an eval, and a staging copy is a directory named for a proposal that
   * lives in memory. The object store's own timestamp is the only thing that knows how old
   * either is, which is also why `list` returns one.
   */
  private async sweepObjects(
    ctx: TenantContext,
    cutoff: string,
  ): Promise<{ exportsDeleted: number; stagingDeleted: number }> {
    let exportsDeleted = 0;
    let stagingDeleted = 0;
    const stagingCutoff = new Date(this.now() - STAGING_MAX_AGE_MS).toISOString();

    for (const object of await this.deps.objects.list(`${workspacePrefix(ctx.workspaceId)}exports/`)) {
      if (object.modifiedAt >= cutoff) continue;
      await this.deps.objects.delete(object.key);
      exportsDeleted++;
    }

    // Staging lives under each agent, so this walks the workspace's whole agent prefix and
    // filters — one list rather than a list per agent, since the store charges per request and a
    // workspace with two hundred agents would otherwise cost two hundred round trips a night.
    for (const object of await this.deps.objects.list(`${workspacePrefix(ctx.workspaceId)}agents/`)) {
      if (!object.key.includes("/staging/")) continue;
      if (object.modifiedAt >= stagingCutoff) continue;
      await this.deps.objects.delete(object.key);
      stagingDeleted++;
    }

    return { exportsDeleted, stagingDeleted };
  }

  /**
   * Drop whole months nobody may still be holding.
   *
   * A DAY OF SLACK past the longest retention, because the two clocks are not the same clock: the
   * per-workspace DELETE above uses this process's, a partition boundary uses UTC midnight, and a
   * drop that raced a workspace's last retained day would take rows that were still promised.
   * The cost of the slack is one extra month of storage; the cost of not having it is data.
   */
  private async dropExpiredPartitions(longestRetentionDays: number): Promise<string[]> {
    if (this.deps.db.dialect !== "postgres" || longestRetentionDays <= 0) return [];
    const cutoff = new Date(this.now() - (longestRetentionDays + 1) * 86_400_000);
    const { months } = await describePartitions(this.deps.db);
    const dropped: string[] = [];
    for (const name of droppableMonths(months, cutoff)) {
      await dropPartition(this.deps.db, name);
      this.log(`[retention] dropped partition ${name} — entirely past the longest retention in force`);
      dropped.push(name);
    }
    return dropped;
  }
}

/** Split a list into chunks a parameter list can carry on both drivers. */
function* batches<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** A one-line summary for the boot log, or null when a sweep did nothing at all. */
export function describeSweep(report: RetentionReport, _ctx?: AnyContext): string | null {
  const runs = report.workspaces.reduce((n, w) => n + w.runsDeleted, 0);
  const steps = report.workspaces.reduce((n, w) => n + w.stepsDeleted, 0);
  const objects = report.workspaces.reduce((n, w) => n + w.exportsDeleted + w.stagingDeleted, 0);
  const checkpoints = report.workspaces.reduce((n, w) => n + w.checkpointsSwept, 0);
  if (!runs && !steps && !objects && !checkpoints && report.partitionsDropped.length === 0) return null;
  return (
    `[retention] ${runs} run(s), ${steps} step(s), ${checkpoints} checkpoint(s), ${objects} object(s)` +
    (report.partitionsDropped.length ? `, ${report.partitionsDropped.length} partition(s)` : "")
  );
}
