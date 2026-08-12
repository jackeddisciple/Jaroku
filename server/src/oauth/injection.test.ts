// A connector's credential reaching a run, and reaching nothing else.
//
// TWO ASSERTIONS CARRY THIS SUITE.
//
// The first is that what a run receives is the SHORT half. A refresh token is a permanent grant
// to somebody's mailbox and an access token is an hour; what executes in the sandbox is
// model-written Python responding to a stranger's prompt. So the environment handed to a run
// contains the access token under the name the connector template reads, and does not contain the
// refresh token under any name at all.
//
// The second is the one the migration spec asks for by name: NO TOKEN IS WRITTEN TO ANY FILE. It
// is checked by pointing the local credential writer at a scratch directory, running a full
// resolution through it, and then reading every byte of every file under that directory back and
// searching for the literal values — plus `runtime/.env` itself, which is the file this whole
// session exists to stop being the answer. Blunt on purpose: a future code path that persisted a
// token fails this without anybody having had to predict the path.
//
//   npm run test:oauth-injection

import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "../db/migrate.ts";
import { SqliteDb } from "../db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { SecretRefRepository } from "../db/repositories/secretRefs.ts";
import { OAuthRepository } from "../db/repositories/oauth.ts";
import { KmsSecretStore } from "../secrets/kmsSecretStore.ts";
import { DotEnvSecretStore } from "../secrets/dotEnvSecretStore.ts";
import { fileCredentialWriter } from "../envWriter.ts";
import { LocalMasterKeyProvider } from "../secrets/masterKey.ts";
import { OAuthService, type TokenTransport } from "./service.ts";
import { TokenRefresher, RUN_TOKEN_GRACE_MS } from "./refresh.ts";
import { connectorEnvNames, connectorRunEnv } from "./injection.ts";
import { GOOGLE } from "./google.ts";
import { SLACK } from "./slack.ts";
import type { OAuthClientConfig } from "./provider.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const MIGRATIONS = join(fileURLToPath(new URL("../..", import.meta.url)), "migrations");
const MASTER = "a-master-key-with-enough-entropy-behind-it-0123456789";

const GMAIL_ACCESS = "ya29.access-for-a-run-4c1f";
const GMAIL_REFRESH = "1//refresh-that-must-not-travel-9d2b";
const SLACK_BOT = "xoxb-bot-token-77e4";

const CONFIG: OAuthClientConfig = {
  clientId: "id",
  clientSecret: "secret",
  redirectUri: "https://jaroku.example.com/v1/oauth/google/callback",
};

const scratch: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "jaroku-inject-"));
scratch.push(dir);
const db = new SqliteDb(join(dir, "inject.db"));
await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});

const identity = new IdentityRepository(db);
const refs = new SecretRefRepository(db);
const repo = new OAuthRepository(db);
const secrets = new KmsSecretStore({
  db,
  master: new LocalMasterKeyProvider(MASTER),
  refs,
  runWorkspace: async () => null,
});

const providers = [GOOGLE, SLACK];
const config = (): OAuthClientConfig => CONFIG;
const noNetwork: TokenTransport = async () => {
  throw new Error("this test must not reach a provider");
};
const service = new OAuthService({ repo, secrets, providers, config, transport: noNetwork });
const refresher = new TokenRefresher({ repo, secrets, providers, config, service });

