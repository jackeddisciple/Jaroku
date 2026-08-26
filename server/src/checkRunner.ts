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
import { APPROVE_ACTION, modeReason, offersApproval, providerModeFor, targetsFor } from "./checkPolicy.ts";
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
    const { row, created } = await this.deps.checks.open(ctx, {
      agentId: input.agentUuid,
      linkId: input.linkId,
      prNumber: event.number,
      headSha: event.headSha,
      providerMode: mode,
    });
    // A DELIVERY FOR A COMMIT ALREADY BEING CHECKED IS NOT A SECOND CHECK. GitHub retries anything
    // it did not get a timely answer to, a retry can land on another replica or after a restart,
    // and `reopened` carries the same head sha as the `opened` before it — while `supersede` above
    // excludes the same sha by construction and therefore cancels nothing. Returning here is what
    // stops a second check run appearing on the pull request and, more expensively, a second eval
    // fan-out spending the workspace's provider balance on a commit already being measured.
    if (!created) {
      this.log(`[checks] ${input.agentSlug}#${event.number} at ${event.headSha.slice(0, 7)}: already checking`);
      return { checkRunId: row.id, reason: "this commit is already being checked" };
    }

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
        // §B.1.3, AND THE REASON offersApproval EXISTED WITH NO CALLER. The state it gates was
        // unreachable by construction: providerModeFor answers paid when approvedForThisSha, that
        // is true only when a paid row exists, and a paid row exists only when providerModeFor
        // answered paid. Meanwhile every external pull request was posted a summary telling
        // whoever read it that a collaborator could approve real providers for the commit.
        //
        // OFFERED ONLY WHEN APPROVING WOULD CHANGE SOMETHING — on a check that is already paid it
        // is a button that does nothing, and under dry_run_only it contradicts a setting somebody
        // chose. Both teach people the control is decorative, which is how the one that matters
        // gets clicked without being read.
        ...(offersApproval(facts) ? { actions: [APPROVE_ACTION] } : {}),
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
      // THE SLUG, NOT THE UUID, and the difference is not cosmetic: `agentId` here becomes the
      // eval row's `agent_id` and then the working directory of every job's subprocess —
      // `runtime/agents/<agentId>` — exactly as an ordinary eval's does. A uuid there names a
      // directory that does not exist, so every job of every check would have failed to start.
      // It could not be observed until now: `setConfig` had no caller, so this line was never
      // reached in a running product. The two ids are both here on purpose — the CONFIG is keyed
      // by uuid, because that is a row in this database, and the RUN is keyed by slug, because
      // that is a directory on disk.
      agentId: input.agentSlug,
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
   * §B.1.3's approval, honoured — the write that made `approvedForSha` reachable.
   *
   * THE LOOP THIS BREAKS. `providerModeFor` answers `paid` when `approvedForThisSha`; that reads a
   * `check_runs` row with `provider_mode = 'paid'` for the sha; and such a row was only ever
   * written by a run `providerModeFor` had already answered `paid` for. Nothing outside that
   * circle could enter it, so no external pull request had ever been approved — while every one of
   * them carried a summary saying a collaborator could approve it.
   *
   * IT WRITES THE PAID ROW DIRECTLY RATHER THAN RE-DERIVING. The approval IS the fact
   * `approvedForSha` is looking for, so recording it is recording a paid check for this commit —
   * and every later trigger on the same sha (a re-request, a supersede-and-retry) then resolves
   * `paid` through the ordinary path with nothing special-cased. A second door into `providerModeFor`
   * would be a second place the boundary lives.
   *
   * THE PERMISSION IS ASKED, NEVER INFERRED. GitHub says who pressed the button; only GitHub can
   * say whether that login may spend this workspace's balance, and the answer is a round trip on
   * the one path in this product that is about to. A refusal is reported on the check itself —
   * where the person is already looking — rather than swallowed, because a button that silently
   * does nothing is the exact failure `offersApproval`'s own comment names.
   */
  async onApproval(
    ctx: TenantContext,
    input: {
      api: GithubApi;
      agentUuid: string;
      agentSlug: string;
      linkId: string;
      repoFullName: string;
      /** The check GitHub says the button was pressed on. */
      check: { id: string; githubCheckRunId: string; prNumber: number; headSha: string };
      /** Who pressed it, per GitHub. Checked against the repository, never trusted as given. */
      senderLogin: string | null;
      configuredTargets: readonly { provider: string; model: string }[];
      datasetName?: string | null;
    },
  ): Promise<CheckDecision> {
    const { api, check } = input;
    const config = await this.deps.checks.config(ctx, input.agentUuid);
    if (!config?.ci_dataset_id) {
      return { checkRunId: null, reason: "no dataset is linked for CI on this agent" };
    }
    // AN OPT-OUT IS AN OPT-OUT. `dry_run_only` is a setting somebody chose, and an approval that
    // overrode it would make the setting advisory — which is the same reason `offersApproval`
    // declines to render the button under it in the first place.
    if (config.provider_policy === "dry_run_only") {
      return { checkRunId: null, reason: "this agent is configured to run checks on the dry-run provider only" };
    }

    const allowed = input.senderLogin
      ? await api.hasWriteAccess(input.repoFullName, input.senderLogin)
      : false;
    if (!allowed) {
      // ON THE CHECK, because that is where the press happened and where the person is. Best-effort:
      // failing to say so is not a reason to act as though the approval succeeded.
      await api
        .putCheckRun(input.repoFullName, {
          checkRunId: check.githubCheckRunId,
          headSha: check.headSha,
          status: "completed",
          conclusion: "neutral",
          title: "Not approved",
          summary: `${input.senderLogin ?? "that account"} does not have write access to this repository, so this commit was not approved for real providers.`,
        })
        .catch(() => {});
      return { checkRunId: null, reason: `${input.senderLogin ?? "an unknown sender"} has no write access` };
    }

    // THE DRY-RUN CHECK IS CLOSED FIRST, AND THE ORDER IS LOAD-BEARING. Migration 045 allows one
    // LIVE check per (agent, pull request, commit) — deliberately, because two checks racing on one
    // commit is two answers to one question — so `open` answers a request made while one is live by
    // handing back the LIVE ROW rather than creating a rival. Opening the paid row first therefore
    // wrote nothing at all: it read back the dry-run row, `approvedForSha` stayed false, and the
    // re-run went out on the fake provider having reported success.
    //
    // The approval is not a second opinion; it is the same check, asked of a real provider.
    const live = await this.deps.checks.liveForSha(ctx, input.agentUuid, check.prNumber, check.headSha);
    if (live) {
      await this.deps.checks.cancel(ctx, live.id);
      // The eval too, best-effort. Its numbers are about the dry-run provider and are about to be
      // superseded by numbers that mean something else; letting it finish would spend the run and
      // post a result nobody asked for over the top of the one that was.
      if (live.eval_run_id) await this.deps.cancelEval?.(ctx, live.eval_run_id).catch(() => {});
    }

    // THE APPROVAL, AS THE ROW THAT MAKES IT TRUE. Opened and completed in one step: it is not a
    // check somebody is waiting on, it is the record that this sha may use real providers.
    const { row } = await this.deps.checks.open(ctx, {
      agentId: input.agentUuid,
      linkId: input.linkId,
      prNumber: check.prNumber,
      headSha: check.headSha,
      providerMode: "paid",
    });
    await this.deps.checks.complete(ctx, row.id, { conclusion: "neutral" });

    this.log(
      `[checks] ${input.agentSlug}#${check.prNumber} at ${check.headSha.slice(0, 7)} approved for real providers by ${input.senderLogin}`,
    );

    // AND THE RE-RUN, through the ordinary trigger so nothing about the dispatch is special-cased.
    // `approvedForSha` now answers true, so `providerModeFor` resolves `paid` on its own.
    return this.onPullRequest(ctx, {
      api,
      agentUuid: input.agentUuid,
      agentSlug: input.agentSlug,
      linkId: input.linkId,
      repoFullName: input.repoFullName,
      event: {
        kind: "pull_request",
        repoFullName: input.repoFullName,
        // `synchronize` RATHER THAN A FOURTH ACTION. What this is, to everything downstream, is
        // "there is code here to check" — which is exactly what that action means, and inventing a
        // fifth would make every consumer learn a case that behaves identically.
        action: "synchronize",
        number: check.prNumber,
        headBranch: "",
        headSha: check.headSha,
        baseBranch: "",
        baseSha: null,
        authorLogin: null,
        fromFork: true,
      },
      configuredTargets: input.configuredTargets,
      datasetName: input.datasetName ?? null,
    });
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
            // NO NAME, because this row does not know the one the check was posted under. §B.1.1's
            // title carries the dataset — "Jaroku eval · weather-agent-suite" — and `check_runs`
            // stores the check's id rather than its title, so the generic string that used to be
            // here RENAMED the run on its way to being cancelled: the check somebody had been
            // watching vanished from the list and a differently-named cancelled one appeared.
            // GitHub keeps the existing name when a PATCH does not carry one.
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
