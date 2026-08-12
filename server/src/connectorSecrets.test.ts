// The one connector whose host a user chooses, and the two places that has to be checked.
//
// `sandbox/databaseUrl.ts` has had the refusal since Session 4 and `test:database-url` proves the
// refusal itself. What this suite is about is the part that was missing: that something CALLS it,
// on both paths, and that the second call is not a duplicate of the first.
//
// THE SECOND CALL IS THE ONE PEOPLE LEAVE OUT. Validating at save is obvious and produces a nice
// error message. Validating again at run time is what closes DNS rebinding: a hostname is not a
// promise, and `db.attacker.example` can answer with a public address for the sixty seconds
// somebody spends saving a form and with 169.254.169.254 at the moment a sandbox connects. The
// test below does exactly that — one resolver answer at save, a different one at run — and
// asserts the run is refused despite the value having been accepted.
//
// AND THE VALUE NEVER COMES BACK. The store has no `get`, so the assertion is structural, but the
// error paths are where a connection string leaks in practice: a message that quotes the URL
// quotes the password in its userinfo, into a log, into a broadcast, into a database. Every
// refusal below is checked for that.
//
//   npm run test:connector-secrets

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "./db/migrate.ts";
import { SqliteDb } from "./db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { SecretRefRepository } from "./db/repositories/secretRefs.ts";
import { KmsSecretStore } from "./secrets/kmsSecretStore.ts";
import { LocalMasterKeyProvider } from "./secrets/masterKey.ts";
import { ConnectorSecrets, DATABASE_URL_NAME } from "./connectorSecrets.ts";
import { EgressPolicyError, type Resolver } from "./sandbox/egressPolicy.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const MIGRATIONS = join(fileURLToPath(new URL("..", import.meta.url)), "migrations");
const MASTER = "a-master-key-with-enough-entropy-behind-it-0123456789";

/** The password is real-shaped on purpose: every refusal below is searched for it. */
const PASSWORD = "s3cr3t-p4ssw0rd-in-the-url";
const GOOD_URL = `postgres://app:${PASSWORD}@db.example.com:5432/production`;

const publicAnswer: Resolver = async () => ({ v4: ["203.0.114.9"], v6: [] });
const metadataAnswer: Resolver = async () => ({ v4: ["169.254.169.254"], v6: [] });

const scratch: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "jaroku-connsec-"));
scratch.push(dir);
const db = new SqliteDb(join(dir, "connsec.db"));
await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});

const identity = new IdentityRepository(db);
const refs = new SecretRefRepository(db);
const runWorkspaces = new Map<string, string>();
const secrets = new KmsSecretStore({
  db,
  master: new LocalMasterKeyProvider(MASTER),
  refs,
  runWorkspace: async (runId) => runWorkspaces.get(runId) ?? null,
});

