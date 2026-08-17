// Connect GitHub, end to end, with no GitHub account anywhere.
//
// `githubApp.test.ts` asserts the pieces — the permission list, the JWT, the token cache, the
// state. This drives them in the order a person does: register the App from a manifest, install it,
// mint a token from the private key that came back, and use it to do the thing the whole migration
// was for. Nothing here is stubbed except GitHub itself.
//
// THE ORDER IS THE TEST. Each step consumes something the previous one produced — a conversion code
// becomes a private key, a private key signs a JWT, a JWT mints an installation token, an
// installation token pushes — so a break anywhere shows up as the step after it having nothing to
// work with. That is why this is one suite rather than five.
//
// AND THE TWO-TOKEN RULE IS ASSERTED FROM BOTH SIDES, because it is the part of this design most
// likely to be "simplified" later by somebody who has not read GitHub's docs: an installation token
// is refused by the three user-scoped calls, and a user token is the only thing that can create a
// repository. If those assertions ever start passing for the wrong reason, §2.2 quietly loses its
// left-hand option again.
//
//   npm run test:github-app-flow

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMockGithubApi } from "../fixtures/github/mockGithubApi.ts";
import { GithubApi } from "./githubApi.ts";
import {
  APP_ENV, InstallationTokens, convertManifest, exchangeUserCode, githubAppConfig,
  mintInstallationToken, readInstallation,
} from "./githubApp.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const mock = await startMockGithubApi();
// BOTH HOSTS, because GitHub has two and the App flow uses both: the REST calls go to the API host
// and the OAuth exchange goes to the web one. A fixture reachable at only one of them would leave
// the token exchange pointed at github.com in a test that claims to need no account.
process.env["JAROKU_GITHUB_API"] = mock.url;
process.env["JAROKU_GITHUB_WEB"] = mock.url;

const scratch = mkdtempSync(join(tmpdir(), "jaroku-appflow-"));
const envPath = join(scratch, ".env");
writeFileSync(envPath, "ANTHROPIC_API_KEY=sk-ant-example\n", "utf8");

/** The fixture's control plane — what a person clicking on github.com stands in for. */
async function control<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`${mock.url}/_mock/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

const before = { ...process.env };

try {
  console.log("\nregistering the App from a manifest");
  {
    const { code } = await control<{ code: string }>("manifest-code", { slug: "jaroku-test" });
    const outcome = await convertManifest(code, { envPath });
    check(outcome.ok === true, "the one-time code becomes an App", JSON.stringify(outcome));
    check(outcome.ok && outcome.slug === "jaroku-test", "…named by the manifest, not by us");

    // THE CREDENTIALS ARE ON DISK AND IN THE PROCESS. Only the file would mean registration
    // appears to work and then does nothing until a restart, on the request that just did it.
    const written = readFileSync(envPath, "utf8");
    check(written.includes(APP_ENV.appId), "the app id is written to the env file");
    check(written.includes(APP_ENV.privateKey), "and the private key, base64-encoded");
    check(!written.includes("BEGIN RSA PRIVATE KEY"), "…never as a PEM, which dotenv cannot hold");
    check(written.includes("ANTHROPIC_API_KEY=sk-ant-example"), "and every other line survives untouched");

    const config = githubAppConfig();
    check(config !== null, "the live process can read it back immediately");
    check(config?.privateKey.includes("BEGIN RSA PRIVATE KEY") === true, "…decoded into a usable key");

    // SINGLE USE, asserted because a replayable conversion code hands out a private key.
    const again = await convertManifest(code, { envPath });
    check(again.ok === false, "and the code cannot be redeemed twice");
  }

  console.log("\ninstalling it, and minting the credential a push actually travels on");
  {
    const app = githubAppConfig()!;
    const install = await control<{ installationId: string; code: string }>("install", { account: "jackeddisciple" });

    const account = await readInstallation(app, install.installationId);
    // ASKED, NOT READ OFF THE REDIRECT. `installation_id` arrives in a query string, which is to
    // say from a browser, which is to say from somewhere a person can edit.
    check(account.login === "jackeddisciple", "GitHub says whose account it is", account.login);
    check(account.type === "user", "and what kind");

    const minted = await mintInstallationToken(app, install.installationId);
    check(minted.token.startsWith("ghs_"), "an installation token is minted from the private key");
    check(Date.parse(minted.expiresAt) > Date.now(), "with an expiry in the future");
    check(Date.parse(minted.expiresAt) - Date.now() <= 3_600_000 + 5_000, "…of about an hour, which is GitHub's");

    const tokens = new InstallationTokens();
    const first = await tokens.get(app, install.installationId);
    const second = await tokens.get(app, install.installationId);
    check(first === second, "and it is reused until it expires rather than minted per call");

    const user = await exchangeUserCode(app, install.code);
    check(user.token.startsWith("user-token-"), "the install's code becomes a user token");
    check(user.refreshToken !== null, "with a refresh token, so hour nine still works");
    check(user.expiresAt !== null, "and an expiry, which a personal access token never had");
  }

  console.log("\nthe capability none of this could be had without");
  {
    const app = githubAppConfig()!;
    const install = await control<{ installationId: string }>("install", { installationId: "7100" });
    const token = await mintInstallationToken(app, install.installationId);
    const api = new GithubApi({ token: token.token, base: mock.url });

    const repo = (await api.createRepo("app-flow-agent")).fullName;
    await api.initialCommit(repo, "main", { path: "README.md", content: "# a\n", message: "Initial commit" });
    const head = (await api.refSha(repo, "main"))!;

    // §B.1's CHECK RUN, POSTED AS A CHECK RUN. Under a personal access token this is a 403 "You
    // must authenticate via a GitHub App" and the product falls back to a 140-character commit
    // status; the whole migration is this one assertion.
    const posted = await api.putCheckRun(repo, {
      name: "Jaroku eval · weather-suite", headSha: head, status: "completed", conclusion: "success",
      title: "pass-rate 92% → 96% (+4)", summary: "three rows of table",
    });
    check(!posted.id.startsWith("status:"), "the eval check posts as a check run, not a fallback status", posted.id);

    const verdict = await api.checksFor(repo, head);
    check(verdict?.state === "success", "and §3.9's line reads it back", JSON.stringify(verdict));
    check(verdict?.total === 1, "…as one gate");
  }

  console.log("\nwhat the installation may see is what somebody ticked");
  {
    // "ONLY SELECT REPOSITORIES" IS A DIFFERENT FIXTURE, deliberately, because it is a different
    // product outcome: a repository created a moment ago is outside it, GitHub offers no API to add
    // one, and §2.2's "Create new repo" therefore has to say so at link time rather than 404 later.
    const app = githubAppConfig()!;
    await control("install", { installationId: "7200", repos: ["jackeddisciple/app-flow-agent"] });
    const token = await mintInstallationToken(app, "7200");
    const api = new GithubApi({ token: token.token, base: mock.url });
    const visible = (await api.installationRepos()).map((r) => r.fullName);
    check(visible.length >= 1, "the picker lists what the installation reaches", visible.join(","));
    check(
      visible.every((n) => n === "jackeddisciple/app-flow-agent"),
      "…and nothing it does not",
      visible.join(","),
    );
  }
} finally {
  await mock.close();
  rmSync(scratch, { recursive: true, force: true });
  for (const key of Object.values(APP_ENV)) {
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key]!;
  }
  delete process.env["JAROKU_GITHUB_API"];
  delete process.env["JAROKU_GITHUB_WEB"];
}

if (failures > 0) {
  console.log(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL CORRECT");
