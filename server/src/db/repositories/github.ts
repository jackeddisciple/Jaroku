// The three GitHub tables, behind one repository.
//
// One class rather than three, because the three tables are never read apart. Every question the
// panel asks — "am I linked", "how far apart are we", "what happened last" — needs the link and
// the grant behind it in the same breath, and the event log is written by the same operations that
// move the link. Three repositories would mean three contexts threaded through one handler and
// three places to forget the workspace half of a composite key.
//
// EVERY METHOD TAKES A `TenantContext` FIRST, and every statement carries `workspace_id` in its
// WHERE even where a uuid primary key would have been enough on its own. That is not belt and
// braces: on SQLite there is no RLS at all (see migration 009), so the WHERE clause here IS the
// tenancy boundary on one of the two supported drivers. A method that found a row by id alone
// would work identically in every test and be a cross-tenant read in production on the driver
// that has no policies.
//
// NOTHING HERE RETURNS A TOKEN. `token_secret_name` is a name in the SecretStore and is returned
// as one, because the caller's next move is to ask the store for a value it will hand straight to
// an HTTPS request. A repository that resolved the name would be a repository that could put a
// credential in a JSON response by accident.

import { randomUUID } from "node:crypto";

import { asBool, jsonFromColumn, type Db, type Queryable } from "../db.ts";
import type { TenantContext } from "../tenant.ts";

/** How the grant was obtained. Only `user` is implemented; see migration 034. */
export type GithubAccountType = "user" | "org";

export interface GithubInstallation {
  id: string;
  user_id: string | null;
  account_login: string;
  account_type: GithubAccountType;
  /** A name in the SecretStore, never a value. `APP_GRANT` on an App row — see migration 042. */
  token_secret_name: string;
  scopes: string[];
  installed_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  /**
   * GitHub's own id for the installation, or null on a personal-access-token row.
   *
   * THE FIELD THAT TELLS THE TWO PATHS APART, and the only one that needs to: an App grant stores
   * an id and mints a token per call, a PAT grant stores a secret name and reads it. `apiFor` is
   * the one place that branches on this.
   */
  github_installation_id: string | null;
  /** SecretStore name for the user-to-server token — the three user-scoped calls. Never a value. */
  user_token_secret_name: string | null;
  /** When that token dies. Null means it does not expire, which is an App setting, not unknown. */
  user_token_expires_at: string | null;
  user_refresh_secret_name: string | null;
}

/**
 * What `token_secret_name` holds on an App row.
 *
 * A SENTINEL RATHER THAN A NULL, because 034 made the column NOT NULL and because a person reading
 * this table in a database console should get a sentence rather than a blank. It names no secret
 * and nothing ever looks it up: an App grant's credential is minted, not stored.
 */
export const APP_GRANT = "__github_app_installation__";

export interface GithubLink {
  id: string;
  agent_id: string;
  installation_id: string;
  repo_full_name: string;
  branch: string;
  /** null means the repository root. Never an empty string — see migration 034. */
  subdirectory: string | null;
  include_artifacts: boolean;
  last_pushed_version_id: string | null;
  last_pushed_sha: string | null;
  last_known_remote_sha: string | null;
  last_synced_at: string | null;
  created_at: string;
}

export type GithubEventKind =
  | "link" | "unlink" | "push" | "fetch" | "pull" | "pr_open" | "force_override" | "branch_switch";

/**
 * How it went.
 *
 * `refused` is not a failure and is kept apart from one deliberately. A pull that validation
 * turned away is Jaroku's own bar being applied to somebody else's code — the thing §3.6 exists to
 * do — and collapsing it into `failed` would put a working safety guarantee in the same bucket as
 * a network timeout.
 */
export type GithubEventOutcome = "ok" | "refused" | "failed";

export interface GithubEvent {
  id: string;
  agent_id: string | null;
  link_id: string | null;
  kind: GithubEventKind;
  outcome: GithubEventOutcome;
  actor_user_id: string | null;
  version_ids: string[];
  commit_sha: string | null;
  detail: string | null;
  created_at: string;
}