async function workspace(label: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `connsec ${label} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

/** A run id that resolves to this workspace, the way a dispatched run's does. */
function runFor(ctx: TenantContext): string {
  const runId = randomUUID();
  runWorkspaces.set(runId, ctx.workspaceId);
  return runId;
}

const A = await workspace("a");
const B = await workspace("b");

// --- saving ---------------------------------------------------------------------------------
console.log("\nsaving a connection string");
{
  const store = new ConnectorSecrets({ secrets, resolver: publicAnswer });
  const saved = await store.saveDatabaseUrl(A, GOOD_URL);
  check(saved.ok, "a well-formed string resolving publicly is accepted", saved.message ?? "");
  check(saved.reachable === null, "...and nothing was probed, because nothing asked for a probe");
  check(
    (await secrets.listNames(A)).some((r) => r.name === DATABASE_URL_NAME),
    "...and it is in the vault under the name the connector reads",
  );
  check((await secrets.listNames(B)).length === 0, "and B's workspace knows nothing about it");

  const probed = new ConnectorSecrets({ secrets, resolver: publicAnswer, probe: async () => false });
  const unreachable = await probed.saveDatabaseUrl(A, GOOD_URL, { probe: true });
  check(unreachable.ok, "a probe that found nothing listening does NOT refuse the save");
  check(
    unreachable.reachable === false,
    "...it reports what it found — a firewall that opens for our egress and not for this box is ordinary",
  );
}

// --- the refusals ----------------------------------------------------------------------------
console.log("\nwhat is refused, and what the refusal says");
{
  const store = new ConnectorSecrets({ secrets, resolver: publicAnswer });
  const cases: [string, string, string][] = [
    ["loopback", `postgres://app:${PASSWORD}@127.0.0.1:5432/x`, "private/link-local"],
    ["the metadata endpoint", `postgres://app:${PASSWORD}@169.254.169.254:5432/x`, "private/link-local"],
    ["RFC1918 space", `postgres://app:${PASSWORD}@10.0.1.7:5432/x`, "private/link-local"],
    ["an IPv6-wrapped metadata address", `postgres://app:${PASSWORD}@[::ffff:a9fe:a9fe]:5432/x`, "private/link-local"],
    ["a port that is not Postgres'", `postgres://app:${PASSWORD}@db.example.com:6379/x`, "not on the allowed list"],
    ["a scheme that is not Postgres'", `mysql://app:${PASSWORD}@db.example.com:5432/x`, "postgres://"],
    ["something that is not a URL", "not a url at all", "not a valid URL"],
  ];
  for (const [label, url, expected] of cases) {
    const refused = await store.saveDatabaseUrl(A, url);
    check(!refused.ok, `${label} is refused`);
    check((refused.message ?? "").includes(expected), `...saying why (${expected})`, refused.message ?? "");
    check(
      !(refused.message ?? "").includes(PASSWORD),
      "...without quoting the password back, which would put it in a log and a broadcast",
    );
  }

  const rebound = new ConnectorSecrets({ secrets, resolver: metadataAnswer });
  const hostile = await rebound.saveDatabaseUrl(A, GOOD_URL);
  check(!hostile.ok, "a public-looking hostname that RESOLVES to the metadata endpoint is refused");
  check(!(hostile.message ?? "").includes(PASSWORD), "...also without quoting the password");
  check(await stillTheGoodOne(), "and none of the refusals overwrote the value that was already saved");
}

async function stillTheGoodOne(): Promise<boolean> {
  const runId = runFor(A);
  const env = await secrets.getForRun(runId, [DATABASE_URL_NAME]);
  return env[DATABASE_URL_NAME] === GOOD_URL;
}

// --- the run path, and rebinding ---------------------------------------------------------------
console.log("\nre-resolved at run time, which is the only time it proves anything");
{
  // Saved when the name answered publicly — accepted, correctly.
  const atSave = new ConnectorSecrets({ secrets, resolver: publicAnswer });
  check((await atSave.saveDatabaseUrl(A, GOOD_URL)).ok, "the value was accepted when it was saved");
  const pinned = await atSave.postgresEgress(runFor(A));
  check(pinned?.host === "db.example.com", "and a run resolves it to a host");
  check(pinned?.port === 5432, "...a port");
  check(pinned?.ips.join(",") === "203.0.114.9", "...and LITERAL pinned addresses, not a name to re-resolve");

  // The same stored value, and the name now answers with the metadata endpoint. Nothing about
  // the vault changed; what changed is what the world says, which is the point.
  const atRun = new ConnectorSecrets({ secrets, resolver: metadataAnswer });
  const rebound = await atRun.postgresEgress(runFor(A)).then(() => null, (e: Error) => e);
  check(rebound instanceof EgressPolicyError, "a name that has since been repointed is refused AT RUN TIME");
  check(
    !(rebound?.message ?? "").includes(PASSWORD),
    "...and the refusal still does not quote the connection string",
  );
}

// --- absence is not a failure ---------------------------------------------------------------
console.log("\na workspace that has not configured one");
{
  const store = new ConnectorSecrets({ secrets, resolver: publicAnswer });
  check(
    (await store.postgresEgress(runFor(B))) === null,
    "resolves to null rather than throwing — the agent reports it at pg_query, with the name",
  );
  check((await store.postgresEgress("a-run-that-does-not-exist")) === null, "and so does an unknown run");
}

// --- across the boundary ------------------------------------------------------------------------
console.log("\nand one workspace's connection string is not another's");
{
  const store = new ConnectorSecrets({ secrets, resolver: publicAnswer });
  await store.saveDatabaseUrl(B, "postgres://b:pw@db-b.example.com:5432/b");
  const forA = await store.postgresEgress(runFor(A));
  const forB = await store.postgresEgress(runFor(B));
  check(forA?.host === "db.example.com", "A's run pins A's host");
  check(forB?.host === "db-b.example.com", "...and B's run pins B's");

  await store.forget(A);
  check((await store.postgresEgress(runFor(A))) === null, "forgetting removes it from A's runs");
  check((await store.postgresEgress(runFor(B))) !== null, "...and leaves B's alone");
}

await db.close();
for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
