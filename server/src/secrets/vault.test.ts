// The hosted secret store: the envelope, the binding, and the rotation.
//
// The conformance suite runs first, because the only interesting thing about a second
// implementation is that it is indistinguishable from the first. Everything after it is about
// what this store has that the local one structurally cannot:
//
//   * A WORKSPACE. Two tenants may hold the same variable name with different values, and
//     neither can read the other's — by query, by run, or by moving a row.
//
//   * A CIPHERTEXT BOUND TO ITS ROW. `<workspace_id>:<name>` is authenticated data, so a
//     ciphertext copied into another workspace or relabelled to another variable decrypts to
//     nothing. That is the wall behind the wall: RLS and the repository scope stop the query,
//     and this makes going around them pointless.
//
//   * ROTATION. A new data key version, every secret re-sealed, the old version retired — with
//     rows readable throughout, because a read uses the key the ROW names.
//
//   * A MASTER KEY THAT IS NOT IN THE DATABASE. A dump without it is a dump of noise, and a
//     process holding the wrong one says so rather than reporting corruption.
//
//   npm run test:vault

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
import { KmsSecretStore } from "./kmsSecretStore.ts";
import { LocalMasterKeyProvider, MasterKeyError, MASTER_KEY_ENV, resolveMasterKey } from "./masterKey.ts";
import { runSecretConformance } from "./conformance.ts";

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
const OTHER_MASTER = "a-different-master-key-with-enough-entropy-9876543210";

const scratch: string[] = [];
const tmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "jaroku-vault-"));
  scratch.push(d);
  return d;
};

// --- 1. the master key, on its own -----------------------------------------------------
console.log("\nthe master key");
{
  const a = new LocalMasterKeyProvider(MASTER);
  const b = new LocalMasterKeyProvider(MASTER);
  const other = new LocalMasterKeyProvider(OTHER_MASTER);

  check(a.id === b.id, "the same material derives the same key id");
  check(a.id !== other.id, "...and different material a different one");
  check(a.id.startsWith("local:") && a.id.length < 32, `the id is short and says where it came from (${a.id})`);
  check(!a.id.includes(MASTER.slice(0, 8)), "...and reveals nothing of the material");

  const dek = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
  const wrapped = await a.wrap(dek);
  check(!wrapped.includes(dek.toString("base64").slice(0, 12)), "a wrapped key does not contain the key");
  check((await b.unwrap(wrapped, a.id)).equals(dek), "...and the same master key opens it");

  let wrongKey = false;
  try {
    await other.unwrap(wrapped, a.id);
  } catch (err) {
    wrongKey = err instanceof MasterKeyError && err.message.includes("wrapped by master key");
  }
  check(wrongKey, "a process holding the wrong master key says so rather than reporting corruption");

  let tampered = false;
  try {
    const raw = Buffer.from(wrapped, "base64");
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
    await a.unwrap(raw.toString("base64"), a.id);
  } catch (err) {
    tampered = err instanceof MasterKeyError;
  }
  check(tampered, "a tampered wrapped key does not authenticate");

  let short = false;
  try {
    new LocalMasterKeyProvider("too-short");
  } catch (err) {
    short = err instanceof MasterKeyError;
  }
  check(short, "a short master key is refused");

  let absent = false;
  try {
    resolveMasterKey({});
  } catch (err) {
    absent = err instanceof MasterKeyError && err.message.includes("no generated fallback");
  }
  check(absent, "there is no generated fallback — a regenerated master key would lose every secret");
  check(resolveMasterKey({ [MASTER_KEY_ENV]: MASTER }).id === a.id, "and a supplied one is used");
}