export interface LinkInput {
  agentId: string;
  installationId: string;
  repoFullName: string;
  branch: string;
  subdirectory?: string | null;
  includeArtifacts?: boolean;
}

/**
 * A link and the workspace that owns it — what a cross-workspace lookup has to return.
 *
 * Only `linksForRepo` produces this, and only the webhook consumes it. Everywhere else the
 * workspace is already known before a link is fetched, which is the ordinary case and the one
 * `GithubLink` is shaped for.
 */
export interface LinkOwner {
  workspaceId: string;
  link: GithubLink;
}

/** The fields a sync updates. All optional: a fetch moves one of them and a push moves three. */
export interface LinkPatch {
  branch?: string;
  subdirectory?: string | null;
  includeArtifacts?: boolean;
  lastPushedVersionId?: string | null;
  lastPushedSha?: string | null;
  lastKnownRemoteSha?: string | null;
  lastSyncedAt?: string | null;
}

const INSTALLATION_COLUMNS = `id, user_id, account_login, account_type, token_secret_name, scopes,
                              installed_at, revoked_at, revoke_reason, github_installation_id,
                              user_token_secret_name, user_token_expires_at,
                              user_refresh_secret_name`;

const LINK_COLUMNS = `id, agent_id, installation_id, repo_full_name, branch, subdirectory,
                      include_artifacts, last_pushed_version_id, last_pushed_sha,
                      last_known_remote_sha, last_synced_at, created_at`;

const EVENT_COLUMNS = `id, agent_id, link_id, kind, outcome, actor_user_id, version_ids,
                       commit_sha, detail, created_at`;

/**
 * A JSON column, always as a list of strings.
 *
 * Both `scopes` and `version_ids` are string arrays, and both arrive as TEXT on SQLite and as a
 * parsed value on Postgres. Filtered rather than cast, because this is a column somebody can edit
 * by hand in a database console and a stray number would otherwise reach the UI as one.
 */
function stringList(dialect: Db["dialect"], v: unknown): string[] {
  const parsed = jsonFromColumn(dialect, v);
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
}

export class GithubRepository {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  private hydrateInstallation(row: Record<string, unknown>): GithubInstallation {
    return {
      id: String(row["id"]),
      user_id: (row["user_id"] as string | null) ?? null,
      account_login: String(row["account_login"]),
      account_type: row["account_type"] as GithubAccountType,
      token_secret_name: String(row["token_secret_name"]),
      scopes: stringList(this.db.dialect, row["scopes"]),
      installed_at: String(row["installed_at"]),
      revoked_at: (row["revoked_at"] as string | null) ?? null,
      revoke_reason: (row["revoke_reason"] as string | null) ?? null,
      github_installation_id: (row["github_installation_id"] as string | null) ?? null,
      user_token_secret_name: (row["user_token_secret_name"] as string | null) ?? null,
      user_token_expires_at: (row["user_token_expires_at"] as string | null) ?? null,
      user_refresh_secret_name: (row["user_refresh_secret_name"] as string | null) ?? null,
    };
  }

  private hydrateLink(row: Record<string, unknown>): GithubLink {
    return {
      id: String(row["id"]),
      agent_id: String(row["agent_id"]),
      installation_id: String(row["installation_id"]),
      repo_full_name: String(row["repo_full_name"]),
      branch: String(row["branch"]),
      // Normalised on the way out as well as on the way in, so a row written by hand with an
      // empty string cannot make the repo root have two spellings downstream.
      subdirectory: (row["subdirectory"] as string | null) || null,
      include_artifacts: asBool(row["include_artifacts"]),
      last_pushed_version_id: (row["last_pushed_version_id"] as string | null) ?? null,
      last_pushed_sha: (row["last_pushed_sha"] as string | null) ?? null,
      last_known_remote_sha: (row["last_known_remote_sha"] as string | null) ?? null,
      last_synced_at: (row["last_synced_at"] as string | null) ?? null,
      created_at: String(row["created_at"]),
    };
  }

