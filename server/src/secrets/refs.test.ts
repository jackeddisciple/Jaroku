// The name registry: what a workspace has configured, and nothing about what it holds.
//
// Two things are being defended here.
//
// THE FIRST IS THAT THERE IS NOWHERE TO PUT A VALUE. Not "we do not put one there" — the table
// has no column for one, and this asserts that against the live schema rather than against the
// migration file, so a column added later fails the test rather than passing review.
//
// THE SECOND IS THAT BOTH STORES ANSWER THE SAME QUESTION THE SAME WAY. A client asking what is
// configured must not be able to tell whether the server keeps its credentials in a file or in
// an encrypted table. That is why `listNames` reads the registry on both, and why this suite
// runs the same assertions against both.
//
// Plus the distinction the `configured` column exists for: a name can be DECLARED before it is
// set — that is what an agent's `required_env` produces — and "this agent needs it and you have
// not set it" has to be tellable from "nobody has ever mentioned that name".
//
//   npm run test:secret-refs

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { SqliteDb } from "../db/sqlite.ts";
import { withScratchPostgres } from "../db/testDb.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { SecretRefRepository } from "../db/repositories/secretRefs.ts";
import { fileCredentialWriter } from "../envWriter.ts";
import { DotEnvSecretStore } from "./dotEnvSecretStore.ts";
import { KmsSecretStore } from "./kmsSecretStore.ts";
import { LocalMasterKeyProvider } from "./masterKey.ts";
import type { SecretStore } from "./secretStore.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const MIGRATIONS = join(new URL("../..", import.meta.url).pathname, "migrations");
const MASTER = "a-master-key-with-enough-entropy-behind-it-0123456789";

const scratch: string[] = [];
const tmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "jaroku-refs-"));
  scratch.push(d);
  return d;
};

