// The first push — the one every other push in this feature is a variation on, and the one nothing
// covered.
//
// TWO FAILURES LIVED HERE, and both were invisible because the fixture was more generous than
// GitHub. `fixtures/github/mockGithubApi.ts` accepted blobs, trees and commits against a
// repository with no commits at all; the real Git Data API answers 409 "Git Repository is empty"
// to every one of them. So §6's first row — "empty repo: first push creates the initial commit" —
// passed here and failed against github.com at the FIRST blob of the FIRST push into a repository
// §2.2 had itself just created, which is the most common way anybody starts.
//
// And in a repository that DID have commits, a first push wrote a commit with no parents. That is
// an orphan branch: GitHub refuses to open a pull request between it and `main` (422 — no merge
// base) and refuses to compare them (404). §3.1 says reconciliation is always through a pull
// request and §3.7 hands divergence off to one, so an orphan branch takes out the entire
// reconciliation path while every screen in the panel still reads as though it worked.
//
// THIS SUITE DRIVES THE REAL `GithubApi` AGAINST THE FIXTURE, rather than asserting on a plan.
// `githubPush.test.ts` covers what a push decides; the two bugs above were both in what a push
// DOES, so nothing short of the four calls in their real order would have caught either.
//
//   npm run test:github-first-push

import { startMockGithubApi } from "../fixtures/github/mockGithubApi.ts";
import { GithubApi, GithubError } from "./githubApi.ts";

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

try {
  console.log("\na repository Jaroku has just created for somebody");
  {
    const created = await api.createRepo("weather-agent", { private: true });
    check(created.fullName.endsWith("/weather-agent"), "is created with no commit in it");
    check(created.empty === true, "and says so, because this is the one moment that is known");

    // The claim the old code was built on, restated as an assertion so it cannot come back: the
    // repository object does NOT carry emptiness. `pushed_at` is stamped at creation.
    const fetched = await api.repo(created.fullName);
    check(fetched.pushedAt !== null, "the repository object still reports a pushed_at…");
    check(fetched.empty === null, "…so reading it back answers 'not asked' rather than a guess");
    check(await api.isEmpty(created.fullName), "and the one exact question answers yes");
  }

  console.log("\nthe Git Data API is unavailable until something is in there");
  {
    const repo = "jackeddisciple/weather-agent";
    let kind: string | null = null;
    try {
      await api.createBlob(repo, { path: "agent.py", content: "x = 1\n" });
    } catch (err) {
      kind = err instanceof GithubError ? err.kind : "not-a-github-error";
    }
    // The whole bug in one assertion. Everything §2.4's push does after "read the versions" goes
    // through this call.
    check(kind === "conflict", "the first blob of the first push is refused", `got ${kind}`);
    check(await api.refSha(repo, "jaroku/weather-agent") === null, "and the branch does not exist yet");
  }

  console.log("\nso the initial commit is written the one way GitHub accepts");
  {
    const repo = "jackeddisciple/weather-agent";
    const seeded = await api.initialCommit(repo, "main", {
      path: "README.md", content: "# weather-agent\n", message: "Initial commit",
    });
    check(typeof seeded === "string" && seeded.length > 0, "it lands, and names its commit");
    check(!(await api.isEmpty(repo)), "the repository is no longer empty");
    check((await api.refSha(repo, "main")) === seeded, "…on the DEFAULT branch");
    // §3.1: Jaroku owns `jaroku/<slug>` and a person owns theirs. Seeding Jaroku's branch in a
    // repository with no others would have made it the repository's default branch.
    check((await api.refSha(repo, "jaroku/weather-agent")) === null, "…and never on Jaroku's own");

    const blob = await api.createBlob(repo, { path: "agent.py", content: "x = 1\n" });
    check(typeof blob === "string", "and the ordinary push path works from here on");
  }

  console.log("\nand the branch is rooted on the default branch rather than on nothing");
  {
    const repo = "jackeddisciple/weather-agent";
    const root = (await api.refSha(repo, "main"))!;
    const blob = await api.createBlob(repo, { path: "agent.py", content: "x = 1\n" });
    const tree = await api.createTree(repo, [{ path: "agent.py", sha: blob }], await api.commitTree(repo, root));
    const commit = await api.createCommit(repo, { message: "Initial generation", tree, parents: [root] });
    await api.createRef(repo, "jaroku/weather-agent", commit.sha);

    // The property an orphan branch does not have, and the one every reconciliation surface needs:
    // a merge base. Without it `compare` is a 404 and §3.7 detects nothing at all.
    const comparison = await api.compare(repo, "main", "jaroku/weather-agent");
    check(comparison.aheadBy === 1, "the branch compares against main", `ahead ${comparison.aheadBy}`);
    check(comparison.files.includes("agent.py"), "and names the file the version added");
    // The README the root carried is inherited rather than deleted — deletions are computed
    // against the branch's own previous head, and a first push has none.
    const entries = (await api.tree(repo, commit.sha)).map((e) => e.path).sort();
    check(entries.join(",") === "README.md,agent.py", "the tree carries both", entries.join(","));
  }

  console.log("\nan empty repository whose default branch IS the linked one");
  {
    // Somebody pointed the link at `main` in a repository with nothing in it. Seeding creates that
    // branch on the way past, so the push has to UPDATE the ref rather than create it — a
    // `createRef` here is a 422 on a push that has otherwise entirely succeeded.
    const created = await api.createRepo("root-linked", { private: true });
    const repo = created.fullName;
    const seeded = await api.initialCommit(repo, "main", {
      path: "README.md", content: "# root-linked\n", message: "Initial commit",
    });
    check((await api.refSha(repo, "main")) === seeded, "seeding created the linked branch itself");

    let refused = false;
    try {
      await api.createRef(repo, "main", seeded);
    } catch (err) {
      refused = err instanceof GithubError && err.kind === "conflict";
    }
    check(refused, "so creating it again is refused — which is why the runner asks");
  }
} finally {
  await mock.close();
}

if (failures > 0) {
  console.log(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL CORRECT");
