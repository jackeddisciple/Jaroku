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
} finally {
  await mock.close();
}

if (failures > 0) {
  console.log(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL CORRECT");
