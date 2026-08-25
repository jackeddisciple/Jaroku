// Notes, pins and feedback — §5.2, §5.3 and §5.5, in one store because they are one feature.
//
// THE THREE ARE DELIBERATELY DIFFERENT AND THE DIFFERENCES ARE LOAD-BEARING:
//
//   A NOTE IS SHARED. It is how a teammate learns "we tried this prompt shape, it broke the retry
//   path, don't redo it" from the thread rather than from Slack, which is the whole reason §5.2
//   exists. Everyone in the workspace reads it; only the author may change it.
//
//   A PIN IS PERSONAL. §5.3: "Two people debugging the same thread care about different anchors."
//   Every method here takes a user id and every statement carries it, because a pin visible to a
//   teammate is a rail full of somebody else's bookmarks.
//
//   FEEDBACK IS ONE OPINION PER PERSON. §5.5: "Mutually exclusive; clicking the active one clears
//   it." Clearing is a DELETE rather than a third rating value, so "no opinion" and "not yet asked"
//   are the same state — which they are.
//
// NOTES HANG OFF THE TURN, NEVER OFF A VARIANT (§12.19). That is the entire mechanism behind
// "notes survive regeneration": there is no column here that could point at a variant, so a note
// cannot become attached to one by accident.
//
// EVERY METHOD TAKES A `TenantContext` FIRST. On SQLite that parameter IS the tenancy boundary
// (migration 009 grants that driver no RLS), and for pins the USER parameter is a second boundary
// of the same kind — RLS could not enforce it even on Postgres, because this schema carries no
// current-user session variable.
//
//   npm run test:turn-interaction

import { randomUUID } from "node:crypto";

import { asInt, jsonFromColumn, type Db, type Queryable } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";

export interface TurnNote {
  id: string;
  turn_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface TurnPin {
  conversation_id: string;
  turn_id: string;
  created_at: string;
}

/** §5.5's picker. A closed set, because the aggregate is only useful if everyone picks from one. */
export const FEEDBACK_REASONS = [
  "wrong_code", "ignored_instruction", "too_slow", "broke_something", "other",
] as const;

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export function isFeedbackReason(v: unknown): v is FeedbackReason {
  return typeof v === "string" && (FEEDBACK_REASONS as readonly string[]).includes(v);
}

export interface TurnFeedback {
  turn_id: string;
  user_id: string;
  /** -1 or 1. There is no 0 — clearing removes the row. */
  rating: -1 | 1;
  reasons: FeedbackReason[];
  comment: string | null;
  created_at: string;
  updated_at: string;
}

/** What the workspace sees: counts, never who. §5.5 — "workspace-visible in aggregate". */
export interface FeedbackSummary {
  up: number;
  down: number;
  /** This user's own rating, or null. The only per-person fact a non-admin gets back. */
  mine: -1 | 1 | null;
}

/** §5.3: "Max 5 pins per conversation; pinning a 6th prompts to unpin one." */
export const MAX_PINS = 5;

const nowIso = (): string => new Date().toISOString();

export class TurnInteractionStore {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  // --- §5.2 notes ------------------------------------------------------------------------------

  /** A turn's notes, oldest first, excluding deleted ones. */
  async notesFor(ctx: TenantContext, turnId: string): Promise<TurnNote[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT id, turn_id, author_id, body, created_at, updated_at
         FROM turn_notes
        WHERE workspace_id = ? AND turn_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC`,
      [ctx.workspaceId, turnId],
    );
    return rows.map((r) => ({
      id: String(r["id"]),
      turn_id: String(r["turn_id"]),
      author_id: (r["author_id"] as string | null) ?? null,
      body: String(r["body"] ?? ""),
      created_at: String(r["created_at"]),
      updated_at: String(r["updated_at"]),
    }));
  }

  async addNote(ctx: TenantContext, turnId: string, authorId: string | null, body: string): Promise<TurnNote> {
    const id = randomUUID();
    const now = nowIso();
    await this.q(ctx).run(
      `INSERT INTO turn_notes (id, workspace_id, turn_id, author_id, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.workspaceId, turnId, authorId, body, now, now],
    );
    return { id, turn_id: turnId, author_id: authorId, body, created_at: now, updated_at: now };
  }

