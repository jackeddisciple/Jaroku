// Deleting a workspace, everywhere it exists, and writing down what happened.
//
// "DELETE MY DATA" IS A CLAIM ABOUT FIVE SYSTEMS, and a delete that only touches one of them is
// a lie told confidently. A workspace's data is rows in Postgres, objects in R2, checkpoint
// threads in another schema, jobs sitting in a Redis queue, and — the one nobody remembers —
// GRANTS AT SOMEBODY ELSE'S COMPANY. A user who deletes their workspace and still appears in
// their own Google account's connected-apps list has not had their data deleted; they have had
// our copy of it forgotten, which is a different sentence.
//
// THE ORDER IS THE DESIGN, and each step is placed where it is because of what fails if it is
// not:
//
//   1. MARK IT DELETED FIRST. Everything below takes time and some of it fails; a workspace that
//      is still accepting runs while its objects are being deleted produces a run that cannot
//      read its own agent. The mark is what makes the rest a cleanup rather than a race.
//
//   2. REVOKE AT THE PROVIDER SECOND, while the credentials still exist to revoke with. Deleting
//      the vault first would make this impossible forever — the refresh token is the only thing
//      that can end its own grant, and once it is gone the grant outlives us.
//
//   3. PURGE THE QUEUE. A job admitted before step 1 is already running and will finish; one
//      still waiting must not start against a workspace that no longer has files.
//
//   4. OBJECTS, then CHECKPOINTS, then ROWS. Rows last because they are the index: the run ids
//      whose checkpoints need sweeping and the agent ids whose objects need deleting are IN the
//      rows, and a cascade that ran first would leave both orphaned with nothing pointing at
//      them. This is the same reasoning the retention sweeper uses at a smaller scale.
//
//   5. THE RECEIPT, into `audit_log`, which is deliberately not cascaded away. Its `workspace_id`
//      is nullable and is NOT a foreign key — migration 004 made that choice for the cross-tenant
//      denial rows, and it pays off here: the record of a deletion survives the deletion. A
//      receipt inside the thing being deleted would be a receipt nobody can produce.
//
// WHAT A RECEIPT PROMISES IS WHAT ACTUALLY HAPPENED, including the parts that failed. A provider
// that could not be reached leaves a grant standing, and the receipt says so by name rather than
// reporting a clean deletion — because the number in it is what somebody would cite when asked
// whether the data is gone.

import type { Db } from "../db/db.ts";
import type { ObjectStore } from "../storage/objectStore.ts";
import { workspacePrefix } from "../storage/keys.ts";
import type { CheckpointStore } from "../checkpoints/store.ts";
import type { IdentityRepository } from "../db/repositories/identity.ts";
import type { SystemContext, TenantContext } from "../db/tenant.ts";
import { newRequestId, systemContextFor } from "../db/tenant.ts";

/** Everything deleting a workspace has to reach. Each one is a system that can fail on its own. */
export interface DeletionDeps {
  db: Db;
  identity: IdentityRepository;
  objects: ObjectStore;
  checkpoints: CheckpointStore;
  /**
   * End the workspace's grants at the providers that issued them.
   *
   * Session 7 built this and named it "the provider-side half of the workspace deletion Session 8
   * owns". Optional, because a deployment with no OAuth apps configured has nothing to revoke and
   * should not need to construct a revoker to delete a workspace.
   */
  endGrants?: (ctx: TenantContext) => Promise<{ revoked: number; failed: string[]; credentialsDeleted: number }>;
  /** Remove not-yet-admitted jobs. Best-effort: an admitted one is already running. */
  purgeQueue?: (ctx: TenantContext) => Promise<number>;
  log?: (line: string) => void;
  now?: () => number;
}

export interface DeletionReceipt {
  workspaceId: string;
  requestedBy: string | null;
  startedAt: string;
  finishedAt: string;
  rowsDeleted: Record<string, number>;
  objectsDeleted: number;
  checkpointsSwept: number;
  jobsPurged: number;
  grantsRevoked: number;
  /** Providers that could not be told. Named, because a standing grant is not a clean deletion. */
  grantsFailed: string[];
  credentialsDeleted: number;
}

