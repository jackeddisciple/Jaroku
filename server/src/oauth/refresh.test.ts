// One refresh per connection, whatever asks for it, and a rejected grant that stays rejected.
//
// THE FIRST ASSERTION IS THE REASON THIS MODULE EXISTS. Twelve callers arrive at once — which is
// what an eval fan-out looks like — and the token endpoint is called ONCE. Under a provider that
// rotates refresh tokens, twelve calls would mean eleven presenting a token the provider has
// already retired, and a provider that sees a retired refresh token treats the reuse as theft and
// revokes the whole grant. So this is not a performance test: without it, a fan-out disconnects
// the integration.
//
// THE SECOND IS THE ROTATION RULE, WHICH CUTS BOTH WAYS. A new refresh token must replace the old
// one under the same name, because a second name is a credential nothing reads while the thing
// everything reads is dead. And an ABSENT refresh token must not overwrite the stored one with
// nothing — Google's ordinary refresh response has no `refresh_token` field, so an implementation
// that stored what it was given would destroy a working connection on the first refresh.
//
// THE THIRD IS THAT `invalid_grant` IS TERMINAL. Retrying a rejected grant is a loop against
// somebody's real account, and it ends in a lockout rather than in a reconnection.
//
//   npm run test:oauth-refresh

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
import { OAuthError, OAuthService, type TokenTransport } from "./service.ts";
import type { OAuthClientConfig, OAuthProvider } from "./provider.ts";
import { REFRESH_WINDOW_MS, TokenRefresher } from "./refresh.ts";

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

/** Rotating, like Google under rotation and like every OAuth 2.1 provider. */
const ROTATING: OAuthProvider = {
  id: "rotating",
  label: "Rotating",
  authorizeUrl: "https://rot.example/authorize",
  tokenUrl: "https://rot.example/token",
  connectors: [
    {
      connectorId: "gmail",
      label: "Rotating Mail",
      scopes: ["mail.read"],
      accessSecretName: "GMAIL_ACCESS_TOKEN",
      refreshSecretName: "GMAIL_REFRESH_TOKEN",
      consent: ["Read your mail"],
    },
  ],
  readTokenResponse(body) {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b["access_token"] !== "string") return null;
    return {
      accessToken: b["access_token"],
      refreshToken: typeof b["refresh_token"] === "string" ? b["refresh_token"] : null,
      expiresInS: typeof b["expires_in"] === "number" ? b["expires_in"] : null,
      scopes: [],
      accountId: null,
      accountLabel: null,
    };
  },
};

/** No refresh token, no expiry. Slack's shape. */
const EVERLASTING: OAuthProvider = {
  id: "everlasting",
  label: "Everlasting",
  authorizeUrl: "https://ever.example/authorize",
  tokenUrl: "https://ever.example/token",
  connectors: [
    {
      connectorId: "slack",
      label: "Everlasting Chat",
      scopes: ["chat:write"],
      accessSecretName: "SLACK_BOT_TOKEN",
      consent: ["Post messages"],
    },
  ],
  readTokenResponse: () => null,
};

const CONFIG: OAuthClientConfig = {
  clientId: "id",
  clientSecret: "secret",
  redirectUri: "https://jaroku.example.com/v1/oauth/rotating/callback",
};