  /**
   * Edit a note. AUTHOR ONLY, and the author check is in the WHERE rather than in an `if`.
   *
   * §5.2 gives Edit and Delete to "the author only". Written as part of the statement so there is
   * no path that skips it: a version that read the row, compared the author and then wrote would
   * be two round trips with a race between them, and one more place for the check to be forgotten.
   */
  async editNote(ctx: TenantContext, noteId: string, authorId: string, body: string): Promise<boolean> {
    const res = await this.q(ctx).run(
      `UPDATE turn_notes SET body = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND author_id = ? AND deleted_at IS NULL`,
      [body, nowIso(), ctx.workspaceId, noteId, authorId],
    );
    return (res.changes ?? 0) > 0;
  }

  /** Soft delete, author only. See migration 058 for why the row stays. */
  async deleteNote(ctx: TenantContext, noteId: string, authorId: string): Promise<boolean> {
    const res = await this.q(ctx).run(
      `UPDATE turn_notes SET deleted_at = ?
        WHERE workspace_id = ? AND id = ? AND author_id = ? AND deleted_at IS NULL`,
      [nowIso(), ctx.workspaceId, noteId, authorId],
    );
    return (res.changes ?? 0) > 0;
  }

  /** Note counts for a whole thread's turns, for §5.2's badge. One query, not one per turn. */
  async noteCounts(ctx: TenantContext, turnIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (turnIds.length === 0) return out;
    const holes = turnIds.map(() => "?").join(", ");
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT turn_id, COUNT(*) AS n FROM turn_notes
        WHERE workspace_id = ? AND turn_id IN (${holes}) AND deleted_at IS NULL
        GROUP BY turn_id`,
      [ctx.workspaceId, ...turnIds],
    );
    // COUNT is a bigint on Postgres and arrives as a string. `asInt` is why the badge renders a
    // number rather than the text "3" concatenated onto something.
    for (const r of rows) out.set(String(r["turn_id"]), asInt(r["n"]));
    return out;
  }

  // --- §5.3 pins -------------------------------------------------------------------------------

  /**
   * One person's pins in one conversation.
   *
   * THE USER IS IN THE WHERE, always. §12.20: "user A's pin is invisible to user B in the same
   * conversation." There is deliberately no method here that lists a conversation's pins without a
   * user — such a method would be the one somebody reached for while building a "team pins" view,
   * and the rail would silently become shared.
   */
  async pinsFor(ctx: TenantContext, conversationId: string, userId: string): Promise<TurnPin[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT conversation_id, turn_id, created_at FROM turn_pins
        WHERE workspace_id = ? AND conversation_id = ? AND user_id = ?
        ORDER BY created_at ASC, turn_id ASC`,
      [ctx.workspaceId, conversationId, userId],
    );
    return rows.map((r) => ({
      conversation_id: String(r["conversation_id"]),
      turn_id: String(r["turn_id"]),
      created_at: String(r["created_at"]),
    }));
  }

  /**
   * Pin a turn, refusing the sixth.
   *
   * §5.3: "Max 5 pins per conversation; pinning a 6th prompts to unpin one. An unbounded pin list
   * is just a second scrollback." Returning `false` rather than throwing, because the client's
   * answer is a prompt rather than an error — the user is going to pick one to remove.
   */
  async pin(
    ctx: TenantContext,
    conversationId: string,
    turnId: string,
    userId: string,
  ): Promise<{ pinned: boolean; atLimit: boolean }> {
    const existing = await this.pinsFor(ctx, conversationId, userId);
    if (existing.some((p) => p.turn_id === turnId)) return { pinned: true, atLimit: false };
    if (existing.length >= MAX_PINS) return { pinned: false, atLimit: true };
    await this.q(ctx).run(
      `INSERT INTO turn_pins (workspace_id, conversation_id, turn_id, user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [ctx.workspaceId, conversationId, turnId, userId, nowIso()],
    );
    return { pinned: true, atLimit: false };
  }

  async unpin(ctx: TenantContext, turnId: string, userId: string): Promise<void> {
    await this.q(ctx).run(
      `DELETE FROM turn_pins WHERE workspace_id = ? AND turn_id = ? AND user_id = ?`,
      [ctx.workspaceId, turnId, userId],
    );
  }

  // --- §5.5 feedback ---------------------------------------------------------------------------

  /**
   * The counts, plus this user's own rating.
   *
   * COUNTS FOR THE WORKSPACE, IDENTITY ONLY FOR YOURSELF. §5.5: "Feedback is workspace-visible in
   * aggregate (counts on the turn) but the reason text is visible to workspace admins and the
   * author only." So this returns numbers and one rating, and the reason text is a separate read
   * the route gates on a capability.
   */
  async feedbackFor(ctx: TenantContext, turnId: string, userId: string): Promise<FeedbackSummary> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT rating, user_id FROM turn_feedback WHERE workspace_id = ? AND turn_id = ?`,
      [ctx.workspaceId, turnId],
    );
    let up = 0;
    let down = 0;
    let mine: -1 | 1 | null = null;
    for (const r of rows) {
      const rating = asInt(r["rating"]) === 1 ? 1 : -1;
      if (rating === 1) up++;
      else down++;
      if (String(r["user_id"]) === userId) mine = rating;
    }
    return { up, down, mine };
  }

  /** The reason text, for the route to gate. Never returned by `feedbackFor`. */
  async feedbackDetail(ctx: TenantContext, turnId: string): Promise<TurnFeedback[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT turn_id, user_id, rating, reasons, comment, created_at, updated_at
         FROM turn_feedback
        WHERE workspace_id = ? AND turn_id = ?
        ORDER BY created_at ASC`,
      [ctx.workspaceId, turnId],
    );
    return rows.map((r) => ({
      turn_id: String(r["turn_id"]),
      user_id: String(r["user_id"]),
      rating: asInt(r["rating"]) === 1 ? 1 : -1,
      reasons: readReasons(this.db.dialect, r["reasons"]),
      comment: (r["comment"] as string | null) ?? null,
      created_at: String(r["created_at"]),
      updated_at: String(r["updated_at"]),
    }));
  }

  /**
   * Set or clear a rating.
   *
   * `null` CLEARS, AND CLEARING IS A DELETE. §5.5: "Mutually exclusive; clicking the active one
   * clears it." A third rating value would make "no opinion" a row, and the aggregate count would
   * then have to know to exclude it — which is one more thing for a later query to forget.
   */
  async setFeedback(
    ctx: TenantContext,
    turnId: string,
    userId: string,
    rating: -1 | 1 | null,
    reasons: FeedbackReason[] = [],
    comment: string | null = null,
  ): Promise<FeedbackSummary> {
    const q = this.q(ctx);
    if (rating === null) {
      await q.run(
        `DELETE FROM turn_feedback WHERE workspace_id = ? AND turn_id = ? AND user_id = ?`,
        [ctx.workspaceId, turnId, userId],
      );
      return this.feedbackFor(ctx, turnId, userId);
    }

    const now = nowIso();
    // On SQLite this column is JSON text and on Postgres it is a real array. The value written has
    // to differ, which is one of the two places in this file the dialect is visible at all.
    const stored = writeReasons(this.db.dialect, reasons);
    const existing = await q.get(
      `SELECT user_id FROM turn_feedback WHERE workspace_id = ? AND turn_id = ? AND user_id = ?`,
      [ctx.workspaceId, turnId, userId],
    );
    if (existing) {
      await q.run(
        `UPDATE turn_feedback SET rating = ?, reasons = ?, comment = ?, updated_at = ?
          WHERE workspace_id = ? AND turn_id = ? AND user_id = ?`,
        [rating, stored, comment, now, ctx.workspaceId, turnId, userId],
      );
    } else {
      await q.run(
        `INSERT INTO turn_feedback (workspace_id, turn_id, user_id, rating, reasons, comment, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ctx.workspaceId, turnId, userId, rating, stored, comment, now, now],
      );
    }
    return this.feedbackFor(ctx, turnId, userId);
  }
}

/** `text[]` on Postgres, JSON text on SQLite. Anything unreadable is an empty list, never a guess. */
function readReasons(dialect: string, raw: unknown): FeedbackReason[] {
  const value = dialect === "postgres" ? raw : jsonFromColumn("sqlite", raw);
  if (!Array.isArray(value)) return [];
  return value.filter(isFeedbackReason);
}

function writeReasons(dialect: string, reasons: FeedbackReason[]): unknown {
  return dialect === "postgres" ? reasons : JSON.stringify(reasons);
}
