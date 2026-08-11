// An agent's files, as versions.
//
// The property under test is the one `renameSync` used to provide and cannot any more: a reader
// sees a whole project or the previous whole project, never a mixture, and it sees the same one
// from any replica. So the assertions are about atomicity, immutability and the pointer — not
// about whether a file round-trips, which the object conformance suite already covers.
//
// Runs against both drivers, and against the local object store. The store half is
// implementation-independent by construction: everything here goes through the ObjectStore
// interface, which `objects.test.ts` has already proven both implementations satisfy.
//
//   npm run test:project-store

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { SqliteDb } from "../db/sqlite.ts";
import { withScratchPostgres } from "../db/testDb.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { FsObjectStore } from "./fsObjectStore.ts";
import { agentVersionKey, agentVersionPrefix } from "./keys.ts";
import { filesFromDirectory, manifestFor, ProjectStore, sha256Of } from "./projectStore.ts";
import { ObjectNotFound } from "./objectStore.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const MIGRATIONS = join(fileURLToPath(new URL("../..", import.meta.url)), "migrations");
const scratch: string[] = [];
const tmpDir = (name: string): string => {
  const d = mkdtempSync(join(tmpdir(), `jaroku-${name}-`));
  scratch.push(d);
  return d;
};

const AGENT_PY = 'def build_graph(llm):\n    return None\n\n\ndef build_initial_state(user_input):\n    return {}\n';

