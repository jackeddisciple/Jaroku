// The read-only set, re-verified against the layout files actually live in now.
//
// This suite exists because the block list was written when a project was a directory and is
// now checked against object paths, and a block list that matches nothing is indistinguishable
// from one that is working. The spec is explicit about it: re-test, do not assume.
//
// What could go wrong, and does not:
//
//   * A PLATFORM SEPARATOR IN AN ENTRY. `tools/mcp_bridge.py` used to be assembled with
//     `join`, which yields a backslash on Windows — matching the local paths that platform
//     produces and matching nothing at all in the object store, whose keys are always
//     `/`-separated. The bridge is what honours an agent's entire MCP grant, so the one file
//     the list most needs to cover is the one that would have silently dropped out of it.
//
//   * A FILE THE LIST NAMES THAT NO PROJECT CONTAINS. An entry that never matches a real path
//     is a rule protecting nothing. So the list is checked against a REAL published version of
//     a REAL generated project rather than against a hand-written array of names.
//
//   * A CONNECTOR THE CATALOGUE HAS AND THE LIST DOES NOT. The block covers every filename in
//     the catalogue, installed or not, so a model cannot introduce a file masquerading as a
//     reviewed template. That property is only true while the two lists agree.
//
//   * THE DEPLOY ARTIFACTS. Blocked before they exist, and — since a deploy now publishes
//     them as a version — present in the version once one has run, which is what makes
//     blocking them mean anything.
//
//   npm run test:read-only

import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { migrate } from "./db/migrate.ts";
import { SqliteDb } from "./db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { AgentRepository } from "./db/repositories/agents.ts";
import { FsObjectStore } from "./storage/fsObjectStore.ts";
import { ProjectStore } from "./storage/projectStore.ts";
import { safeObjectPath } from "./storage/keys.ts";
import { Generator } from "./generator.ts";
import { DEPLOY_ARTIFACTS, hostOwnedPaths, readOnlyPaths } from "./projectFs.ts";
import { loadConnectors } from "./connectors.ts";
import { writeDeployArtifacts } from "./deployArtifacts.ts";
import { BRIDGE_FILE, MANIFEST_FILE } from "./mcpManifest.ts";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_DIR = resolve(SERVER_DIR, "..", "runtime");

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const scratch: string[] = [];
const tmpDir = (name: string): string => {
  const d = mkdtempSync(join(tmpdir(), `jaroku-${name}-`));
  scratch.push(d);
  return d;
};

// --- 1. the entries themselves are object paths --------------------------------------------
console.log("\nthe block list is spelled in object paths");
{
  const entries = hostOwnedPaths();
  check(entries.length > 0, `there are entries at all (${entries.length})`);
  check(
    entries.every((p) => !p.includes("\\")),
    "no entry contains a backslash, which no object key can",
    entries.filter((p) => p.includes("\\")).join(", "),
  );
  check(
    entries.every((p) => safeObjectPath(p) === p),
    "every entry is a path the key builder would accept unchanged",
    entries.filter((p) => safeObjectPath(p) !== p).join(", "),
  );
  check(entries.includes(BRIDGE_FILE), `the MCP bridge is covered (${BRIDGE_FILE})`);
  check(entries.includes(MANIFEST_FILE), `the MCP manifest is covered (${MANIFEST_FILE})`);
  check(entries.includes("jaroku.json") && entries.includes("__init__.py"), "and the host-owned metadata and package marker");
  check([...DEPLOY_ARTIFACTS].every((p) => entries.includes(p)), "and all four deploy artifacts");

  // The nastier half: near-misses must NOT be covered, or the list would be refusing files a
  // model is entitled to write.
  const set = readOnlyPaths([]);
  check(!set.has("tools/notes.py"), "a bespoke tool is not read-only");
  check(!set.has("prompts/system.md"), "nor is the system prompt");
  check(!set.has("tools/mcp_bridge_helper.py"), "nor is a file whose name merely starts the same");
}

// --- 2. every connector in the catalogue is covered ------------------------------------------
console.log("\nevery connector filename, installed or not");
{
  const catalogue = loadConnectors(RUNTIME_DIR);
  check(catalogue.length > 0, `the catalogue loads (${catalogue.length} connectors)`);
  const blocked = readOnlyPaths(catalogue.map((c) => `tools/${c.file}`));
  const missing = catalogue.filter((c) => !blocked.has(`tools/${c.file}`));
  check(missing.length === 0, "the block list covers every catalogue filename", missing.map((c) => c.file).join(", "));
  check(
    catalogue.every((c) => safeObjectPath(`tools/${c.file}`) === `tools/${c.file}`),
    "...and each of them is a legal object path",
  );
}

