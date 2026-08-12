// Whose key, and where it is allowed to go.
//
// Three properties, and the first two are the security boundary:
//
//   A KEY IS PROVED BEFORE IT IS STORED, so "connected" means connected rather than "typed".
//   A RUN GETS ONLY ITS OWN PROVIDER'S KEY, even when the workspace has configured two.
//   THE PLATFORM'S OWN CALLS USE THE PLATFORM'S KEY UNLESS SOMEBODY SAID OTHERWISE — the
//   default is false, no migration turns it on, and using a tenant's credential for a call they
//   did not ask for is a use they did not consent to whatever the accounting says.
//
// Runs against the hosted store, because the local one has no notion of a workspace in it —
// `runtime/.env` is one file and says so — and every assertion here is about which workspace
// gets what.
//
//   npm run test:byok

import { randomUUID } from "node:crypto";
import { openTestSqlite } from "../db/testDb.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { SecretRefRepository } from "../db/repositories/secretRefs.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { KmsSecretStore } from "../secrets/kmsSecretStore.ts";
import { LocalMasterKeyProvider } from "../secrets/masterKey.ts";
import { PROVIDER_ENV_KEY, providerStatus } from "../providers.ts";
import { WorkspaceProviderKeys } from "./providerKeys.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const db = await openTestSqlite();
const refs = new SecretRefRepository(db);
const billing = new BillingRepository(db);
const identity = new IdentityRepository(db);

/** runId -> workspace, the same map index.ts keeps. Lets `getForRun` resolve a scope. */
const runWorkspaces = new Map<string, string>();

const secrets = new KmsSecretStore({
  db,
  refs,
  master: new LocalMasterKeyProvider("a-master-key-long-enough-for-the-vault-suite"),
  runWorkspace: async (runId) => runWorkspaces.get(runId) ?? null,
  providerFor: (name) => (name.startsWith("ANTHROPIC") ? "anthropic" : name.startsWith("OPENAI") ? "openai" : null),
});
/**
 * The probe, stubbed.
 *
 * Deliberately not the real one: the property worth asserting is that a key which does not
 * authenticate is never written, and calling a provider to establish that would need a network,
 * would be slow, and would report somebody else's outage as a failure of this code. Anything
 * starting `sk-good` passes; everything else is refused with a message shaped like a provider's.
 */
const keys = new WorkspaceProviderKeys(secrets, billing, async (_provider, key) =>
  key.startsWith("sk-good")
    ? { ok: true, message: null }
    : { ok: false, message: "401 authentication_error: invalid x-api-key" });

