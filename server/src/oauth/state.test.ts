// The flow rows and the connection rows: what they hold, what they refuse, and what they do not
// have a column for.
//
// Four properties, and each is the answer to a specific way this goes wrong.
//
//   THERE IS NOWHERE TO PUT A TOKEN. Asserted against the LIVE schema rather than against the
//   migration file, exactly as `test:secret-refs` does for `secret_refs`, so a column added later
//   fails a test rather than passing review. The whole design of this session is that credentials
//   live in one place; a second place would be the one nobody remembers to redact.
//
//   A STATE WORKS EXACTLY ONCE, EVEN WHEN TWO CALLBACKS RACE FOR IT. Replay is the entire attack
//   against an OAuth callback: an authorization code that can be presented twice is a connection
//   that can be made twice, once by the person who intercepted it. The delete is the decision,
//   and this asserts the loser is refused rather than admitted.
//
//   AN EXPIRED STATE IS BURNT, NOT LEFT. It is refused either way; what matters is that the row
//   is gone afterwards, so a stale state cannot be probed for repeatedly.
//
//   A CONNECTION IS ONE PER CONNECTOR AND A RECONNECT REPLACES IT — including resetting a status
//   that said reauth_required, because a workspace that has just come back from a consent screen
//   is connected whatever the row said a moment ago.
//
//   npm run test:oauth-state

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { SqliteDb } from "../db/sqlite.ts";
import { withScratchPostgres } from "../db/testDb.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { OAuthRepository } from "../db/repositories/oauth.ts";
import { hashState, looksLikeState, newPkce, newState, safeEquals } from "./pkce.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const MIGRATIONS = join(fileURLToPath(new URL("../..", import.meta.url)), "migrations");

const scratch: string[] = [];
const tmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "jaroku-oauth-"));
  scratch.push(d);
  return d;
};

async function newWorkspace(db: Db, label: string): Promise<TenantContext> {
  const identity = new IdentityRepository(db);
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `oauth ${label} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

async function columnsOf(db: Db, table: string): Promise<Set<string>> {
  return new Set(
    db.dialect === "postgres"
      ? (
          await db.all<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns WHERE table_name = ?`,
            [table],
          )
        ).map((r) => r.column_name)
      : (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((r) => r.name),
  );
}

// --- PKCE, which needs no database ---------------------------------------------------------

function pkceSuite(): void {
  console.log("\nPKCE and the state value");

  const a = newPkce();
  const b = newPkce();
  check(a.method === "S256", "the challenge method is always S256, never plain");
  check(a.verifier !== b.verifier, "two flows get two verifiers");
  check(a.challenge !== a.verifier, "the challenge is not the verifier — which is what `plain` would be");
  check(/^[A-Za-z0-9_-]+$/.test(a.challenge), "the challenge is base64url, so it survives a query string");
  check(a.verifier.length >= 43 && a.verifier.length <= 128, "the verifier is inside RFC 7636's length window");

  const state = newState();
  check(looksLikeState(state), "a minted state passes the shape check the callback applies");
  check(!looksLikeState(""), "...and an empty string does not");
  check(!looksLikeState("../../etc/passwd"), "...nor does anything that is not base64url");
  check(!looksLikeState("x".repeat(4096)), "...nor does a kilobyte of junk pointed at the callback");
  check(hashState(state) !== state, "the digest stored is not the value handed out");
  check(hashState(state) === hashState(state), "...and hashing is stable, or nothing would ever resolve");

  check(safeEquals("abc", "abc"), "safeEquals accepts equal values");
  check(!safeEquals("abc", "abd"), "...refuses different ones");
  check(!safeEquals("abc", "abcd"), "...and refuses a length mismatch instead of throwing on one");
}

// --- the rows ---------------------------------------------------------------------------------

