// One pull request, one check — asserted by counting what GitHub is left holding.
//
// THE BUG THIS EXISTS FOR was two lines apart and read correctly at both of them. §B.1.2 wants the
// check visible as soon as the commit is, so `checks.open` writes the row at `queued` with no
// GitHub id and `attachGithubId` patches it in once GitHub has accepted the creation. The
// in-progress update then took its id from `row.github_check_run_id` — the object `open` RETURNED,
// which is the row as it was inserted, which is to say null. `putCheckRun` reads an absent id as
// "create". So every pull request got two check runs: the real one, which went queued → completed
// when the eval finished, and a duplicate stuck at `in_progress` that nothing ever came back to.
// On a repository where the check is required, that second one is a merge button that never
// unlocks — and on one where it is not, it is a permanent spinner nobody can explain.
//
// It could not be caught by asserting on the runner's return value, which was correct throughout.
// The only thing that shows it is asking GitHub how many checks are on the commit.
//
//   npm run test:check-runner

import { startMockGithubApi } from "../fixtures/github/mockGithubApi.ts";
import { CheckRunner } from "./checkRunner.ts";
import { GithubApi } from "./githubApi.ts";
import type { AgentCiConfig, CheckRunRow } from "./db/repositories/checks.ts";
import type { PullRequestEvent } from "./githubWebhook.ts";
import type { TenantContext } from "./db/tenant.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

/**
 * `check_runs`, in memory, with the one property that matters reproduced exactly: `open` hands back
 * the row as it was written, and `attachGithubId` changes the store rather than that object.
 */
function fakeChecks(config: AgentCiConfig | undefined) {
  const rows = new Map<string, CheckRunRow>();
  let next = 1;
  return {
    rows,
    config: async () => config,
    approvedForSha: async () => false,
    supersededBy: async () => [] as CheckRunRow[],
    cancel: async () => {},
    baselineFor: async () => undefined,
    open: async (_ctx: TenantContext, input: { agentId: string; linkId: string | null; prNumber: number; headSha: string; providerMode: "dry_run" | "paid" }) => {
      const row = {
        id: `row-${next++}`, agent_id: input.agentId, link_id: input.linkId, pr_number: input.prNumber,
        head_sha: input.headSha, github_check_run_id: null, eval_run_id: null, status: "queued",
        conclusion: null, provider_mode: input.providerMode, pass_rate: null, cost_per_run_usd: null,
        latency_p50_ms: null, pass_rate_delta: null, cost_delta: null, latency_delta: null,
        baseline_check_id: null, created_at: new Date().toISOString(), completed_at: null,
      } as CheckRunRow;
      rows.set(row.id, row);
      // A COPY, exactly as the real repository's `byId` re-read returns: the caller's object is not
      // the store's, so a later UPDATE to the column is invisible to whoever is holding it.
      return { ...row };
    },
    byId: async (_ctx: TenantContext, id: string) => rows.get(id),
    attachGithubId: async (_ctx: TenantContext, id: string, githubId: string) => {
      const row = rows.get(id);
      if (row) row.github_check_run_id = githubId;
    },
    attachEval: async (_ctx: TenantContext, id: string, evalRunId: string) => {
      const row = rows.get(id);
      if (row) { row.eval_run_id = evalRunId; row.status = "in_progress"; }
    },
    complete: async () => {},
  };
}

const mock = await startMockGithubApi();
const api = new GithubApi({ token: "test-token", base: mock.url });
const repo = (await api.createRepo("weather-agent")).fullName;
await api.initialCommit(repo, "main", { path: "README.md", content: "# x\n", message: "Initial commit" });
const headSha = (await api.refSha(repo, "main"))!;

const ctx = { workspaceId: "ws-1", requestId: "req-1" } as unknown as TenantContext;
const event: PullRequestEvent = {
  kind: "pull_request", repoFullName: repo, action: "opened", number: 42,
  headBranch: "jaroku/weather-agent", headSha, baseBranch: "main", baseSha: null,
  authorLogin: "someone", fromFork: false,
};

try {
  console.log("\na pull request opens one check and moves it to in progress");
  {
    const checks = fakeChecks({
      agent_id: "agent-1", ci_dataset_id: "dataset-1",
      provider_policy: "collaborators_paid", updated_at: new Date().toISOString(),
    });
    const runner = new CheckRunner({
      checks: checks as never,
      repo: {} as never,
      startEval: async () => "eval-1",
      log: () => {},
    });

    const decision = await runner.onPullRequest(ctx, {
      api, agentUuid: "agent-1", agentSlug: "weather-agent", linkId: "link-1",
      repoFullName: repo, event, configuredTargets: [{ provider: "fake", model: "" }],
      datasetName: "weather-suite",
    });
    check(decision.checkRunId !== null, "the check is posted", decision.reason);

    const posted = await fetch(`${mock.url}/repos/${repo}/commits/${headSha}/check-runs`, {
      headers: { Authorization: "Bearer test-token" },
    }).then((r) => r.json() as Promise<{ total_count: number; check_runs: { id: number; status: string }[] }>);

    // THE ASSERTION THE WHOLE FILE IS FOR.
    check(posted.total_count === 1, "GitHub is holding exactly one check run", `${posted.total_count}`);
    check(
      posted.check_runs.every((c) => c.status === "in_progress"),
      "…and it is the one that moved on, not a duplicate left at queued beside it",
      posted.check_runs.map((c) => c.status).join(","),
    );
    check(
      [...checks.rows.values()][0]?.github_check_run_id === String(posted.check_runs[0]?.id),
      "and the row we keep names the check GitHub actually has",
    );
  }

  console.log("\nno dataset is no check, and no request either");
  {
    const checks = fakeChecks(undefined);
    const runner = new CheckRunner({ checks: checks as never, repo: {} as never, startEval: async () => "eval-2", log: () => {} });
    const decision = await runner.onPullRequest(ctx, {
      api, agentUuid: "agent-2", agentSlug: "other", linkId: "link-2",
      repoFullName: repo, event: { ...event, headSha }, configuredTargets: [],
    });
    check(decision.checkRunId === null, "§B.1.2's opt-in holds — the absence of a row is a decision");
    check(checks.rows.size === 0, "and nothing was written down about a check that did not happen");
  }
} finally {
  await mock.close();
}

if (failures > 0) {
  console.log(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL CORRECT");