/**
 * The tables a workspace's rows live in, children before parents.
 *
 * EXPLICIT RATHER THAN LEFT TO `ON DELETE CASCADE`, and the reason is not distrust of the
 * database. It is that the cascade exists only on Postgres, that SQLite's is only enforced with
 * `PRAGMA foreign_keys` on, and that a receipt has to say HOW MANY rows went — which a cascade
 * performs silently. Deleting them by name gives one number per table on both drivers, and the
 * cascade remains underneath as the backstop for anything this list forgets.
 */
const DELETION_ORDER = [
  "eval_scores",
  "eval_jobs",
  "eval_runs",
  "rubrics",
  "dataset_examples",
  "datasets",
  "steps",
  "runs",
  "mcp_tools",
  "mcp_servers",
  "deployment_logs",
  "deployments",
  // Before `agents`, and in this order among themselves: events reference links, links reference
  // installations, and all three reference the agent. The cascades would take them anyway —
  // naming them puts their counts in the receipt, and a deletion nobody can read the extent of is
  // a deletion nobody can defend.
  //
  // NOTHING IS DONE TO THE REPOSITORIES THEMSELVES, here or anywhere. §6's rule holds at the
  // workspace scale exactly as it does for one agent: deleting a Jaroku workspace deletes Jaroku's
  // record of where the code went, and leaves the user's repos untouched. The alternative — a
  // "clean up" that reached into somebody's GitHub account — is not a trade this product makes.
  "github_events",
  "github_links",
  "github_installations",
  // Before `agents`, and that ordering is the one place this list disagrees with the rest of the
  // schema on purpose. Everywhere else a child is deleted first because its cascade would take it
  // anyway; a thread's foreign key is ON DELETE SET NULL, so deleting `agents` first would leave
  // every thread in the workspace standing with a nulled agent and a snapshot — rows that are then
  // deleted a line later, having been pointlessly rewritten first. Deleting threads before the
  // agents they point at is one statement instead of two, and the receipt's count is the same.
  "threads",
  "agent_versions",
  "agents",
  "usage_events",
  "billing_holds",
  "workspace_balances",
  "subscriptions",
  // Before `secret_refs`, which both of them reference on the (workspace_id, name) pair. The
  // cascade would take them anyway; naming them here puts their counts in the receipt, and a
  // deletion nobody can read the extent of is a deletion nobody can defend.
  "secret_usages",
  "secret_rotations",
  "secret_refs",
  "workspace_secrets",
  "workspace_data_keys",
  // The secrets gate's own state. `secret_elevations` first: an authorisation outliving the
  // workspace it authorises is a small window, and it costs one line to not have it.
  "secret_elevations",
  "user_secret_passcodes",
  "oauth_states",
  "oauth_connections",
  "ws_tickets",
  "workspace_invites",
  "abuse_signals",
  "workspace_enforcements",
  "workspace_members",
] as const;

/** Tables whose scope is not a column of their own — same exception the export makes. */
const INDIRECT_SCOPE: Record<string, string> = {
  agent_versions: `agent_id IN (SELECT id FROM agents WHERE workspace_id = ?)`,
  deployment_logs: `deployment_id IN (SELECT id FROM deployments WHERE workspace_id = ?)`,
};

export class WorkspaceDeleter {
  private log: (line: string) => void;
  private now: () => number;

  constructor(private deps: DeletionDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
    this.now = deps.now ?? Date.now;
  }

