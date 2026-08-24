// Persisting what a turn was looking at.
//
// Small on purpose. Everything interesting about attachments — what a ref means, what it costs,
// whether it fits — is in attachments.ts, which is pure and therefore checkable. This is the part
// that touches the database, and it does the two things a store here always does: scope every
// statement by workspace, and translate the one column whose type differs between the drivers.
//
// `ref` IS THE TRANSLATION THAT WOULD BITE. It is `jsonb` on Postgres and `TEXT` on SQLite, so the
// driver hands back a parsed object on one and a string on the other. Every read goes through
// `jsonFromColumn`, which exists because that difference is invisible until a `.path` on a string
// returns undefined in production and an object in every local suite.
//
// EVERY METHOD TAKES A `TenantContext` FIRST. On SQLite that parameter IS the tenancy boundary
// (migration 009 grants that driver no RLS), and there is no method here that finds an attachment
// by id alone.
//
//   npm run test:attachment-store

import { randomUUID } from "node:crypto";

import { jsonFromColumn, type Db, type Queryable } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";
import { labelFor, type AttachmentKind, type ResolvedAttachment } from "./attachments.ts";

export interface StoredAttachment {
  id: string;
  turn_id: string;
  kind: AttachmentKind;
  ref: Record<string, unknown>;
  resolved_at: string;
  token_estimate: number;
  /** Derived, never stored — see `labelFor`. One spelling of an attachment, not two. */
  label: string;
}

const nowIso = (): string => new Date().toISOString();

export class AttachmentStore {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  private hydrate(row: Record<string, unknown>): StoredAttachment {
    const ref = (jsonFromColumn(this.db.dialect, row["ref"]) ?? {}) as Record<string, unknown>;
    const kind = String(row["kind"]) as AttachmentKind;
    return {
      id: String(row["id"]),
      turn_id: String(row["turn_id"]),
      kind,
      ref,
      resolved_at: String(row["resolved_at"]),
      token_estimate: Number(row["token_estimate"] ?? 0),
      label: labelFor(kind, ref),
    };
  }

  /**
   * Attach the resolved refs to a turn, all of them or none.
   *
   * ALL OR NONE, because a partially-attached turn is worse than an unattached one: the model
   * would answer from three of the five things somebody meant to show it, and nothing on screen
   * would say which two were missing. The transaction is the whole guarantee here, and it is the
   * same reason the generation path stages a version before publishing it.
   */
  async attach(
    ctx: TenantContext,
    turnId: string,
    resolved: readonly ResolvedAttachment[],
  ): Promise<StoredAttachment[]> {
    if (resolved.length === 0) return [];
    const at = nowIso();
    // `scoped` rather than `forWorkspace`, because this is multi-statement work: on Postgres the
    // per-statement form would put each INSERT in its own transaction, and the all-or-none promise
    // above would be a comment rather than a guarantee.
    await this.db.scoped(ctx.workspaceId, async (q) => {
      for (const a of resolved) {
        await q.run(
          `INSERT INTO turn_attachments (id, workspace_id, turn_id, kind, ref, resolved_at, token_estimate)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [randomUUID(), ctx.workspaceId, turnId, a.kind, JSON.stringify(a.ref), at, a.tokenEstimate],
        );
      }
    });
    return this.forTurn(ctx, turnId);
  }

  /** Everything attached to one turn, oldest first — the order the rail showed them in. */
  async forTurn(ctx: TenantContext, turnId: string): Promise<StoredAttachment[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT id, turn_id, kind, ref, resolved_at, token_estimate
         FROM turn_attachments
        WHERE workspace_id = ? AND turn_id = ?
        ORDER BY resolved_at ASC, id ASC`,
      [ctx.workspaceId, turnId],
    );
    return rows.map((r) => this.hydrate(r));
  }

  /**
   * Remove one.
   *
   * SCOPED BY TURN AS WELL AS BY ID, which is redundant and stays. The route already knows both,
   * the id is a uuid nobody can guess, and the workspace is in the WHERE — but a DELETE that
   * matched on id alone would be one refactor away from being reachable with only an id, and this
   * is the cheapest possible insurance against that refactor.
   */
  async remove(ctx: TenantContext, turnId: string, attachmentId: string): Promise<boolean> {
    const res = await this.q(ctx).run(
      `DELETE FROM turn_attachments WHERE workspace_id = ? AND turn_id = ? AND id = ?`,
      [ctx.workspaceId, turnId, attachmentId],
    );
    return (res.changes ?? 0) > 0;
  }

  /**
   * How many are already on this turn, for §4.4's cap.
   *
   * A COUNT RATHER THAN `forTurn().length`, because the cap is checked before every attach and
   * reading ten rows to learn there are ten is work nobody asked for.
   */
  async countFor(ctx: TenantContext, turnId: string): Promise<number> {
    const row = await this.q(ctx).get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM turn_attachments WHERE workspace_id = ? AND turn_id = ?`,
      [ctx.workspaceId, turnId],
    );
    return Number(row?.n ?? 0);
  }
}
