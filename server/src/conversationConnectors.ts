// Which connectors' tools a conversation may reach.
//
// THE ABSENT ROW MEANS "YES", which is the opposite of `conversation_settings` and is the right
// way round for the same reason that one is the other way round. A settings row that did not exist
// means "inherit"; a connector row that does not exist means "nobody has switched this off". A
// conversation started before Notion was connected should be able to reach Notion, and a backfill
// would have frozen every conversation's list at the moment of migration.
//
// SO `enabledFor` TAKES THE WORKSPACE'S CONNECTORS AS INPUT rather than returning a list of its
// own. This table records DECISIONS, not membership — it has no idea what a workspace has
// connected, and a version of it that thought it did would be a second, stale copy of the
// connector list.
//
// AND THE DISPATCH PATH IS THE POINT. §12.10: "Disabling a connector for a conversation removes
// its tools from that conversation's dispatch and leaves the workspace connection intact." A
// toggle that only dimmed a logo would leave the tool in the dispatch, the model would call it
// anyway, and the user would conclude the control does nothing — the same failure the permission
// shield would have if the client were the thing deciding.
//
//   The route suite (npm run test:conversation-routes) is what exercises this store: it drives
//   the same absent-row rule, the same write, and the dispatch read, through the surface a client
//   actually reaches. A second suite over the class alone would restate those in a shape nothing
//   calls.

import { asBool, type Db, type Queryable } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";

const nowIso = (): string => new Date().toISOString();

export class ConversationConnectorStore {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  /**
   * The decisions recorded for one conversation, as a map.
   *
   * A MAP RATHER THAN A LIST, because every caller is asking "is this one on" about a connector it
   * already has in hand. Returning rows would make each of them build this map itself.
   */
  async decisionsFor(ctx: TenantContext, conversationId: string): Promise<Map<string, boolean>> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT connector_id, enabled FROM conversation_connectors
        WHERE workspace_id = ? AND conversation_id = ?`,
      [ctx.workspaceId, conversationId],
    );
    // INTEGER 0/1 on SQLite, boolean on Postgres. A truthy check on the raw column would make `0`
    // false on one driver and `false` false on both — and here that means a connector somebody
    // switched off staying reachable by the model. See `test:boolean-literals`.
    return new Map(rows.map((r) => [String(r["connector_id"]), asBool(r["enabled"])]));
  }

  /**
   * Which of these connectors this conversation may use.
   *
   * `available` is what the WORKSPACE has. The answer is that list minus anything explicitly
   * switched off — never a list assembled from this table, which knows about decisions and not
   * about membership.
   */
  async enabledFor(
    ctx: TenantContext,
    conversationId: string,
    available: readonly string[],
  ): Promise<string[]> {
    const decisions = await this.decisionsFor(ctx, conversationId);
    // `?? true` is the absent-row rule, in one operator: a connector nobody has ruled on is on.
    return available.filter((id) => decisions.get(id) ?? true);
  }

  /**
   * Record a decision.
   *
   * WRITTEN EVEN WHEN THE VALUE IS THE DEFAULT. Turning something back on writes `true` over the
   * existing row rather than deleting it, so "deliberately re-enabled" and "never touched" stay
   * distinguishable — which matters the first time somebody asks why a conversation started using
   * Slack again.
   */
  async set(
    ctx: TenantContext,
    conversationId: string,
    connectorId: string,
    enabled: boolean,
    actorUserId: string | null,
  ): Promise<void> {
    const q = this.q(ctx);
    const now = nowIso();
    const existing = await q.get(
      `SELECT connector_id FROM conversation_connectors
        WHERE workspace_id = ? AND conversation_id = ? AND connector_id = ?`,
      [ctx.workspaceId, conversationId, connectorId],
    );
    // Read-modify-write rather than a dialect-specific upsert, for the reason
    // conversationSettings.ts gives at length: the two drivers spell `ON CONFLICT` differently
    // enough that the SQL would fork, and a forked statement is where the Postgres dialect bugs
    // came from.
    if (existing) {
      await q.run(
        `UPDATE conversation_connectors
            SET enabled = ?, updated_by = ?, updated_at = ?
          WHERE workspace_id = ? AND conversation_id = ? AND connector_id = ?`,
        // 0/1, never the strings — see `decisionsFor`.
        [enabled ? 1 : 0, actorUserId, now, ctx.workspaceId, conversationId, connectorId],
      );
    } else {
      await q.run(
        `INSERT INTO conversation_connectors
           (workspace_id, conversation_id, connector_id, enabled, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [ctx.workspaceId, conversationId, connectorId, enabled ? 1 : 0, actorUserId, now],
      );
    }
  }

  /** Several at once — what a PUT of the whole map does, without a round trip per connector. */
  async setMany(
    ctx: TenantContext,
    conversationId: string,
    map: Record<string, boolean>,
    actorUserId: string | null,
  ): Promise<void> {
    // One transaction, so a PUT of five toggles cannot land as three. A half-applied connector map
    // is a conversation whose dispatch nobody chose.
    await this.db.scoped(ctx.workspaceId, async () => {
      for (const [connectorId, enabled] of Object.entries(map)) {
        await this.set(ctx, conversationId, connectorId, enabled, actorUserId);
      }
    });
  }
}
