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
//   a plan promise would mean a free workspace's dead staging outliving a Team workspace's.
//
//   EXPORTS, which are a convenience copy of data the trace already holds. They expire on the
//   plan's own clock: an export is a snapshot of exactly the regulated content above, and a CSV
//   that outlives the trace it was made from would be the retention promise defeated by a
//   download button.
//
//   THREAD ITEMS THAT POINT AT SWEPT RUNS AND EVALS. Migration 044's join table names a run or an
//   eval by a plain `text` ref with no foreign key — deliberately, because it is one column six
//   kinds share — so nothing cascades when the run goes and the row is left pointing at nothing.
//   Two consequences, and the second is the worse one: `thread_items` becomes the one table in the
//   schema that only ever grows, and it is read IN FULL on every thread snapshot; and §3.3's
//   derivation, which looks a run up and gives up when it is missing, silently drops the thread's
//   `failedSteps` and `lastEndedInError` — so a thread that ended in error becomes `idle` the day
//   its run passes the retention window. Swept in the same batch as the runs that orphan them.
//
//   THREADS THEMSELVES ARE NEVER SWEPT. §3.4 is explicit and `test:thread-archive` audits the
//   whole server for a delete path; a retention sweep of `threads` would be exactly the one it is
//   looking for. A thread holds what was thought and what it cost, and its cost survives anyway —
//   `spendByThread` joins through `usage_events`, which retention does not touch.
//
// THE PARTITION DROP IS AN OPTIMISATION OVER THE DELETE, NOT A REPLACEMENT FOR IT, and the
// reason is worth stating because it is the one thing about this design that surprises people: a
// partition is a MONTH, and a month contains every workspace's steps. It can only be dropped
// once it is past the LONGEST retention any live workspace has — 365 days on Team — so a free
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
  /**
   * Record what a sweep took, in the log that outlives the rows it took.
   *
   * WHY THIS IS NOT OPTIONAL POLISH. A sweep is the one scheduled job in this product that DELETES
   * a user's work, on purpose, with no undo — and the question it provokes months later is always
   * the same: "where did my trace from March go". Without a row, the honest answer is that nobody
   * can tell whether it was swept correctly, swept early, or never existed. `audit_log` is the one
   * table retention itself exempts (see RETENTION_KEPT_TABLES), which is exactly what makes it the
   * right place to write this down.
   *
   * A CALLBACK RATHER THAN THE REPOSITORY, so this file keeps importing no repository and the
   * sweeper stays constructible in a suite that has no identity layer.
   */
  audit?: (ctx: TenantContext, sweep: WorkspaceSweep) => Promise<void> | void;
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
  /** Rows in migration 044's join table left pointing at a run or eval this sweep removed. */
  threadItemsDeleted: number;
  /**
   * RESOLVED inbox items past the plan's window, and their per-user state with them.
   *
   * Resolved only — an open item is a live problem however old it is, and the age bar filling under
   * its card is the whole point of keeping the timestamp. Sweeping one because it had been true for
   * a month would silently remove a blocking problem from the board that exists to show it.
   */
  inboxItemsDeleted: number;
}

export interface RetentionReport {
  workspaces: WorkspaceSweep[];
  /** Whole months removed from the catalogue. Empty on SQLite, and empty most days. */
  partitionsDropped: string[];
}

/**
 * Every workspace-scoped table, and what this sweeper does about it.
 *
 * A LIST THAT EXISTS TO BE AUDITED, exactly as `export.ts`'s does, and for the reason its suite
 * states: forgetting is the failure mode, and a list maintained by remembering is a list that is
 * already wrong. `retention.test.ts` reads the schema and fails on any workspace-scoped table that
 * appears in neither half of this — which is how `thread_items` should have been caught. It was
 * added by migration 044, nothing here touched it, and the result was the one table in the schema
 * that only ever grew, read in full on every thread snapshot, holding rows that pointed at runs
 * this sweeper had already deleted.
 *
 * `swept` names the tables this removes rows from. `kept` names the rest, each with the reason it
 * is not retention's to take — because an unexplained absence is an oversight nobody can tell from
 * a decision.
 */
export const RETENTION_SWEPT_TABLES: readonly string[] = [
  "runs",
  "steps",
  "thread_items",
  // §6.2 of the Inbox specification says the reconciler is what keeps this table from becoming a
  // landfill, and it is only half right: the reconciler stops OPEN items being stale, and nothing
  // it does removes the resolved ones it leaves behind. A workspace that clears fourteen items a
  // week accumulates them forever, and this is the table the zero state's statistic reads.
  "inbox_items",
];