async function newWorkspace(db: Db, label: string): Promise<TenantContext> {
  const identity = new IdentityRepository(db);
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `projects ${label} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

async function suite(label: string, db: Db): Promise<void> {
  console.log(`\n${label}`);
  const agents = new AgentRepository(db);
  const objects = new FsObjectStore({ root: tmpDir("objects"), signingKey: randomBytes(32) });
  const projects = new ProjectStore(objects, agents);

  const ctx = await newWorkspace(db, label);
  const other = await newWorkspace(db, `${label}-other`);
  const agent = await agents.upsertFromDisk(ctx, { slug: "support_bot", display_name: "Support" });

  // --- publishing ---------------------------------------------------------------------
  const v1 = await projects.publish(
    ctx,
    agent.id,
    [
      { path: "agent.py", content: AGENT_PY },
      { path: "jaroku.json", content: '{"agent_id":"support_bot"}\n' },
      { path: "tools/notes.py", content: "NOTES = []\n" },
    ],
    { source: "generation", summary: "first cut" },
  );
  check(v1.version === 2, `publish bumps past the row's starting version (v${v1.version})`);
  check(
    (await agents.bySlug(ctx, "support_bot"))!.current_version === v1.version,
    "...and moves current_version to it",
  );
  check(
    v1.manifest["agent.py"]!.sha256 === sha256Of(AGENT_PY),
    "the manifest carries a sha256 of each file, so a version verifies without a fetch",
  );
  check(
    v1.manifest["agent.py"]!.bytes === Buffer.byteLength(AGENT_PY, "utf8"),
    "...and its byte length, not its character count",
  );

  const read = await projects.readVersion(ctx, agent.id, v1.version);
  check(read.length === 3 && read[0]!.path === "agent.py", "a version reads back as its files, in manifest order");
  check(read.find((f) => f.path === "tools/notes.py")?.content === "NOTES = []\n", "...with their contents intact");

  const row = await agents.version(ctx, agent.id, v1.version);
  check(row?.source === "generation" && row.summary === "first cut", "the version row records what made it");
  check(row?.total_bytes === Object.values(v1.manifest).reduce((n, f) => n + f.bytes, 0), "...and how big it is");

  // --- immutability -------------------------------------------------------------------
  const v2 = await projects.publish(
    ctx,
    agent.id,
    [
      { path: "agent.py", content: `${AGENT_PY}# edited\n` },
      { path: "jaroku.json", content: '{"agent_id":"support_bot"}\n' },
      { path: "tools/notes.py", content: "NOTES = []\n" },
    ],
    { source: "edit", instruction: "add a comment", summary: "added a comment" },
  );
  check(v2.version === v1.version + 1, "a second publish is the next version");
  const stillV1 = await projects.readVersion(ctx, agent.id, v1.version);
  check(
    stillV1.find((f) => f.path === "agent.py")?.content === AGENT_PY,
    "...and the previous version's bytes are untouched — this is what makes undo a pointer move",
  );

  // --- undo is a pointer move ----------------------------------------------------------
  const undone = await agents.undoVersion(ctx, agent.id);
  check(undone?.from === v2.version && undone.to === v1.version, "undo moves current_version back one");
  check((await agents.bySlug(ctx, "support_bot"))!.current_version === v1.version, "...on the agent row");
  check(
    (await agents.version(ctx, agent.id, v2.version))?.undone_at !== null,
    "...and takes the version it left behind off the line",
  );
  check(
    (await agents.versions(ctx, agent.id)).every((v) => v.version !== v2.version),
    "...so the history list no longer offers it",
  );
  check(
    (await agents.versions(ctx, agent.id, true)).some((v) => v.version === v2.version),
    "...while it is still there for anything asking for everything",
  );
  check(
    (await projects.readVersion(ctx, agent.id, v2.version)).length === 3,
    "...and its objects were never deleted, so an undo is reversible by more than regenerating",
  );

  // A new edit after an undo lands ABOVE everything, not on top of the version it superseded.
  const v3 = await projects.publish(ctx, agent.id, [{ path: "agent.py", content: `${AGENT_PY}# again\n` }], {
    source: "edit",
  });
  check(v3.version === v2.version + 1, `a publish after an undo starts a fresh line (v${v3.version})`);
  check(
    (await projects.readVersion(ctx, agent.id, v2.version)).find((f) => f.path === "agent.py")?.content.includes("# edited") === true,
    "...without overwriting the undone version's objects",
  );

  const first = await agents.upsertFromDisk(ctx, { slug: "only_one" });
  await projects.publish(ctx, first.id, [{ path: "agent.py", content: AGENT_PY }], { source: "generation" });
  // `upsertFromDisk` starts an agent at current_version 1 with no row, and the publish above is
  // v2 — so there is exactly one version row and nothing behind it.
  check((await agents.undoVersion(ctx, first.id)) === null, "the first version cannot be undone — there is nothing behind it");

  // --- materialising ------------------------------------------------------------------
  const dest = tmpDir("materialise");
  const written = await projects.materialise(ctx, agent.id, v1.version, join(dest, "support_bot"));
  check(written.length === 3, "materialise writes every file of a version");
  check(
    readFileSync(join(dest, "support_bot", "tools", "notes.py"), "utf8") === "NOTES = []\n",
    "...into the right nested paths",
  );
  // A stale file from a previous materialisation must not survive into the next one, or the
  // validator imports code the version does not contain.
  await projects.materialise(ctx, agent.id, v3.version, join(dest, "support_bot"));
  check(!existsSync(join(dest, "support_bot", "tools", "notes.py")), "...and the destination is emptied first");

  // --- staging ------------------------------------------------------------------------
  const stagingId = randomUUID();
  await projects.putStaging(ctx, agent.id, stagingId, { path: "agent.py", content: "# staged\n" });
  await projects.putStaging(ctx, agent.id, stagingId, { path: "tools/x.py", content: "X = 1\n" });
  const staged = await projects.readStaging(ctx, agent.id, stagingId);
  check(staged.length === 2 && staged[0]!.path === "agent.py", "staging reads back what was streamed into it");
  check(
    (await agents.bySlug(ctx, "support_bot"))!.current_version === v3.version,
    "...without touching the live version, which is the whole point of staging",
  );

  const promoted = await projects.publishStaging(ctx, agent.id, stagingId, { source: "generation" });
  check(promoted.version === v3.version + 1, "publishing a staging copy makes it the next version");
  check((await projects.readStaging(ctx, agent.id, stagingId)).length === 0, "...and the staging copy is cleared");

  const discarded = randomUUID();
  await projects.putStaging(ctx, agent.id, discarded, { path: "agent.py", content: "# never applied\n" });
  check((await projects.discardStaging(ctx, agent.id, discarded)) === 1, "a discarded proposal leaves nothing behind");

  // --- the import bridge ---------------------------------------------------------------
  const legacy = await agents.upsertFromDisk(ctx, { slug: "handwritten" });
  const imported = await projects.importFromDirectory(ctx, legacy.id, legacy.current_version, [
    { path: "agent.py", content: AGENT_PY },
  ]);
  check(imported.imported, "an agent with no published version is imported from disk");
  check(
    (await agents.version(ctx, legacy.id, imported.version))?.source === "import",
    "...and labelled import rather than pretending to be a generation",
  );
  const second = await projects.importFromDirectory(ctx, legacy.id, imported.version, [
    { path: "agent.py", content: AGENT_PY },
  ]);
  check(!second.imported, "...and importing again is a no-op, so it can run at every boot");

  // --- one workspace cannot reach another's -------------------------------------------
  const theirs = await agents.upsertFromDisk(other, { slug: "support_bot" });
  await projects.publish(other, theirs.id, [{ path: "agent.py", content: "# theirs\n" }], { source: "generation" });
  check(theirs.id !== agent.id, "two workspaces may both have a support_bot, with different uuids");
  check(
    (await projects.readVersion(ctx, theirs.id, 2)).length === 0,
    "reading another workspace's agent by uuid answers nothing",
  );
  check((await agents.version(ctx, theirs.id, 2)) === undefined, "...because the version row is scoped through the agent");
  check((await agents.versions(ctx, theirs.id)).length === 0, "...and so is the version list");
  check((await agents.undoVersion(ctx, theirs.id)) === null, "...and undo refuses an agent in another workspace");
  check(
    (await agents.bySlug(other, "support_bot"))!.current_version === 2,
    "...leaving their pointer exactly where it was",
  );

  // The keys themselves, which is where a mistake would be invisible from the database side.
  const mineKey = agentVersionKey(ctx.workspaceId, agent.id, v1.version, "agent.py");
  check((await objects.head(mineKey)) !== null, "an agent's objects live under its own workspace's prefix");
  check(
    (await objects.list(agentVersionPrefix(other.workspaceId, agent.id, v1.version))).length === 0,
    "...and nothing of it exists under another workspace's",
  );

  // --- a manifest that outruns the objects ----------------------------------------------
  //
  // The manifest is the truth about what a version contains, so an object that is gone has to
  // be an error rather than a file that quietly disappears from a project.
  await objects.delete(agentVersionKey(ctx.workspaceId, agent.id, v1.version, "tools/notes.py"));
  let reportedMissing = false;
  try {
    await projects.readVersion(ctx, agent.id, v1.version);
  } catch (err) {
    reportedMissing = err instanceof ObjectNotFound;
  }
  check(reportedMissing, "a manifest naming an object that is gone reports it rather than returning a short project");

  // --- two publishes at once -------------------------------------------------------------
  //
  // The failure this defends against corrupted an agent outright. Both publishes predicted the
  // same version number, both wrote objects to it, and the loser — which had already bumped the
  // pointer — deleted the winner's objects on its way out, leaving `current_version` on a
  // version with no files.
  const racer = await agents.upsertFromDisk(ctx, { slug: "racer" });
  const raced = await Promise.allSettled([
    projects.publish(ctx, racer.id, [{ path: "agent.py", content: "# one\n" }], { source: "edit", summary: "one" }),
    projects.publish(ctx, racer.id, [{ path: "agent.py", content: "# two\n" }], { source: "edit", summary: "two" }),
  ]);
  check(raced.every((r) => r.status === "fulfilled"), "two concurrent publishes both succeed");
  const numbers = raced.map((r) => (r.status === "fulfilled" ? r.value.version : -1));
  check(new Set(numbers).size === 2, `...taking different version numbers (${numbers.join(", ")})`);

  const racedAgent = (await agents.bySlug(ctx, "racer"))!;
  check(numbers.includes(racedAgent.current_version), "the pointer is on one of them");
  const racedFiles = await projects.readVersion(ctx, racer.id, racedAgent.current_version);
  check(racedFiles.length === 1, "...and that version's objects are there");
  const racedRow = await agents.version(ctx, racer.id, racedAgent.current_version);
  check(
    racedFiles[0]!.content === `# ${racedRow!.summary}\n`,
    "...and are the ones its own manifest describes, not the other publish's",
  );
  // The loser is a complete version too — nothing deleted it, and nothing half-wrote it.
  for (const v of numbers) {
    check((await projects.readVersion(ctx, racer.id, v)).length === 1, `v${v} is readable in full`);
  }

  // --- refusing a path that should never be a key ---------------------------------------
  let refused = false;
  try {
    await projects.publish(ctx, agent.id, [{ path: "../../etc/passwd", content: "no" }], { source: "generation" });
  } catch {
    refused = true;
  }
  check(refused, "publishing a traversing path is refused before a single object is written");

  // --- a filename that is a javascript keyword ------------------------------------------
  //
  // `__proto__` is a legal filename and an illegal object key in the sense that matters here:
  // assigning to it on a plain `{}` sets a prototype instead of adding a property. The manifest
  // is a path-keyed object built from names a model chose, so the file would be written to the
  // store, left out of the manifest, and thus absent from the version that supposedly holds it.
  const trap = await agents.upsertFromDisk(ctx, { slug: "trap_bot", display_name: "Trap" });
  const trapped = await projects.publish(
    ctx,
    trap.id,
    [
      { path: "agent.py", content: AGENT_PY },
      { path: "__proto__", content: "# a file, not a prototype\n" },
      { path: "constructor", content: "# nor a constructor\n" },
      { path: "tools/__proto__.py", content: "# and not in a subdirectory either\n" },
    ],
    { source: "generation", summary: "booby-trapped names" },
  );
  check(Object.keys(trapped.manifest).length === 4, `every name reaches the manifest (${Object.keys(trapped.manifest).length})`);
  const trapRead = await projects.readVersion(ctx, trap.id, trapped.version);
  check(
    trapRead.map((f) => f.path).join(",") === "__proto__,agent.py,constructor,tools/__proto__.py",
    "...and survives the round trip through the database's json",
  );
  check(
    trapRead.find((f) => f.path === "__proto__")?.content === "# a file, not a prototype\n",
    "...as a file with its own bytes",
  );
}

