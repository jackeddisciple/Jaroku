// The provider-key migration: that it is idempotent, that `--dry-run` writes nothing, and — the
// one that matters — that it completes without ever decrypting anything.
//
// THE DECRYPT ASSERTION IS THE POINT OF THIS FILE. A migration that decrypted six thousand
// workspaces' credentials to compute a cosmetic hint would be the largest concentration of
// plaintext this system has ever produced, existing for the duration of a batch job nobody is
// watching. So "moves the pointer, not the plaintext" is enforced rather than reviewed.
//
// It is enforced by the job having NO WAY to decrypt — its options carry no `SecretStore`, so
// there is no parameter a vault could arrive through — and asserted against the module's source,
// because the tempting change is small and local: somebody wanting a nicer mask adds a store to
// the options, four lines, and a decrypt, and nothing in a review says no.
//
//   npm run test:provider-key-migration

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { SqliteDb } from "../db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { SecretRefRepository } from "../db/repositories/secretRefs.ts";
import { KmsSecretStore } from "./kmsSecretStore.ts";
import { LocalMasterKeyProvider } from "./masterKey.ts";
import { GENERIC_MASK } from "./mask.ts";
import { migrateProviderKeys, resolveProviderKeyName } from "./migrateProviderKeys.ts";

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
  const d = mkdtempSync(join(tmpdir(), "jaroku-key-migration-"));
  scratch.push(d);
  return d;
};

const dir = tmpDir();
const db: Db = new SqliteDb(join(dir, "migration.db"));
await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});

