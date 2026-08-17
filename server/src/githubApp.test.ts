// The App's own identity, and the permission list as a tested fact.
//
// THE FIRST SUITE HERE IS THE MANIFEST, and it exists because of how this feature was specified:
// the permission list was written down by hand, and one line of it — `checks: read` — was the
// opposite of what §B.1 needs. A read-only checks permission lets the panel SEE check runs and
// never post one, which is precisely the capability the whole move to a GitHub App was made to
// obtain. It would not have failed at registration. It would have failed on somebody's first pull
// request, with a 403 several screens from the decision that caused it, which is the failure shape
// this migration exists to end.
//
// So the manifest is asserted rather than reviewed. A permission that is dropped, narrowed, or
// added without a reason breaks a named assertion here.
//
// THE SECOND AND THIRD SUITES are the two things that replace a stored credential: a token minted
// per hour and cached against GitHub's own expiry, and a single-use state that ties a redirect back
// to the workspace that started it. Both are pure and both are where a subtle bug would be
// invisible — a cache that outlives its token is a 401 on a push, and a state that can be replayed
// is somebody else's installation landing in your workspace.
//
//   npm run test:github-app

import {
  InstallationTokens, RoundTripStates, appJwt, buildManifest, githubAppConfig,
} from "./githubApp.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

console.log("\nthe permissions the App asks for");
{
  const manifest = buildManifest({ baseUrl: "http://localhost:4317" });
  const perms = manifest["default_permissions"] as Record<string, string>;

  // THE ONE THE SPEC GOT BACKWARDS. `POST /check-runs` is a write, it is App-only, and it is the
  // reason this whole path exists.
  check(perms["checks"] === "write", "checks is WRITE — §B.1 posts a check run, it does not read one", perms["checks"]);

  check(perms["contents"] === "write", "contents is write — blobs, trees, commits, refs");
  check(perms["workflows"] === "write", "workflows is write — .github/workflows/jaroku-build.yml");
  check(perms["administration"] === "write", "administration is write — creating a repository");
  check(perms["pull_requests"] === "write", "pull_requests is write — §3.9's PR and §B.5's replies");
  check(perms["statuses"] === "write", "statuses is present — checksFor reads the combined status");
  check(perms["metadata"] === "read", "metadata is read — mandatory on every App");

  // A LIST, NOT A MINIMUM. Something added here without a line in `buildManifest`'s comment naming
  // the calls it is for is a permission nobody can justify later, which is how they accumulate.
  check(
    Object.keys(perms).sort().join(",") ===
      "administration,checks,contents,metadata,pull_requests,statuses,workflows",
    "and there are exactly seven, so an unexplained one cannot appear quietly",
    Object.keys(perms).sort().join(","),
  );

  const events = manifest["default_events"] as string[];
  check(events.includes("pull_request"), "pull_request is subscribed — §B.1.2's trigger");
  check(events.includes("push"), "push is subscribed — the watermark a teammate's push moves");
  check(manifest["request_oauth_on_install"] === true, "user authorization is requested at install");
  check(manifest["public"] === false, "the App is private to this account by default");
}

console.log("\nwhere GitHub is told to come back to");
{
  const manifest = buildManifest({ baseUrl: "https://jaroku.example.com/" });
  // The trailing slash is the interesting input: a base URL somebody pasted with one would
  // otherwise produce `//v1/github/webhook`, which GitHub accepts and this server does not route.
  check(
    (manifest["hook_attributes"] as { url: string }).url === "https://jaroku.example.com/v1/github/webhook",
    "the webhook URL survives a trailing slash on the base",
    (manifest["hook_attributes"] as { url: string }).url,
  );
  check(
    manifest["redirect_url"] === "https://jaroku.example.com/v1/github/app/registered",
    "and so does the registration callback",
  );
  check(
    manifest["setup_url"] === "https://jaroku.example.com/v1/github/install/callback",
    "and the install callback, which is where the installation id arrives",
  );
}