// --- the disk half ---------------------------------------------------------------------
console.log("\nreading a directory");
{
  const dir = tmpDir("disk");
  const projectDir = join(dir, "proj");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(projectDir, "tools"), { recursive: true });
  writeFileSync(join(projectDir, "agent.py"), AGENT_PY);
  writeFileSync(join(projectDir, "tools", "notes.py"), "NOTES = []\n");

  const files = filesFromDirectory(projectDir, ["agent.py", "tools/notes.py", "gone.py"]);
  check(files.length === 2, "a file that vanished between the listing and the read is skipped, not fatal");
  check(files[0]!.path === "agent.py" && files[1]!.path === "tools/notes.py", "...and the rest come back sorted, posix-style");

  const hostile = filesFromDirectory(projectDir, ["../../../etc/passwd"]);
  check(hostile.length === 0, "a traversing path is refused on the way in as well as on the way out");

  const manifest = manifestFor(files);
  check(Object.keys(manifest).length === 2, "the manifest covers every file");
  check(manifest["agent.py"]!.sha256 === sha256Of(AGENT_PY), "...with one hash function, computed one way");
}

// --- run it ------------------------------------------------------------------------------
const tmp = tmpDir("db");
{
  const db = new SqliteDb(join(tmp, "projects.db"));
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
