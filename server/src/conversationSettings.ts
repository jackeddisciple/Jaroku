// Per-conversation composer settings — reasoning effort and permission mode, with the workspace
// default underneath both.
//
// THE ABSENT ROW IS THE POINT. §7's migration note refuses a backfill: "conversation_settings rows
// are created lazily on first change, falling back to workspace defaults. Do not backfill a row per
// conversation." So every read here is a three-level resolution — conversation, then workspace,
// then Jaroku's own default — and `effective()` is the only function anything outside this module
// should call. A caller that read the row directly would see NULL and have to decide for itself
// what that means, which is how two surfaces end up disagreeing about what a conversation is set to.
//
// A NULL COLUMN IS NOT A LEVEL. A row can exist because somebody set the permission mode while
// leaving effort alone. Writing 'medium' into the effort column at that moment would freeze that
// conversation at today's default forever, and a later change to the workspace default would move
// every conversation except the ones somebody had touched — which is precisely backwards.
//
// EVERY METHOD TAKES A `TenantContext` FIRST, and on SQLite that parameter IS the tenancy boundary
// (migration 009 grants that driver no RLS at all). There is no method here that finds a
// conversation's settings by id alone.
//
//   npm run test:conversation-settings

import { asBool, type Db, type Queryable } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";
import { DEFAULT_EFFORT, isEffort, type Effort } from "./effort.ts";

/**
 * §3.2's three, and there is no fourth.
 *
 * "Three modes only. There is no 'approve everything' mode, and adding one later is a product
 * decision, not an implementation shortcut." The union is that sentence in the type system; the
 * CHECK constraint in migration 054 is the same sentence in the schema. Both exist because the
 * shortcut this rules out is a one-line change that nobody would notice in review.
 */
export const PERMISSION_MODES = ["strict", "smart", "fast"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === "string" && (PERMISSION_MODES as readonly string[]).includes(v);
}

/** Confirm writes and destructive calls, auto-approve reads. The middle of the three. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "smart";

/** What is actually in effect, after the workspace default and Jaroku's own have been applied. */
export interface EffectiveSettings {
  effort: Effort;
  permissionMode: PermissionMode;
  /** True when a workspace admin has pinned the mode — the control renders read-only (§3.2). */
  pinned: boolean;
  /** True when Fast is disallowed workspace-wide. The option renders disabled, not hidden. */
  fastDisallowed: boolean;
  /** Whether the conversation has a row at all. Drives nothing in the UI; useful in the suite. */
  explicit: { effort: boolean; permissionMode: boolean };
}

/** The workspace's own defaults, resolved. */
export interface WorkspaceDefaults {
  effort: Effort;
  permissionMode: PermissionMode;
  pinned: boolean;
  fastDisallowed: boolean;
}

const nowIso = (): string => new Date().toISOString();

/**
 * Refuse Fast when the workspace has disallowed it, whatever the stored row says.
 *
 * The fall-back-to-the-fall-back is not paranoia: an admin can disallow Fast while the workspace
 * default is itself Fast, which is a contradictory configuration a UI should prevent and a
 * resolver must survive. Returning Fast because the default said so would make the policy
 * self-defeating, so the last resort is Jaroku's own Smart.
 */
function withoutDisallowedFast(mode: PermissionMode, defaults: WorkspaceDefaults): PermissionMode {
  if (!defaults.fastDisallowed || mode !== "fast") return mode;
  return defaults.permissionMode === "fast" ? DEFAULT_PERMISSION_MODE : defaults.permissionMode;
}

