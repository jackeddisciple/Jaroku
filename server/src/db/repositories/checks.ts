// `agent_ci_config` and `check_runs`, behind one repository.
//
// TWO TABLES AND ONE CLASS, for the reason `GithubRepository` gives about its three: they are never
// read apart. Deciding whether to post a check reads the config; posting it writes a run; finding
// the baseline reads the runs — and every one of those happens inside one webhook delivery. Two
// repositories would be two contexts threaded through one handler and two places to forget the
// workspace half of a composite key.
//
// EVERY METHOD TAKES A `TenantContext` FIRST and every statement carries `workspace_id` in its
// WHERE. On SQLite there is no RLS at all (migration 009), so that clause IS the tenancy boundary
// on one of the two supported drivers — and this feature is reached from a WEBHOOK, which is the
// one entry point in the product with no session behind it. A method here that found a row by id
// alone would be a cross-tenant read triggered by a stranger's POST.
//
// NOTHING HERE DECIDES ANYTHING. The provider boundary (§B.1.3), the supersede rule (§B.1.2) and
// the delta arithmetic (§B.1.1) all live above this: the repository stores what was decided and
// answers what is recorded. That split is why `supersededBy` returns rows rather than cancelling
// them — the caller has to tell GitHub before it can tell the database, and a repository that did
// both would be a repository that makes network calls.

import { randomUUID } from "node:crypto";

import type { Db, Queryable } from "../db.ts";
import type { TenantContext } from "../tenant.ts";

/** §B.1.3's three positions. Never a boolean — the middle one is the interesting case. */
export type ProviderPolicy = "dry_run_only" | "collaborators_paid" | "always_paid";

/** Which provider a check was ALLOWED to use, after the boundary was applied. */
export type ProviderMode = "dry_run" | "paid";

export type CheckStatus = "queued" | "in_progress" | "completed";
export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled" | "timed_out";

export interface AgentCiConfig {
  agent_id: string;
  /** Null means configured-but-posting-nothing, which is not the same as never configured. */
  ci_dataset_id: string | null;
  provider_policy: ProviderPolicy;
  updated_at: string;
}

export interface CheckRunRow {
  id: string;
  agent_id: string;
  link_id: string | null;
  pr_number: number;
  head_sha: string;
  github_check_run_id: string | null;
  eval_run_id: string | null;
  status: CheckStatus;
  conclusion: CheckConclusion | null;
  provider_mode: ProviderMode;
  pass_rate: number | null;
  cost_per_run_usd: number | null;
  latency_p50_ms: number | null;
  pass_rate_delta: number | null;
  cost_delta: number | null;
  latency_delta: number | null;
  baseline_check_id: string | null;
  created_at: string;
  completed_at: string | null;
}

const CONFIG_COLUMNS = `agent_id, ci_dataset_id, provider_policy, updated_at`;