  private hydrateEvent(row: Record<string, unknown>): GithubEvent {
    return {
      id: String(row["id"]),
      agent_id: (row["agent_id"] as string | null) ?? null,
      link_id: (row["link_id"] as string | null) ?? null,
      kind: row["kind"] as GithubEventKind,
      outcome: row["outcome"] as GithubEventOutcome,
      actor_user_id: (row["actor_user_id"] as string | null) ?? null,
      version_ids: stringList(this.db.dialect, row["version_ids"]),
      commit_sha: (row["commit_sha"] as string | null) ?? null,
      detail: (row["detail"] as string | null) ?? null,
      created_at: String(row["created_at"]),
    };
  }

  // --- the grant -------------------------------------------------------------

  /**
   * Record a linked GitHub account, or bring a revoked one back.
   *
   * UPSERT ON THE LIVE UNIQUE INDEX rather than insert-or-fail. Reconnecting the same account after
   * a token rotation is the ordinary recovery path — it is what the "GitHub access was revoked —
   * reconnect to push" reason sends somebody to do — and making it an error would mean the fix for
   * a broken link is "unlink first", which nobody would guess.
   *
   * `revoked_at` IS CLEARED ON THE WAY BACK IN. The partial index only covers live rows, so a
   * revoked row does not conflict and would otherwise be left behind as a second row for the same
   * account, half of them dead. Resurrecting the row rather than adding one keeps every
   * `github_events.link_id` and every `github_links.installation_id` pointing at the same grant it
   * always did.
   */
  async linkAccount(
    ctx: TenantContext,
    input: {
      accountLogin: string;
      accountType?: GithubAccountType;
      tokenSecretName: string;
      scopes?: string[];
      /** Set on an App grant. Its presence is what makes this row an installation — see 042. */
      githubInstallationId?: string | null;
      userTokenSecretName?: string | null;
      userTokenExpiresAt?: string | null;
      userRefreshSecretName?: string | null;
    },
  ): Promise<GithubInstallation> {
    const existing = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${INSTALLATION_COLUMNS} FROM github_installations
        WHERE workspace_id = ? AND account_login = ?
        ORDER BY installed_at DESC LIMIT 1`,
      [ctx.workspaceId, input.accountLogin],
    );
    const scopes = JSON.stringify(input.scopes ?? []);
    const now = new Date().toISOString();

    if (existing) {
      await this.q(ctx).run(
        `UPDATE github_installations
            SET user_id = ?, account_type = ?, token_secret_name = ?, scopes = ?,
                installed_at = ?, revoked_at = NULL, revoke_reason = NULL,
                github_installation_id = ?, user_token_secret_name = ?,
                user_token_expires_at = ?, user_refresh_secret_name = ?
          WHERE workspace_id = ? AND id = ?`,
        [
          ctx.actorUserId, input.accountType ?? "user", input.tokenSecretName, scopes, now,
          input.githubInstallationId ?? null, input.userTokenSecretName ?? null,
          input.userTokenExpiresAt ?? null, input.userRefreshSecretName ?? null,
          ctx.workspaceId, String(existing["id"]),
        ],
      );
      return (await this.installation(ctx, String(existing["id"])))!;
    }

    const id = randomUUID();
    await this.q(ctx).run(
      `INSERT INTO github_installations
         (id, workspace_id, user_id, account_login, account_type, token_secret_name, scopes,
          installed_at, github_installation_id, user_token_secret_name, user_token_expires_at,
          user_refresh_secret_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, ctx.workspaceId, ctx.actorUserId, input.accountLogin, input.accountType ?? "user",
        input.tokenSecretName, scopes, now,
        input.githubInstallationId ?? null, input.userTokenSecretName ?? null,
        input.userTokenExpiresAt ?? null, input.userRefreshSecretName ?? null,
      ],
    );
    return (await this.installation(ctx, id))!;
  }

  async installation(ctx: TenantContext, id: string): Promise<GithubInstallation | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${INSTALLATION_COLUMNS} FROM github_installations WHERE workspace_id = ? AND id = ?`,
      [ctx.workspaceId, id],
    );
    return row ? this.hydrateInstallation(row) : undefined;
  }

  /** The workspace's live grants, newest first. Revoked rows are kept but never offered. */
  async installations(ctx: TenantContext): Promise<GithubInstallation[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${INSTALLATION_COLUMNS} FROM github_installations
        WHERE workspace_id = ? AND revoked_at IS NULL
        ORDER BY installed_at DESC`,
      [ctx.workspaceId],
    );
    return rows.map((r) => this.hydrateInstallation(r));
  }

  /**
   * Mark a grant dead, with the reason.
   *
   * THE LINKS ARE LEFT ALONE, and that is the point of separating the two tables. A revoked token
   * does not mean the user changed their mind about which repo an agent belongs to — it usually
   * means they rotated a credential on GitHub — so the links stay, the badge goes to ⚠, and one
   * reconnect brings every agent in the workspace back rather than fifteen relinks.
   */
  async revokeAccount(ctx: TenantContext, id: string, reason: string): Promise<void> {
    await this.q(ctx).run(
      `UPDATE github_installations SET revoked_at = ?, revoke_reason = ?
        WHERE workspace_id = ? AND id = ? AND revoked_at IS NULL`,
      [new Date().toISOString(), reason, ctx.workspaceId, id],
    );
  }

  // --- the link --------------------------------------------------------------

  /**
   * Point an agent at a repository and a branch.
   *
   * The live partial index makes "one link per agent" the database's rule rather than this
   * method's, so two members linking the same agent at the same moment cannot produce two rows —
   * the second either updates the first or loses the race cleanly.
   */
  async link(ctx: TenantContext, input: LinkInput): Promise<GithubLink> {
    const existing = await this.linkFor(ctx, input.agentId);
    if (existing) {
      await this.patchLink(ctx, existing.id, {
        branch: input.branch,
        subdirectory: input.subdirectory ?? null,
        includeArtifacts: input.includeArtifacts ?? true,
      });
      await this.q(ctx).run(
        `UPDATE github_links SET installation_id = ?, repo_full_name = ?
          WHERE workspace_id = ? AND id = ?`,
        [input.installationId, input.repoFullName, ctx.workspaceId, existing.id],
      );
      return (await this.linkFor(ctx, input.agentId))!;
    }

    const id = randomUUID();
    await this.q(ctx).run(
      `INSERT INTO github_links
         (id, workspace_id, agent_id, installation_id, repo_full_name, branch, subdirectory,
          include_artifacts, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, ctx.workspaceId, input.agentId, input.installationId, input.repoFullName, input.branch,
        input.subdirectory || null, (input.includeArtifacts ?? true) ? 1 : 0,
        ctx.actorUserId, new Date().toISOString(),
      ],
    );
    return (await this.linkFor(ctx, input.agentId))!;
  }

  /** The live link for one agent, or undefined. The single read the badge is computed from. */
  async linkFor(ctx: TenantContext, agentId: string): Promise<GithubLink | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${LINK_COLUMNS} FROM github_links
        WHERE workspace_id = ? AND agent_id = ? AND deleted_at IS NULL`,
      [ctx.workspaceId, agentId],
    );
    return row ? this.hydrateLink(row) : undefined;
  }

  /** Every live link in the workspace. What the sidebar's Synced filter counts. */
  async links(ctx: TenantContext): Promise<GithubLink[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${LINK_COLUMNS} FROM github_links
        WHERE workspace_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [ctx.workspaceId],
    );
    return rows.map((r) => this.hydrateLink(r));
  }

  /**
   * Every live link pointing at one repository and branch, ACROSS WORKSPACES.
   *
   * THE ONE METHOD IN THIS FILE THAT TAKES NO `TenantContext`, and the signature is the warning
   * label. The header above says every method takes a context first because on SQLite the WHERE
   * clause IS the tenancy boundary — this is the documented exception, and it exists because the
   * GitHub webhook genuinely has no tenant to be scoped to. GitHub POSTs a repository name to a
   * public URL with no session and no socket; "which workspaces care about this repository?" is
   * the question, and no workspace can ask it.
   *
   * THE PAYLOAD NAMES A REPOSITORY AND NEVER A WORKSPACE. That is the whole tenancy argument. The
   * caller matches on the repo name and gets back rows that each carry the workspace they belong
   * to, then does its work per workspace through `forWorkspace` like everything else. A handler
   * that read a workspace id OFF the delivery would be letting a stranger choose a tenant.
   *
   * `asPlatform` RATHER THAN A BARE READ, because on Postgres an unscoped statement sees nothing:
   * with no `app.workspace_id` set, `tenant_isolation` is false for every row, so this would
   * return empty and the webhook would silently do nothing on the one driver that matters.
   * Migration 035 grants the SELECT this unlocks, and grants only that.
   *
   * TWO WORKSPACES MAY LINK THE SAME REPOSITORY and both are returned. That is not a leak: each
   * of them independently told Jaroku to watch that repo, and telling one of them their branch
   * moved reveals nothing they did not already have a link to.
   */
  async linksForRepo(repoFullName: string, branch: string): Promise<LinkOwner[]> {
    const rows = await this.db.asPlatform((tx) =>
      tx.all<Record<string, unknown>>(
        `SELECT ${LINK_COLUMNS}, workspace_id FROM github_links
          WHERE repo_full_name = ? AND branch = ? AND deleted_at IS NULL`,
        [repoFullName, branch],
      ),
    );
    // The workspace rides ALONGSIDE the link rather than on it. `GithubLink` is read by the
    // service, the runners and the panel, none of which should start seeing a workspace id on a
    // shape whose whole point is that it was already scoped to one before they got it.
    return rows.map((r) => ({ workspaceId: String(r["workspace_id"]), link: this.hydrateLink(r) }));
  }

  /**
   * Move whichever pointers a sync moved.
   *
   * BUILT FROM THE KEYS THAT ARE PRESENT rather than from a fixed column list, because the
   * difference between "set this to null" and "leave this alone" is load-bearing here. A fetch
   * updates `last_known_remote_sha` and must not touch `last_pushed_version_id`; writing every
   * column every time would let a fetch quietly forget what was last pushed, which is half of the
   * ahead/behind computation.
   */
  async patchLink(ctx: TenantContext, id: string, patch: LinkPatch): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.branch !== undefined) put("branch", patch.branch);
    if (patch.subdirectory !== undefined) put("subdirectory", patch.subdirectory || null);
    if (patch.includeArtifacts !== undefined) put("include_artifacts", patch.includeArtifacts ? 1 : 0);
    if (patch.lastPushedVersionId !== undefined) put("last_pushed_version_id", patch.lastPushedVersionId);
    if (patch.lastPushedSha !== undefined) put("last_pushed_sha", patch.lastPushedSha);
    if (patch.lastKnownRemoteSha !== undefined) put("last_known_remote_sha", patch.lastKnownRemoteSha);
    if (patch.lastSyncedAt !== undefined) put("last_synced_at", patch.lastSyncedAt);
    if (sets.length === 0) return;
    values.push(ctx.workspaceId, id);
    await this.q(ctx).run(
      `UPDATE github_links SET ${sets.join(", ")} WHERE workspace_id = ? AND id = ?`,
      values,
    );
  }

  /**
   * Detach an agent from its repository.
   *
   * SOFT, and §6 is unambiguous about the rule it enforces: Jaroku never deletes a user's repo,
   * ever. The row is marked rather than removed so the events that reference it still resolve, and
   * so relinking the same agent tomorrow does not collide with a tombstone — the live index is
   * partial for exactly that.
   */
  async unlink(ctx: TenantContext, agentId: string): Promise<void> {
    await this.q(ctx).run(
      `UPDATE github_links SET deleted_at = ?
        WHERE workspace_id = ? AND agent_id = ? AND deleted_at IS NULL`,
      [new Date().toISOString(), ctx.workspaceId, agentId],
    );
  }

  // --- the history -----------------------------------------------------------

  /**
   * Append one thing that happened.
   *
   * NO UPDATE COUNTERPART EXISTS, and that is deliberate rather than unfinished: the only row
   * anybody would ever want to edit is the one recording an override they now regret. A table with
   * no writer for a column is a table whose history can be trusted.
   */
  async record(
    ctx: TenantContext,
    entry: {
      agentId?: string | null;
      linkId?: string | null;
      kind: GithubEventKind;
      outcome?: GithubEventOutcome;
      versionIds?: string[];
      commitSha?: string | null;
      detail?: string | null;
    },
  ): Promise<void> {
    await this.q(ctx).run(
      `INSERT INTO github_events
         (id, workspace_id, agent_id, link_id, kind, outcome, actor_user_id, version_ids,
          commit_sha, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), ctx.workspaceId, entry.agentId ?? null, entry.linkId ?? null, entry.kind,
        entry.outcome ?? "ok", ctx.actorUserId, JSON.stringify(entry.versionIds ?? []),
        entry.commitSha ?? null, entry.detail ?? null, new Date().toISOString(),
      ],
    );
  }

  /** What has happened to one agent, newest first. The History region's own read. */
  async events(ctx: TenantContext, agentId: string, limit = 50): Promise<GithubEvent[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${EVENT_COLUMNS} FROM github_events
        WHERE workspace_id = ? AND agent_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      [ctx.workspaceId, agentId, limit],
    );
    return rows.map((r) => this.hydrateEvent(r));
  }

  // --- §B.6's findings ---------------------------------------------------------

  /**
   * Record what a pre-push scan found.
   *
   * NO VALUE REACHES THIS METHOD, and the signature is where that is enforced: there is no
   * parameter a matched string would fit in. Migration 040's header makes the argument at length —
   * a table of "here is where the credentials are, and here is a bit of each one" would be a
   * strictly worse leak than the push it prevented — and a repository method that ACCEPTED one
   * would make that argument depend on every caller remembering it.
   *
   * WRITTEN EVEN WHEN THE PUSH IS ABOUT TO BE REFUSED, which is the ordinary case and the whole
   * point. §B.6's rows are mostly refusals nobody overrode; the interesting minority is the ones
   * somebody did, and that minority is only meaningful because the majority is recorded too.
   */
  async recordFindings(
    ctx: TenantContext,
    entry: {
      agentId: string;
      linkId?: string | null;
      eventId?: string | null;
      findings: readonly { path: string; rule: string; kind: "secret" | "artifact"; line: number | null }[];
      /** Set when this push went ahead over the findings. See `github_events`' force_override. */
      overridden?: boolean;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const finding of entry.findings) {
      await this.q(ctx).run(
        `INSERT INTO secret_scan_findings
           (id, workspace_id, agent_id, link_id, event_id, path, rule, kind, line,
            overridden, overridden_by, overridden_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(), ctx.workspaceId, entry.agentId, entry.linkId ?? null, entry.eventId ?? null,
          finding.path, finding.rule, finding.kind, finding.line,
          entry.overridden ? 1 : 0,
          entry.overridden ? ctx.actorUserId : null,
          entry.overridden ? now : null,
          now,
        ],
      );
    }
  }

  /** One agent's findings, newest first. What the panel renders under a refusal. */
  async findings(
    ctx: TenantContext,
    agentId: string,
    limit = 50,
  ): Promise<{ path: string; rule: string; kind: string; line: number | null; overridden: boolean; created_at: string }[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT path, rule, kind, line, overridden, created_at FROM secret_scan_findings
        WHERE workspace_id = ? AND agent_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      [ctx.workspaceId, agentId, limit],
    );
    return rows.map((r) => ({
      path: String(r["path"]),
      rule: String(r["rule"]),
      kind: String(r["kind"]),
      line: (r["line"] as number | null) ?? null,
      overridden: asBool(r["overridden"]),
      created_at: String(r["created_at"]),
    }));
  }
}
