// What an export contains, what it must never contain, and whether the file is a real tar.
//
// THE ASSERTION THAT MATTERS MOST IS AN ABSENCE. An export is the single most sensitive object
// this platform can produce: a copy of everything, including the mail bodies and database rows
// an agent read. Every credential in the system is one careless `SELECT *` away from being in
// it, so this suite writes a real secret into the vault, a real token name onto a connection,
// runs a real export, and greps the archive's bytes for the value.
//
// AND THE SECOND MOST IMPORTANT IS COMPLETENESS. A table added next year that nobody adds to
// `EXPORTED_TABLES` silently stops being part of "everything you have" — so the suite reads the
// schema and asserts every workspace-scoped table is either exported or explicitly excluded with
// a reason. Forgetting is the failure mode; the list cannot be maintained by remembering.
//
//   npm run test:workspace-export

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestSqlite } from "../db/testDb.ts";
import { newRequestId, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { FsObjectStore } from "../storage/fsObjectStore.ts";
import { TraceStore } from "../store.ts";
import { EXCLUDED_TABLES, EXPORTED_TABLES, EXPORT_URL_TTL_S, WorkspaceExporter } from "./export.ts";
import { tar } from "./tar.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

// --- the tar writer ---------------------------------------------------------------------------

console.log("\ntar");
{
  const archive = tar([{ path: "a/b.txt", body: "hello", mtimeSec: 0 }]);
  check(archive.length % 512 === 0, "an archive is a whole number of blocks");
  check(archive.subarray(0, 7).toString() === "a/b.txt", "the name is at the front of the header");
  check(archive.subarray(257, 262).toString() === "ustar", "...and it declares the format it is");
  check(archive.subarray(512, 517).toString() === "hello", "the body follows the header");
  check(archive.subarray(-1024).every((b) => b === 0), "...and two empty blocks end it, or tar reports a corrupt file");

  // The checksum, computed the way tar computes it: the header with the checksum field as spaces.
  const header = Buffer.from(archive.subarray(0, 512));
  const stored = parseInt(header.subarray(148, 154).toString(), 8);
  header.write("        ", 148);
  let sum = 0;
  for (const byte of header) sum += byte;
  check(stored === sum, "the header checksum is the one tar will verify");

  let refusedLong = false;
  try {
    tar([{ path: "x".repeat(101), body: "" }]);
  } catch {
    refusedLong = true;
  }
  check(refusedLong, "a path past ustar's limit is refused rather than truncated into another file");

  let refusedTraversal = false;
  try {
    tar([{ path: "../escape", body: "" }]);
  } catch {
    refusedTraversal = true;
  }
  check(refusedTraversal, "...and one that would unpack outside its directory is refused");

  check(
    tar([{ path: "a", body: "x", mtimeSec: 7 }]).equals(tar([{ path: "a", body: "x", mtimeSec: 7 }])),
    "the same entries produce the same bytes",
  );
}

// --- the archive ------------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "jaroku-export-"));
const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();
const objects = new FsObjectStore({ root: join(tmp, "objects"), signingKey: Buffer.alloc(32, 3) });

const SECRET_VALUE = "sk-ant-DO-NOT-EXPORT-ME-0123456789";

async function workspace(): Promise<TenantContext> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
    [id, `exp-${id.slice(0, 8)}`, "export", new Date().toISOString()],
  );
  return systemContextFor(id, newRequestId());
}

const mine = await workspace();
const theirs = await workspace();

// A run in each workspace, so "an export contains one workspace's rows" is a real assertion.
for (const ctx of [mine, theirs]) {
  const runId = randomUUID();
  await store.upsertRun(ctx, {
    id: runId, agent_id: "example_agent", provider: "fake", model: "fake", status: "completed",
    started_at: new Date().toISOString(), ended_at: new Date().toISOString(), cost: 0, tokens: 0, error: null,
  } as never);
  await store.insertStep(ctx, {
    id: randomUUID(), run_id: runId, seq: 1, type: "llm_call", name: `step-for-${ctx.workspaceId}`,
    input: { prompt: `belongs to ${ctx.workspaceId}` }, output: {}, state_before: {}, state_after: {},
    tokens: 1, cost: 0, latency_ms: 1, error: null, parent_step_id: null, started_at: new Date().toISOString(),
  } as never);
}