export const RETENTION_KEPT_TABLES: Record<string, string> = {
  workspace_members: "membership is not data that ages out — a member is current or removed",
  workspace_invites: "invitations expire on their own clock, in their own column",
  workspace_secrets: "a credential is current or revoked; an agent still using one does not care how old it is",
  workspace_data_keys: "the per-workspace encryption key. Sweeping it would make every ciphertext unreadable",
  workspace_balances: "money. A balance is a running total, not an event with an age",
  workspace_enforcements: "the abuse ladder's own record, which has to outlive the behaviour it describes",
  abuse_signals: "the evidence an enforcement rests on. Removing it would leave a rung nobody can justify",
  ws_tickets: "single-use socket tickets, which expire in seconds by construction rather than in days",
  secret_refs: "which agent needs which credential. A fact about the agent, not an event",
  secret_usages: "which credential an agent actually reached for, read long after the run that did it",
  secret_rotations: "why a credential changed, which is the question asked long afterwards",
  secret_elevations: "an elevation has an absolute TTL of its own; a swept one would be a grant with no record",
  user_secret_passcodes: "the verifier a person set. Current or replaced, never old",
  secret_scan_findings: "whether somebody pushed over a credential warning — an audit answer, not a trace",
  audit_log: "the record of who did what. Sweeping an audit log is the one thing an audit log must not do",
  agents: "an agent is the product. It leaves when it is deleted, never because it is old",
  agent_ci_config: "a choice somebody made about this agent, with no age",
  datasets: "a dataset is authored, not emitted",
  dataset_examples: "authored beside the dataset, and removed with it rather than on a clock",
  eval_runs: "swept by evalCleanup.ts on the eval's own terms, which knows about its jobs and artifacts",
  eval_jobs: "an eval's parts go with the eval, not with a calendar — evalCleanup.ts again",
  eval_scores: "a judge verdict belongs to its job, and leaves when the job does",
  rubrics: "authored, like the dataset it belongs to",
  usage_events: "the ledger. A bill stays defensible for longer than a trace does, and §4.3's per-thread cost joins through it",
  workspace_usage_periods: "the counter beside that ledger — a running total per month, not an event with an age, and the answer to what a workspace was charged for long after its traces have gone",
  billing_holds: "settled or expired by the billing layer, which is the only thing that knows which",
  billing_webhook_events: "the provider's own delivery record, and the queue an operator replays",
  subscriptions: "the current plan. There is one, and it is not an event",
  deployments: "what is live, and what was live. Forgetting one is a user action with its own command",
  deployment_logs: "read beside the deployment they belong to, and removed with it",
  mcp_servers: "a connected server is current or removed",
  mcp_tools: "a server's advertised tools, which are current or gone with the server",
  oauth_connections: "an OAuth grant is held or handed back, never aged out from under a live agent",
  oauth_states: "short-lived by construction, and swept on their own expiry rather than a plan's",
  github_links: "where an agent's code goes. A link is current or unlinked",
  github_events: "the sync history a panel renders. Bounded by its own list limit rather than by a clock",
  github_installations: "the App installation. Current or uninstalled",
  check_runs: "the measurement history per commit — the only place those numbers survive their eval jobs",
  shadow_runs: "what a run WAS. Without the row, neither the run nor its cost can be attributed to anything",
  pr_comments: "a mirror of a review — other people's words, like steps and audit_log",
  threads: "§3.4: a thread is archived, never deleted. test:thread-archive audits the whole server for a delete path, and this would be it",
  conversation_settings: "a setting is current or absent, not an event with an age — and it is bounded by the thread it belongs to, which cascades. Sweeping one would silently loosen a permission mode somebody chose",
  turn_attachments: "what a turn was looking at, and it leaves when that turn does — the row cascades from thread_items, which this sweep already removes. Sweeping it on its own clock would leave a turn whose context is unreconstructible while the turn itself still renders, which is the one thing §4.4 says the table exists to prevent",
  conversation_connectors: "which connectors a conversation may reach. A decision, not an event — and one that must outlive the runs it shaped, because 'why could this thread not see Slack' is asked long after those traces have been swept",
};

