// Reading what is in force, and writing what changed.
//
// Every write here also writes an `audit_log` row, and that is not decoration: "why can this
// workspace not start a run" is asked weeks later by somebody who was not there, and the answer
// has to survive in something other than a log that rotated. The enforcement row is the state;
// the audit row is the account of it.

import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { jsonFromColumn } from "../db.ts";
import type { SystemContext, TenantContext } from "../tenant.ts";
import {
  NO_ENFORCEMENT,
  isEnforcementLevel,
  type EnforcementLevel,
  type EnforcementState,
} from "../../abuse/enforcement.ts";
import { IdentityRepository } from "./identity.ts";

export interface EnforcementRow {
  id: string;
  workspace_id: string;
  level: EnforcementLevel;
  reason: string;
  evidence: Record<string, unknown>;
  applied_by: string | null;
  applied_at: string;
  expires_at: string | null;
  lifted_at: string | null;
  lifted_by: string | null;
  lifted_reason: string | null;
  appeal_note: string | null;
  appealed_at: string | null;
}

const nowIso = (): string => new Date().toISOString();

export class EnforcementRepository {
  private identity: IdentityRepository;

  constructor(private db: Db) {
    this.identity = new IdentityRepository(db);
  }

  /**
   * What is in force for this workspace, or `none`.
   *
   * The most recent unlifted row. A LAPSED one is still returned rather than filtered out here —
   * `decide()` is what knows that an expired automatic rung means nothing, and hiding it at this
   * level would mean the gate could not tell "expired, lift it" from "never applied".
   */
  async current(ctx: TenantContext): Promise<EnforcementState> {
    const row = await this.db.forWorkspace(ctx.workspaceId).get<Record<string, unknown>>(
      `SELECT level, reason, applied_by, applied_at, expires_at
         FROM workspace_enforcements
        WHERE workspace_id = ? AND lifted_at IS NULL
        ORDER BY applied_at DESC
        LIMIT 1`,
      [ctx.workspaceId],
    );
    if (!row) return NO_ENFORCEMENT;
    const level = row["level"];
    if (!isEnforcementLevel(level)) {
      // A rung this build does not know about. Treated as nothing rather than as the worst case:
      // a rollback that made an unknown level mean "suspended" would suspend everybody who was
      // under the rung that was removed.
      return NO_ENFORCEMENT;
    }
    return {
      level,
      reason: String(row["reason"] ?? ""),
      appliedAt: (row["applied_at"] as string) ?? null,
      expiresAt: (row["expires_at"] as string) ?? null,
      byHuman: row["applied_by"] !== null && row["applied_by"] !== undefined,
    };
  }