// --- 3. against a real published version -----------------------------------------------------
console.log("\nagainst a project that actually exists");
{
  const db = new SqliteDb(join(tmpDir("db"), "readonly.db"));
  await migrate(db.migrationTarget(), join(SERVER_DIR, "migrations", "sqlite"), () => {});
  const agents = new AgentRepository(db);
  const objects = new FsObjectStore({ root: tmpDir("objects"), signingKey: randomBytes(32) });
  const projects = new ProjectStore(objects, agents);

  const runtimeDir = tmpDir("runtime");
  fs.mkdirSync(join(runtimeDir, "agents"), { recursive: true });
  for (const name of ["tool_templates", "jaroku_runner", "jaroku_interceptor", "pyproject.toml", ".python-version", "uv.lock", ".venv"]) {
    if (existsSync(join(RUNTIME_DIR, name))) fs.symlinkSync(join(RUNTIME_DIR, name), join(runtimeDir, name));
  }

  const identity = new IdentityRepository(db);
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), { name: `read-only ${randomUUID().slice(0, 6)}` });
  const ctx = systemContextFor(ws.id, newRequestId());

  const generator = new Generator({ runtimeDir, agents, projects });
  process.env.JAROKU_GEN_FIXTURE = join(SERVER_DIR, "fixtures", "support_bot.txt");
  const generated = await new Promise<string | null>((done) => {
    generator.once("done", () => done(null));
    generator.once("error", (e) => done(e.message));
    void generator.generate({ runtimeDir, ctx, prompt: "support bot", connectors: ["postgres"], name: "Support Bot" });
  });
  delete process.env.JAROKU_GEN_FIXTURE;
  check(generated === null, "a real project is generated to check against", generated ?? "");

  const agent = (await agents.bySlug(ctx, "support_bot"))!;
  const files = await projects.readVersion(ctx, agent.id, agent.current_version);
  const paths = new Set(files.map((f) => f.path));
  const blocked = readOnlyPaths(loadConnectors(runtimeDir).map((c) => `tools/${c.file}`));

  // The point of the whole suite: the rule matches the paths a version actually holds.
  const covered = [...paths].filter((p) => blocked.has(p));
  check(covered.includes("jaroku.json"), "jaroku.json in the version is matched by the rule");
  check(covered.includes("__init__.py"), "...and the package marker");
  check(covered.includes("tools/postgres.py"), "...and the installed connector template");
  check(
    files.some((f) => f.path === "agent.py") && !blocked.has("agent.py"),
    "...while agent.py, which an edit must be able to rewrite, is not",
  );

  // Everything the rule names that the project does not have. Legitimate for the deploy
  // artifacts and the MCP pair — those are blocked BEFORE they exist, on purpose — and a bug
  // for anything else, which would be a rule protecting a file nothing ever writes.
  const namedButAbsent = hostOwnedPaths().filter((p) => !paths.has(p));
  const expectedAbsent = new Set([...DEPLOY_ARTIFACTS, MANIFEST_FILE, BRIDGE_FILE]);
  check(
    namedButAbsent.every((p) => expectedAbsent.has(p)),
    "every entry the project lacks is one that is blocked before it exists",
    namedButAbsent.filter((p) => !expectedAbsent.has(p)).join(", "),
  );

  // --- 4. a deploy's artifacts become part of the version -----------------------------------
  console.log("\nafter a deploy has written its artifacts");
  writeDeployArtifacts({ runtimeDir, agentId: "support_bot", provider: "anthropic" });
  const onDisk = [...DEPLOY_ARTIFACTS].filter((p) => existsSync(join(runtimeDir, "agents", "support_bot", p)));
  check(onDisk.length === DEPLOY_ARTIFACTS.size, `the four artifacts are written locally (${onDisk.length})`);

  // The deploy manager publishes them; here the same publish is made directly, because this
  // suite is about the block list rather than about Railway.
  const { filesFromDirectory } = await import("./storage/projectStore.ts");
  const { listProjectFiles } = await import("./projectFs.ts");
  const dir = join(runtimeDir, "agents", "support_bot");
  await projects.publish(
    ctx,
    agent.id,
    filesFromDirectory(dir, listProjectFiles(dir, ["tools/postgres.py"]).map((f) => f.path)),
    { source: "deploy", summary: "deploy artifacts" },
  );

  const after = await agents.bySlug(ctx, "support_bot");
  const deployed = new Set((await projects.readVersion(ctx, agent.id, after!.current_version)).map((f) => f.path));
  check(
    [...DEPLOY_ARTIFACTS].every((p) => deployed.has(p)),
    "...and are part of the version afterwards, which is what makes blocking them mean something",
    [...DEPLOY_ARTIFACTS].filter((p) => !deployed.has(p)).join(", "),
  );
  check(
    [...DEPLOY_ARTIFACTS].every((p) => blocked.has(p)),
    "...while still being refused to an edit",
  );
  check(deployed.has("agent.py"), "...and the agent's own code came along unchanged");

  await db.close();
}

for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
