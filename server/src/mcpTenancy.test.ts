// Two workspaces, one MCP endpoint, two different tokens.
//
// THE BUG THIS CLOSES, stated plainly because it is a one-line consequence of a design that was
// correct for years. An MCP server's credential lived in `process.env` under a name DERIVED FROM
// ITS ID — `JAROKU_MCP_LINEAR_TOKEN` for a server called `linear`. A server id is a slug, and a
// slug is derived from the endpoint's hostname, so two workspaces connecting `mcp.linear.app`
// both get `linear` and both derive the same variable. The process environment has no workspace
// in it, so the second workspace to save a token overwrote the first's — and from then on BOTH
// workspaces authenticated to Linear as whoever wrote last, silently, with `configured: true`
// on both panels.
//
// That is not a subtle failure. It is one tenant's agents reading another tenant's issue tracker
// with the second tenant's credential, reported to both as working.
//
// So: the tokens go through `SecretStore`, which has a workspace in it, and this suite is two
// workspaces doing exactly that and observing each other not at all. It also asserts the read
// path — `configured` — comes from the workspace's own listing rather than from `process.env`,
// because a panel that read the environment would tell every workspace it has a credential the
// moment the SERVER has one.
//
//   npm run test:mcp-tenancy

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
import { McpStore } from "./mcpStore.ts";
import { McpRegistry, slugifyServerId } from "./mcpRegistry.ts";
import { authEnvKeyFor } from "./envWriter.ts";

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

const ENDPOINT = "https://mcp.linear.app/sse";
const TOKEN_A = "lin_api_workspace_a_11111";
const TOKEN_B = "lin_api_workspace_b_22222";

const scratch: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "jaroku-mcptenancy-"));
scratch.push(dir);
const db = new SqliteDb(join(dir, "mcp.db"));
await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});

const identity = new IdentityRepository(db);
const refs = new SecretRefRepository(db);
const secrets = new KmsSecretStore({
  db,
  master: new LocalMasterKeyProvider(MASTER),
  refs,
  runWorkspace: async () => null,
});
const store = new McpStore(db);
const registry = new McpRegistry(store, secrets);

async function workspace(label: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `mcp ${label} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

const A = await workspace("a");
const B = await workspace("b");

// --- the collision that used to be silent -----------------------------------------------
console.log("\ntwo workspaces derive the same env key from the same endpoint");
{
  const id = slugifyServerId(ENDPOINT);
  check(id.length > 0, `both would call this server "${id}"`);
  check(
    authEnvKeyFor(id) === authEnvKeyFor(id),
    `...and both derive the same variable name, ${authEnvKeyFor(id)}`,
  );
  check(
    authEnvKeyFor(id).startsWith("JAROKU_MCP_"),
    "which is exactly why one process-wide value was never going to be enough",
  );
}

// --- and the tokens stay apart anyway -----------------------------------------------------
console.log("\nand the tokens stay apart anyway");
{
  // Registered without a network: `addServer` writes a row even when the handshake fails, which
  // is the behaviour a user needs and is also what lets this suite exercise the credential path
  // without a live MCP server. The endpoint is unreachable and both rows say so.
  const key = authEnvKeyFor("linear");
  await registry.addServer(A, { endpoint: ENDPOINT, id: "linear", token: TOKEN_A });
  await registry.addServer(B, { endpoint: ENDPOINT, id: "linear", token: TOKEN_B });

  check((await store.getServer(A, "linear")) !== null, "A has a server row");
  check((await store.getServer(B, "linear")) !== null, "...and so does B, under the same id");

  const inA = await secrets.getForPlatformCall(A, [key]);
  const inB = await secrets.getForPlatformCall(B, [key]);
  check(inA[key] === TOKEN_A, "A's vault holds A's token under the shared name");
  check(inB[key] === TOKEN_B, "...and B's holds B's, under the SAME name and a different key");
  check(
    inA[key] !== inB[key],
    "which is the whole of it: the second write did not overwrite the first",
  );
}

// --- what each workspace is told ----------------------------------------------------------
console.log("\nand each is told only about its own");
{
  const key = authEnvKeyFor("linear");
  const viewA = await registry.get(A, "linear");
  const viewB = await registry.get(B, "linear");
  check(viewA?.configured === true, "A's panel says configured");
  check(viewB?.configured === true, "...and so does B's");

  // `configured` must come from the WORKSPACE's listing, not the process environment. Set the
  // variable in this process and a workspace that has NOT configured one must still say so.
  const C = await workspace("c");
  process.env[key] = "a value the server happens to have";
  try {
    await registry.addServer(C, { endpoint: ENDPOINT, id: "linear" });
    check(
      (await registry.get(C, "linear"))?.configured === false,
      "a workspace with no credential says so, even when the SERVER's environment has one",
    );
  } finally {
    delete process.env[key];
  }

  // And nothing about the credential is on the snapshot itself, on any workspace.
  const serialised = JSON.stringify(await registry.list(A));
  check(!serialised.includes(TOKEN_A), "no token is on A's registry snapshot");
  check(!serialised.includes(TOKEN_B), "...and certainly not B's");
  check(serialised.includes(key), "only the NAME the credential is held under");
}

// --- clearing one does not clear the other -------------------------------------------------
console.log("\nclearing one workspace's credential leaves the other's");
{
  const key = authEnvKeyFor("linear");
  await registry.setCredential(A, "linear", null);
  check(
    (await secrets.getForPlatformCall(A, [key]))[key] === undefined,
    "A's credential is gone from A's vault",
  );
  check(
    (await secrets.getForPlatformCall(B, [key]))[key] === TOKEN_B,
    "...and B's is untouched, which a shared process variable could not have managed",
  );
  check((await registry.get(A, "linear"))?.configured === false, "A's panel says not configured");
  check((await registry.get(B, "linear"))?.configured === true, "...and B's still says it is");
}

// --- the rows themselves ---------------------------------------------------------------------
console.log("\nand no row crosses either");
{
  await registry.setToolImpact(A, "linear", "create_issue", "low");
  check((await store.getServer(B, "linear"))?.endpoint === ENDPOINT, "B's row still exists");
  check((await registry.removeServer(A, "linear")) === true, "A can remove its own server");
  check((await registry.get(A, "linear")) === null, "...and it is gone for A");
  check((await registry.get(B, "linear")) !== null, "...and still there for B");
  check(
    (await secrets.getForPlatformCall(B, [authEnvKeyFor("linear")]))[authEnvKeyFor("linear")] === TOKEN_B,
    "...with its credential intact",
  );
}

// A tick before closing, and another before exiting.
//
// `addServer` performs a real handshake — against an endpoint that does not resolve, which is
// the point — and the MCP SDK's transport tears its socket down asynchronously after `close()`
// returns. Calling `process.exit()` into the middle of that aborts the process from inside
// libuv with an assertion, AFTER every check above has already passed: a green suite that exits
// 127, which is the worst of both. Draining first costs nothing and makes the exit code mean
// what it says.
const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));
await drain();
await db.close();
await drain();
for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