try {
  const identity = new IdentityRepository(db);
  const refs = new SecretRefRepository(db);
  const sys = systemContext(newRequestId());

  const makeWorkspace = async (label: string): Promise<TenantContext> => {
    const ws = await identity.createWorkspaceUnowned(sys, { name: `${label} ${randomUUID().slice(0, 6)}` });
    return systemContextFor(ws.id, newRequestId());
  };

  const vault = new KmsSecretStore({
    db,
    master: new LocalMasterKeyProvider("a-master-key-with-enough-entropy-behind-it-0123456789"),
    refs,
    runWorkspace: async () => null,
  });

  // Two workspaces the way onboarding left them: a key in the vault, a row in the registry, and no
  // classification — because `kind` did not exist when they were written.
  const A = await makeWorkspace("has-two");
  const B = await makeWorkspace("has-one");
  const C = await makeWorkspace("has-none");
  await vault.set(A, "ANTHROPIC_API_KEY", "sk-ant-api03-a-real-looking-secret-value-aaaa");
  await vault.set(A, "OPENAI_API_KEY", "sk-proj-another-real-looking-value-bbbb");
  await vault.set(A, "OPENWEATHER_API_KEY", "not-a-provider-key-at-all-cccc");
  await vault.set(B, "ANTHROPIC_API_KEY", "sk-ant-api03-b-workspace-value-dddd");

  check((await refs.get(A, "ANTHROPIC_API_KEY"))?.kind === "custom", "an unmigrated key starts unclassified");

  // --- it cannot decrypt, by construction ---------------------------------------------------
  //
  // The first draft of this suite handed the job a Proxy over the vault whose plaintext exits all
  // threw. That was the wrong assertion, and finding out why is worth recording: the job does not
  // take a `SecretStore` AT ALL. There is no parameter a vault could arrive through, so there is
  // nothing to intercept — which is a stronger property than a spy that catches the call, and one
  // a reviewer can check by reading a five-line interface.
  //
  // What is asserted, therefore, is the shape of `MigrationOptions` itself: `db`, `refs`,
  // `identity`, `dryRun`, `log`. Adding a store to it would fail here, which is exactly the change
  // somebody makes when they want a prettier mask.
  console.log("\nit cannot decrypt, because there is nothing to decrypt with");
  {
    const source = readFileSync(fileURLToPath(new URL("./migrateProviderKeys.ts", import.meta.url)), "utf8");
    const code = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    check(!/SecretStore/.test(code), "the module never names SecretStore outside a comment");
    for (const exit of ["getForRun", "getForPlatformCall", "revealForUser"]) {
      check(!code.includes(exit), `and never calls ${exit}`);
    }
  }

  console.log("\n--dry-run");
  {
    const report = await migrateProviderKeys({ db, refs, identity, dryRun: true, log: () => {} });
    check(report.keysClassified === 3, `it reports the work it would do (${report.keysClassified})`);
    check(report.workspacesChanged === 2, "across the workspaces that have any");
    check((await refs.get(A, "ANTHROPIC_API_KEY"))?.kind === "custom", "and writes nothing at all");
    check((await refs.get(A, "ANTHROPIC_API_KEY"))?.masked_hint === null, "not even a mask");
  }

  console.log("\nthe real run");
  const before = await refs.get(A, "ANTHROPIC_API_KEY");
  {
    const report = await migrateProviderKeys({ db, refs, identity, log: () => {} });
    check(report.keysClassified === 3, `three provider keys classified (${report.keysClassified})`);
    check(report.workspacesSeen >= 3, "having walked every workspace, including the one with none");

    const anthropic = await refs.get(A, "ANTHROPIC_API_KEY");
    check(anthropic?.kind === "provider_key", "an Anthropic key is classified");
    check((await refs.get(A, "OPENAI_API_KEY"))?.kind === "provider_key", "and an OpenAI one");
    check((await refs.get(B, "ANTHROPIC_API_KEY"))?.kind === "provider_key", "in every workspace, not just the first");

    // The credential that is NOT a provider key is left exactly alone.
    check((await refs.get(A, "OPENWEATHER_API_KEY"))?.kind === "custom", "a custom credential is untouched");

    check(anthropic?.masked_hint === GENERIC_MASK, "the hint is generic, because deriving a real one needs the value");
    check(anthropic?.status === "unknown", "and the status stays unknown — nothing has probed this key");
    check(anthropic?.created_at === before?.created_at, "created_at is preserved; this classifies rather than re-creates");
    check(anthropic?.configured === true, "and the key is still configured");
  }

  console.log("\nrunning it again");
  {
    const second = await migrateProviderKeys({ db, refs, identity, log: () => {} });
    check(second.keysClassified === 0, "a second run classifies nothing");
    check(second.workspacesChanged === 0, "and changes no workspace");
    check(second.alreadyDone === 3, `reporting what was already done (${second.alreadyDone})`);
  }

  console.log("\none audit row per workspace, not per key");
  {
    // A has two keys and must have exactly one row for the migration.
    const rows = await identity.listAudit(A, 50);
    const migrationRows = rows.filter((r) => r.action === "secrets.provider_keys_migrated");
    check(migrationRows.length === 1, `A got one row for two keys (${migrationRows.length})`);
    const meta = migrationRows[0]?.metadata as { count?: number } | undefined;
    check(meta?.count === 2, "which says how many it covered");
  }

  console.log("\nthe dual read, for the release the fallback survives");
  {
    const D = await makeWorkspace("unmigrated");
    await vault.set(D, "ANTHROPIC_API_KEY", "sk-ant-api03-not-yet-migrated-eeee");

    const unmigrated = await resolveProviderKeyName(refs, D, "ANTHROPIC_API_KEY");
    check(unmigrated.name === "ANTHROPIC_API_KEY", "a workspace the job has not reached still resolves its key");
    check(unmigrated.usedFallback === true, "...by the fallback, which is what the telemetry counts");

    const migrated = await resolveProviderKeyName(refs, A, "ANTHROPIC_API_KEY");
    check(migrated.name === "ANTHROPIC_API_KEY", "and a migrated one resolves the same name");
    check(migrated.usedFallback === false, "...without the fallback, so the count goes to zero as the job runs");

    const absent = await resolveProviderKeyName(refs, C, "ANTHROPIC_API_KEY");
    check(absent.name === null, "a workspace with no key resolves to nothing");
    check(absent.usedFallback === false, "which is not a fallback hit — it is an absence");
  }
} finally {
  await db.close();
}

for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