  /**
   * Put a rung in force, lifting whatever was.
   *
   * ONE TRANSACTION, because the two halves are one fact: a moment where both the old row and
   * the new one are unlifted is a moment where `current()` answers by `applied_at` order and a
   * clock that ticks twice in one millisecond decides which enforcement a workspace is under.
   */
  async apply(
    ctx: TenantContext,
    input: {
      level: EnforcementLevel;
      reason: string;
      evidence?: Record<string, unknown>;
      /** A user id for a human decision, null for the ladder's own. See migration 028. */
      appliedBy?: string | null;
      expiresAt?: string | null;
    },
  ): Promise<EnforcementRow> {
    const row: EnforcementRow = {
      id: randomUUID(),
      workspace_id: ctx.workspaceId,
      level: input.level,
      reason: input.reason,
      evidence: input.evidence ?? {},
      applied_by: input.appliedBy ?? null,
      applied_at: nowIso(),
      expires_at: input.expiresAt ?? null,
      lifted_at: null,
      lifted_by: null,
      lifted_reason: null,
      appeal_note: null,
      appealed_at: null,
    };
    await this.db.scoped(ctx.workspaceId, async (tx) => {
      await tx.run(
        `UPDATE workspace_enforcements SET lifted_at = ?, lifted_reason = ?
          WHERE workspace_id = ? AND lifted_at IS NULL`,
        [row.applied_at, `replaced by ${input.level}`, ctx.workspaceId],
      );
      await tx.run(
        `INSERT INTO workspace_enforcements
           (id, workspace_id, level, reason, evidence, applied_by, applied_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.workspace_id,
          row.level,
          row.reason,
          JSON.stringify(row.evidence),
          row.applied_by,
          row.applied_at,
          row.expires_at,
        ],
      );
    });
    await this.identity.appendAudit(ctx, {
      workspaceId: ctx.workspaceId,
      actorUserId: input.appliedBy ?? null,
      action: "enforcement.applied",
      targetType: "workspace",
      targetId: ctx.workspaceId,
      metadata: { level: input.level, reason: input.reason, automatic: !input.appliedBy },
    });
    return row;
  }

  /** End whatever is in force. Idempotent: lifting nothing is not an error. */
  async lift(ctx: TenantContext, reason: string, liftedBy: string | null = null): Promise<boolean> {
    const res = await this.db.scoped(ctx.workspaceId, async (tx) =>
      tx.run(
        `UPDATE workspace_enforcements
            SET lifted_at = ?, lifted_by = ?, lifted_reason = ?
          WHERE workspace_id = ? AND lifted_at IS NULL`,
        [nowIso(), liftedBy, reason, ctx.workspaceId],
      ),
    );
    if (res.changes === 0) return false;
    await this.identity.appendAudit(ctx, {
      workspaceId: ctx.workspaceId,
      actorUserId: liftedBy,
      action: "enforcement.lifted",
      targetType: "workspace",
      targetId: ctx.workspaceId,
      metadata: { reason, automatic: !liftedBy },
    });
    return true;
  }

  /**
   * Record what the workspace said about the rung it is under.
   *
   * A write a MEMBER may make about their own workspace, which is the whole point: an appeal
   * that has to go through the party that applied the enforcement is not an appeal. It changes
   * nothing on its own — a human reads it and decides — and it is deliberately one note rather
   * than a thread, because a support conversation belongs in a support system and a decision's
   * record belongs here.
   */
  async appeal(ctx: TenantContext, note: string): Promise<boolean> {
    const trimmed = note.trim().slice(0, 4000);
    if (!trimmed) return false;
    const res = await this.db.scoped(ctx.workspaceId, async (tx) =>
      tx.run(
        `UPDATE workspace_enforcements SET appeal_note = ?, appealed_at = ?
          WHERE workspace_id = ? AND lifted_at IS NULL`,
        [trimmed, nowIso(), ctx.workspaceId],
      ),
    );
    if (res.changes === 0) return false;
    await this.identity.appendAudit(ctx, {
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.actorUserId,
      action: "enforcement.appealed",
      targetType: "workspace",
      targetId: ctx.workspaceId,
      // The note itself is on the row; the audit records that one was made and by whom.
      metadata: { length: trimmed.length },
    });
    return true;
  }

  /** The whole history for one workspace, newest first. What an appeal review reads. */
  async history(ctx: TenantContext, limit = 50): Promise<EnforcementRow[]> {
    const rows = await this.db.forWorkspace(ctx.workspaceId).all<Record<string, unknown>>(
      `SELECT id, workspace_id, level, reason, evidence, applied_by, applied_at, expires_at,
              lifted_at, lifted_by, lifted_reason, appeal_note, appealed_at
         FROM workspace_enforcements
        WHERE workspace_id = ?
        ORDER BY applied_at DESC
        LIMIT ?`,
      [ctx.workspaceId, limit],
    );
    return rows.map((r) => ({
      ...(r as unknown as EnforcementRow),
      evidence: (jsonFromColumn(this.db.dialect, r["evidence"]) as Record<string, unknown>) ?? {},
    }));
  }

  /**
   * Every workspace currently under a rung at or above `level`.
   *
   * Unscoped, and for the platform rather than for a tenant — hence the SystemContext. It is
   * what an operator's "who is suspended" question reads, and what the metrics in commit 12
   * export as a gauge.
   */
  async workspacesAt(_ctx: SystemContext, levels: readonly EnforcementLevel[]): Promise<{ workspace_id: string; level: EnforcementLevel }[]> {
    if (levels.length === 0) return [];
    const placeholders = levels.map(() => "?").join(", ");
    return this.db.all<{ workspace_id: string; level: EnforcementLevel }>(
      `SELECT workspace_id, level FROM workspace_enforcements
        WHERE lifted_at IS NULL AND level IN (${placeholders})
        ORDER BY applied_at DESC`,
      [...levels],
    );
  }
}
