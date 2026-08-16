// §3.9's one-line CI verdict, and the endpoint that could never answer it.
//
// "✓ checks passing" is the line §3.9 argues is a genuine gate rather than decoration, because
// Jaroku emits a Dockerfile and §B.6.2 writes the workflow that builds it. It was computed from
// `GET /commits/{sha}/status` — the COMMIT STATUSES API, which is the older mechanism and does not
// include check runs. GitHub Actions writes check runs. §B.1's eval check writes a check run. So
// the card asked an endpoint that structurally could not see either of the two checks this feature
// creates itself, got `total_count: 0`, and rendered "no checks reported" over a failing build.
//
// Measured against this repository's own latest commit at the time this was written: the statuses
// API answered `total_count: 0`; the check-runs API answered two runs, both `failure`.
//
// WHAT THIS SUITE PINS is the rollup, because that is where the next mistake lives: a pull request
// carrying a passing build and a running eval is not "passing", and one carrying a `neutral` dry
// run is not "failing".
//
//   npm run test:github-checks-line

import { startMockGithubApi } from "../fixtures/github/mockGithubApi.ts";
import { GithubApi } from "./githubApi.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const mock = await startMockGithubApi();
const api = new GithubApi({ token: "test-token", base: mock.url });
const repo = (await api.createRepo("weather-agent")).fullName;
await api.initialCommit(repo, "main", { path: "README.md", content: "# x\n", message: "Initial commit" });
const sha = (await api.refSha(repo, "main"))!;

/** Ask the fixture directly, so this suite can say what each endpoint answers on its own. */
async function raw<T>(path: string): Promise<T> {
  const r = await fetch(`${mock.url}${path}`, { headers: { Authorization: "Bearer test-token" } });
  return (await r.json()) as T;
}

/** Open a check run on the commit, as §B.1 does, and settle it. */
async function post(name: string, status: "queued" | "in_progress" | "completed", conclusion?: string): Promise<void> {
  await api.putCheckRun(repo, {
    name, headSha: sha, status, title: name, summary: "",
    ...(conclusion === undefined ? {} : { conclusion }),
  });
}

