// Running a git ref once, watching what it does, and throwing the run away.
//
// §3.2 is right that switching a linked branch is heavy: it re-materialises the agent's working
// state, which is why the switcher asks three questions before it will do it. But "what does this
// branch do?" does not require making it the working state at all. It requires running its tree
// once and reading the trace — and that is not a new capability, it is v0.1.5's branch/fork run
// primitive pointed at a git ref instead of a checkpoint.
//
// THE PROMOTION STEP IS NEVER REACHED, AND THAT IS THE WHOLE GUARANTEE. A generation stages into
// `agents/.staging/<id>/`, validates, and then promotes: a row in `agent_versions`, objects under
// the version's prefix, and `current_version` moved. A shadow run does the first of those and stops.
// There is no candidate version, nothing enters `agent_versions`, and `current_version` never moves
// — enforced by there being no code path from this module to `publishStaging` or `promoteVersion`,
// which is a stronger statement than a flag somebody remembers to check.
//
// THE CONTRACT CHECK RUNS AND THE FULL VALIDATOR DOES NOT, and §B.2.2 says why in one line: a
// shadow run is disposable by definition. The contract check has to run — `build_graph` is what
// builds the graph, and without it there is nothing to run at all — but a rule-3 `print()` in a
// branch somebody is INSPECTING is not a reason to refuse to show them what the branch does. So a
// contract failure surfaces as a run with `status: "error"`, which is the graceful failure v0.0.1's
// runner already guarantees for any broken agent, rather than as a validator refusal.
//
// THEY ARE NOT FREE. §B.2.2 is explicit: same cost accounting, same budget visibility as any other
// run. A shadow run is disposable to the PRODUCT; it is not disposable to the bill, and nothing in
// this file exempts one from metering.
//
// AND THEY ARE SWEPT. The staging directory is reclaimed on a timer, exactly as the checkpoint
// sweep reclaims finished eval jobs (v0.2.5) — "ephemeral and later garbage collected" is not a new
// idea in this codebase, which is why the sweep below is a policy function rather than a mechanism.

import { randomUUID } from "node:crypto";

import type { Db, Queryable } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";

export type ShadowStatus = "staging" | "running" | "completed" | "error" | "cancelled";

export interface ShadowRun {
  id: string;
  agent_id: string;
  link_id: string | null;
  /** The ref as the user named it — what the panel says. */
  ref: string;
  /** The commit it resolved to when the run started — what a comparison is keyed on. */
  head_sha: string;
  /** The ordinary `runs` row this produced, or null before there is one. */
  run_id: string | null;
  staging_key: string | null;
  status: ShadowStatus;
  error: string | null;
  created_at: string;
  ended_at: string | null;
  swept_at: string | null;
}

/**
 * The staging directory a shadow run gets — §B.2.2's `agents/.staging/<id>__shadow-<sha>/`.
 *
 * THE SHA IS IN THE NAME AND THE RANDOM ID IS TOO, and both are needed. The sha makes a directory
 * on disk answerable — somebody looking at a staging root during an incident can see which commit
 * each one is — and the random half is what lets two people shadow the SAME ref at the same moment
 * without one of them materialising into the other's directory. A name built from the sha alone
 * would make that collision silent and the resulting trace a mixture.
 *
 * TWELVE CHARACTERS OF SHA, which is git's own abbreviation length for a repository of any size,
 * and enough that a directory listing is readable rather than a wall of forty-character hex.
 */
export function shadowStagingId(headSha: string): string {
  return `${randomUUID().slice(0, 8)}__shadow-${headSha.slice(0, 12)}`;
}

/**
 * How long a finished shadow run's staging directory survives.
 *
 * FIFTEEN MINUTES: long enough that somebody who ran two refs to compare them can still open both
 * traces, short enough that a workspace exploring six branches does not leave six projects on disk
 * overnight. The trace itself is an ordinary `runs` row and is NOT swept by this — retention owns
 * that, on its own schedule, for every run in the system. What is reclaimed here is the materialised
 * project, which is the only thing a shadow run creates that nothing else would clean up.
 */
export const SWEEP_AFTER_MS = 15 * 60 * 1000;

/**
 * Whether this run's staging directory should be reclaimed now.
 *
 * A POLICY FUNCTION RATHER THAN A QUERY, so the interesting cases are assertable without a database
 * and without waiting fifteen minutes: a run still going is never swept whatever its age, a run
 * already swept is not swept twice, and a run that never got a staging directory has nothing to
 * reclaim.
 *
 * A RUN WITH NO `ended_at` IS NEVER SWEPT, however old. That is deliberate and is the same
 * conservative direction the eval cleanup takes: a process that died without writing an end time
 * leaves a row that looks unfinished forever, and reclaiming its directory on age alone would pull
 * the project out from under a run that is, in fact, still executing on another replica.
 */
export function shouldSweep(run: ShadowRun, now = Date.now()): boolean {
  if (run.swept_at !== null) return false;
  if (run.staging_key === null) return false;
  if (run.ended_at === null) return false;
  return now - Date.parse(run.ended_at) >= SWEEP_AFTER_MS;
}

const COLUMNS = `id, agent_id, link_id, ref, head_sha, run_id, staging_key, status, error,
                 created_at, ended_at, swept_at`;

/**
 * The `shadow_runs` table, behind one repository.
 *
 * EVERY METHOD TAKES A `TenantContext` FIRST and every statement carries `workspace_id` in its
 * WHERE, for the reason `GithubRepository`'s header gives at length: on SQLite there is no RLS at
 * all, so that clause IS the tenancy boundary on one of the two supported drivers.
 */