async function workspace(): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `byok ${randomUUID().slice(0, 8)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

/**
 * Store a key WITHOUT the probe.
 *
 * `save` deliberately calls a provider to verify, which a test must not do — so the storage
 * half is exercised directly here and the probe is asserted separately, against a key that
 * cannot possibly authenticate. Testing "a bad key is refused" is the assertion that matters;
 * testing "a good key is accepted" would be testing Anthropic.
 */
async function store(ctx: TenantContext, provider: "anthropic" | "openai", value: string): Promise<void> {
  await secrets.set(ctx, PROVIDER_ENV_KEY[provider], value);
}

const A = await workspace();
const B = await workspace();

console.log("\na key that does not authenticate is not stored");

{
  const ctx = await workspace();
  const before = await keys.configuredNames(ctx);
  const res = await keys.save(ctx, "anthropic", "sk-ant-obviously-not-a-real-key-000000");
  check(!res.ok, "the probe refuses it");
  check(typeof res.message === "string" && res.message.length > 0, "and says why, in the provider's own words");
  check(!res.message!.includes("sk-ant-obviously"), "without echoing any part of the key back");
  const after = await keys.configuredNames(ctx);
  check(after.size === before.size, "nothing was written — 'connected' cannot mean 'typed'");
}

console.log("\na key that does authenticate is stored, through the SecretStore");

{
  const ctx = await workspace();
  const res = await keys.save(ctx, "openai", "sk-good-openai");
  check(res.ok, "a verified key is accepted");
  check((await keys.configuredNames(ctx)).has(PROVIDER_ENV_KEY.openai), "and is configured afterwards");
  check(!JSON.stringify(res).includes("sk-good-openai"), "and the result hands nothing back");
}

console.log("\nan empty key is refused before anything is called");

{
  const res = await keys.save(A, "anthropic", "   ");
  check(!res.ok && res.message === "no key was entered", "refused with the message that names the problem");
}

console.log("\nkeys are the workspace's own");

{
  await store(A, "anthropic", "sk-ant-A");
  await store(B, "anthropic", "sk-ant-B");
  check((await keys.configuredNames(A)).has(PROVIDER_ENV_KEY.anthropic), "A has one configured");
  check((await keys.configuredNames(B)).has(PROVIDER_ENV_KEY.anthropic), "so does B");

  const statusA = providerStatus(await keys.configuredNames(A));
  check(statusA.find((p) => p.id === "anthropic")?.configured === true, "A's panel says anthropic is connected");
  check(statusA.find((p) => p.id === "openai")?.configured === false, "and openai is not");
  check(!JSON.stringify(statusA).includes("sk-ant-A"), "and the snapshot carries no key material at all");
}

console.log("\na run gets its own provider's key, and no other");

{
  await store(A, "openai", "sk-openai-A");
  const runId = randomUUID();
  runWorkspaces.set(runId, A.workspaceId);

  const anthropicRun = await keys.runEnv(runId, "anthropic");
  check(anthropicRun[PROVIDER_ENV_KEY.anthropic] === "sk-ant-A", "an anthropic run receives the anthropic key");
  check(!(PROVIDER_ENV_KEY.openai in anthropicRun), "and does NOT receive the openai key it will not use");

  const openaiRun = await keys.runEnv(runId, "openai");
  check(openaiRun[PROVIDER_ENV_KEY.openai] === "sk-openai-A", "an openai run receives the openai key");
  check(!(PROVIDER_ENV_KEY.anthropic in openaiRun), "and not the anthropic one");

  check(Object.keys(await keys.runEnv(runId, undefined)).length === 0, "a run with no provider named gets nothing");
  check(Object.keys(await keys.runEnv(runId, "fake")).length === 0, "and neither does the dry-run provider, which needs none");
}

console.log("\na run cannot reach another workspace's key");

{
  const theirRun = randomUUID();
  runWorkspaces.set(theirRun, B.workspaceId);
  const env = await keys.runEnv(theirRun, "anthropic");
  check(env[PROVIDER_ENV_KEY.anthropic] === "sk-ant-B", "B's run gets B's key");
  check(env[PROVIDER_ENV_KEY.anthropic] !== "sk-ant-A", "which is not A's");

  const unknownRun = randomUUID(); // never registered
  check(
    Object.keys(await keys.runEnv(unknownRun, "anthropic")).length === 0,
    "a run id that resolves to no workspace gets nothing — never 'all of them'",
  );
}

console.log("\nthe platform's calls use the platform's key until somebody says otherwise");

{
  check((await keys.ownKeyForPlatform(A)) === false, "the opt-in is off by default");
  check((await keys.platformKey(A)) === undefined, "so the platform's own key is what thinks");

  await keys.setOwnKeyForPlatform(A, true);
  check((await keys.ownKeyForPlatform(A)) === true, "it can be turned on");
  check((await keys.platformKey(A)) === "sk-ant-A", "and then the workspace's own key is handed to platform calls");
  check((await keys.platformKey(B)) === undefined, "while B, which did not opt in, is unaffected");

  await keys.setOwnKeyForPlatform(A, false);
  check((await keys.platformKey(A)) === undefined, "turning it off takes effect on the next call, not the next restart");
}

console.log("\nopting in with no key falls back rather than failing every call");

{
  const ctx = await workspace();
  await billing.setOwnKeyForPlatform(ctx, true);
  check(
    (await keys.platformKey(ctx)) === undefined,
    "a workspace that opted in and has no key gets the platform's, not an authentication error on every generation",
  );
}

console.log("\nthe opt-in is one workspace's decision");

{
  await keys.setOwnKeyForPlatform(A, true);
  check((await keys.ownKeyForPlatform(B)) === false, "turning it on for A does not turn it on for B");
  await keys.setOwnKeyForPlatform(A, false);
}

await db.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
