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
import { APPROVE_ACTION } from "./checkPolicy.ts";
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
function fakeChecks(config: AgentCiConfig | undefined, stale: CheckRunRow[] = []) {
  const rows = new Map<string, CheckRunRow>();
  let next = 1;
  return {
    rows,
    config: async () => config,
    approvedForSha: async () => false,
    supersededBy: async () => stale,
    cancel: async (_ctx: TenantContext, id: string) => {
      // CLOSES THE ROW, because `liveForSha` reads `status !== "completed"` and a cancel that only
      // recorded an intention would leave the constraint holding a check nothing is running.
      const row = rows.get(id);
      if (row) { row.status = "completed"; row.conclusion = "cancelled"; }
    },
    baselineFor: async () => undefined,
    open: async (_ctx: TenantContext, input: { agentId: string; linkId: string | null; prNumber: number; headSha: string; providerMode: "dry_run" | "paid" }) => {
      const row = {
        id: `row-${next++}`, agent_id: input.agentId, link_id: input.linkId, pr_number: input.prNumber,
        head_sha: input.headSha, github_check_run_id: null, eval_run_id: null, status: "queued",
        conclusion: null, provider_mode: input.providerMode, pass_rate: null, cost_per_run_usd: null,
        latency_p50_ms: null, pass_rate_delta: null, cost_delta: null, latency_delta: null,
        baseline_check_id: null, created_at: new Date().toISOString(), completed_at: null,
      } as CheckRunRow;
      // Migration 045's constraint, in miniature: one LIVE check per (agent, pr, commit). A second
      // delivery for a commit already being checked reads the winner rather than opening a rival.
      const live = [...rows.values()].find(
        (r) => r.agent_id === input.agentId && r.pr_number === input.prNumber
          && r.head_sha === input.headSha && r.status !== "completed",
      );
      if (live) return { row: { ...live }, created: false };
      rows.set(row.id, row);
      // A COPY, exactly as the real repository's `byId` re-read returns: the caller's object is not
      // the store's, so a later UPDATE to the column is invisible to whoever is holding it.
      return { row: { ...row }, created: true };
    },
    liveForSha: async (_ctx: TenantContext, agentId: string, prNumber: number, headSha: string) =>
      [...rows.values()].find(
        (r) => r.agent_id === agentId && r.pr_number === prNumber && r.head_sha === headSha
          && r.status !== "completed",
      ),
    byId: async (_ctx: TenantContext, id: string) => rows.get(id),
    attachGithubId: async (_ctx: TenantContext, id: string, githubId: string) => {
      const row = rows.get(id);
      if (row) row.github_check_run_id = githubId;
    },
    attachEval: async (_ctx: TenantContext, id: string, evalRunId: string) => {
      const row = rows.get(id);
      if (row) { row.eval_run_id = evalRunId; row.status = "in_progress"; }
    },
    complete: async (_ctx: TenantContext, id: string, input: { conclusion: string }) => {
      // CLOSES THE ROW, as the real repository does. It was a no-op while nothing in this suite
      // read the status back; the approval path does — it opens a paid row, completes it, and then
      // re-runs, and a completed row that stayed live made the re-run collide with the record of
      // its own approval.
      const row = rows.get(id);
      if (row) { row.status = "completed"; row.conclusion = input.conclusion as CheckRunRow["conclusion"]; row.completed_at = new Date().toISOString(); }
    },
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
    const started: { agentId: string; datasetId: string }[] = [];
    const runner = new CheckRunner({
      checks: checks as never,
      repo: {} as never,
      startEval: async (_ctx, input) => {
        started.push({ agentId: input.agentId, datasetId: input.datasetId });
        return "eval-1";
      },
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

    // THE SLUG, NOT THE UUID. `agentId` here becomes the eval row's `agent_id` and then the working
    // directory of every job's subprocess — `runtime/agents/<agentId>` — exactly as an ordinary
    // eval's does. This line passed `agentUuid` for as long as the feature was unreachable, which is
    // how it stayed unobserved: with no way to write `agent_ci_config`, the dispatch was never
    // reached in a running product, and the first real check would have failed every job.
    check(
      started[0]?.agentId === "weather-agent",
      "the eval is started against the agent SLUG, which is what a job's directory is derived from",
      started[0]?.agentId ?? "nothing was started",
    );
    check(started[0]?.datasetId === "dataset-1", "...against the dataset the config named");
  }

  console.log("\na superseded check is cancelled under the name it was posted with");
  {
    // §B.1.1's title carries the dataset, and `check_runs` stores an id rather than a title — so
    // the cancel path has no name to send and must send none. It used to send "Jaroku eval", which
    // RENAMED the run: the check somebody was watching disappeared from the pull request's list and
    // a differently-named cancelled one took its place.
    const old = await api.putCheckRun(repo, {
      name: "Jaroku eval · weather-suite", headSha, status: "in_progress", title: "Running", summary: "",
    });
    const staleRow = {
      id: "row-old", agent_id: "agent-1", link_id: "link-1", pr_number: 42, head_sha: headSha,
      github_check_run_id: old.id, eval_run_id: null, status: "in_progress", conclusion: null,
      provider_mode: "dry_run", pass_rate: null, cost_per_run_usd: null, latency_p50_ms: null,
      pass_rate_delta: null, cost_delta: null, latency_delta: null, baseline_check_id: null,
      created_at: new Date().toISOString(), completed_at: null,
    } as CheckRunRow;

    const checks = fakeChecks(
      { agent_id: "agent-1", ci_dataset_id: "dataset-1", provider_policy: "dry_run_only", updated_at: "" },
      [staleRow],
    );
    const runner = new CheckRunner({ checks: checks as never, repo: {} as never, startEval: async () => "eval-3", log: () => {} });
    await runner.onPullRequest(ctx, {
      api, agentUuid: "agent-1", agentSlug: "weather-agent", linkId: "link-1",
      repoFullName: repo, event, configuredTargets: [], datasetName: "weather-suite",
    });

    const posted = await fetch(`${mock.url}/repos/${repo}/commits/${headSha}/check-runs`, {
      headers: { Authorization: "Bearer test-token" },
    }).then((r) => r.json() as Promise<{ check_runs: { id: number; name: string; conclusion: string | null }[] }>);
    const cancelled = posted.check_runs.find((c) => String(c.id) === old.id);
    check(cancelled?.conclusion === "cancelled", "the older check is cancelled");
    check(cancelled?.name === "Jaroku eval · weather-suite", "…keeping its own name", cancelled?.name);
  }

  console.log("\na redelivered pull_request does not open a rival or spend a second time");
  {
    // GitHub retries anything it did not answer in time, a retry can land on another replica or
    // after a restart, and `reopened` carries the same head sha as the `opened` before it. Meanwhile
    // `supersede` excludes the same sha by construction, so it cancels nothing — the whole reason a
    // redelivery used to produce a second check run on the pull request and a second PAID eval
    // fan-out for one commit.
    const checks = fakeChecks({
      agent_id: "agent-3", ci_dataset_id: "dataset-1",
      provider_policy: "collaborators_paid", updated_at: new Date().toISOString(),
    });
    let dispatches = 0;
    const runner = new CheckRunner({
      checks: checks as never,
      repo: {} as never,
      startEval: async () => `eval-${++dispatches}`,
      log: () => {},
    });
    const twice = { ...event, number: 77 };
    const first = await runner.onPullRequest(ctx, {
      api, agentUuid: "agent-3", agentSlug: "weather-agent", linkId: "link-1",
      repoFullName: repo, event: twice, configuredTargets: [{ provider: "fake", model: "" }],
      datasetName: "weather-suite",
    });
    // The same delivery again — the reopen, the retry, the second replica.
    const second = await runner.onPullRequest(ctx, {
      api, agentUuid: "agent-3", agentSlug: "weather-agent", linkId: "link-1",
      repoFullName: repo, event: { ...twice, action: "reopened" },
      configuredTargets: [{ provider: "fake", model: "" }], datasetName: "weather-suite",
    });

    check(second.checkRunId === first.checkRunId, "the redelivery answers with the check already open");
    check(second.reason === "this commit is already being checked", "…saying so", second.reason);
    check(dispatches === 1, "…and the workspace's balance is spent once, not twice", String(dispatches));
    check(
      [...checks.rows.values()].filter((r) => r.pr_number === 77).length === 1,
      "…with one row for the commit rather than two rivals",
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

  // -------------------------------------------------------------------------------------------
  // §B.1.3's APPROVAL, AND THE LOOP IT BREAKS.
  //
  // `providerModeFor` answers `paid` when `approvedForThisSha`; that reads a `check_runs` row with
  // `provider_mode = 'paid'` for the commit; and such a row was only ever written by a run
  // `providerModeFor` had already answered `paid` for. Nothing outside that circle could enter it,
  // so no external pull request had ever been approved — while every one of them carried a summary
  // telling whoever read it that a collaborator could approve real providers for the commit.
  //
  // Driven against the fixture rather than asserted on a return value, because the two things that
  // matter are both writes: the paid row that makes `approvedForSha` true, and the re-run that
  // resolves `paid` through the ordinary path with nothing special-cased.
  // -------------------------------------------------------------------------------------------
  console.log("\nan approval on a stranger's check makes the commit paid, once, and only from write access");
  {
    const config: AgentCiConfig = {
      agent_id: "agent-3", ci_dataset_id: "dataset-1",
      provider_policy: "collaborators_paid", updated_at: new Date().toISOString(),
    };
    const checks = fakeChecks(config);
    // The real `approvedForSha`, in miniature: TRUE exactly when a paid row exists for the commit.
    // The fake's default answers false unconditionally, which is the state that made this
    // unreachable — deriving it from the rows is what lets the loop actually close.
    checks.approvedForSha = (async (_ctx: TenantContext, agentId: string, sha: string) =>
      [...checks.rows.values()].some(
        (r) => r.agent_id === agentId && r.head_sha === sha && r.provider_mode === "paid",
      )) as never;

    const dispatched: { targets: { provider: string; model: string }[] }[] = [];
    const runner = new CheckRunner({
      checks: checks as never,
      repo: {} as never,
      startEval: async (_ctx, input) => { dispatched.push({ targets: [...input.targets] }); return "eval-3"; },
      log: () => {},
    });

    // A stranger's pull request first, so there is a check to press the button on.
    const opened = await runner.onPullRequest(ctx, {
      api, agentUuid: "agent-3", agentSlug: "weather-agent", linkId: "link-3",
      repoFullName: repo, event: { ...event, number: 77 },
      configuredTargets: [{ provider: "anthropic", model: "claude-haiku-4-5" }],
    });
    check(opened.checkRunId !== null, "a stranger's pull request opens a check", opened.reason);
    check(dispatched[0]?.targets[0]?.provider === "fake", "...on the dry-run provider", JSON.stringify(dispatched[0]));
    check(opened.reason.includes(APPROVE_ACTION.label), "...and its summary names the button that is now on it", opened.reason);

    const opencheck = [...checks.rows.values()].find((r) => r.pr_number === 77)!;
    const githubId = opencheck.github_check_run_id!;

    // AN APPROVAL FROM SOMEBODY WITHOUT WRITE ACCESS IS REFUSED, and this is the assertion the
    // boundary is for: GitHub says who pressed the button, and only GitHub can say whether that
    // person may spend this workspace's balance.
    const rowsBefore = checks.rows.size;
    const refused = await runner.onApproval(ctx, {
      api, agentUuid: "agent-3", agentSlug: "weather-agent", linkId: "link-3", repoFullName: repo,
      check: { id: opencheck.id, githubCheckRunId: githubId, prNumber: 77, headSha },
      senderLogin: "a-stranger",
      configuredTargets: [{ provider: "anthropic", model: "claude-haiku-4-5" }],
    });
    check(refused.checkRunId === null, "a login with no write access cannot approve", refused.reason);
    check(checks.rows.size === rowsBefore, "...and no paid row was written for the commit");
    check(dispatched.length === 1, "...and nothing was dispatched");

    // AND FROM A COLLABORATOR IT WORKS, which is the state that was unreachable by construction.
    await fetch(`${mock.url}/_mock/collaborator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, login: "maintainer", permission: "write" }),
    });
    const approved = await runner.onApproval(ctx, {
      api, agentUuid: "agent-3", agentSlug: "weather-agent", linkId: "link-3", repoFullName: repo,
      check: { id: opencheck.id, githubCheckRunId: githubId, prNumber: 77, headSha },
      senderLogin: "maintainer",
      configuredTargets: [{ provider: "anthropic", model: "claude-haiku-4-5" }],
    });
    check(approved.checkRunId !== null, "a collaborator's approval is honoured", approved.reason);
    check(
      await (checks.approvedForSha as (c: TenantContext, a: string, h: string) => Promise<boolean>)(ctx, "agent-3", headSha),
      "...and approvedForSha now answers true, which nothing could make it do before",
    );
    check(
      dispatched.length === 2 && dispatched[1]?.targets[0]?.provider === "anthropic",
      "...and the re-run goes out on the configured real provider",
      JSON.stringify(dispatched[1]),
    );
    check(
      approved.reason === "a collaborator approved this commit for real providers",
      "...with the check's summary saying which of the four reasons applied",
      approved.reason,
    );

    // AN OPT-OUT IS AN OPT-OUT. A button that overrode `dry_run_only` would make the setting
    // advisory, which is why `offersApproval` declines to render it there in the first place.
    const optedOut = fakeChecks({ ...config, agent_id: "agent-4", provider_policy: "dry_run_only" });
    const strict = new CheckRunner({
      checks: optedOut as never, repo: {} as never, startEval: async () => "eval-4", log: () => {},
    });
    const overridden = await strict.onApproval(ctx, {
      api, agentUuid: "agent-4", agentSlug: "weather-agent", linkId: "link-4", repoFullName: repo,
      check: { id: "row-x", githubCheckRunId: githubId, prNumber: 78, headSha },
      senderLogin: "maintainer",
      configuredTargets: [{ provider: "anthropic", model: "claude-haiku-4-5" }],
    });
    check(overridden.checkRunId === null, "an approval does not override dry_run_only", overridden.reason);
    check(optedOut.rows.size === 0, "...and writes no paid row either");
  }
} finally {
  await mock.close();
}

if (failures > 0) {
  console.log(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL CORRECT");