console.log("\nthe App's own JWT");
{
  // A throwaway key. Generated rather than checked in, because a private key in a test fixture is
  // a private key in a repository, whatever it is for.
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  const now = 1_700_000_000_000;
  const token = appJwt("12345", privateKey as unknown as string, now);
  const [header, payload, signature] = token.split(".");
  const decode = (part: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));

  check(decode(header!)["alg"] === "RS256", "signed RS256, which is the only algorithm GitHub takes");
  check(decode(payload!)["iss"] === "12345", "issued by the app id");
  // BACKDATED BY A MINUTE ON PURPOSE. `iat` is compared against GitHub's clock, and a machine a
  // few seconds fast mints a token GitHub reads as issued in the future and refuses.
  check(decode(payload!)["iat"] === Math.floor(now / 1000) - 60, "with `iat` a minute in the past");
  check(
    (decode(payload!)["exp"] as number) - (decode(payload!)["iat"] as number) <= 10 * 60,
    "and a lifetime inside GitHub's ten-minute ceiling",
  );
  check(typeof signature === "string" && signature.length > 40, "and a signature");
  check(!token.includes("+") && !token.includes("/") && !token.includes("="), "base64url, not base64");
}

console.log("\ninstallation tokens are cached against their own expiry and no longer");
{
  const config = { appId: "1", slug: "jaroku", clientId: "c", clientSecret: "s", privateKey: "k", webhookSecret: "w" };
  let minted = 0;
  const mint = async (): Promise<{ token: string; expiresAt: string }> => {
    minted++;
    return { token: `token-${minted}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  };

  const tokens = new InstallationTokens();
  check((await tokens.get(config, "42", mint)) === "token-1", "the first call mints");
  check((await tokens.get(config, "42", mint)) === "token-1", "the second does not");
  check(minted === 1, "…so one hour of pushes is one token", String(minted));
  check((await tokens.get(config, "99", mint)) === "token-2", "a different installation is a different token");

  // THE PROPERTY THAT MATTERS: a token near its expiry is replaced BEFORE it is used, because one
  // that dies between the check and the request is a 401 on a push.
  const expiring = new InstallationTokens(60_000);
  let issued = 0;
  const soon = async (): Promise<{ token: string; expiresAt: string }> => {
    issued++;
    return { token: `soon-${issued}`, expiresAt: new Date(Date.now() + 30_000).toISOString() };
  };
  await expiring.get(config, "42", soon);
  await expiring.get(config, "42", soon);
  check(issued === 2, "a token inside the skew window is re-minted rather than used", String(issued));

  const forgetful = new InstallationTokens();
  await forgetful.get(config, "42", mint);
  forgetful.forget("42");
  const before = minted;
  await forgetful.get(config, "42", mint);
  check(minted === before + 1, "and forgetting one — as an uninstall does — mints the next time");
}

console.log("\nthe state that ties a redirect back to the workspace that started it");
{
  const states = new RoundTripStates();
  const state = states.issue("ws-1");
  check(states.claim(state) === "ws-1", "a state names its workspace");
  // SINGLE USE. A state that can be claimed twice is one that can be replayed, and a replayed
  // install callback writes somebody else's installation into the workspace that issued it.
  check(states.claim(state) === null, "…once, and never again");
  check(states.claim("something-else") === null, "and one nobody issued is refused");
  check(states.claim(undefined) === null, "…as is none at all");

  const expired = new RoundTripStates(-1);
  check(expired.claim(expired.issue("ws-1")) === null, "an expired state is refused rather than honoured");
}

console.log("\nno App configured is a state, not a misconfiguration");
{
  check(githubAppConfig({}) === null, "an empty environment answers null");
  check(
    githubAppConfig({ JAROKU_GITHUB_APP_ID: "1" }) === null,
    "…and so does a half-written one, rather than a config with holes in it",
  );
  const config = githubAppConfig({
    JAROKU_GITHUB_APP_ID: "1",
    JAROKU_GITHUB_APP_CLIENT_ID: "cid",
    JAROKU_GITHUB_APP_CLIENT_SECRET: "secret",
    JAROKU_GITHUB_APP_PRIVATE_KEY_B64: Buffer.from("-----BEGIN RSA PRIVATE KEY-----\nx\n").toString("base64"),
  });
  check(config !== null, "a complete one answers a config");
  // THE PEM IS STORED BASE64 BECAUSE `setEnvVar` REFUSES A NEWLINE, and a PEM is nothing but
  // newlines. Decoded on the way out, so nothing above this layer knows.
  check(config?.privateKey.includes("BEGIN RSA PRIVATE KEY") === true, "with the key decoded from base64");
  check(config?.privateKey.includes("\n") === true, "…newlines intact, which is what makes it a key");
  check(config?.slug === "jaroku", "and a slug that falls back rather than being undefined");
}

if (failures > 0) {
  console.log(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL CORRECT");