export class ShadowRunRepository {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  private hydrate(row: Record<string, unknown>): ShadowRun {
    return {
      id: String(row["id"]),
      agent_id: String(row["agent_id"]),
      link_id: (row["link_id"] as string | null) ?? null,
      ref: String(row["ref"]),
      head_sha: String(row["head_sha"]),
      run_id: (row["run_id"] as string | null) ?? null,
      staging_key: (row["staging_key"] as string | null) ?? null,
      status: row["status"] as ShadowStatus,
      error: (row["error"] as string | null) ?? null,
      created_at: String(row["created_at"]),
      ended_at: (row["ended_at"] as string | null) ?? null,
      swept_at: (row["swept_at"] as string | null) ?? null,
    };
  }

  /**
   * Start one, before anything has been staged.
   *
   * THE ROW EXISTS BEFORE THE WORK, which is what makes an interrupted shadow run visible rather
   * than invisible: a process that dies during materialisation leaves a `staging` row somebody can
   * see and the sweep can reason about, instead of a directory nothing points at.
   */
  async start(
    ctx: TenantContext,
    input: { agentId: string; linkId?: string | null; ref: string; headSha: string; stagingKey: string },
  ): Promise<ShadowRun> {
    const id = randomUUID();
    await this.q(ctx).run(
      `INSERT INTO shadow_runs
         (id, workspace_id, agent_id, link_id, ref, head_sha, staging_key, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'staging', ?, ?)`,
      [
        id, ctx.workspaceId, input.agentId, input.linkId ?? null, input.ref, input.headSha,
        input.stagingKey, ctx.actorUserId, new Date().toISOString(),
      ],
    );
    return (await this.get(ctx, id))!;
  }

  async get(ctx: TenantContext, id: string): Promise<ShadowRun | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM shadow_runs WHERE workspace_id = ? AND id = ?`,
      [ctx.workspaceId, id],
    );
    return row ? this.hydrate(row) : undefined;
  }

  /**
   * Attach the ordinary run this produced.
   *
   * SEPARATE FROM `start` BECAUSE THE ID DOES NOT EXIST YET at that point — the runner mints it when
   * it dispatches — and separate from `finish` because a run that is dispatched and then crashes
   * still has a trace worth opening. Three writes, three facts, none of them inferable from another.
   */
  async attachRun(ctx: TenantContext, id: string, runId: string): Promise<void> {
    await this.q(ctx).run(
      `UPDATE shadow_runs SET run_id = ?, status = 'running' WHERE workspace_id = ? AND id = ?`,
      [runId, ctx.workspaceId, id],
    );
  }

  /**
   * How it ended.
   *
   * A CONTRACT FAILURE ARRIVES HERE AS `error` WITH A MESSAGE, not as an exception the caller
   * unwinds. §B.2.2: a shadow run is disposable, so a broken agent surfaces as a run with
   * `status: "error"` — the graceful failure v0.0.1's runner already guarantees — rather than as a
   * refusal card. The person asked what this branch does, and "it does not import" is an answer.
   */
  async finish(
    ctx: TenantContext,
    id: string,
    outcome: { status: Exclude<ShadowStatus, "staging" | "running">; error?: string | null },
  ): Promise<void> {
    await this.q(ctx).run(
      `UPDATE shadow_runs SET status = ?, error = ?, ended_at = ?
        WHERE workspace_id = ? AND id = ?`,
      [outcome.status, outcome.error ?? null, new Date().toISOString(), ctx.workspaceId, id],
    );
  }

  /**
   * This agent's shadow runs, newest first — §B.2.2's transient list.
   *
   * ITS OWN READ, AND THAT IS THE POINT. §B.2.2 requires that shadow runs never appear in the
   * agent's ordinary run history sidebar, and the way that is guaranteed is that the sidebar's query
   * does not join this table and this query is the only one that does. A flag on `runs` would have
   * made "exclude shadows" something every existing read had to remember.
   */
  async forAgent(ctx: TenantContext, agentId: string, limit = 20): Promise<ShadowRun[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM shadow_runs
        WHERE workspace_id = ? AND agent_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      [ctx.workspaceId, agentId, limit],
    );
    return rows.map((r) => this.hydrate(r));
  }

  /** Everything finished and not yet reclaimed, oldest first. What the sweep walks. */
  async sweepable(ctx: TenantContext, limit = 100): Promise<ShadowRun[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM shadow_runs
        WHERE workspace_id = ? AND swept_at IS NULL AND ended_at IS NOT NULL
        ORDER BY ended_at ASC LIMIT ?`,
      [ctx.workspaceId, limit],
    );
    return rows.map((r) => this.hydrate(r));
  }

  /**
   * Mark a staging directory reclaimed.
   *
   * MARKS RATHER THAN DELETES, and migration 038's header makes the argument: a deleted row would
   * make "this shadow run's trace is gone" indistinguishable from "there was never a shadow run",
   * and the second is what a comparison view would render as an empty column with no explanation.
   */
  async markSwept(ctx: TenantContext, id: string): Promise<void> {
    await this.q(ctx).run(
      `UPDATE shadow_runs SET swept_at = ? WHERE workspace_id = ? AND id = ? AND swept_at IS NULL`,
      [new Date().toISOString(), ctx.workspaceId, id],
    );
  }
}

/** Whether a `shadow_runs` row is one the panel should still offer a trace for. */
export function hasReadableTrace(run: ShadowRun): boolean {
  // The trace outlives the staging directory: `runs` and `steps` are ordinary rows on retention's
  // own schedule, and sweeping reclaims the project rather than the record of what it did. So a
  // swept run is still openable, which is exactly what makes the sweep safe to run on a short timer.
  return run.run_id !== null;
}