/** How many rows a sweep actually took, across every table it touches. */
export function deleted(sweep: WorkspaceSweep): number {
  return sweep.runsDeleted + sweep.stepsDeleted + sweep.checkpointsSwept + sweep.exportsDeleted +
    sweep.stagingDeleted + sweep.threadItemsDeleted + sweep.inboxItemsDeleted;
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
        const swept = await this.sweepWorkspace(ctx, limits.retentionDays);
        report.workspaces.push(swept);
        // WRITTEN ONLY WHEN SOMETHING WENT. A nightly row per workspace saying nothing was deleted
        // is a log nobody can read: the audit page would be a wall of empty sweeps, and the one
        // entry that matters would be somewhere in it. A sweep that took nothing is fully described
        // by the absence of a row.
        if (deleted(swept) > 0) await this.deps.audit?.(ctx, swept);
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
      threadItemsDeleted: 0,
      inboxItemsDeleted: 0,
    };

    // RESOLVED INBOX ITEMS, BEFORE THE RUN READ AND ITS EARLY RETURN. This has nothing to do with
    // which runs expired — a workspace with no expired runs still accumulates resolved items — and
    // putting it after the `expired.length === 0` return below would mean the table is only ever
    // swept in workspaces that also happen to have old traces.
    //
    // `resolved_at` RATHER THAN `first_seen_at`, and the difference is the one that matters: an item
    // that has been blocking somebody for six months is not old data, it is an unsolved problem, and
    // the age bar under its card is drawn from exactly the timestamp a `first_seen_at` cutoff would
    // sweep it by. The per-user dismissals and snoozes go with it through the foreign key's cascade.
    out.inboxItemsDeleted = (
      await this.deps.db.scoped(ctx.workspaceId, async (tx) =>
        tx.run(
          `DELETE FROM inbox_items
            WHERE workspace_id = ? AND state = 'resolved' AND resolved_at IS NOT NULL
              AND resolved_at < ?`,
          [ctx.workspaceId, cutoff],
        ),
      )
    ).changes;

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

    // The thread items that name those runs, in the same batches and BEFORE the run rows go — so
    // there is no window in which the join table points at a run that has already been deleted.
    // `kind = 'run'` only: an item's `ref_id` is one column shared by six kinds, and a proposal id
    // that happened to collide with a run id is not this sweep's to remove.
    for (const chunk of batches(runIds, 200)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const res = await this.deps.db.scoped(ctx.workspaceId, async (tx) =>
        tx.run(
          `DELETE FROM thread_items
            WHERE workspace_id = ? AND kind = 'run' AND ref_id IN (${placeholders})`,
          [ctx.workspaceId, ...chunk],
        ),
      );
      out.threadItemsDeleted += res.changes;
    }

    for (const chunk of batches(runIds, 200)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const res = await this.deps.db.scoped(ctx.workspaceId, async (tx) =>
        tx.run(`DELETE FROM runs WHERE workspace_id = ? AND id IN (${placeholders})`, [ctx.workspaceId, ...chunk]),
      );
      out.runsDeleted += res.changes;
    }

    // AND THE EVAL ITEMS WHOSE EVAL IS GONE. An eval run is removed by `evalCleanup`, not here, so
    // these are not swept alongside a batch of ids — they are the rows left over from every earlier
    // removal, and a single anti-join finds them. `NOT EXISTS` rather than `NOT IN`, because
    // `NOT IN` against a set containing a NULL matches nothing at all on both drivers.
    out.threadItemsDeleted += (
      await this.deps.db.scoped(ctx.workspaceId, async (tx) =>
        tx.run(
          `DELETE FROM thread_items
            WHERE workspace_id = ? AND kind = 'eval' AND ref_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM eval_runs e
                 WHERE e.workspace_id = thread_items.workspace_id AND e.id = thread_items.ref_id
              )`,
          [ctx.workspaceId],
        ),
      )
    ).changes;

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
  const items = report.workspaces.reduce((n, w) => n + w.threadItemsDeleted, 0);
  const inbox = report.workspaces.reduce((n, w) => n + w.inboxItemsDeleted, 0);
  if (!runs && !steps && !objects && !checkpoints && !items && !inbox && report.partitionsDropped.length === 0) {
    return null;
  }
  return (
    `[retention] ${runs} run(s), ${steps} step(s), ${checkpoints} checkpoint(s), ${objects} object(s)` +
    // Said rather than silent: a sweep that quietly removed rows from the thread list's own join
    // table would be a list that got shorter for a reason nothing in the log explains.
    (items ? `, ${items} thread item(s)` : "") +
    // And for the same reason: the zero state's "cleared 14 items this week" is counted off this
    // table, so a sweep that shortens it without saying so makes that sentence quietly wrong.
    (inbox ? `, ${inbox} inbox item(s)` : "") +
    (report.partitionsDropped.length ? `, ${report.partitionsDropped.length} partition(s)` : "")
  );
}