async function newWorkspace(db: Db, label: string): Promise<TenantContext> {
  const identity = new IdentityRepository(db);
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `refs ${label} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

async function suite(label: string, db: Db): Promise<void> {
  console.log(`\n${label}`);
  const refs = new SecretRefRepository(db);
  const agents = new AgentRepository(db);
  const A = await newWorkspace(db, "a");
  const B = await newWorkspace(db, "b");

  // --- there is nowhere to put a value -------------------------------------------------
  //
  // Against the LIVE schema, not against the migration file. A column added later has to fail
  // something rather than pass review.
  const columns = new Set(
    db.dialect === "postgres"
      ? (
          await db.all<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'secret_refs'`,
          )
        ).map((r) => r.column_name)
      : (await db.all<{ name: string }>(`PRAGMA table_info(secret_refs)`)).map((r) => r.name),
  );
  check(columns.size > 0, `the table exists (${columns.size} columns)`);
  const valueish = [...columns].filter((c) => /value|secret_value|plaintext|token|ciphertext|password/.test(c));
  check(valueish.length === 0, "and no column a plaintext credential would fit in", valueish.join(", "));
  check(
    ["name", "provider", "scope", "configured", "last_used_at"].every((c) => columns.has(c)),
    "...while every column the spec asks for is there",
  );

  // --- declared, then configured -------------------------------------------------------
  console.log("\n  declared is not configured");
  await refs.declare(A, { name: "GMAIL_REFRESH_TOKEN", provider: "connector" });
  const declared = await refs.get(A, "GMAIL_REFRESH_TOKEN");
  check(declared !== undefined, "a name can be declared before anybody sets it");
  check(declared?.configured === false, "...and is not configured yet");
  check(declared?.provider === "connector", "...carrying what it is for");

  await refs.markConfigured(A, { name: "GMAIL_REFRESH_TOKEN" });
  check((await refs.get(A, "GMAIL_REFRESH_TOKEN"))?.configured === true, "setting a value marks it configured");
  check(
    (await refs.get(A, "GMAIL_REFRESH_TOKEN"))?.provider === "connector",
    "...without losing what the declaration said it was for",
  );

  await refs.declare(A, { name: "GMAIL_REFRESH_TOKEN", provider: "connector" });
  check(
    (await refs.get(A, "GMAIL_REFRESH_TOKEN"))?.configured === true,
    "declaring it again does not un-set it — the two facts arrive from different places",
  );

  await refs.markCleared(A, "GMAIL_REFRESH_TOKEN");
  const cleared = await refs.get(A, "GMAIL_REFRESH_TOKEN");
  check(cleared !== undefined, "clearing a value keeps the name, so the panel still shows what is needed");
  check(cleared?.configured === false, "...with an empty state beside it");
  check(cleared?.last_used_at === null, "...and no stale usage timestamp");

  await refs.forget(A, "GMAIL_REFRESH_TOKEN");
  check((await refs.get(A, "GMAIL_REFRESH_TOKEN")) === undefined, "and a declaration nothing needs can be forgotten");

  // --- scope ---------------------------------------------------------------------------
  console.log("\n  workspace-scoped and agent-scoped");
  const agent = await agents.upsertFromDisk(A, { slug: "support_bot" });
  await refs.declare(A, { name: "AGENT_ONLY_TOKEN", scope: "agent", agentId: agent.id });
  check((await refs.get(A, "AGENT_ONLY_TOKEN"))?.scope === "agent", "a credential can belong to one agent");
  check((await refs.get(A, "AGENT_ONLY_TOKEN"))?.agent_id === agent.id, "...naming which");

  let brokenScope = false;
  try {
    await refs.declare(A, { name: "BROKEN_SCOPE", scope: "agent", agentId: null });
  } catch {
    brokenScope = true;
  }
  check(brokenScope, "agent scope with no agent is refused by the schema, not by convention");

  // --- usage ---------------------------------------------------------------------------
  console.log("\n  when a run last received it");
  await refs.markConfigured(A, { name: "ANTHROPIC_API_KEY", provider: "anthropic" });
  check((await refs.get(A, "ANTHROPIC_API_KEY"))?.last_used_at === null, "a value nothing has read has no usage");
  await refs.touch(A.workspaceId, ["ANTHROPIC_API_KEY"]);
  check((await refs.get(A, "ANTHROPIC_API_KEY"))?.last_used_at !== null, "...and a run receiving it records when");

  // --- one workspace cannot see another's ------------------------------------------------
  console.log("\n  scoped, like everything else");
  await refs.markConfigured(B, { name: "B_ONLY_TOKEN", provider: "mcp" });
  check((await refs.get(A, "B_ONLY_TOKEN")) === undefined, "A cannot read B's ref by name");
  check((await refs.list(A)).every((r) => r.name !== "B_ONLY_TOKEN"), "...nor find it in a listing");
  await refs.markCleared(A, "B_ONLY_TOKEN");
  check((await refs.get(B, "B_ONLY_TOKEN"))?.configured === true, "...nor clear it");
  await refs.forget(A, "B_ONLY_TOKEN");
  check((await refs.get(B, "B_ONLY_TOKEN")) !== undefined, "...nor forget it");
  await refs.touch(A.workspaceId, ["B_ONLY_TOKEN"]);
  check((await refs.get(B, "B_ONLY_TOKEN"))?.last_used_at === null, "...nor touch it");

  // --- both stores answer identically ------------------------------------------------------
  console.log("\n  a client cannot tell which store answered");
  const envPath = join(tmpDir(), ".env");
  writeFileSync(envPath, "");
  const local: SecretStore = new DotEnvSecretStore({
    writer: fileCredentialWriter(envPath),
    envPath,
    refs,
    providerFor: () => "mcp",
  });
  const hosted: SecretStore = new KmsSecretStore({
    db,
    master: new LocalMasterKeyProvider(MASTER),
    refs,
    runWorkspace: async () => null,
    providerFor: () => "mcp",
  });

  const localWs = await newWorkspace(db, "local");
  const hostedWs = await newWorkspace(db, "hosted");
  await local.set(localWs, "JAROKU_MCP_SAME_TOKEN", "value-in-a-file");
  await hosted.set(hostedWs, "JAROKU_MCP_SAME_TOKEN", "value-in-a-table");

  const fromLocal = await local.listNames(localWs);
  const fromHosted = await hosted.listNames(hostedWs);
  check(
    JSON.stringify(fromLocal.map((s) => ({ ...s, lastUsedAt: null }))) ===
      JSON.stringify(fromHosted.map((s) => ({ ...s, lastUsedAt: null }))),
    "the two stores return the same shape and the same names",
    `${JSON.stringify(fromLocal)} vs ${JSON.stringify(fromHosted)}`,
  );
  check(
    !JSON.stringify([...fromLocal, ...fromHosted]).includes("value-in-a"),
    "and neither listing carries a value",
  );

  await local.delete(localWs, "JAROKU_MCP_SAME_TOKEN");
  check((await local.listNames(localWs)).length === 0, "deleting removes it from the local store's listing");
  check(
    (await refs.get(localWs, "JAROKU_MCP_SAME_TOKEN"))?.configured === false,
    "...by clearing the ref rather than dropping it",
  );
  await hosted.delete(hostedWs, "JAROKU_MCP_SAME_TOKEN");
  check((await hosted.listNames(hostedWs)).length === 0, "and the same for the hosted one");
}

const dir = tmpDir();
{
  const db = new SqliteDb(join(dir, "refs.db"));
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