try {
  console.log("\nnothing has reported");
  {
    check((await api.checksFor(repo, sha)) === null, "is null, and null is not passing");
  }

  console.log("\none check run, which the statuses API cannot see at all");
  {
    await post("build (Docker)", "completed", "success");
    const statuses = await raw<{ total_count: number }>(`/repos/${repo}/commits/${sha}/status`);
    check(statuses.total_count === 0, "the endpoint this used to ask still reports nothing");
    const verdict = await api.checksFor(repo, sha);
    check(verdict?.state === "success" && verdict.total === 1, "and the one that answers reports it", JSON.stringify(verdict));
  }

  console.log("\na second check still running");
  {
    await post("Jaroku eval · weather-suite", "in_progress");
    const verdict = await api.checksFor(repo, sha);
    // A build that passed beside an eval that has not finished is not a pull request anybody should
    // be told is green.
    check(verdict?.state === "pending", "pending outranks the one that already passed", JSON.stringify(verdict));
    check(verdict?.total === 2, "and both are counted");
  }

  console.log("\nand when it fails");
  {
    const runs = await raw<{ check_runs: { id: number; name: string }[] }>(
      `/repos/${repo}/commits/${sha}/check-runs`,
    );
    const evalRun = runs.check_runs.find((r) => r.name.startsWith("Jaroku eval"))!;
    await api.putCheckRun(repo, {
      checkRunId: String(evalRun.id), name: evalRun.name, headSha: sha,
      status: "completed", conclusion: "failure", title: "t", summary: "s",
    });
    check((await api.checksFor(repo, sha))?.state === "failure", "failure outranks everything");
  }

  console.log("\n§B.1.3's dry run on a stranger's pull request");
  {
    // It concludes `neutral` — a check that decided it had nothing to say. Reading that as a
    // failure would make the provider boundary look like a refusal of somebody's code.
    const fresh = await api.createRepo("neutral-agent");
    await api.initialCommit(fresh.fullName, "main", { path: "README.md", content: "# n\n", message: "Initial commit" });
    const head = (await api.refSha(fresh.fullName, "main"))!;
    await api.putCheckRun(fresh.fullName, {
      name: "Jaroku eval", headSha: head, status: "completed", conclusion: "neutral", title: "t", summary: "s",
    });
    const verdict = await api.checksFor(fresh.fullName, head);
    check(verdict?.state === "success", "neutral does not hold the pull request", JSON.stringify(verdict));
    check(verdict?.total === 1, "but it is still a check that reported");
  }
  console.log("\nthe Checks API refuses every token this product has");
  {
    // `POST /check-runs` answers 403 "You must authenticate via a GitHub App." to every personal
    // access token — classic, fine-grained, `checks: write` ticked or not — and Jaroku
    // authenticates as a user with a PAT. So §B.1's check could not appear on anybody's pull
    // request, and the message it failed with told people to re-issue a token that would fail the
    // same way. It goes out as a commit status instead: fewer rows than §B.1.1's table, on the
    // pull request, where a gate belongs.
    mock.setAppOnlyChecks(true);
    const fresh = await api.createRepo("app-only-agent");
    await api.initialCommit(fresh.fullName, "main", { path: "README.md", content: "# a\n", message: "Initial commit" });
    const head = (await api.refSha(fresh.fullName, "main"))!;

    const opened = await api.putCheckRun(fresh.fullName, {
      name: "Jaroku eval · weather-suite", headSha: head, status: "queued",
      title: "Queued", summary: "on the free dry-run provider",
    });
    check(opened.id.startsWith("status:"), "the check falls back rather than throwing", opened.id);
    check((await api.checksFor(fresh.fullName, head))?.state === "pending", "and the pull request has a gate");

    // The id it handed back updates the same way a check run's would — the context IS the identity.
    await api.putCheckRun(fresh.fullName, {
      checkRunId: opened.id, headSha: head, status: "completed", conclusion: "success",
      title: "pass-rate 92% → 96% (+4)", summary: "",
    });
    const settled = await api.checksFor(fresh.fullName, head);
    check(settled?.state === "success", "and settles it rather than adding a second");
    check(settled?.total === 1, "…one gate, not two", `${settled?.total}`);

    const raw2 = await raw<{ statuses: { context: string; description: string }[] }>(
      `/repos/${fresh.fullName}/commits/${head}/status`,
    );
    check(raw2.statuses[0]?.context === "Jaroku eval · weather-suite", "under the check's own name");
    check(
      raw2.statuses[0]?.description === "pass-rate 92% → 96% (+4)",
      "carrying the numbers §B.1.1 exists to put there",
      raw2.statuses[0]?.description,
    );
    mock.setAppOnlyChecks(false);
  }

  console.log("\na token that may not READ checks is not a repository without any");
  {
    // OBSERVED ON A REAL PULL REQUEST. A fine-grained token without `Checks: read` gets 403 from
    // the check-runs endpoint, so a build that had just gone red rendered as "no checks reported"
    // — word for word what a repository with no CI at all shows. §3.9's whole argument is that this
    // line is a gate rather than decoration, and a gate that says nothing when it cannot see is
    // decoration with extra steps.
    const fresh = await api.createRepo("blind-agent");
    await api.initialCommit(fresh.fullName, "main", { path: "README.md", content: "# b\n", message: "Initial commit" });
    const head = (await api.refSha(fresh.fullName, "main"))!;
    mock.setChecksReadable(false);
    const verdict = await api.checksFor(fresh.fullName, head);
    check(verdict?.state === "unreadable", "it says so", JSON.stringify(verdict));
    check(verdict?.total === 0, "and counts nothing, because it saw nothing");

    // And it must not swallow what it CAN see: a commit status still reports.
    await api.putCheckRun(fresh.fullName, {
      checkRunId: "status:status-only", headSha: head, status: "completed", conclusion: "failure",
      title: "the build failed", summary: "",
    });
    const partial = await api.checksFor(fresh.fullName, head);
    check(partial?.state === "failure", "a refused half does not hide the half that answered", JSON.stringify(partial));
    mock.setChecksReadable(true);
  }
} finally {
  await mock.close();
}

if (failures > 0) {
  console.log(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL CORRECT");