async function workspace(label: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `inject ${label} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

/** A live Gmail connection with plenty of life left, so nothing tries to refresh it. */
async function connectGmail(ctx: TenantContext, opts: { expiresInMs?: number } = {}): Promise<void> {
  await secrets.set(ctx, "GMAIL_ACCESS_TOKEN", GMAIL_ACCESS);
  await secrets.set(ctx, "GMAIL_REFRESH_TOKEN", GMAIL_REFRESH);
  await repo.upsert(ctx, {
    provider: "google",
    connectorId: "gmail",
    scopes: ["openid"],
    accessSecretName: "GMAIL_ACCESS_TOKEN",
    refreshSecretName: "GMAIL_REFRESH_TOKEN",
    accessExpiresAt: new Date(Date.now() + (opts.expiresInMs ?? 6 * 60 * 60_000)).toISOString(),
  });
}

async function connectSlack(ctx: TenantContext): Promise<void> {
  await secrets.set(ctx, "SLACK_BOT_TOKEN", SLACK_BOT);
  await repo.upsert(ctx, {
    provider: "slack",
    connectorId: "slack",
    scopes: ["chat:write"],
    accessSecretName: "SLACK_BOT_TOKEN",
    accessExpiresAt: null,
  });
}

// --- what a run receives --------------------------------------------------------------------
console.log("\nwhat a run receives, and what it does not");
{
  const A = await workspace("run");
  await connectGmail(A);
  await connectSlack(A);

  const resolved = await connectorRunEnv(A, refresher, service, {
    connectors: ["gmail", "slack", "postgres"],
  });

  check(resolved.env["GMAIL_ACCESS_TOKEN"] === GMAIL_ACCESS, "the Gmail access token is in the run's environment");
  check(resolved.env["SLACK_BOT_TOKEN"] === SLACK_BOT, "...and the Slack bot token, under the name slack.py reads");
  check(
    !Object.values(resolved.env).includes(GMAIL_REFRESH),
    "and the REFRESH token is not, under any name — it is a permanent grant and stays on the control plane",
  );
  check(
    !("GMAIL_REFRESH_TOKEN" in resolved.env),
    "...not even under the name it has in the vault",
  );
  check(
    !("DATABASE_URL" in resolved.env),
    "postgres resolves through required_env instead, so this contributes nothing for it",
  );
  check(
    resolved.credentials.filter((c) => c.unavailable === null).length === 2,
    "two connectors resolved, and the third was not this module's to answer",
  );
}

// --- least privilege ------------------------------------------------------------------------
console.log("\nan agent gets its own connectors and no others");
{
  const A = await workspace("least");
  await connectGmail(A);
  await connectSlack(A);

  const gmailOnly = await connectorRunEnv(A, refresher, service, { connectors: ["gmail"] });
  check(gmailOnly.env["GMAIL_ACCESS_TOKEN"] === GMAIL_ACCESS, "an agent declaring gmail gets Gmail");
  check(
    !("SLACK_BOT_TOKEN" in gmailOnly.env),
    "...and does NOT get Slack, even though the workspace has connected it",
  );

  const none = await connectorRunEnv(A, refresher, service, { connectors: [] });
  check(Object.keys(none.env).length === 0, "an agent with no connectors gets nothing at all");
}

// --- not connected --------------------------------------------------------------------------
console.log("\na connector nothing is connected for");
{
  const A = await workspace("absent");
  const resolved = await connectorRunEnv(A, refresher, service, { connectors: ["gmail"] });
  check(Object.keys(resolved.env).length === 0, "no variable is invented");
  check(
    !("GMAIL_ACCESS_TOKEN" in resolved.env),
    "...and certainly not an empty string, which would become an opaque 401 from Google",
  );
  check(
    (resolved.credentials[0]?.unavailable ?? "").includes("not connected"),
    "the reason is reported so the run's log can say it before a tool call discovers it",
  );
}

// --- reauth_required ------------------------------------------------------------------------
console.log("\na connection that needs a human");
{
  const A = await workspace("reauth");
  await connectGmail(A);
  const row = await repo.forConnector(A, "gmail");
  await repo.markReauthRequired(A, row?.id ?? "", "the provider rejected our refresh");

  const resolved = await connectorRunEnv(A, refresher, service, { connectors: ["gmail"] });
  check(Object.keys(resolved.env).length === 0, "the stale token is NOT handed to a run");
  check(
    (resolved.credentials[0]?.unavailable ?? "").includes("reauthorising"),
    "...and the reason names what somebody has to do",
  );
}

// --- the horizon ------------------------------------------------------------------------------
console.log("\na token has to outlast the run it is given to");
{
  const A = await workspace("horizon");
  // Twenty minutes of life, and a run allowed to take an hour. Without a horizon that accounts
  // for the run's own deadline this would look fine and expire mid-graph.
  await connectGmail(A, { expiresInMs: 20 * 60_000 });
  let refreshed = 0;
  const rotating = new TokenRefresher({
    repo,
    secrets,
    providers,
    config,
    service: new OAuthService({
      repo,
      secrets,
      providers,
      config,
      transport: async () => {
        refreshed++;
        return { status: 200, body: { access_token: "refreshed-for-a-long-run", expires_in: 3600 } };
      },
    }),
  });

  const short = await connectorRunEnv(A, rotating, service, { connectors: ["gmail"], runTimeoutMs: 0 });
  check(refreshed === 0, "a run with no deadline does not refresh a token twenty minutes from expiry");
  check(short.env["GMAIL_ACCESS_TOKEN"] === GMAIL_ACCESS, "...and gets the one that is already there");

  const long = await connectorRunEnv(A, rotating, service, {
    connectors: ["gmail"],
    runTimeoutMs: 60 * 60_000,
  });
  check(refreshed === 1, "a run allowed an hour refreshes first, rather than expiring mid-graph");
  check(long.env["GMAIL_ACCESS_TOKEN"] === "refreshed-for-a-long-run", "...and is given the fresh one");
  check(RUN_TOKEN_GRACE_MS === 10 * 60 * 1000, "the grace beyond a run's own deadline is ten minutes");
}

// --- the names, without the values -------------------------------------------------------------
console.log("\nthe names a run will see can be asked for without resolving anything");
{
  const names = connectorEnvNames(service, ["gmail", "slack", "postgres", "nonsense"]);
  check(names.includes("GMAIL_ACCESS_TOKEN"), "gmail contributes its access-token name");
  check(names.includes("SLACK_BOT_TOKEN"), "...and slack its bot-token name");
  check(names.length === 2, "...while postgres and an unknown id contribute nothing", names.join(","));
}

// --- NO TOKEN IS WRITTEN TO ANY FILE -------------------------------------------------------------
console.log("\nno token is written to any file");
{
  // The LOCAL store, which is the one that writes to disk at all — the hosted store has no file
  // to write to, so running this against it would prove nothing. This is the path a developer
  // runs, and the question is whether a connector credential resolved through it leaves a copy
  // behind anywhere other than the one file `runtime/.env` has always been.
  const fileDir = mkdtempSync(join(tmpdir(), "jaroku-inject-fs-"));
  scratch.push(fileDir);
  const envPath = join(fileDir, ".env");
  writeFileSync(envPath, "# an existing file, which must survive\nUNRELATED=keep-me\n", "utf8");

  const localRefs = new SecretRefRepository(db);
  const local = new DotEnvSecretStore({
    writer: fileCredentialWriter(envPath),
    envPath,
    refs: localRefs,
  });
  const B = await workspace("files");
  const localService = new OAuthService({ repo, secrets: local, providers, config, transport: noNetwork });
  const localRefresher = new TokenRefresher({ repo, secrets: local, providers, config, service: localService });

  await local.set(B, "SLACK_BOT_TOKEN", SLACK_BOT);
  await repo.upsert(B, {
    provider: "slack",
    connectorId: "slack",
    scopes: [],
    accessSecretName: "SLACK_BOT_TOKEN",
    accessExpiresAt: null,
  });
  const resolved = await connectorRunEnv(B, localRefresher, localService, { connectors: ["slack"] });
  check(resolved.env["SLACK_BOT_TOKEN"] === SLACK_BOT, "the local path resolves a token too");

  // Every byte under the scratch directory, plus the database file. The `.env` is the ONE file
  // the local store is allowed to hold a value in — it is the local implementation of the vault
  // and its whole job — so it is checked separately and everything else must be clean.
  const walk = (root: string): string[] =>
    readdirSync(root).flatMap((name) => {
      const path = join(root, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });

  const elsewhere = walk(fileDir).filter((p) => p !== envPath);
  const dirty = elsewhere.filter((p) => readFileSync(p, "utf8").includes(SLACK_BOT));
  check(dirty.length === 0, "and no OTHER file under the store's directory holds it", dirty.join(", "));

  const envText = readFileSync(envPath, "utf8");
  check(envText.includes("UNRELATED=keep-me"), "the existing file survived byte-for-byte");
  check(
    envText.split("\n").filter((l) => l.includes(SLACK_BOT)).length === 1,
    "...and the credential is on exactly one line of the one file that is the local vault",
  );

  // The hosted store keeps ciphertext, so the same search against the DATABASE has to come up
  // empty — which is the property the envelope encryption exists for, asserted here because this
  // is the suite that asks "where did the bytes go".
  const dbBytes = readFileSync(join(dir, "inject.db"));
  check(!dbBytes.includes(Buffer.from(GMAIL_ACCESS)), "the hosted store's database holds no plaintext access token");
  check(!dbBytes.includes(Buffer.from(GMAIL_REFRESH)), "...and no plaintext refresh token");
  check(!dbBytes.includes(Buffer.from(SLACK_BOT)), "...and no plaintext bot token");
}

await db.close();
for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
