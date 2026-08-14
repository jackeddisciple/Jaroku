// The Secrets tab's schema, exercised rather than described.
//
// Migration 033 adds four tables and eight columns, and three of the properties it depends on are
// the kind that look obviously true and are not:
//
//   THE USAGE INDEX HAS TO DEDUPLICATE ROWS WITH NULLS IN THEM. `secret_usages` is unique by site,
//   and two of the site's five columns are nullable. In an ordinary unique index two NULLs are
//   DISTINCT, so a workspace-scoped runtime read would insert a fresh row on every run and the
//   blast-radius view would show the same read a thousand times. The COALESCE in the index is what
//   makes it work, and this suite is what proves the COALESCE is doing it.
//
//   A RE-DECLARATION MUST NOT RESET A CLASSIFICATION. `kind` and `status` are NOT NULL with
//   defaults, so an upsert naming them supplies a value on every call — which would quietly reset
//   a provider key to 'custom' every time an agent's manifest mentioned its name. The metadata is
//   written by a separate partial update for exactly this reason, and that is asserted here.
//
//   AN ELEVATION MUST NOT SLIDE. A second tab of one session inherits the first's expiry rather
//   than getting a fresh ten minutes, because a sliding window means an idle open tab stays
//   elevated all day — the property the gate exists to deny.
//
// Both drivers, same assertions. The nullable-unique-index behaviour in particular is a place the
// two could plausibly differ, which is exactly why it is not asserted on one of them.
//
//   npm run test:secret-schema

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
import { SecretRefRepository } from "../db/repositories/secretRefs.ts";
import { SecretUsageRepository } from "../db/repositories/secretUsages.ts";
import { SecretPasscodeRepository } from "../db/repositories/secretPasscodes.ts";
import { SecretElevationRepository } from "../db/repositories/secretElevations.ts";

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
  const d = mkdtempSync(join(tmpdir(), "jaroku-secret-schema-"));
  scratch.push(d);
  return d;
};