// --- the store, on both drivers ---------------------------------------------------------
async function suite(label: string, db: Db): Promise<void> {
  console.log(`\n${label}`);
  const identity = new IdentityRepository(db);
  const master = new LocalMasterKeyProvider(MASTER);

  const makeWorkspace = async (name: string): Promise<TenantContext> => {
    const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
      name: `vault ${name} ${randomUUID().slice(0, 6)}`,
    });
    return systemContextFor(ws.id, newRequestId());
  };

  const A = await makeWorkspace("a");
  const B = await makeWorkspace("b");
  /** run id -> workspace. What a worker would resolve from the run row. */
  const runs = new Map<string, string>();
  const runA = randomUUID();
  const runB = randomUUID();
  runs.set(runA, A.workspaceId);
  runs.set(runB, B.workspaceId);

  const refs = new SecretRefRepository(db);
  const store = new KmsSecretStore({
    db,
    master,
    refs,
    runWorkspace: async (id) => runs.get(id) ?? null,
    providerFor: (n) => (n.startsWith("ANTHROPIC") ? "anthropic" : null),
  });

  failures += (await runSecretConformance(`  conformance: KmsSecretStore (${label})`, store, A, runA)).failures;

  // --- two workspaces, one name ------------------------------------------------------
  console.log("\n  two workspaces holding the same variable");
  await store.set(A, "ANTHROPIC_API_KEY", "sk-ant-belongs-to-A");
  await store.set(B, "ANTHROPIC_API_KEY", "sk-ant-belongs-to-B");

  check(
    (await store.getForRun(runA, ["ANTHROPIC_API_KEY"]))["ANTHROPIC_API_KEY"] === "sk-ant-belongs-to-A",
    "A's run gets A's value",
  );
  check(
    (await store.getForRun(runB, ["ANTHROPIC_API_KEY"]))["ANTHROPIC_API_KEY"] === "sk-ant-belongs-to-B",
    "...and B's run gets B's",
  );
  check((await store.listNames(A)).length === 1, "A's listing holds one name");
  check(
    (await store.listNames(A)).every((s) => s.name === "ANTHROPIC_API_KEY"),
    "...and it is A's own",
  );

  const unknownRun = await store.getForRun(randomUUID(), ["ANTHROPIC_API_KEY"]);
  check(Object.keys(unknownRun).length === 0, "a run id that resolves to no workspace gets nothing, never everything");

  await store.delete(A, "ANTHROPIC_API_KEY");
  check(
    (await store.getForRun(runB, ["ANTHROPIC_API_KEY"]))["ANTHROPIC_API_KEY"] === "sk-ant-belongs-to-B",
    "deleting A's does not touch B's",
  );
  await store.set(A, "ANTHROPIC_API_KEY", "sk-ant-belongs-to-A");

  // --- the binding -------------------------------------------------------------------
  console.log("\n  a ciphertext is bound to the row it was written for");
  const raw = await db
    .forWorkspace(A.workspaceId)
    .get<{ ciphertext: string; data_key_id: string }>(
      `SELECT ciphertext, data_key_id FROM workspace_secrets WHERE workspace_id = ? AND name = ?`,
      [A.workspaceId, "ANTHROPIC_API_KEY"],
    );
  check(raw !== undefined, "the value is stored as ciphertext in a row");
  check(!(raw?.ciphertext ?? "").includes("sk-ant"), "...which contains no part of the plaintext");

  // Copied into B's workspace under B's data key id — the crudest version of the attack the
  // repository scope and RLS are there to stop, done here BY HAND so the binding is what has
  // to refuse it.
  const bKey = await db
    .forWorkspace(B.workspaceId)
    .get<{ id: string }>(`SELECT id FROM workspace_data_keys WHERE workspace_id = ? ORDER BY version DESC`, [B.workspaceId]);
  await db.forWorkspace(B.workspaceId).run(
    `INSERT INTO workspace_secrets (workspace_id, name, data_key_id, ciphertext, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, name) DO UPDATE SET ciphertext = excluded.ciphertext`,
    [B.workspaceId, "STOLEN_KEY", bKey!.id, raw!.ciphertext, new Date().toISOString(), new Date().toISOString()],
  );
  let refusedCopy = false;
  try {
    await store.getForRun(runB, ["STOLEN_KEY"]);
  } catch (err) {
    refusedCopy = (err as Error).message.includes("does not authenticate");
  }
  check(refusedCopy, "A's ciphertext copied into B's workspace decrypts to nothing at all");
  await store.delete(B, "STOLEN_KEY");

  // Relabelled within the same workspace: `SLACK_BOT_TOKEN` renamed to `ANTHROPIC_API_KEY`
  // would inject one credential into the run that sends it to the other host.
  await db.forWorkspace(A.workspaceId).run(
    `INSERT INTO workspace_secrets (workspace_id, name, data_key_id, ciphertext, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [A.workspaceId, "RELABELLED_KEY", raw!.data_key_id, raw!.ciphertext, new Date().toISOString(), new Date().toISOString()],
  );
  let refusedRename = false;
  try {
    await store.getForRun(runA, ["RELABELLED_KEY"]);
  } catch (err) {
    refusedRename = (err as Error).message.includes("does not authenticate");
  }
  check(refusedRename, "...and the same row relabelled to another variable name is refused too");
  await store.delete(A, "RELABELLED_KEY");

  // --- rotation ------------------------------------------------------------------------
  console.log("\n  rotating a workspace's data key");
  await store.set(A, "SLACK_BOT_TOKEN", "xoxb-before-rotation");
  const before = await db
    .forWorkspace(A.workspaceId)
    .get<{ ciphertext: string }>(`SELECT ciphertext FROM workspace_secrets WHERE workspace_id = ? AND name = ?`, [
      A.workspaceId, "SLACK_BOT_TOKEN",
    ]);

  const rotated = await store.rotate(A);
  check(rotated.version >= 2, `rotation creates a new data key version (v${rotated.version})`);
  check(rotated.resealed >= 2, `...and re-seals every secret (${rotated.resealed})`);

  const after = await db
    .forWorkspace(A.workspaceId)
    .get<{ ciphertext: string }>(`SELECT ciphertext FROM workspace_secrets WHERE workspace_id = ? AND name = ?`, [
      A.workspaceId, "SLACK_BOT_TOKEN",
    ]);
  check(after?.ciphertext !== before?.ciphertext, "...so the ciphertext on disk is different");
  check(
    (await store.getForRun(runA, ["SLACK_BOT_TOKEN"]))["SLACK_BOT_TOKEN"] === "xoxb-before-rotation",
    "...while the value a run receives is unchanged",
  );
  check(
    (await store.getForRun(runB, ["ANTHROPIC_API_KEY"]))["ANTHROPIC_API_KEY"] === "sk-ant-belongs-to-B",
    "...and B, which was not rotated, is untouched",
  );

  const retired = await db.forWorkspace(A.workspaceId).all<{ version: unknown; retired_at: string | null }>(
    `SELECT version, retired_at FROM workspace_data_keys WHERE workspace_id = ? ORDER BY version`,
    [A.workspaceId],
  );
  check(retired.length >= 2, "the old data key row is kept, not deleted");
  check(retired[0]?.retired_at !== null, "...and marked retired");
  check(retired[retired.length - 1]?.retired_at === null, "...while the newest is live");

  // A row still pointing at the retired key stays readable — which is what makes a rotation
  // interrupted half way through a resumable job rather than a data loss.
  await db.forWorkspace(A.workspaceId).run(
    `UPDATE workspace_secrets SET ciphertext = ?, data_key_id =
       (SELECT id FROM workspace_data_keys WHERE workspace_id = ? ORDER BY version LIMIT 1)
      WHERE workspace_id = ? AND name = ?`,
    [before!.ciphertext, A.workspaceId, A.workspaceId, "SLACK_BOT_TOKEN"],
  );
  check(
    (await store.getForRun(runA, ["SLACK_BOT_TOKEN"]))["SLACK_BOT_TOKEN"] === "xoxb-before-rotation",
    "a row left on the retired key is still readable, so an interrupted rotation is resumable",
  );
  const second = await store.rotate(A);
  check(second.version > rotated.version, "...and re-running the rotation finishes the job");

  // --- the master key is not in the database ---------------------------------------------
  console.log("\n  a database dump without the master key");
  const wrongMaster = new KmsSecretStore({
    db,
    master: new LocalMasterKeyProvider(OTHER_MASTER),
    refs,
    runWorkspace: async (id) => runs.get(id) ?? null,
  });
  let unreadable = false;
  try {
    await wrongMaster.getForRun(runA, ["SLACK_BOT_TOKEN"]);
  } catch (err) {
    unreadable = err instanceof MasterKeyError;
  }
  check(unreadable, "a process with the wrong master key cannot read a single value");
  check(
    (await wrongMaster.listNames(A)).some((s) => s.name === "SLACK_BOT_TOKEN"),
    "...though it can still see the NAMES, which are not secret and are what the client renders",
  );
}

const dir = tmpDir();
{
  const db = new SqliteDb(join(dir, "vault.db"));
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
