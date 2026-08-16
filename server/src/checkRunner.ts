// A pull request arrives, and a quality check appears on it.
//
// §B.10 SAYS THIS IS "A SHADOW RUN, TRIGGERED BY A WEBHOOK, WRAPPED IN A CHECK RUN — not new
// execution machinery, once B.2 exists", and this file is where that claim either holds or does
// not. It holds: nothing below starts a process, materialises a tree or talks to a provider. It
// decides WHETHER to check, applies §B.1.3's boundary to decide WHERE, hands the work to the eval
// engine, and turns what comes back into a summary. Every expensive verb belongs to something else.
//
// THE ORDER OF THE FIVE STEPS IS THE DESIGN, and each one can refuse:
//
//   1. IS THERE A LINK, AND IS THIS ITS BRANCH? A pull request from a branch nothing links to is
//      not this feature's business.
//   2. IS THERE A DATASET? §B.1.2: no dataset linked, no check posted. The absence of a row is a
//      decision, and this is where it is honoured.
//   3. SUPERSEDE. A new commit cancels the check that was running for the old one — cancelled, not
//      queued behind, which is GitHub Actions' own discipline for superseded workflow runs.
//   4. WHERE MAY IT RUN? §B.1.3's boundary, asked BEFORE anything is dispatched, because the whole
//      point is that a stranger's pull request never reaches a paid provider.
//   5. OPEN THE CHECK, THEN DISPATCH. In that order: §B.1.2 wants the check visible as soon as the
//      commit is, and a row that waited for an eval id would make the visible half wait on the
//      expensive half.
//
// AND THE CHECK IS OPENED EVEN WHEN THE ANSWER WILL BE `neutral`. A dry run on a stranger's pull
// request still proves every tool imports and executes — v0.0.3's original justification for the
// fake provider — and still catches a contract violation before a human reviewer has to. Posting
// nothing would be giving all of that up to avoid a cost that was never going to be incurred.

import { compareToBaseline, conclusionFor, summaryFor, titleFor, type CheckMetrics } from "./evalCheck.ts";
import { modeReason, providerModeFor, targetsFor } from "./checkPolicy.ts";
import type { ChecksRepository, CheckRunRow, ProviderMode } from "./db/repositories/checks.ts";
import type { GithubApi } from "./githubApi.ts";
import type { GithubRepository } from "./db/repositories/github.ts";
import type { PullRequestEvent } from "./githubWebhook.ts";
import type { TenantContext } from "./db/tenant.ts";

/** What the caller must be able to do without this module knowing how. */
export interface CheckRunnerDeps {
  checks: ChecksRepository;
  repo: GithubRepository;
  /**
   * Start an eval and return its id.
   *
   * INJECTED, so this module never imports the eval engine. §B.10's claim is that eval-as-CI is not
   * new execution machinery, and the way that stays true under maintenance is that the file which
   * would be tempted to grow some cannot reach any.
   */
  startEval: (
    ctx: TenantContext,
    input: {
      agentId: string;
      datasetId: string;
      targets: { provider: string; model: string }[];
      /** Which check this eval belongs to, so its completion can find its way back here. */
      checkRunId: string;
    },
  ) => Promise<string>;
  /** Cancel an eval whose check has been superseded. Best-effort — see `supersede`. */
  cancelEval?: (ctx: TenantContext, evalRunId: string) => Promise<void>;
  log?: (line: string) => void;
}

export interface CheckDecision {
  /** Null when no check was posted, with `reason` saying which of the five steps stopped it. */
  checkRunId: string | null;
  reason: string;
}

export class CheckRunner {
  private readonly log: (line: string) => void;

