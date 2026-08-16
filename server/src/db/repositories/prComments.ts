// Review comments, mirrored, and what Jaroku did about each one.
//
// THE MIRROR IS ALLOWED HERE AND WAS REFUSED FOR COMMITS, and migration 039's header makes the
// argument at length. In one line: this table does not store the comment to answer "what did the
// reviewer say" — GitHub answers that, and the body column is a convenience a sync refreshes. It
// stores the RESOLUTION STATE, which is a fact about Jaroku that GitHub has no column for.
//
// THE UPSERT IS THE INTERESTING METHOD. A sync runs on every panel open and must be idempotent: the
// same comment arriving twice updates one row rather than adding a second, AND the resolution state
// on it survives the update. That second half is the one a naive upsert loses — a `REPLACE INTO`
// would faithfully overwrite `resolution` with the default on every refresh, so an edit somebody
// applied this morning would read as an open comment this afternoon.

import { randomUUID } from "node:crypto";

import type { Db, Queryable } from "../db.ts";
import type { TenantContext } from "../tenant.ts";

/** What Jaroku did about a comment. `open` is the default and the overwhelming majority. */
export type CommentResolution = "open" | "proposed" | "applied" | "dismissed";

export interface PrComment {
  id: string;
  agent_id: string;
  pr_number: number;
  github_comment_id: string;
  in_reply_to_id: string | null;
  author_login: string | null;
  /** Repository-relative, as GitHub spells it. Translated by the reader — see `syncComments`. */
  path: string | null;
  line: number | null;
  body: string;
  commit_sha: string | null;
  resolution: CommentResolution;
  resolved_version: number | null;
  replied_at: string | null;
  created_at: string;
}

const COLUMNS = `id, agent_id, pr_number, github_comment_id, in_reply_to_id, author_login, path,
                 line, body, commit_sha, resolution, resolved_version, replied_at, created_at`;

export class PrCommentsRepository {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  private hydrate(row: Record<string, unknown>): PrComment {
    return {
      id: String(row["id"]),
      agent_id: String(row["agent_id"]),
      pr_number: Number(row["pr_number"]),
      github_comment_id: String(row["github_comment_id"]),
      in_reply_to_id: (row["in_reply_to_id"] as string | null) ?? null,
      author_login: (row["author_login"] as string | null) ?? null,
      path: (row["path"] as string | null) ?? null,
      line: (row["line"] as number | null) ?? null,
      body: String(row["body"] ?? ""),
      commit_sha: (row["commit_sha"] as string | null) ?? null,
      resolution: row["resolution"] as CommentResolution,
      resolved_version: (row["resolved_version"] as number | null) ?? null,
      replied_at: (row["replied_at"] as string | null) ?? null,
      created_at: String(row["created_at"]),
    };
  }

  /**
   * Bring one comment up to date, or record it for the first time.
   *
   * THE RESOLUTION IS NEVER TOUCHED BY A SYNC, which is the property this method exists to hold.
   * What GitHub owns — the body, the path, the line, who wrote it — is refreshed every time; what
   * Jaroku owns — whether an edit was proposed, applied or dismissed, and which version came out —
   * is written only by the paths that actually do those things. A sync that reset it would make the
   * REVIEW region forget every answered comment on the next panel open.
   *
   * `synced_at` MOVES ON EVERY PASS, so a comment that has stopped arriving from GitHub — deleted,
   * or on a pull request that closed — is identifiable as stale rather than indistinguishable from
   * one nobody has looked at.
   */
  async upsert(
    ctx: TenantContext,
    input: {
      agentId: string;
      linkId?: string | null;
      prNumber: number;
      githubCommentId: string;
      inReplyToId?: string | null;
      authorLogin?: string | null;
      path?: string | null;
      line?: number | null;
      body: string;
      commitSha?: string | null;
      createdAt: string;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT id FROM pr_comments WHERE workspace_id = ? AND github_comment_id = ?`,
      [ctx.workspaceId, input.githubCommentId],
    );
    if (existing) {
      await this.q(ctx).run(
        `UPDATE pr_comments
            SET author_login = ?, path = ?, line = ?, body = ?, commit_sha = ?, synced_at = ?
          WHERE workspace_id = ? AND id = ?`,
        [
          input.authorLogin ?? null, input.path ?? null, input.line ?? null, input.body,
          input.commitSha ?? null, now, ctx.workspaceId, String(existing["id"]),
        ],
      );
      return;
    }
    await this.q(ctx).run(
      `INSERT INTO pr_comments
         (id, workspace_id, agent_id, link_id, pr_number, github_comment_id, in_reply_to_id,
          author_login, path, line, body, commit_sha, synced_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), ctx.workspaceId, input.agentId, input.linkId ?? null, input.prNumber,
        input.githubCommentId, input.inReplyToId ?? null, input.authorLogin ?? null,
        input.path ?? null, input.line ?? null, input.body, input.commitSha ?? null,
        now, input.createdAt,
      ],
    );
  }

  /**
   * The REVIEW region's read: this pull request's comments, oldest first.
   *
   * OLDEST FIRST, which is the order a conversation is read in — and the opposite of every other
   * list in this panel, which is newest first because it is a history. A review is not a history;
   * it is a discussion, and reading it backwards would put a reply above the thing it answers.
   */
  async forPr(ctx: TenantContext, agentId: string, prNumber: number, limit = 100): Promise<PrComment[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM pr_comments
        WHERE workspace_id = ? AND agent_id = ? AND pr_number = ?
        ORDER BY created_at ASC, id ASC LIMIT ?`,
      [ctx.workspaceId, agentId, prNumber, limit],
    );
    return rows.map((r) => this.hydrate(r));
  }

  async byId(ctx: TenantContext, id: string): Promise<PrComment | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM pr_comments WHERE workspace_id = ? AND id = ?`,
      [ctx.workspaceId, id],
    );
    return row ? this.hydrate(row) : undefined;
  }

  /** Record what Jaroku did. Written by the edit loop and by the dismiss control, never by a sync. */
  async setResolution(
    ctx: TenantContext,
    id: string,
    resolution: CommentResolution,
    resolvedVersion?: number | null,
  ): Promise<void> {
    await this.q(ctx).run(
      `UPDATE pr_comments SET resolution = ?, resolved_version = ? WHERE workspace_id = ? AND id = ?`,
      [resolution, resolvedVersion ?? null, ctx.workspaceId, id],
    );
  }

  /**
   * Record that the threaded reply reached GitHub.
   *
   * SEPARATE FROM `setResolution` BECAUSE THE TWO FAIL INDEPENDENTLY. An edit can land and the
   * reply can 500 — a row that conflated them would either claim the work was not done or claim the
   * teammate was told. §B.5.3's whole promise is that somebody who never opens Jaroku sees the
   * conversation resolve in place, and a silently-failed reply is that promise broken invisibly.
   */
  async markReplied(ctx: TenantContext, id: string): Promise<void> {
    await this.q(ctx).run(
      `UPDATE pr_comments SET replied_at = ? WHERE workspace_id = ? AND id = ?`,
      [new Date().toISOString(), ctx.workspaceId, id],
    );
  }
}