const CHECK_COLUMNS = `id, agent_id, link_id, pr_number, head_sha, github_check_run_id,
                       eval_run_id, status, conclusion, provider_mode, pass_rate,
                       cost_per_run_usd, latency_p50_ms, pass_rate_delta, cost_delta,
                       latency_delta, baseline_check_id, created_at, completed_at`;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export class ChecksRepository {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  // --- §B.1.2's opt-in ---------------------------------------------------------

  /**
   * This agent's CI configuration, or undefined.
   *
   * UNDEFINED IS THE DEFAULT AND IT MEANS "POST NOTHING". §B.1.2 is explicit that linking a repo
   * does not enable an eval check — silent, unbounded spend on every push to a pull request is not
   * a default this product gets to have — so the absence of a row is a decision, not a gap, and
   * every caller reads it as one.
   */
  async config(ctx: TenantContext, agentId: string): Promise<AgentCiConfig | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${CONFIG_COLUMNS} FROM agent_ci_config WHERE workspace_id = ? AND agent_id = ?`,
      [ctx.workspaceId, agentId],
    );
    if (!row) return undefined;
    return {
      agent_id: String(row["agent_id"]),
      ci_dataset_id: (row["ci_dataset_id"] as string | null) ?? null,
      provider_policy: row["provider_policy"] as ProviderPolicy,
      updated_at: String(row["updated_at"]),
    };
  }

  /**
   * Set the dataset, the policy, or both.
   *
   * FIELD BY FIELD FROM WHAT IS PRESENT, the same rule `patchLink` follows and for the same reason:
   * the difference between "set this to null" and "leave this alone" is load-bearing. Clearing a
   * dataset must keep the policy somebody chose, and choosing a policy must not clear the dataset.
   *
   * UPSERT, because the row's absence is a state rather than an error. Somebody configuring this for
   * the first time and somebody changing it are doing the same thing, and making the first one an
   * insert and the second an update would be two code paths for one action.
   */
  async setConfig(
    ctx: TenantContext,
    agentId: string,
    patch: { datasetId?: string | null; policy?: ProviderPolicy },
  ): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.config(ctx, agentId);
    if (!existing) {
      await this.q(ctx).run(
        `INSERT INTO agent_ci_config
           (id, workspace_id, agent_id, ci_dataset_id, provider_policy, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(), ctx.workspaceId, agentId,
          patch.datasetId ?? null,
          // The default is the middle position, which is §B.1.3's rule: collaborators may spend, a
          // stranger may not. Defaulting to `always_paid` would make opting in an opt-out of the
          // boundary, and to `dry_run_only` would make the feature do nothing until configured
          // twice.
          patch.policy ?? "collaborators_paid",
          ctx.actorUserId, now, now,
        ],
      );
      return;
    }
    const sets: string[] = ["updated_at = ?", "updated_by = ?"];
    const values: unknown[] = [now, ctx.actorUserId];
    if (patch.datasetId !== undefined) {
      sets.push("ci_dataset_id = ?");
      values.push(patch.datasetId);
    }
    if (patch.policy !== undefined) {
      sets.push("provider_policy = ?");
      values.push(patch.policy);
    }
    values.push(ctx.workspaceId, agentId);
    await this.q(ctx).run(
      `UPDATE agent_ci_config SET ${sets.join(", ")} WHERE workspace_id = ? AND agent_id = ?`,
      values,
    );
  }

  // --- §B.1.1's runs -----------------------------------------------------------

  private hydrate(row: Record<string, unknown>): CheckRunRow {
    return {
      id: String(row["id"]),
      agent_id: String(row["agent_id"]),
      link_id: (row["link_id"] as string | null) ?? null,
      pr_number: Number(row["pr_number"]),
      head_sha: String(row["head_sha"]),
      github_check_run_id: (row["github_check_run_id"] as string | null) ?? null,
      eval_run_id: (row["eval_run_id"] as string | null) ?? null,
      status: row["status"] as CheckStatus,
      conclusion: (row["conclusion"] as CheckConclusion | null) ?? null,
      provider_mode: row["provider_mode"] as ProviderMode,
      pass_rate: num(row["pass_rate"]),
      cost_per_run_usd: num(row["cost_per_run_usd"]),
      latency_p50_ms: num(row["latency_p50_ms"]),
      pass_rate_delta: num(row["pass_rate_delta"]),
      cost_delta: num(row["cost_delta"]),
      latency_delta: num(row["latency_delta"]),
      baseline_check_id: (row["baseline_check_id"] as string | null) ?? null,
      created_at: String(row["created_at"]),
      completed_at: (row["completed_at"] as string | null) ?? null,
    };
  }

  /**
   * Open a check, before anything has been dispatched.
   *
   * WRITTEN AT `queued` WITH NO EVAL AND NO GITHUB ID, because §B.1.2 requires the check to appear
   * on the pull request as soon as the commit does. Both ids are patched in as they come to exist —
   * a row that waited for them would make the visible half of the feature wait on the expensive
   * half, which is the wrong way round for something whose job is to say "I am working on it".
   */
  async open(
    ctx: TenantContext,
    input: {
      agentId: string;
      linkId?: string | null;
      prNumber: number;
      headSha: string;
      providerMode: ProviderMode;
    },
  ): Promise<CheckRunRow> {
    const id = randomUUID();
    await this.q(ctx).run(
      `INSERT INTO check_runs
         (id, workspace_id, agent_id, link_id, pr_number, head_sha, status, provider_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [
        id, ctx.workspaceId, input.agentId, input.linkId ?? null, input.prNumber, input.headSha,
        input.providerMode, new Date().toISOString(),
      ],
    );
    return (await this.byId(ctx, id))!;
  }

  async byId(ctx: TenantContext, id: string): Promise<CheckRunRow | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${CHECK_COLUMNS} FROM check_runs WHERE workspace_id = ? AND id = ?`,
      [ctx.workspaceId, id],
    );
    return row ? this.hydrate(row) : undefined;
  }

  /** Attach GitHub's own check run id, once it has accepted the creation. */
  async attachGithubId(ctx: TenantContext, id: string, githubCheckRunId: string): Promise<void> {
    await this.q(ctx).run(
      `UPDATE check_runs SET github_check_run_id = ? WHERE workspace_id = ? AND id = ?`,
      [githubCheckRunId, ctx.workspaceId, id],
    );
  }

  /** Attach the eval run and move to `in_progress`. Two facts, one transition. */
  async attachEval(ctx: TenantContext, id: string, evalRunId: string): Promise<void> {
    await this.q(ctx).run(
      `UPDATE check_runs SET eval_run_id = ?, status = 'in_progress'
        WHERE workspace_id = ? AND id = ?`,
      [evalRunId, ctx.workspaceId, id],
    );
  }

  /**
   * Record the outcome.
   *
   * EVERY NUMBER IS NULLABLE AND EVERY NULL IS WRITTEN AS ONE. The caller has already applied
   * §B.1.1's rule — a delta against no baseline is null, not zero — and this stores what it decided
   * rather than coercing. A `?? 0` anywhere in these parameters would undo the whole of `evalCheck`.
   */
  async complete(
    ctx: TenantContext,
    id: string,
    outcome: {
      conclusion: CheckConclusion;
      passRate?: number | null;
      costPerRunUsd?: number | null;
      latencyP50Ms?: number | null;
      passRateDelta?: number | null;
      costDelta?: number | null;
      latencyDelta?: number | null;
      baselineCheckId?: string | null;
    },
  ): Promise<void> {
    await this.q(ctx).run(
      `UPDATE check_runs
          SET status = 'completed', conclusion = ?, pass_rate = ?, cost_per_run_usd = ?,
              latency_p50_ms = ?, pass_rate_delta = ?, cost_delta = ?, latency_delta = ?,
              baseline_check_id = ?, completed_at = ?
        WHERE workspace_id = ? AND id = ?`,
      [
        outcome.conclusion,
        outcome.passRate ?? null,
        outcome.costPerRunUsd ?? null,
        outcome.latencyP50Ms ?? null,
        outcome.passRateDelta ?? null,
        outcome.costDelta ?? null,
        outcome.latencyDelta ?? null,
        outcome.baselineCheckId ?? null,
        new Date().toISOString(),
        ctx.workspaceId,
        id,
      ],
    );
  }

  /**
   * §B.1.1's baseline: the last COMPLETED check against a given commit.
   *
   * AGAINST A SHA AND NOT AGAINST A BRANCH, because a branch moves and a baseline must not. The
   * caller resolves the pull request's base ref to a commit and asks about that commit, so a
   * comparison is always between two specific trees — which is the only comparison that means
   * anything when somebody re-reads the check a week later.
   *
   * `completed` ONLY. A queued or in-progress check has no numbers on it, and one that was cancelled
   * has numbers that describe a run somebody stopped. Neither is a baseline.
   */
  async baselineFor(
    ctx: TenantContext,
    agentId: string,
    baseSha: string,
  ): Promise<CheckRunRow | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${CHECK_COLUMNS} FROM check_runs
        WHERE workspace_id = ? AND agent_id = ? AND head_sha = ? AND status = 'completed'
          AND conclusion <> 'cancelled'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [ctx.workspaceId, agentId, baseSha],
    );
    return row ? this.hydrate(row) : undefined;
  }

  /**
   * §B.1.2's supersede rule: live checks on this PR that are about an older commit.
   *
   * RETURNS THEM RATHER THAN CANCELLING THEM, and the split is deliberate. Cancelling means telling
   * GitHub first — a check left `in_progress` on GitHub while the database calls it cancelled is a
   * spinner on somebody's pull request that never resolves — and a repository that made network
   * calls would be a repository whose failures are somebody else's. The caller cancels, then
   * records.
   *
   * "OLDER" IS "NOT THE CURRENT HEAD" rather than a timestamp comparison. A force-push can make the
   * new head older by date than the one it replaced, and a check about a commit that is no longer
   * the tip is superseded whenever it was created.
   */
  async supersededBy(
    ctx: TenantContext,
    agentId: string,
    prNumber: number,
    headSha: string,
  ): Promise<CheckRunRow[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${CHECK_COLUMNS} FROM check_runs
        WHERE workspace_id = ? AND agent_id = ? AND pr_number = ? AND head_sha <> ?
          AND status <> 'completed'
        ORDER BY created_at DESC`,
      [ctx.workspaceId, agentId, prNumber, headSha],
    );
    return rows.map((r) => this.hydrate(r));
  }

  /** Mark a superseded check cancelled, once GitHub has been told. */
  async cancel(ctx: TenantContext, id: string): Promise<void> {
    await this.q(ctx).run(
      `UPDATE check_runs SET status = 'completed', conclusion = 'cancelled', completed_at = ?
        WHERE workspace_id = ? AND id = ? AND status <> 'completed'`,
      [new Date().toISOString(), ctx.workspaceId, id],
    );
  }

  /**
   * Whether a collaborator has already approved real providers for this commit — §B.1.3.
   *
   * DERIVED FROM THE CHECK ROWS RATHER THAN STORED SEPARATELY, and §B.9's discipline is the reason:
   * storage goes only where a feature actually needs memory. An approval is "a paid check was
   * authorised for this sha", and a paid check for this sha IS that record — a second table would
   * be a second answer to the same question, and the day they disagree the one an attacker's pull
   * request reads is the one that matters.
   *
   * PER COMMIT, WHICH IS THE POINT. The query is keyed on `head_sha` and nothing else, so pushing a
   * new commit to an approved pull request produces a sha nobody has approved — which is exactly
   * the hole GitHub's own first-time-contributor gate exists to close, and would be wide open if
   * this were keyed on the pull request number.
   */
  async approvedForSha(ctx: TenantContext, agentId: string, headSha: string): Promise<boolean> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT 1 AS ok FROM check_runs
        WHERE workspace_id = ? AND agent_id = ? AND head_sha = ? AND provider_mode = 'paid'
        LIMIT 1`,
      [ctx.workspaceId, agentId, headSha],
    );
    return row !== undefined;
  }

  /**
   * This agent's checks, newest first — what §B.8.2's graph canvas hangs its ⧫ markers off.
   *
   * BY COMMIT, which is how the canvas reads it: a marker sits beneath the commit it ran against,
   * so the consumer groups on `head_sha` rather than walking a pull request. Returned flat because
   * grouping is the caller's question and a repository that answered it would have to know what a
   * lane is.
   */
  async forAgent(ctx: TenantContext, agentId: string, limit = 100): Promise<CheckRunRow[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${CHECK_COLUMNS} FROM check_runs
        WHERE workspace_id = ? AND agent_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      [ctx.workspaceId, agentId, limit],
    );
    return rows.map((r) => this.hydrate(r));
  }
}
