// A run's credentials, read while the run is placed in its workspace.
//
// What it exists to stop: a run asking the hosted store for its own provider key before the run is
// registered anywhere the store can see — which answers nothing, so a desktop run was refused with
// "Add ANTHROPIC_API_KEY in the Secrets tab" while the key was in Secrets, and a hosted run quietly
// spent the platform's key instead of the workspace's own.
//
//   npm run test:run-binding

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openTestSqlite } from "./db/testDb.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { SecretRefRepository } from "./db/repositories/secretRefs.ts";
import { KmsSecretStore } from "./secrets/kmsSecretStore.ts";
import { LocalMasterKeyProvider } from "./secrets/masterKey.ts";
import { bindForCredentials } from "./runBinding.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

console.log("§1 the binding lasts as long as the read, and never disturbs one already there");
{
  const registry = new Map<string, string>();
  const release = bindForCredentials(registry, "run-1", "ws-a");
  check(registry.get("run-1") === "ws-a", "an unbound run is placed in the asking workspace");
  release();
  check(!registry.has("run-1"), "and released afterwards, so a run refused before it starts leaves nothing");

  registry.set("run-2", "ws-a");
  const keep = bindForCredentials(registry, "run-2", "ws-b");
  check(registry.get("run-2") === "ws-a", "a run already registered keeps its own workspace");
  keep();
  check(registry.get("run-2") === "ws-a", "and releasing does not remove it");
}

console.log("\n§2 against the hosted store: no binding, no key");
{
  const db = await openTestSqlite();
  const refs = new SecretRefRepository(db);
  const identity = new IdentityRepository(db);
  const runWorkspaces = new Map<string, TenantContext>();
  const secrets = new KmsSecretStore({
    db,
    refs,
    master: new LocalMasterKeyProvider("a-master-key-long-enough-for-the-vault-suite"),
    runWorkspace: async (runId) => runWorkspaces.get(runId)?.workspaceId ?? null,
    providerFor: (name) => (name.startsWith("ANTHROPIC") ? "anthropic" : null),
  });
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), { name: `bind ${randomUUID().slice(0, 8)}` });
  const ctx = systemContextFor(ws.id, newRequestId());
  await secrets.set(ctx, "ANTHROPIC_API_KEY", "sk-ant-a-key-that-is-stored");

  const runId = randomUUID();
  check(Object.keys(await secrets.getForRun(runId, ["ANTHROPIC_API_KEY"])).length === 0,
    "a run the store cannot place gets nothing — the refusal the desktop run met");
  const release = bindForCredentials(runWorkspaces, runId, ctx);
  const env = await secrets.getForRun(runId, ["ANTHROPIC_API_KEY"]);
  check(env.ANTHROPIC_API_KEY === "sk-ant-a-key-that-is-stored", "bound, it gets its workspace's own key");
  release();
  check(Object.keys(await secrets.getForRun(runId, ["ANTHROPIC_API_KEY"])).length === 0, "and released, nothing again");
  await db.close();
}

console.log("\n§3 index.ts binds before every read of a run's credentials");
{
  const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  // Every place a run's credentials are read, and the function it is read in: the nearest
  // `function` before it. The binding must sit between that function's start and the read.
  const reads = [...source.matchAll(/secrets\.getForRun\(|providerKeys\.runEnv\(/g)].map((m) => m.index!);
  check(reads.length >= 5, `the reads are where this suite expects them (${reads.length} found)`);
  const unbound = reads.filter((at) => {
    const fnStart = Math.max(source.lastIndexOf("\nasync function ", at), source.lastIndexOf("\nfunction ", at));
    const bound = source.lastIndexOf("bindForCredentials(runWorkspaces, ", at);
    return bound < fnStart;
  });
  check(unbound.length === 0, "each read is preceded by a binding in its own function",
  );
  if (unbound.length) {
    for (const at of unbound) console.log(`       unbound read at line ${source.slice(0, at).split("\n").length}`);
  }
  const releases = (source.match(/finally \{\n\s+releaseCredentials\(\);/g) ?? []).length;
  check(releases === (source.match(/const releaseCredentials = bindForCredentials\(/g) ?? []).length,
    "and every binding is released in a finally");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