  /**
   * Delete a workspace and everything of it, and return the receipt.
   *
   * NOT A TRANSACTION, and it cannot be one: it spans an object store, a queue and somebody
   * else's API, none of which can join a database transaction — and a delete held open across a
   * network call to Google is a lock held for as long as Google takes. What makes it safe
   * instead is the ORDER above and the fact that every step is idempotent: a deletion
   * interrupted halfway can be run again and will finish, which is a stronger property than
   * atomicity would have been here.
   */
  async deleteWorkspace(ctx: TenantContext): Promise<DeletionReceipt> {
    const startedAt = new Date(this.now()).toISOString();
    const receipt: DeletionReceipt = {
      workspaceId: ctx.workspaceId,
      requestedBy: ctx.actorUserId,
      startedAt,
      finishedAt: startedAt,
      rowsDeleted: {},
      objectsDeleted: 0,
      checkpointsSwept: 0,
      jobsPurged: 0,
      grantsRevoked: 0,
      grantsFailed: [],
      credentialsDeleted: 0,
    };

    // 1. Nothing new starts. Soft first, so the rest of this is a cleanup rather than a race.
    await this.deps.db.run(`UPDATE workspaces SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, [
      startedAt,
      ctx.workspaceId,
    ]);

    // 2. The grants, while the credentials that can end them still exist.
    if (this.deps.endGrants) {
      try {
        const ended = await this.deps.endGrants(ctx);
        receipt.grantsRevoked = ended.revoked;
        receipt.grantsFailed = ended.failed;
        receipt.credentialsDeleted = ended.credentialsDeleted;
      } catch (err) {
        // Recorded, not fatal. A provider being down must not leave a workspace half-deleted
        // forever — and the receipt saying which grant is still standing is the honest outcome.
        receipt.grantsFailed.push(`revocation failed: ${(err as Error)?.message ?? err}`);
      }
    }

    // 3. Work that has not started.
    if (this.deps.purgeQueue) {
      receipt.jobsPurged = await this.deps.purgeQueue(ctx).catch(() => 0);
    }

    // 4a. Objects: every key under the workspace's own prefix. The prefix is derived from a
    // validated uuid, which is the property that makes "delete everything under here" safe.
    receipt.objectsDeleted = await this.deps.objects
      .deletePrefix(workspacePrefix(ctx.workspaceId))
      .catch((err) => {
        this.log(`[deletion] ${ctx.workspaceId} objects: ${(err as Error)?.message ?? err}`);
        return 0;
      });

    // 4b. Checkpoints, for the runs this workspace's own rows name — and, on the hosted store
    // only, for whatever else it is holding under this workspace's thread prefix.
    //
    // THE SPLIT IS NOT FASTIDIOUSNESS. `FileCheckpointStore.runsHeld` ignores the context it is
    // given, because locally `.checkpoints/` is one flat directory and a file has no workspace on
    // it. That is correct for the single-user path it was written for, and asking it here — where
    // the answer is used to DELETE — would sweep every other workspace's checkpoints on a
    // multi-workspace dev database. The suite beside this file caught exactly that. So the run
    // ids come from the scoped `runs` table, which is authoritative on both drivers, and
    // `runsHeld` is consulted only on the store whose implementation genuinely filters by
    // workspace (it queries `thread_id LIKE 'ws:<id>:%'`).
    try {
      const runRows = await this.deps.db
        .forWorkspace(ctx.workspaceId)
        .all<{ id: string }>(`SELECT id FROM runs WHERE workspace_id = ?`, [ctx.workspaceId]);
      const runIds = new Set(runRows.map((r) => r.id));
      if (this.deps.checkpoints.kind === "postgres") {
        for (const id of await this.deps.checkpoints.runsHeld(ctx)) runIds.add(id);
      }
      if (runIds.size) {
        const swept = await this.deps.checkpoints.sweepRuns(ctx, [...runIds]);
        receipt.checkpointsSwept = swept.removed;
      }
    } catch (err) {
      this.log(`[deletion] ${ctx.workspaceId} checkpoints: ${(err as Error)?.message ?? err}`);
    }

    // 4c. The rows, children before parents.
    for (const table of DELETION_ORDER) {
      const where = INDIRECT_SCOPE[table] ?? `workspace_id = ?`;
      try {
        const res = await this.deps.db.scoped(ctx.workspaceId, async (tx) =>
          tx.run(`DELETE FROM ${table} WHERE ${where}`, [ctx.workspaceId]),
        );
        if (res.changes > 0) receipt.rowsDeleted[table] = res.changes;
      } catch (err) {
        // A table this deployment does not have. Recorded and skipped: a deletion that stops at
        // the first unknown table leaves everything after it behind.
        this.log(`[deletion] ${ctx.workspaceId} ${table}: ${(err as Error)?.message ?? err}`);
      }
    }

    // 5. The workspace itself, hard. The soft mark above stopped new work; this is what makes
    // the slug free again and the row genuinely gone.
    const removed = await this.deps.db.run(`DELETE FROM workspaces WHERE id = ?`, [ctx.workspaceId]);
    if (removed.changes > 0) receipt.rowsDeleted["workspaces"] = removed.changes;

    receipt.finishedAt = new Date(this.now()).toISOString();

    // 6. The receipt, into the one table that survives this. See the header.
    await this.deps.identity.appendAudit(ctx, {
      // NULL, deliberately: the workspace no longer exists, and a row pointing at a deleted id
      // would be a dangling reference in the table whose job is to outlive the thing it records.
      workspaceId: null,
      actorUserId: ctx.actorUserId,
      action: "workspace.deleted",
      targetType: "workspace",
      targetId: ctx.workspaceId,
      metadata: { ...receipt },
    });
    this.log(
      `[deletion] ${ctx.workspaceId} deleted — ` +
        `${Object.values(receipt.rowsDeleted).reduce((a, b) => a + b, 0)} row(s), ` +
        `${receipt.objectsDeleted} object(s), ${receipt.grantsRevoked} grant(s) revoked` +
        (receipt.grantsFailed.length ? `, ${receipt.grantsFailed.length} grant(s) STILL STANDING` : ""),
    );
    return receipt;
  }

  /**
   * Delete an account: the person, and whatever only they were holding.
   *
   * THE HARD QUESTION IS THE SHARED WORKSPACE, and the answer is that a team's data is not one
   * member's to take. So: their personal workspace is deleted outright, a workspace where they
   * are the last owner is deleted (nobody else can administer it, and leaving it would be
   * leaving an unbillable, unmanageable object behind), and a workspace with another owner
   * simply loses a member. That is the same rule `removeMember` already enforces from the other
   * direction — a workspace must keep at least one owner — applied to somebody leaving entirely.
   */
  async deleteAccount(sys: SystemContext, userId: string): Promise<{ receipts: DeletionReceipt[]; leftBehind: string[] }> {
    const memberships = await this.deps.identity.workspacesForUser(sys, userId);
    const receipts: DeletionReceipt[] = [];
    const leftBehind: string[] = [];

    for (const ws of memberships) {
      const ctx = { ...systemContextFor(ws.id, newRequestId()), actorUserId: userId };
      const owners = (await this.deps.identity.listMembers(ctx)).filter((m) => m.role === "owner");
      const soleOwner = owners.length === 1 && owners[0]!.user_id === userId;
      if (ws.kind === "personal" || soleOwner) {
        receipts.push(await this.deleteWorkspace(ctx));
      } else {
        await this.deps.identity.removeMember(ctx, userId);
        leftBehind.push(ws.id);
      }
    }

    // The person, soft-deleted rather than removed. Their id appears on other people's audit
    // rows — "who invited this member", "who applied this enforcement" — and deleting the row
    // would either cascade those away or leave them pointing at nothing. What is removed is
    // everything that identifies them.
    await this.deps.db.run(
      `UPDATE users SET deleted_at = ?, email = ?, display_name = NULL, external_id = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [
        new Date(this.now()).toISOString(),
        // Unique per user, so the column's UNIQUE constraint survives, and unusable as an
        // address. The same shape for `external_id`, which is what a provider's `sub` maps
        // through — a deleted account must not be reachable by signing in again.
        `deleted+${userId}@invalid`,
        `deleted:${userId}`,
        userId,
      ],
    );

    await this.deps.identity.appendAudit(sys, {
      workspaceId: null,
      actorUserId: userId,
      action: "account.deleted",
      targetType: "user",
      targetId: userId,
      metadata: { workspacesDeleted: receipts.map((r) => r.workspaceId), workspacesLeft: leftBehind },
    });
    return { receipts, leftBehind };
  }
}