const scratch: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "jaroku-refresh-"));
scratch.push(dir);
const db = new SqliteDb(join(dir, "refresh.db"));
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
    name: `refresh ${label} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

/** A connection that is already `dueInMs` from expiring, with both credentials in the vault. */
async function connected(
  ctx: TenantContext,
  opts: { dueInMs: number | null; access: string; refresh?: string | null; connector?: string },
): Promise<OAuthConnectionRow> {
  const connector = opts.connector ?? "gmail";
  const provider = connector === "gmail" ? "rotating" : "everlasting";
  const accessName = connector === "gmail" ? "GMAIL_ACCESS_TOKEN" : "SLACK_BOT_TOKEN";
  const refreshName = connector === "gmail" ? "GMAIL_REFRESH_TOKEN" : null;
  await secrets.set(ctx, accessName, opts.access);
  if (refreshName && opts.refresh) await secrets.set(ctx, refreshName, opts.refresh);
  return repo.upsert(ctx, {
    provider,
    connectorId: connector,
    scopes: [],
    accessSecretName: accessName,
    refreshSecretName: refreshName,
    accessExpiresAt: opts.dueInMs === null ? null : new Date(Date.now() + opts.dueInMs).toISOString(),
  });
}

function refresherOn(
  transport: TokenTransport,
  onReauth?: (ctx: TenantContext, c: OAuthConnectionRow, reason: string) => void,
): TokenRefresher {
  const providers = [ROTATING, EVERLASTING];
  const config = () => CONFIG;
  const service = new OAuthService({ repo, secrets, providers, config, transport });
  return new TokenRefresher({ repo, secrets, providers, config, service, onReauthRequired: onReauth });
}

// --- when a token is due -------------------------------------------------------------------
console.log("\nwhat counts as due");
{
  const A = await workspace("due");
  const soon = await connected(A, { dueInMs: 60_000, access: "a1", refresh: "r1" });
  const later = await connected(A, { dueInMs: 60 * 60_000, access: "a1", refresh: "r1" });
  const never = await connected(A, { dueInMs: null, access: "s1", connector: "slack" });
  const r = refresherOn(async () => ({ status: 200, body: {} }));

  check(r.isDue(soon), "a token a minute from expiring is due");
  check(!r.isDue(later), "one an hour out is not");
  check(
    !r.isDue(never),
    "and one with NO expiry is never due — a null must not read as `expired long ago`",
  );
  check(r.isDue(later, 2 * 60 * 60_000), "a caller may ask for more life than the sweep does");
  check(REFRESH_WINDOW_MS === 5 * 60 * 1000, "the default window is five minutes");
}

// --- one refresh, however many callers -----------------------------------------------------
console.log("\ntwelve concurrent callers, one call to the token endpoint");
{
  const A = await workspace("fanout");
  await connected(A, { dueInMs: 30_000, access: "old-access", refresh: "old-refresh" });

  let calls = 0;
  const presented: string[] = [];
  const r = refresherOn(async (_url, body) => {
    calls++;
    presented.push(body.get("refresh_token") ?? "");
    // A real round trip takes a moment. Without a delay every caller would resolve before the
    // next one even started, and the coalescing would be untested.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: 200, body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 } };
  });

  const fanout = await Promise.all(
    Array.from({ length: 12 }, () => r.tokenForRun(A, "gmail")),
  );
  check(calls === 1, "the token endpoint was called exactly once", `${calls} calls`);
  check(
    presented.every((p) => p === "old-refresh"),
    "...presenting the stored refresh token, never a retired one",
  );
  check(fanout.every((f) => f?.accessToken === "new-access"), "and every caller got the SAME new token");
  check(r.inFlightCount === 0, "the in-flight entry is cleared afterwards, so the next refresh is not wedged");
  check(
    (await secrets.getForPlatformCall(A, ["GMAIL_REFRESH_TOKEN"]))["GMAIL_REFRESH_TOKEN"] === "new-refresh",
    "the rotated refresh token replaced the old one under the SAME name",
  );
  check(
    (await repo.forConnector(A, "gmail"))?.last_refreshed_at !== null,
    "and the row records that a refresh happened",
  );
}

// --- an absent refresh token is not a rotation ---------------------------------------------
console.log("\nan absent refresh token means keep the one you have");
{
  const A = await workspace("noroll");
  await connected(A, { dueInMs: 30_000, access: "old-access", refresh: "keep-me" });
  const r = refresherOn(async () => ({
    status: 200,
    // Google's ordinary refresh response: a new access token and no refresh_token field at all.
    body: { access_token: "fresh-access", expires_in: 3600 },
  }));
  const got = await r.tokenForRun(A, "gmail");
  check(got?.accessToken === "fresh-access", "the new access token is stored and handed back");
  check(
    (await secrets.getForPlatformCall(A, ["GMAIL_REFRESH_TOKEN"]))["GMAIL_REFRESH_TOKEN"] === "keep-me",
    "and the stored refresh token SURVIVES — overwriting it with nothing would end the connection",
  );
}

// --- nothing to refresh ---------------------------------------------------------------------
console.log("\na connection with no refresh token is handed back unchanged");
{
  const A = await workspace("slack");
  const row = await connected(A, { dueInMs: null, access: "xoxb-live", connector: "slack" });
  let calls = 0;
  const r = refresherOn(async () => {
    calls++;
    return { status: 200, body: {} };
  });
  const got = await r.tokenForRun(A, "slack");
  check(got?.accessToken === "xoxb-live", "a bot token is returned as it is");
  check(calls === 0, "...and nothing was asked of the provider, because there is nothing to refresh");
  check((await r.refresh(A, row)).id === row.id, "refreshing it explicitly is a no-op rather than a failure");
}

// --- a rejected grant is terminal ------------------------------------------------------------
console.log("\ninvalid_grant marks the connection and stops");
{
  const A = await workspace("revoked");
  await connected(A, { dueInMs: 30_000, access: "old", refresh: "retired" });
  let calls = 0;
  const told: string[] = [];
  const r = refresherOn(
    async () => {
      calls++;
      return { status: 400, body: { error: "invalid_grant", error_description: "token revoked" } };
    },
    (_ctx, _c, reason) => told.push(reason),
  );

  const first = await r.tokenForRun(A, "gmail");
  check(first === null, "a run asking for a token gets nothing rather than a stale one");
  check(
    (await repo.forConnector(A, "gmail"))?.status === "reauth_required",
    "...and the connection is marked as needing a human",
  );
  check(told.length === 1, "the workspace is told once, so a banner can be shown");
  check(
    (told[0] ?? "").includes("no longer valid"),
    "...in the provider's own words rather than as a generic failure",
  );

  const second = await r.tokenForRun(A, "gmail");
  check(second === null, "a second run also gets nothing");
  check(
    calls === 1,
    "and the provider was NOT called again — retrying a rejected grant is how an account gets locked",
    `${calls} calls`,
  );
}

// --- a transient failure is not a revocation ------------------------------------------------
console.log("\na 503 does not disconnect anything");
{
  const A = await workspace("blip");
  await connected(A, { dueInMs: 60_000, access: "still-valid", refresh: "r" });
  const r = refresherOn(async () => ({ status: 503, body: { error: "unavailable" } }));

  const got = await r.tokenForRun(A, "gmail");
  check(
    got?.accessToken === "still-valid",
    "the run is handed the CURRENT token, which has not expired yet — a blip is not an outage",
  );
  check(
    (await repo.forConnector(A, "gmail"))?.status === "active",
    "...and nothing was marked reauth_required over a provider being briefly down",
  );

  const thrown = await r
    .refresh(A, (await repo.forConnector(A, "gmail"))!)
    .then(() => null, (e: OAuthError) => e);
  check(thrown?.kind === "transient", "asking for the refresh directly still reports it as transient");
  check(r.inFlightCount === 0, "and a rejected refresh leaves no entry behind to wedge the next one");
}

// --- the vault and the row disagreeing --------------------------------------------------------
console.log("\na row that claims a credential the vault does not have");
{
  const A = await workspace("missing");
  await connected(A, { dueInMs: 60 * 60_000, access: "present", refresh: "r" });
  await secrets.delete(A, "GMAIL_ACCESS_TOKEN");
  const told: string[] = [];
  const r = refresherOn(async () => ({ status: 200, body: {} }), (_c, _x, reason) => told.push(reason));

  check((await r.tokenForRun(A, "gmail")) === null, "no empty string is handed to a run");
  check(
    (await repo.forConnector(A, "gmail"))?.status === "reauth_required",
    "...and the connection says so rather than producing a 401 from inside a graph",
  );
  check(told.length === 1, "and somebody is told");
}

// --- across the boundary -----------------------------------------------------------------------
console.log("\nand a refresh reaches only its own workspace");
{
  const A = await workspace("iso-a");
  const B = await workspace("iso-b");
  await connected(A, { dueInMs: 30_000, access: "a-token", refresh: "a-refresh" });
  await connected(B, { dueInMs: 30_000, access: "b-token", refresh: "b-refresh" });
  const presented: string[] = [];
  const r = refresherOn(async (_url, body) => {
    presented.push(body.get("refresh_token") ?? "");
    return { status: 200, body: { access_token: `fresh-for-${presented.length}`, expires_in: 3600 } };
  });

  await r.tokenForRun(A, "gmail");
  check(presented[0] === "a-refresh", "A's refresh presents A's token");
  await r.tokenForRun(B, "gmail");
  check(presented[1] === "b-refresh", "...and B's presents B's");
  check(
    (await secrets.getForPlatformCall(A, ["GMAIL_ACCESS_TOKEN"]))["GMAIL_ACCESS_TOKEN"] === "fresh-for-1",
    "A's new token landed in A's vault",
  );
  check(
    (await secrets.getForPlatformCall(B, ["GMAIL_ACCESS_TOKEN"]))["GMAIL_ACCESS_TOKEN"] === "fresh-for-2",
    "...and B's in B's, under the same name and a different key",
  );
}

await db.close();
for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
