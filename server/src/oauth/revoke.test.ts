// Disconnecting, and whether it is true.
//
// THE ASSERTION THIS SUITE IS FOR is the first one: pressing Disconnect makes a call to the
// PROVIDER. Everything else here is about what happens when that call does not go as hoped, and
// the reason the list is long is that every one of those cases has an obvious wrong answer.
//
//   A provider that is DOWN must not keep somebody connected. Retrying forever holds a user in a
//   state they explicitly asked to leave.
//
//   A token that was ALREADY revoked — in Google's own settings page, an hour ago — must not
//   report a failure. It is the outcome the user asked for.
//
//   A provider with NO revocation endpoint must say so rather than claim success. Slack has one;
//   a future connector might not, and "we forgot it" is a smaller promise than "it is revoked".
//
//   And the LOCAL teardown happens in every one of those cases, because our copy of somebody
//   else's credential is not something to keep as leverage over a provider outage.
//
// The REFRESH token is preferred over the access token when there is one, and that is not a
// detail: revoking a Google refresh token ends the whole authorisation, while revoking an access
// token ends an hour of it and leaves the refresh token free to mint another.
//
//   npm run test:oauth-revoke

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "../db/migrate.ts";
import { SqliteDb } from "../db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { SecretRefRepository } from "../db/repositories/secretRefs.ts";
import { OAuthRepository, type OAuthConnectionRow } from "../db/repositories/oauth.ts";
import { KmsSecretStore } from "../secrets/kmsSecretStore.ts";
import { LocalMasterKeyProvider } from "../secrets/masterKey.ts";
import { ConnectionRevoker, endAllGrants, type RevokeTransport } from "./revoke.ts";
import { GOOGLE } from "./google.ts";
import { SLACK } from "./slack.ts";
import type { OAuthClientConfig, OAuthProvider } from "./provider.ts";

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

const ACCESS = "ya29.access-1a2b";
const REFRESH = "1//refresh-3c4d";

const CONFIG: OAuthClientConfig = {
  clientId: "id",
  clientSecret: "secret",
  redirectUri: "https://jaroku.example.com/v1/oauth/google/callback",
};

/** A provider with no revocation endpoint at all — the case that must not claim success. */
const NO_REVOKE: OAuthProvider = {
  id: "norevoke",
  label: "NoRevoke",
  authorizeUrl: "https://nr.example/authorize",
  tokenUrl: "https://nr.example/token",
  connectors: [
    {
      connectorId: "gmail",
      label: "NoRevoke Mail",
      scopes: [],
      accessSecretName: "GMAIL_ACCESS_TOKEN",
      consent: [],
    },
  ],
  readTokenResponse: () => null,
};

const scratch: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "jaroku-revoke-"));
scratch.push(dir);
const db = new SqliteDb(join(dir, "r.db"));
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