export class ConversationSettingsStore {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  /** The workspace's defaults, with Jaroku's underneath whichever the admin has not set. */
  async workspaceDefaults(ctx: TenantContext): Promise<WorkspaceDefaults> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT default_reasoning_effort, default_permission_mode,
              permission_mode_pinned, permission_fast_disallowed
         FROM workspaces WHERE id = ?`,
      [ctx.workspaceId],
    );
    return {
      effort: isEffort(row?.default_reasoning_effort) ? row.default_reasoning_effort : DEFAULT_EFFORT,
      permissionMode: isPermissionMode(row?.default_permission_mode)
        ? row.default_permission_mode
        : DEFAULT_PERMISSION_MODE,
      // INTEGER 0/1 on SQLite, boolean on Postgres. A truthy check on the raw column would make
      // `0` false on one driver and `false` false on both — the parity bug `test:boolean-literals`
      // exists for.
      pinned: asBool(row?.permission_mode_pinned),
      fastDisallowed: asBool(row?.permission_fast_disallowed),
    };
  }

  /**
   * What this conversation is actually set to.
   *
   * THE ONLY READ ANYTHING OUTSIDE THIS MODULE SHOULD USE, including the dispatch path. §3.2's
   * enforcement rules are about the mode in EFFECT, and a caller that resolved the fallback itself
   * would be a second implementation of the fallback — which is one more than the number that can
   * be kept in agreement.
   */
  async effective(ctx: TenantContext, conversationId: string): Promise<EffectiveSettings> {
    const defaults = await this.workspaceDefaults(ctx);
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT reasoning_effort, permission_mode
         FROM conversation_settings
        WHERE workspace_id = ? AND conversation_id = ?`,
      [ctx.workspaceId, conversationId],
    );

    const ownEffort = isEffort(row?.reasoning_effort) ? row.reasoning_effort : null;
    const ownMode = isPermissionMode(row?.permission_mode) ? row.permission_mode : null;

    // A PINNED WORKSPACE OVERRIDES THE CONVERSATION, not the other way round. §3.2: "A workspace
    // admin can pin the default and disallow Fast". A pin that a conversation could still opt out
    // of would be a suggestion, and the control renders read-only precisely because it is not one.
    const mode = defaults.pinned ? defaults.permissionMode : (ownMode ?? defaults.permissionMode);

    return {
      effort: ownEffort ?? defaults.effort,
      // AND FAST IS REFUSED EVEN WHEN A ROW ALREADY SAYS FAST. An admin can disallow Fast after
      // somebody has already chosen it, and a stored value that outlived the policy is exactly the
      // case where reading the column and trusting it is wrong.
      permissionMode: withoutDisallowedFast(mode, defaults),
      pinned: defaults.pinned,
      fastDisallowed: defaults.fastDisallowed,
      explicit: { effort: ownEffort !== null, permissionMode: ownMode !== null },
    };
  }

  /**
   * Set one or both, creating the row if this is the first change.
   *
   * `undefined` LEAVES A FIELD ALONE; `null` CLEARS IT BACK TO THE WORKSPACE DEFAULT. Those are
   * genuinely different requests and a single "not set" would collapse them: PATCHing only the
   * permission mode must not silently pin the effort at whatever the default happened to be that
   * afternoon, and "go back to inheriting" needs a way to be said.
   *
   * Returns the settings as they now are, resolved — so the caller answers the client with the
   * effective values rather than with what it asked for, which are not the same thing when a
   * workspace has pinned the mode.
   */
  async set(
    ctx: TenantContext,
    conversationId: string,
    patch: { effort?: Effort | null; permissionMode?: PermissionMode | null },
    actorUserId: string | null,
  ): Promise<EffectiveSettings> {
    const q = this.q(ctx);
    const now = nowIso();

    const existing = await q.get<Record<string, unknown>>(
      `SELECT reasoning_effort, permission_mode
         FROM conversation_settings
        WHERE workspace_id = ? AND conversation_id = ?`,
      [ctx.workspaceId, conversationId],
    );

    // Read-modify-write rather than a dialect-specific upsert with COALESCE. Both drivers spell
    // `ON CONFLICT … DO UPDATE` differently enough that the SQL would fork, and this store's whole
    // job is small enough that one extra SELECT is cheaper than a second query per dialect —
    // which is where the four Postgres dialect bugs of 21 August came from.
    const effort = patch.effort === undefined
      ? (isEffort(existing?.reasoning_effort) ? existing.reasoning_effort : null)
      : patch.effort;
    const mode = patch.permissionMode === undefined
      ? (isPermissionMode(existing?.permission_mode) ? existing.permission_mode : null)
      : patch.permissionMode;

    if (existing) {
      await q.run(
        `UPDATE conversation_settings
            SET reasoning_effort = ?, permission_mode = ?, updated_by = ?, updated_at = ?
          WHERE workspace_id = ? AND conversation_id = ?`,
        [effort, mode, actorUserId, now, ctx.workspaceId, conversationId],
      );
    } else {
      await q.run(
        `INSERT INTO conversation_settings
           (workspace_id, conversation_id, reasoning_effort, permission_mode, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [ctx.workspaceId, conversationId, effort, mode, actorUserId, now],
      );
    }

    return this.effective(ctx, conversationId);
  }

  /**
   * The workspace-level pin, for an admin.
   *
   * Here rather than in a workspace repository because the columns are this feature's and the
   * fallback rule that reads them is directly above. A setting whose meaning lives in one file and
   * whose write lives in another is a setting that acquires a second meaning.
   */
  async setWorkspaceDefaults(
    ctx: TenantContext,
    patch: {
      effort?: Effort | null;
      permissionMode?: PermissionMode | null;
      pinned?: boolean;
      fastDisallowed?: boolean;
    },
  ): Promise<WorkspaceDefaults> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.effort !== undefined) { sets.push("default_reasoning_effort = ?"); params.push(patch.effort); }
    if (patch.permissionMode !== undefined) { sets.push("default_permission_mode = ?"); params.push(patch.permissionMode); }
    // 0/1 rather than false/true. On SQLite the column is INTEGER, and the string 'false' stored
    // there is truthy on every read forever — see `test:boolean-literals`.
    if (patch.pinned !== undefined) { sets.push("permission_mode_pinned = ?"); params.push(patch.pinned ? 1 : 0); }
    if (patch.fastDisallowed !== undefined) { sets.push("permission_fast_disallowed = ?"); params.push(patch.fastDisallowed ? 1 : 0); }

    if (sets.length > 0) {
      params.push(ctx.workspaceId);
      await this.q(ctx).run(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`, params);
    }
    return this.workspaceDefaults(ctx);
  }
}