async function newWorkspace(db: Db, label: string): Promise<TenantContext> {
  const identity = new IdentityRepository(db);
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `schema ${label} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

async function newUser(db: Db): Promise<string> {
  const identity = new IdentityRepository(db);
  const { user } = await identity.provisionUser(systemContext(newRequestId()), {
    externalId: `schema_${randomUUID().slice(0, 10)}`,
    email: `${randomUUID().slice(0, 10)}@example.com`,
  });
  return user.id;
}

const iso = (msFromNow: number): string => new Date(Date.now() + msFromNow).toISOString();

async function suite(label: string, db: Db): Promise<void> {
  console.log(`\n${label}`);
  const refs = new SecretRefRepository(db);
  const usages = new SecretUsageRepository(db);
  const passcodes = new SecretPasscodeRepository(db);
  const elevations = new SecretElevationRepository(db);
  const ws = await newWorkspace(db, "w");
  const user = await newUser(db);

  // --- the metadata, and what a re-declaration must not touch ---------------------------
  console.log("\n  metadata");
  await refs.markConfigured(ws, { name: "ANTHROPIC_API_KEY", provider: "anthropic" });
  await refs.setMetadata(ws, "ANTHROPIC_API_KEY", {
    kind: "provider_key",
    maskedHint: "sk-ant-...4f2a",
    status: "valid",
  });
  let row = await refs.get(ws, "ANTHROPIC_API_KEY");
  check(row?.kind === "provider_key", "a credential can be classified");
  check(row?.masked_hint === "sk-ant-...4f2a", "and carries a stored mask");
  check(row?.status === "valid", "and a status");

  // The failure this shape exists to prevent: an agent's manifest mentions the name, which
  // re-declares it, which must not undo the classification a user gave it.
  await refs.declare(ws, { name: "ANTHROPIC_API_KEY" });
  row = await refs.get(ws, "ANTHROPIC_API_KEY");
  check(row?.kind === "provider_key", "a re-declaration does not reset the kind to 'custom'");
  check(row?.masked_hint === "sk-ant-...4f2a", "nor erase the mask");
  check(row?.configured === true, "nor un-set a configured credential");

  // And an explicit null is a value somebody meant, not a field to skip.
  await refs.setMetadata(ws, "ANTHROPIC_API_KEY", { expiresAt: iso(86_400_000) });
  check((await refs.get(ws, "ANTHROPIC_API_KEY"))?.expires_at !== null, "an expiry can be set");
  await refs.setMetadata(ws, "ANTHROPIC_API_KEY", { expiresAt: null });
  check((await refs.get(ws, "ANTHROPIC_API_KEY"))?.expires_at === null, "...and explicitly cleared");

  // --- health counts, which are the one answer served without elevation ------------------
  console.log("\n  health");
  await refs.markConfigured(ws, { name: "EXPIRING_SOON_KEY" });
  await refs.setMetadata(ws, "EXPIRING_SOON_KEY", { expiresAt: iso(3 * 86_400_000) });
  await refs.markConfigured(ws, { name: "BROKEN_KEY" });
  await refs.setMetadata(ws, "BROKEN_KEY", { status: "invalid" });
  await refs.declare(ws, { name: "DECLARED_NOT_SET" });

  const health = await refs.health(ws);
  check(health.expiringSoon === 1, `one credential expires within seven days (got ${health.expiringSoon})`);
  check(health.invalid === 1, `one is known broken (got ${health.invalid})`);
  check(health.total === 3, `and only CONFIGURED ones are counted (got ${health.total})`);
  check(
    !JSON.stringify(health).includes("KEY"),
    "the health answer has no room for a name in it",
    JSON.stringify(health),
  );

  // A credential expiring outside the window is not "expiring", which is the half of the
  // comparison a `<=` written the wrong way round would get silently wrong.
  await refs.setMetadata(ws, "EXPIRING_SOON_KEY", { expiresAt: iso(30 * 86_400_000) });
  check((await refs.health(ws)).expiringSoon === 0, "and one expiring next month is not counted");

  // --- rotation history ------------------------------------------------------------------
  console.log("\n  rotation history");
  await refs.recordRotation(ws, { name: "BROKEN_KEY", maskedHint: "••••aaaa", reason: "first" });
  await refs.recordRotation(ws, { name: "BROKEN_KEY", maskedHint: "••••bbbb", reason: "second" });
  const history = await refs.rotations(ws, "BROKEN_KEY");
  check(history.length === 2, `both rotations are kept (got ${history.length})`);
  check(history[0]?.reason === "second", "newest first");
  check((await refs.get(ws, "BROKEN_KEY"))?.rotated_at !== null, "and the credential records when it last moved");
  check(
    !JSON.stringify(history).includes("value"),
    "the history carries masks and reasons, never a value",
  );

  // --- usage sites, and the index that has to deduplicate NULLs ---------------------------
  console.log("\n  blast radius");
  await usages.record(ws, { name: "BROKEN_KEY", source: "static_scan", location: "tools/weather.py:14" });
  await usages.record(ws, { name: "BROKEN_KEY", source: "static_scan", location: "tools/weather.py:14" });
  await usages.record(ws, { name: "BROKEN_KEY", source: "static_scan", location: "tools/other.py:3" });
  let sites = await usages.forSecret(ws, "BROKEN_KEY");
  check(sites.length === 2, `the same static site twice is one row (got ${sites.length})`);
  check(sites.find((s) => s.location === "tools/weather.py:14")?.hits === 2, "with its hits counted");

  // THE ONE THAT WOULD SILENTLY BE WRONG. Both nullable columns are null here, so without the
  // COALESCE in the unique index every call inserts a new row.
  await usages.record(ws, { name: "BROKEN_KEY", source: "runtime_read" });
  await usages.record(ws, { name: "BROKEN_KEY", source: "runtime_read" });
  await usages.record(ws, { name: "BROKEN_KEY", source: "runtime_read" });
  sites = await usages.forSecret(ws, "BROKEN_KEY");
  const runtime = sites.filter((s) => s.source === "runtime_read");
  check(runtime.length === 1, `three runtime reads with no agent and no line are one row (got ${runtime.length})`);
  check(runtime[0]?.hits === 3, `and the count is what accumulated (got ${runtime[0]?.hits})`);
  check(runtime[0]?.first_seen_at !== runtime[0]?.detected_at || runtime[0]!.hits === 3, "first and last are both kept");

  check(await usages.isReferenced(ws, "BROKEN_KEY"), "a referenced credential is known to be referenced");
  check(!(await usages.isReferenced(ws, "DECLARED_NOT_SET")), "and one nothing points at is not");

  // A rescan replaces static hits and leaves the record of what actually ran alone.
  await usages.record(ws, { name: "BROKEN_KEY", source: "static_scan", location: "x.py:1" });
  const cleared = await usages.clearStaticFor(ws, "no-such-agent");
  check(cleared === 0, "clearing an agent with no scan results removes nothing");
  check(
    (await usages.forSecret(ws, "BROKEN_KEY")).some((s) => s.source === "runtime_read"),
    "and a runtime read survives a static rescan, because it is a thing that happened",
  );

  // --- the passcode's counters ------------------------------------------------------------
  console.log("\n  passcode");
  check(!(await passcodes.exists(ws, user)), "a user starts with no passcode");
  await passcodes.put(ws, user, { hash: "h1", salt: "s1", algo: "scrypt", params: { N: 16384, r: 8 } });
  check(await passcodes.exists(ws, user), "and has one after it is set");
  const stored = await passcodes.get(ws, user);
  check(stored?.params?.["N"] === 16384, "the cost parameters travel with the hash, so it can be re-tuned later");
  check(stored?.failed_attempts === 0, "with a clean counter");

  check((await passcodes.recordFailure(ws, user)) === 1, "a failure counts");
  check((await passcodes.recordFailure(ws, user)) === 2, "and accumulates");
  await passcodes.lock(ws, user, iso(900_000));
  check((await passcodes.get(ws, user))?.locked_until !== null, "a lockout is recorded server-side");
  await passcodes.recordSuccess(ws, user);
  check((await passcodes.get(ws, user))?.failed_attempts === 0, "a correct passcode clears the run of failures");
  check((await passcodes.get(ws, user))?.locked_until === null, "and the lockout with it");

  // Re-setting one clears a lockout, because reaching that path means proving an identity to a
  // HIGHER standard than a passcode — leaving the old lockout would lock somebody out of a
  // credential they just re-proved they own.
  await passcodes.recordFailure(ws, user);
  await passcodes.lock(ws, user, iso(900_000));
  await passcodes.put(ws, user, { hash: "h2", salt: "s2", algo: "scrypt", params: { N: 32768 } });
  check((await passcodes.get(ws, user))?.locked_until === null, "setting a new passcode clears the lockout");
  check((await passcodes.get(ws, user))?.failed_attempts === 0, "and the failure count");

  // --- elevation --------------------------------------------------------------------------
  console.log("\n  elevation");
  const tokenHash = `hash-${randomUUID()}`;
  const first = await elevations.issue(ws, {
    userId: user,
    sessionId: "session-1",
    tokenHash,
    method: "passcode",
    expiresAt: iso(600_000),
  });
  check(
    (await elevations.liveByToken(ws, { userId: user, sessionId: "session-1", tokenHash }))?.id === first.id,
    "a token redeems the elevation it was issued for",
  );
  check(
    (await elevations.liveByToken(ws, { userId: user, sessionId: "session-2", tokenHash })) === undefined,
    "but not from a different session",
  );

  // A SECOND TAB INHERITS THE EXPIRY. The TTL is absolute; a second tab that reset the clock
  // would make "open a tab every nine minutes" an indefinite elevation with nobody present.
  const live = await elevations.liveForSession(ws, user, "session-1");
  const secondTabHash = `hash-${randomUUID()}`;
  const second = await elevations.issue(ws, {
    userId: user,
    sessionId: "session-1",
    tokenHash: secondTabHash,
    method: "passcode",
    expiresAt: live!.expires_at,
  });
  check(second.expires_at === first.expires_at, "a second tab of one session inherits the first's expiry");
  check(second.id !== first.id, "on its own token, so neither tab holds the other's");

  // Locking in one tab ends it in both.
  const revoked = await elevations.revokeSession(ws, user, "session-1", "lock now");
  check(revoked === 2, `locking ends every token the session holds (got ${revoked})`);
  check(
    (await elevations.liveByToken(ws, { userId: user, sessionId: "session-1", tokenHash: secondTabHash })) ===
      undefined,
    "so the other tab's token stops working too",
  );
  check((await elevations.liveForSession(ws, user, "session-1")) === undefined, "and the session holds nothing live");

  // An expired elevation is not live, without anything having to revoke it.
  const staleHash = `hash-${randomUUID()}`;
  await elevations.issue(ws, {
    userId: user,
    sessionId: "session-3",
    tokenHash: staleHash,
    method: "passcode",
    expiresAt: iso(-1_000),
  });
  check(
    (await elevations.liveByToken(ws, { userId: user, sessionId: "session-3", tokenHash: staleHash })) === undefined,
    "an elevation past its expiry is not live, with nothing having to revoke it",
  );

  await elevations.issue(ws, {
    userId: user,
    sessionId: "session-4",
    tokenHash: `hash-${randomUUID()}`,
    method: "passcode",
    expiresAt: iso(600_000),
  });
  // Two, not one: the expired session-3 row is past its expiry but has never been REVOKED, and
  // "unrevoked" is what this sweeps. Marking an already-dead row costs nothing and the alternative
  // — filtering on expiry here too — would mean a row could be expired-and-unrevoked forever,
  // which is a second state to reason about for no benefit.
  check(
    (await elevations.revokeAllForUser(ws, user, "passcode changed")) === 2,
    "changing a passcode ends every elevation the user holds, on every device",
  );
  check(
    (await elevations.liveForSession(ws, user, "session-4")) === undefined,
    "...including the one that was still live",
  );

  // The sweep runs across workspaces, which on Postgres means it needs the platform marker; the
  // assertion is that it removes the dead row and leaves the live one.
  const swept = await elevations.sweep(0);
  check(swept >= 1, `the sweep removes elevations past the grace period (got ${swept})`);
}

const dir = tmpDir();
{
  const db = new SqliteDb(join(dir, "secret-schema.db"));
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