async function workspace(label: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `revoke ${label} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

/** A live Gmail connection with both halves in the vault. */
async function connect(ctx: TenantContext, opts: { refresh?: boolean; provider?: string } = {}): Promise<OAuthConnectionRow> {
  await secrets.set(ctx, "GMAIL_ACCESS_TOKEN", ACCESS);
  if (opts.refresh !== false) await secrets.set(ctx, "GMAIL_REFRESH_TOKEN", REFRESH);
  return repo.upsert(ctx, {
    provider: opts.provider ?? "google",
    connectorId: "gmail",
    scopes: ["openid"],
    accessSecretName: "GMAIL_ACCESS_TOKEN",
    refreshSecretName: opts.refresh === false ? null : "GMAIL_REFRESH_TOKEN",
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
}

function revokerOn(
  answer: () => { status: number; body: unknown },
  providers: OAuthProvider[] = [GOOGLE, SLACK, NO_REVOKE],
): { revoker: ConnectionRevoker; calls: URLSearchParams[] } {
  const calls: URLSearchParams[] = [];
  const transport: RevokeTransport = async (_url, body) => {
    calls.push(body);
    return answer();
  };
  return {
    calls,
    revoker: new ConnectionRevoker({ repo, secrets, providers, config: () => CONFIG, transport }),
  };
}

// --- the call actually happens ----------------------------------------------------------
console.log("\ndisconnecting tells the provider");
{
  const A = await workspace("tell");
  const row = await connect(A);
  const { revoker, calls } = revokerOn(() => ({ status: 200, body: {} }));

  const ended = await revoker.disconnect(A, row);
  check(ended.ok, "the disconnect completes");
  check(ended.remote === "revoked", "...and the provider confirmed it");
  check(calls.length === 1, "exactly one revocation call was made");
  check(
    calls[0]?.get("token") === REFRESH,
    "...presenting the REFRESH token, which ends the whole grant rather than an hour of it",
  );
  check(
    calls[0]?.get("token_type_hint") === "refresh_token",
    "...and saying which kind it is, because providers ask",
  );

  check(
    (await secrets.getForPlatformCall(A, ["GMAIL_ACCESS_TOKEN"]))["GMAIL_ACCESS_TOKEN"] === undefined,
    "the access token is gone from the vault",
  );
  check(
    (await secrets.getForPlatformCall(A, ["GMAIL_REFRESH_TOKEN"]))["GMAIL_REFRESH_TOKEN"] === undefined,
    "...and so is the refresh token",
  );
  const after = await repo.forConnector(A, "gmail");
  check(after?.status === "revoked", "the row says revoked");
  check(after?.revoked_at !== null, "...stamped, so an audit trail has something to point at");
  check((await repo.usable(A, "gmail")) === null, "and no run can be handed a credential from it");
}

// --- when there is only an access token -----------------------------------------------------
console.log("\na connection with no refresh token revokes the one it has");
{
  const A = await workspace("accessonly");
  const row = await connect(A, { refresh: false });
  const { revoker, calls } = revokerOn(() => ({ status: 200, body: {} }));
  const ended = await revoker.disconnect(A, row);
  check(ended.remote === "revoked", "it is revoked");
  check(calls[0]?.get("token") === ACCESS, "...presenting the access token, which is all there is");
  check(calls[0]?.get("token_type_hint") === "access_token", "...and saying so");
}

// --- the failure modes ------------------------------------------------------------------------
console.log("\nand every way it can go wrong still ends the connection here");
{
  const A = await workspace("down");
  const row = await connect(A);
  const { revoker } = revokerOn(() => {
    throw new Error("ETIMEDOUT");
  });
  const ended = await revoker.disconnect(A, row);
  check(ended.ok, "a provider we cannot reach does not block the disconnect");
  check(ended.remote === "unreachable", "...it is reported as unreachable");
  check(
    (ended.message ?? "").includes("connected apps"),
    "...and the user is told to go and check their own account",
  );
  check(
    (await secrets.getForPlatformCall(A, ["GMAIL_REFRESH_TOKEN"]))["GMAIL_REFRESH_TOKEN"] === undefined,
    "the credential is forgotten anyway — it is not leverage over somebody else's outage",
  );
  check((await repo.forConnector(A, "gmail"))?.status === "revoked", "and the row says revoked");
  check(
    ((await repo.forConnector(A, "gmail"))?.last_error ?? "").length > 0,
    "...with the note about what could not be confirmed, so the panel can say which it was",
  );
}

{
  const A = await workspace("already");
  const row = await connect(A);
  const { revoker } = revokerOn(() => ({ status: 400, body: { error: "invalid_token" } }));
  const ended = await revoker.disconnect(A, row);
  check(
    ended.remote === "already_gone",
    "a token the provider says is already invalid is the outcome asked for, not a failure",
  );
  check(ended.message === null, "...so there is nothing to warn about");
  check((await repo.forConnector(A, "gmail"))?.last_error === null, "...and no error on the row");
}

{
  const A = await workspace("norevoke");
  const row = await connect(A, { provider: "norevoke", refresh: false });
  const { revoker, calls } = revokerOn(() => ({ status: 200, body: {} }));
  const ended = await revoker.disconnect(A, row);
  check(ended.remote === "unsupported", "a provider with no revocation endpoint says so");
  check(calls.length === 0, "...and nothing was called");
  check(
    (ended.message ?? "").includes("forgotten here"),
    "...promising only what actually happened, which is that we forgot it",
  );
  check(
    (await secrets.getForPlatformCall(A, ["GMAIL_ACCESS_TOKEN"]))["GMAIL_ACCESS_TOKEN"] === undefined,
    "and the credential is gone",
  );
}

{
  const A = await workspace("nocred");
  const row = await repo.upsert(A, {
    provider: "google",
    connectorId: "gmail",
    scopes: [],
    accessSecretName: "GMAIL_ACCESS_TOKEN",
    refreshSecretName: "GMAIL_REFRESH_TOKEN",
  });
  const { revoker, calls } = revokerOn(() => ({ status: 200, body: {} }));
  const ended = await revoker.disconnect(A, row);
  check(ended.remote === "no_credential", "a row with nothing in the vault says so");
  check(calls.length === 0, "...rather than calling the provider with an empty string");
  check((await repo.forConnector(A, "gmail"))?.status === "revoked", "and the row is still ended");
}

// --- nothing leaks into a message --------------------------------------------------------------
console.log("\nand no message anywhere quotes a token");
{
  const A = await workspace("quiet");
  const row = await connect(A);
  const { revoker } = revokerOn(() => ({ status: 500, body: { error: "server_error", error_description: REFRESH } }));
  const ended = await revoker.disconnect(A, row);
  const said = JSON.stringify({ ended, row: await repo.forConnector(A, "gmail") });
  check(!said.includes(REFRESH), "not even when the PROVIDER puts one in its own error text");
  check(!said.includes(ACCESS), "...and not the access token either");
}

// --- the whole workspace ------------------------------------------------------------------------
console.log("\nevery grant a workspace holds, for the deletion Session 8 owns");
{
  const A = await workspace("all");
  await connect(A);
  await secrets.set(A, "SLACK_BOT_TOKEN", "xoxb-1");
  await repo.upsert(A, {
    provider: "slack",
    connectorId: "slack",
    scopes: [],
    accessSecretName: "SLACK_BOT_TOKEN",
  });
  await secrets.set(A, "JAROKU_MCP_LINEAR_TOKEN", "lin_api_1");

  const { revoker, calls } = revokerOn(() => ({ status: 200, body: {} }));
  const receipt = await endAllGrants(A, {
    revoker,
    secrets,
    mcpAuthKeys: async () => ["JAROKU_MCP_LINEAR_TOKEN"],
  });

  check(receipt.connections.length === 2, "both OAuth connections were ended");
  check(calls.length === 2, "...with a revocation call for each");
  check(receipt.mcpCredentialsDeleted === 1, "and the MCP credential was deleted");
  check((await secrets.listNames(A)).length === 0, "the workspace holds no credential of any kind");
  check(
    (await repo.list(A)).every((c) => c.status === "revoked"),
    "...and every connection row says revoked",
  );

  // Idempotent: running it again over an already-emptied workspace does nothing and says so.
  const again = await endAllGrants(A, { revoker, secrets, mcpAuthKeys: async () => [] });
  check(again.connections.length === 0, "running it again ends nothing, because nothing is live");
}

// --- across the boundary --------------------------------------------------------------------------
console.log("\nand a disconnect reaches only its own workspace");
{
  const A = await workspace("iso-a");
  const B = await workspace("iso-b");
  const rowA = await connect(A);
  await connect(B);
  const { revoker } = revokerOn(() => ({ status: 200, body: {} }));
  await revoker.disconnect(A, rowA);
  check((await repo.usable(A, "gmail")) === null, "A's connection is ended");
  check((await repo.usable(B, "gmail")) !== null, "...and B's is untouched");
  check(
    (await secrets.getForPlatformCall(B, ["GMAIL_REFRESH_TOKEN"]))["GMAIL_REFRESH_TOKEN"] === REFRESH,
    "...with its credential intact, under the same name and a different key",
  );
}

await db.close();
for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