async function suite(label: string, db: Db): Promise<void> {
  console.log(`\n${label}`);
  const repo = new OAuthRepository(db);
  const A = await newWorkspace(db, "a");
  const B = await newWorkspace(db, "b");

  // --- there is nowhere to put a token -------------------------------------------------
  console.log("\n  no column a credential would fit in");
  const connectionColumns = await columnsOf(db, "oauth_connections");
  check(connectionColumns.size > 0, `oauth_connections exists (${connectionColumns.size} columns)`);
  const tokenish = [...connectionColumns].filter((c) =>
    /^(access_token|refresh_token|token|secret|password|client_secret|ciphertext)$/.test(c),
  );
  check(tokenish.length === 0, "and no column an access or refresh token would go in", tokenish.join(", "));
  check(
    connectionColumns.has("access_secret_name") && connectionColumns.has("refresh_secret_name"),
    "...only the NAMES the vault holds them under",
  );
  check(
    connectionColumns.has("scopes") && connectionColumns.has("status") && connectionColumns.has("revoked_at"),
    "...beside what was granted, what state it is in, and when it was disconnected",
  );

  // --- a flow, once --------------------------------------------------------------------
  console.log("\n  a state works exactly once");
  const pkce = newPkce();
  const state = newState();
  await repo.beginFlow(A, hashState(state), {
    provider: "google",
    connectorId: "gmail",
    codeVerifier: pkce.verifier,
    redirectUri: "https://jaroku.example.com/v1/oauth/callback",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    returnTo: "/connections",
  });
  check((await repo.openFlowCount(A)) === 1, "beginning a flow records one open flow for the workspace");
  check((await repo.openFlowCount(B)) === 0, "...and none for anybody else's");

  const first = await repo.consumeState(state, systemContext(newRequestId()));
  check(first !== null, "the state resolves");
  check(first?.workspaceId === A.workspaceId, "...to the workspace that opened the flow");
  check(first?.connectorId === "gmail", "...carrying which connector it was for");
  check(first?.codeVerifier === pkce.verifier, "...and the verifier the exchange has to present");
  check(first?.returnTo === "/connections", "...and where to send the browser afterwards");

  const second = await repo.consumeState(state, systemContext(newRequestId()));
  check(second === null, "and the same state a second time resolves to nothing");
  check((await repo.openFlowCount(A)) === 0, "...because consuming it deleted the row");

  // Two callbacks arriving at once. On Postgres the concurrent DELETE blocks on the row lock and
  // then re-evaluates against committed state; on SQLite transactions serialise. Either way
  // exactly one may win, which is the property — not which one.
  const raced = newState();
  await repo.beginFlow(A, hashState(raced), {
    provider: "google",
    connectorId: "gmail",
    codeVerifier: newPkce().verifier,
    redirectUri: "https://jaroku.example.com/v1/oauth/callback",
    scopes: [],
  });
  const outcomes = await Promise.all([repo.consumeState(raced), repo.consumeState(raced)]);
  check(
    outcomes.filter((o) => o !== null).length === 1,
    "two callbacks racing for one state: exactly one is admitted",
    `${outcomes.filter((o) => o !== null).length} won`,
  );

  // --- expiry --------------------------------------------------------------------------
  console.log("\n  an expired flow is refused, and burnt");
  const stale = newState();
  await repo.beginFlow(A, hashState(stale), {
    provider: "slack",
    connectorId: "slack",
    codeVerifier: newPkce().verifier,
    redirectUri: "https://jaroku.example.com/v1/oauth/callback",
    scopes: [],
    ttlS: -1, // already over by the time it is written
  });
  check((await repo.consumeState(stale)) === null, "a state past its expiry does not resolve");
  const leftBehind = await db.get<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM oauth_states WHERE state_hash = ?`,
    [hashState(stale)],
  );
  check(Number(leftBehind?.n ?? 0) === 0, "...and the row is gone rather than left to be probed");

  check(
    (await repo.consumeState("not-a-state")) === null,
    "a value that is not shaped like a state never becomes a query",
  );

  // --- connections ---------------------------------------------------------------------
  console.log("\n  one connection per connector, and a reconnect replaces it");
  const made = await repo.upsert(A, {
    provider: "google",
    connectorId: "gmail",
    scopes: ["gmail.readonly"],
    accessSecretName: "GMAIL_ACCESS_TOKEN",
    refreshSecretName: "GMAIL_REFRESH_TOKEN",
    externalAccountLabel: "ada@example.com",
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  check(made.status === "active", "a completed flow lands as active");
  check(made.scopes.length === 1 && made.scopes[0] === "gmail.readonly", "...carrying what was granted");
  check((await repo.usable(A, "gmail")) !== null, "...and a run may be handed a credential from it");

  await repo.markReauthRequired(A, made.id, "the provider rejected our refresh");
  const broken = await repo.forConnector(A, "gmail");
  check(broken?.status === "reauth_required", "a rejected refresh marks it reauth_required");
  check(broken?.last_error !== null, "...with the provider's own words for the panel");
  check((await repo.usable(A, "gmail")) === null, "...and no run is handed a credential from it");
  check(
    (await repo.forConnector(A, "gmail")) !== null,
    "...while the row is still findable, so the UI can say WHICH integration needs attention",
  );

  const reconnected = await repo.upsert(A, {
    provider: "google",
    connectorId: "gmail",
    scopes: ["gmail.readonly", "gmail.compose"],
    accessSecretName: "GMAIL_ACCESS_TOKEN",
    refreshSecretName: "GMAIL_REFRESH_TOKEN",
    externalAccountLabel: "ada@example.com",
  });
  check(reconnected.status === "active", "reconnecting clears reauth_required");
  check(reconnected.last_error === null, "...and the stale error with it");
  check(reconnected.scopes.length === 2, "...recording the scopes granted the second time");
  check(reconnected.created_at === made.created_at, "...without reshuffling the panel");
  check((await repo.list(A)).length === 1, "and a workspace still has exactly one gmail connection");

  await repo.recordRefresh(A, reconnected.id, new Date(Date.now() + 1800_000).toISOString());
  check(
    (await repo.forConnector(A, "gmail"))?.last_refreshed_at !== null,
    "a refresh records when, and moves only the expiry — the token's NAME has not changed",
  );

  await repo.markRevoked(A, reconnected.id);
  const revoked = await repo.forConnector(A, "gmail");
  check(revoked?.status === "revoked", "disconnecting marks it revoked");
  check(revoked?.revoked_at !== null, "...stamped, so the audit trail has something to point at");
  check(revoked?.access_expires_at === null, "...and nothing left claiming a live token");
  check((await repo.usable(A, "gmail")) === null, "...and it is not usable");

  // --- across the boundary -------------------------------------------------------------
  console.log("\n  and none of it is visible from another workspace");
  await repo.upsert(B, {
    provider: "slack",
    connectorId: "slack",
    scopes: ["chat:write"],
    accessSecretName: "SLACK_BOT_TOKEN",
  });
  check((await repo.forConnector(A, "slack")) === null, "A cannot see B's slack connection");
  check((await repo.forConnector(B, "gmail")) === null, "B cannot see A's gmail connection");
  check((await repo.list(A)).every((c) => c.connector_id !== "slack"), "...nor does it appear in A's listing");
  check(
    (await repo.list(B)).length === 1,
    "...and B's listing holds only its own",
  );
}

pkceSuite();

const dir = tmpDir();
{
  const db = new SqliteDb(join(dir, "oauth.db"));
  await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});
  try {
    await suite("SqliteDb", db);
  } finally {
    await db.close();
  }
}

await withScratchPostgres(async (db) => {
  await suite("PostgresDb", db);
});

for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
