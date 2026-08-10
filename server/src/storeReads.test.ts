// Reading an agent's code from the object store rather than from a disk.
//
// The claim this suite exists to check is one sentence: a replica that has never run an agent,
// and has nothing of it on disk, answers the graph view and the validator identically to the one
// that generated it. So it generates a project, DELETES the local copy, and then asks both.
//
// Deleting the copy is the whole method. Every one of these paths would pass against a directory
// that happened to still be there, which is exactly how a hosted regression hides until the
// second replica gets the request.
//
// WHAT THIS DOES NOT CLAIM. The Python still runs on the control plane — building a compiled
// graph imports model-written code, and routing the FILES through an object store does not make
// executing them here safe. Session 4 moves both into a sandbox. What is done now is the file
// access, so that when they move, the call sites do not change.
//
//   npm run test:store-reads

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
import { Generator } from "./generator.ts";
import { introspectGraph } from "./graphIntrospect.ts";
import { validateProject } from "./validator.ts";

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

function isolatedRuntime(): string {
  const dir = tmpDir("runtime");
  fs.mkdirSync(join(dir, "agents"), { recursive: true });
  for (const name of ["tool_templates", "jaroku_runner", "jaroku_interceptor", "pyproject.toml", ".python-version", "uv.lock", ".venv"]) {
    if (existsSync(join(RUNTIME_DIR, name))) fs.symlinkSync(join(RUNTIME_DIR, name), join(dir, name));
  }
  return dir;
}

const db = new SqliteDb(join(tmpDir("db"), "store-reads.db"));
await migrate(db.migrationTarget(), join(SERVER_DIR, "migrations", "sqlite"), () => {});

const agents = new AgentRepository(db);
const objects = new FsObjectStore({ root: tmpDir("objects"), signingKey: randomBytes(32) });
const projects = new ProjectStore(objects, agents);
const runtimeDir = isolatedRuntime();

const identity = new IdentityRepository(db);
const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), { name: `reads ${randomUUID().slice(0, 6)}` });
const ctx = systemContextFor(ws.id, newRequestId());

// A real generated project, off the recorded fixture.
const generator = new Generator({ runtimeDir, agents, projects });
process.env.JAROKU_GEN_FIXTURE = join(SERVER_DIR, "fixtures", "support_bot.txt");
const generated = await new Promise<string | null>((done) => {
  generator.once("done", () => done(null));
  generator.once("error", (e) => done(e.message));
  void generator.generate({ runtimeDir, ctx, prompt: "support bot", connectors: ["postgres"], name: "Support Bot" });
});
delete process.env.JAROKU_GEN_FIXTURE;

if (generated !== null) {
  console.log(`  FAIL could not generate the agent under test — ${generated}`);
  failures++;
} else {
  const agent = (await agents.bySlug(ctx, "support_bot"))!;
  const localCopy = join(runtimeDir, "agents", "support_bot");

  // --- 1. with the local copy, as a baseline -----------------------------------------------
  console.log("\nwith a local copy on disk");
  const withDisk = await introspectGraph(runtimeDir, "support_bot");
  check(!withDisk.error, "the graph view reads the topology", withDisk.error);
  check((withDisk.nodes ?? []).length > 0, `...with nodes (${(withDisk.nodes ?? []).length})`);

  // --- 2. the replica that has never seen it -----------------------------------------------
  //
  // Deleting the directory is what makes this a real test rather than a coincidence.
  console.log("\nwith nothing on disk at all");
  rmSync(localCopy, { recursive: true, force: true });
  check(!existsSync(localCopy), "the local copy is gone");

  const blind = await introspectGraph(runtimeDir, "support_bot");
  check(
    Boolean(blind.error),
    "...so reading it from the directory fails, which is the situation a second replica is in",
    JSON.stringify(blind).slice(0, 120),
  );

  const materialised = join(tmpDir("materialised"), "support_bot");
  const written = await projects.materialise(ctx, agent.id, agent.current_version, materialised);
  check(written.includes("agent.py"), "the version materialises out of the object store");
  check(written.includes("tools/postgres.py"), "...with its connector template");

  const fromStore = await introspectGraph(runtimeDir, "support_bot", materialised);
  check(!fromStore.error, "and the graph view reads the topology from there", fromStore.error);
  check(
    JSON.stringify(fromStore.nodes) === JSON.stringify(withDisk.nodes),
    "...node for node identical to what the disk produced",
    `${JSON.stringify(fromStore.nodes)} vs ${JSON.stringify(withDisk.nodes)}`,
  );
  check(
    JSON.stringify(fromStore.edges) === JSON.stringify(withDisk.edges),
    "...and edge for edge",
  );

  // --- 3. the validator, from the same place ------------------------------------------------
  console.log("\nvalidating a project that only exists as objects");
  const result = await validateProject(materialised, {
    runtimeDir,
    connectorFiles: ["tools/postgres.py"],
    connectorToolNames: ["pg_query"],
    requireToolErrorHandling: true,
  });
  check(result.ok, "a version materialised out of the store validates", result.problems.join(" | "));

  // The import check is the part that actually executes the project, and it is the one that
  // would quietly pass on a stale directory — so it is checked against a DELIBERATELY broken
  // materialisation, to prove it is reading these bytes and not somebody's leftovers.
  const broken = join(tmpDir("broken"), "support_bot");
  await projects.materialise(ctx, agent.id, agent.current_version, broken);
  fs.writeFileSync(join(broken, "agent.py"), "def build_graph(llm):\n    import nonexistent_module_xyz\n");
  const brokenResult = await validateProject(broken, {
    runtimeDir,
    connectorFiles: ["tools/postgres.py"],
    connectorToolNames: ["pg_query"],
  });
  check(!brokenResult.ok, "...and a broken one is rejected, so the check is reading these bytes");
  check(
    brokenResult.problems.some((p) => /build_initial_state|import/.test(p)),
    "...naming what is wrong with them",
    brokenResult.problems.join(" | "),
  );

  // --- 4. the runner resolves the directory it was given -------------------------------------
  //
  // `JAROKU_AGENT_DIR` is what the two above rest on, and it has to import the project under
  // the package name it would have had — a project whose modules import each other relatively
  // breaks otherwise, and this fixture has a `tools/` package that does exactly that.
  console.log("\nJAROKU_AGENT_DIR");
  check(
    (await projects.readVersion(ctx, agent.id, agent.current_version)).some((f) => f.path.startsWith("tools/")),
    "the fixture project has a tools package, which is what makes relative imports load-bearing",
  );
  const elsewhere = join(tmpDir("elsewhere"), "a-directory-not-named-after-the-agent");
  await projects.materialise(ctx, agent.id, agent.current_version, elsewhere);
  const renamed = await introspectGraph(runtimeDir, "support_bot", elsewhere);
  check(
    !renamed.error,
    "a project materialised into a directory with an unrelated name still imports",
    renamed.error,
  );
}

await db.close();
for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