  constructor(private deps: CheckRunnerDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /**
   * Everything from a delivery to a dispatched eval, for one workspace's link.
   *
   * TAKES A RESOLVED CONTEXT AND A RESOLVED LINK, because the cross-workspace lookup is the
   * webhook's exception and must not spread: by the time this is called the workspace is known and
   * every statement below is an ordinary scoped one. That is the same shape `applyPush` keeps.
   */
  async onPullRequest(
    ctx: TenantContext,
    input: {
      api: GithubApi;
      agentUuid: string;
      agentSlug: string;
      linkId: string;
      repoFullName: string;
      event: PullRequestEvent;
      /** The dataset's configured legs. Filtered by the boundary, never replaced by it. */
      configuredTargets: readonly { provider: string; model: string }[];
      datasetName?: string | null;
    },
  ): Promise<CheckDecision> {
    const { api, event } = input;

    // 2. §B.1.2's opt-in. The absence of a row is a decision — see `ChecksRepository.config`.
    const config = await this.deps.checks.config(ctx, input.agentUuid);
    if (!config?.ci_dataset_id) {
      return { checkRunId: null, reason: "no dataset is linked for CI on this agent" };
    }

    // 3. SUPERSEDE, BEFORE ANYTHING NEW IS OPENED. §B.1.2: a superseded run is cancelled, not
    // queued behind. Done first so a burst of pushes leaves one live check rather than five.
    await this.supersede(ctx, input.api, input.repoFullName, input.agentUuid, event);

    // 4. §B.1.3'S BOUNDARY, BEFORE A SINGLE JOB IS DISPATCHED. Asking GitHub costs a round trip on
    // the one path in this product that is about to spend somebody else's provider balance.
    const authorIsCollaborator = event.authorLogin
      ? await api.hasWriteAccess(input.repoFullName, event.authorLogin)
      : false;
    const facts = {
      policy: config.provider_policy,
      authorIsCollaborator,
      approvedForThisSha: await this.deps.checks.approvedForSha(ctx, input.agentUuid, event.headSha),
    };
    const mode = providerModeFor(facts);

    // 5. THE CHECK FIRST, THE EVAL SECOND.
    const row = await this.deps.checks.open(ctx, {
      agentId: input.agentUuid,
      linkId: input.linkId,
      prNumber: event.number,
      headSha: event.headSha,
      providerMode: mode,
    });

    const name = titleFor(input.datasetName ?? null);
    // GITHUB'S OWN ID FOR THE CHECK, HELD HERE RATHER THAN RE-READ OFF `row`. `open` returns the
    // row as it was INSERTed — `github_check_run_id` null, because GitHub has not been asked yet —
    // and `attachGithubId` writes the column without refreshing the object. The in-progress update
    // below read `row.github_check_run_id`, got that null, and `putCheckRun` reads an absent id as
    // "create": every pull request got a SECOND check run, and it was the one nothing ever
    // finished. The first went queued → completed; the duplicate sat at `in_progress` forever,
    // which on a repository where the check is required is a merge button that never unlocks.
    let githubCheckRunId: string;
    try {
      const created = await api.putCheckRun(input.repoFullName, {
        name,
        headSha: event.headSha,
        status: "queued",
        title: "Queued",
        // Said at the START rather than only at the end. Somebody watching a check spin on their
        // own pull request is entitled to know, before the numbers arrive, whether they are about
        // to be numbers from a real model.
        summary: modeReason(facts),
      });
      githubCheckRunId = created.id;
      await this.deps.checks.attachGithubId(ctx, row.id, created.id);
    } catch (err) {
      // A CHECK THAT COULD NOT BE POSTED IS NOT AN EVAL THAT SHOULD RUN. The whole value of this
      // feature is the number appearing on the pull request; spending a workspace's balance to
      // produce one nobody will see is the worst of both.
      const message = (err as Error)?.message ?? String(err);
      await this.deps.checks.complete(ctx, row.id, { conclusion: "neutral" });
      this.log(`[checks] ${input.agentSlug}#${event.number}: could not post a check run: ${message}`);
      return { checkRunId: null, reason: message };
    }

    const evalRunId = await this.deps.startEval(ctx, {
      agentId: input.agentUuid,
      datasetId: config.ci_dataset_id,
      targets: targetsFor(mode, input.configuredTargets),
      checkRunId: row.id,
    });
    await this.deps.checks.attachEval(ctx, row.id, evalRunId);
    await api
      .putCheckRun(input.repoFullName, {
        checkRunId: githubCheckRunId,
        name,
        headSha: event.headSha,
        status: "in_progress",
        title: mode === "paid" ? "Running" : "Running (dry-run provider)",
        summary: modeReason(facts),
      })
      // The check is already open and the eval is already going; failing to move it from queued to
      // in-progress is cosmetic, and unwinding a dispatched eval over it would not be.
      .catch(() => {});

    this.log(`[checks] ${input.agentSlug}#${event.number} at ${event.headSha.slice(0, 7)} → ${mode}`);
    return { checkRunId: row.id, reason: modeReason(facts) };
  }

  /**
   * Cancel the checks this commit supersedes.
   *
   * GITHUB FIRST, THE DATABASE SECOND, and the order is not interchangeable: a row marked cancelled
   * while GitHub still shows `in_progress` is a spinner on somebody's pull request that never
   * resolves and that nothing will ever come back to finish. The other way round leaves a row that
   * the next supersede pass picks up again, which is a retry rather than a stuck UI.
   *
   * §B.1.2's rule applied exactly: "a cancelled check never starts new jobs, but a job already
   * dispatched runs to completion" — which is the eval engine's own budget discipline (v0.1.9), so
   * `cancelEval` cancels what is QUEUED and lets what is running finish and be paid for.
   */
  private async supersede(
    ctx: TenantContext,
    api: GithubApi,
    repoFullName: string,
    agentUuid: string,
    event: PullRequestEvent,
  ): Promise<void> {
    const stale = await this.deps.checks.supersededBy(ctx, agentUuid, event.number, event.headSha);
    for (const row of stale) {
      if (row.github_check_run_id) {
        await api
          .putCheckRun(repoFullName, {
            checkRunId: row.github_check_run_id,
            name: "Jaroku eval",
            headSha: row.head_sha,
            status: "completed",
            conclusion: "cancelled",
            title: "Superseded",
            summary: `A newer commit (${event.headSha.slice(0, 7)}) is on this pull request.`,
          })
          .catch((err) => this.log(`[checks] could not cancel ${row.github_check_run_id}: ${(err as Error)?.message}`));
      }
      if (row.eval_run_id) {
        await this.deps.cancelEval?.(ctx, row.eval_run_id).catch(() => {});
      }
      await this.deps.checks.cancel(ctx, row.id);
    }
  }

  /**
   * An eval finished: compute the deltas and post the summary.
   *
   * THE BASELINE IS LOOKED UP AT COMPLETION, not at dispatch, and the difference is real on a
   * long-running check: the base branch can gain a commit with its own check while this eval runs,
   * and comparing against the newest completed check for the base sha we were told about is the
   * comparison somebody reading the pull request would draw.
   *
   * A CHECK THAT WAS CANCELLED WHILE ITS EVAL RAN IS NOT REOPENED. §B.1.2's supersede already told
   * GitHub the check was cancelled; posting numbers onto it afterwards would resurrect a check the
   * pull request has moved past, under a commit that is no longer its head.
   */
  async onEvalFinished(
    ctx: TenantContext,
    input: {
      api: GithubApi;
      repoFullName: string;
      checkRunId: string;
      metrics: CheckMetrics;
      baseSha: string | null;
      datasetName?: string | null;
    },
  ): Promise<void> {
    const row = await this.deps.checks.byId(ctx, input.checkRunId);
    if (!row) return;
    if (row.status === "completed") {
      this.log(`[checks] ${input.checkRunId} already completed (${row.conclusion}) — not reopening`);
      return;
    }

    const baselineRow = input.baseSha
      ? await this.deps.checks.baselineFor(ctx, row.agent_id, input.baseSha)
      : undefined;
    const baseline = baselineRow ? metricsOf(baselineRow) : null;
    const comparison = compareToBaseline(input.metrics, baseline);
    const conclusion = conclusionFor(comparison);

    await this.deps.checks.complete(ctx, row.id, {
      conclusion,
      passRate: comparison.metrics.passRate,
      costPerRunUsd: comparison.metrics.costPerRunUsd,
      latencyP50Ms: comparison.metrics.latencyP50Ms,
      passRateDelta: comparison.deltas.passRate,
      costDelta: comparison.deltas.cost,
      latencyDelta: comparison.deltas.latency,
      baselineCheckId: baselineRow?.id ?? null,
    });

    await input.api
      .putCheckRun(input.repoFullName, {
        checkRunId: row.github_check_run_id,
        name: titleFor(input.datasetName ?? null),
        headSha: row.head_sha,
        status: "completed",
        conclusion,
        title: titleFor(input.datasetName ?? null),
        summary: summaryFor(comparison, baseline, {
          ...(input.datasetName ? { datasetName: input.datasetName } : {}),
          providerMode: row.provider_mode,
        }),
      })
      // RECORDED EVEN IF GITHUB REFUSES THE UPDATE. The numbers are the thing §B.8.2's canvas reads
      // and the thing the next check's baseline is; losing them because a token expired between
      // dispatch and completion would lose the measurement as well as the display.
      .catch((err) => this.log(`[checks] could not post the result: ${(err as Error)?.message ?? err}`));
  }
}

/** A stored row's three numbers, as the comparison wants them. */
function metricsOf(row: CheckRunRow): CheckMetrics {
  return {
    passRate: row.pass_rate,
    costPerRunUsd: row.cost_per_run_usd,
    latencyP50Ms: row.latency_p50_ms,
  };
}

/** Re-exported so a caller can name the mode without importing the repository for a type. */
export type { ProviderMode };
