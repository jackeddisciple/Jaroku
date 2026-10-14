// A person's marks on a trace's steps — viewed, and pinned (migration 085).
//
// PERSONAL, LIKE A TURN PIN. Every method takes the user and every statement carries it: two people
// reviewing one run have each read different steps, and a teammate's ticks would mark yours as read.
// There is deliberately no method that lists a run's marks without a user.
//
// EVERY METHOD TAKES A `TenantContext` FIRST, which on SQLite is the tenancy boundary (no RLS there,
// migration 009), and a write checks the run is this workspace's first: `run_id` references the
// runs table by id alone, so the key cannot refuse another workspace's run on its own.
//
//   npm run test:tenancy

import { type Db, type Queryable } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";

/** One step's marks, for one person. */
export interface StepMark {
  step_id: string;
  viewed: boolean;
  pinned: boolean;
}

export type StepMarkKind = "viewed" | "pinned";

const nowIso = (): string => new Date().toISOString();

export class TraceMarkStore {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  /** One person's marks on one run's steps. */
  async marksFor(ctx: TenantContext, runId: string, userId: string): Promise<StepMark[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT step_id, viewed_at, pinned_at FROM trace_step_marks
        WHERE workspace_id = ? AND run_id = ? AND user_id = ?
        ORDER BY step_id`,
      [ctx.workspaceId, runId, userId],
    );
    return rows.map((r) => ({ step_id: String(r["step_id"]), viewed: r["viewed_at"] != null, pinned: r["pinned_at"] != null }));
  }

  /**
   * Set or clear one mark on one step, for one person, and answer with their marks on the run — or
   * null when the run is not this workspace's, which is the same answer as a run that does not exist.
   */
  async setMark(
    ctx: TenantContext,
    runId: string,
    stepId: string,
    userId: string,
    kind: StepMarkKind,
    on: boolean,
  ): Promise<StepMark[] | null> {
    const run = await this.q(ctx).get<{ id: string }>(
      `SELECT id FROM runs WHERE id = ? AND workspace_id = ?`,
      [runId, ctx.workspaceId],
    );
    if (!run) return null;
    const column = kind === "viewed" ? "viewed_at" : "pinned_at";
    const at = on ? nowIso() : null;
    await this.q(ctx).run(
      `INSERT INTO trace_step_marks (workspace_id, run_id, step_id, user_id, ${column})
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, run_id, step_id, user_id) DO UPDATE SET ${column} = excluded.${column}`,
      [ctx.workspaceId, runId, stepId, userId, at],
    );
    // Unmarked is one state: a row with neither mark goes.
    await this.q(ctx).run(
      `DELETE FROM trace_step_marks
        WHERE workspace_id = ? AND run_id = ? AND step_id = ? AND user_id = ? AND viewed_at IS NULL AND pinned_at IS NULL`,
      [ctx.workspaceId, runId, stepId, userId],
    );
    return this.marksFor(ctx, runId, userId);
  }
}