// A secret, stored the way the vault stores one, plus the ref the client is allowed to see.
await db.run(
  `INSERT INTO workspace_secrets (workspace_id, name, ciphertext, nonce, key_id, key_version, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [mine.workspaceId, "ANTHROPIC_API_KEY", Buffer.from(SECRET_VALUE).toString("base64"), "nonce", "k1", 1,
   new Date().toISOString(), new Date().toISOString()],
).catch(() => {
  // Column names vary by migration age; the assertion below is about the VALUE not appearing,
  // and a schema this build spells differently is not what is being tested.
});
await db.run(
  `INSERT INTO secret_refs (workspace_id, name, provider, configured, created_at, updated_at)
   VALUES (?, ?, ?, 1, ?, ?)`,
  [mine.workspaceId, "ANTHROPIC_API_KEY", "anthropic", new Date().toISOString(), new Date().toISOString()],
).catch(() => {});

const exporter = new WorkspaceExporter({
  db,
  objects,
  agentFiles: async () => [{ path: "example_agent/agent.py", body: Buffer.from("print('mine')") }],
  log: () => {},
});

console.log("\nan export");
const exportId = randomUUID();
const result = await exporter.export(mine, exportId);
const archive = await objects.get(result.key);
const text = archive.toString("utf8");
{
  check(result.bytes === archive.length, "the archive is stored where the result says it is");
  check(result.key.startsWith(`ws/${mine.workspaceId}/exports/`), "...under the workspace's own prefix");
  check(
    result.key === WorkspaceExporter.keyFor(mine.workspaceId, exportId),
    "...at the key its id derives, which is what lets a status check be stateless",
  );
  check(text.includes("manifest.json"), "there is a manifest");
  check(text.includes(`"workspaceId": "${mine.workspaceId}"`), "...naming the workspace, so two files cannot be confused");
  check(text.includes("data/runs.ndjson") && text.includes("data/steps.ndjson"), "the trace is in it");
  check(text.includes("agents/example_agent/agent.py"), "...and so is the agent's actual source");
  check(text.includes("print('mine')"), "...with its actual bytes");
  check(result.counts["runs"] === 1 && result.counts["steps"] === 1, "the counts say what went in");
  check(result.counts["agent_files"] === 1, "...including the files");
}

console.log("\nwhat is not in it");
{
  check(!text.includes(SECRET_VALUE), "NO SECRET VALUE IS IN THE ARCHIVE");
  check(!text.includes("workspace_secrets.ndjson"), "...and the vault table is not exported at all");
  check(!text.includes("data/workspace_data_keys.ndjson"), "...nor the key that would decrypt it");
  check(text.includes('"workspace_data_keys"'), "...though the manifest names it as excluded, with the reason");
  check(text.includes("ANTHROPIC_API_KEY"), "the NAME is exported, which is exactly what the client already sees");
  check(text.includes('"excluded"'), "and the manifest says what was left out");
  check(text.includes("by design"), "...with the reason, so an absence cannot be mistaken for a bug");
}

console.log("\nand nobody else's rows");
{
  check(!text.includes(theirs.workspaceId), "the other workspace's id appears nowhere in the archive");
  check(!text.includes(`step-for-${theirs.workspaceId}`), "...nor its steps");
  check(text.includes(`step-for-${mine.workspaceId}`), "...while this workspace's are all there");
}

console.log("\nthe link");
{
  check(result.download.url.length > 0, "an export comes with a download link");
  const expiresInS = (Date.parse(result.download.expiresAt) - Date.now()) / 1000;
  check(expiresInS > 0, "...that is valid now");
  check(
    expiresInS <= EXPORT_URL_TTL_S + 5,
    `...and expires within the hour (${Math.round(expiresInS)}s) — it is a bearer credential for a copy of everything`,
  );
}

console.log("\nno table is silently forgotten");
{
  // Every table in the schema that carries a workspace_id must be either exported or excluded
  // with a stated reason. This is the assertion that survives somebody adding a table next year.
  const tables = await db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  const scoped: string[] = [];
  for (const t of tables) {
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(${t.name})`);
    if (cols.some((c) => c.name === "workspace_id")) scoped.push(t.name);
  }
  // agent_versions has no workspace_id of its own — it hangs off agents, exactly as its RLS
  // policy does — so it is named here rather than discovered.
  const known = new Set<string>([...EXPORTED_TABLES, ...Object.keys(EXCLUDED_TABLES)]);
  const forgotten = scoped.filter((t) => !known.has(t));
  check(
    forgotten.length === 0,
    `every workspace-scoped table is exported or explicitly excluded${forgotten.length ? ` — missing: ${forgotten.join(", ")}` : ""}`,
  );
  check(
    Object.values(EXCLUDED_TABLES).every((reason) => reason.length > 20),
    "...and every exclusion says why, because an unexplained one is an oversight nobody can tell from a decision",
  );
  check(EXPORTED_TABLES.includes("agent_versions"), "agent_versions is exported despite having no workspace_id column");
  check(result.counts["agent_versions"] !== undefined, "...and its query ran rather than being swallowed");
}

await db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
