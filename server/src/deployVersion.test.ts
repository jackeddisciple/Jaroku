// A deployment names the version it actually serves.
//
// THE BUG. A deploy writes its Dockerfile and serve.py into the project and publishes that as a new
// version — and the deployment row named the version BEFORE it. So every deploy left its own
// deployment a version behind: straight after a successful deploy the Inbox said "Margot is serving
// v2, current is v3" and offered a Redeploy, which did the same thing again.
//
// And a redeploy of an unchanged agent minted an identical version on every press.
//
//   npm run test:deploy-version

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "./db/migrate.ts";
import { SqliteDb } from "./db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { AgentRepository } from "./db/repositories/agents.ts";
import { FsObjectStore } from "./storage/fsObjectStore.ts";
import { ProjectStore } from "./storage/projectStore.ts";
import { DeployStore } from "./deployStore.ts";
import { DeployManager } from "./deployManager.ts";

let fail = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else { fail++; console.log(`  FAIL ${msg}`); }
};

const MIGRATIONS = join(fileURLToPath(new URL("..", import.meta.url)), "migrations");
const scratch = mkdtempSync(join(tmpdir(), "jaroku-deploy-version-"));
const db = new SqliteDb(join(scratch, "db.sqlite"));
await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});
const identity = new IdentityRepository(db);
const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), { name: "deploy version" });
const ctx = systemContextFor(ws.id, newRequestId());
const agents = new AgentRepository(db);
const projects = new ProjectStore(new FsObjectStore({ root: join(scratch, "objects"), signingKey: randomBytes(32) }), agents);
const runtimeDir = join(scratch, "runtime");

const agent = await agents.upsertFromDisk(ctx, { slug: "margot" });
const AGENT_PY = "def build_graph(llm):\n    return None\n\n\ndef build_initial_state(user_input):\n    return {}\n\nTOOLS = []\n";
const published = await projects.publish(ctx, agent.id, [{ path: "agent.py", content: AGENT_PY }], { source: "generation" });
const dir = join(runtimeDir, "agents", "margot");
await projects.materialise(ctx, agent.id, published.version, dir);

const manager = new DeployManager({
  runtimeDir,
  store: new DeployStore(db),
  agents,
  projects,
  context: () => ctx,
  token: async () => null,
  agentBusy: () => false,
  onStage: () => {},
  onLog: () => {},
  onFinished: () => {},
} as never);
// Keyed by the deployment it belongs to, for that deploy's context; with none in flight it falls back.
const recordFor = (manager as unknown as { recordArtifacts(id: string, slug: string): Promise<number | null> }).recordArtifacts.bind(manager);
const record = (slug: string) => recordFor("deployment-under-test", slug);

console.log("\nthe version a deploy uploads");
{
  // What a deploy writes before it uploads.
  writeFileSync(join(dir, "Dockerfile"), "FROM python:3.12-slim\n");
  writeFileSync(join(dir, "serve.py"), "# the deployed entrypoint\n");
  const built = await record("margot");
  const row = await agents.bySlug(ctx, "margot");
  check(built !== null && built > published.version, `the artifacts are published as a newer version (v${built})`);
  check(row?.current_version === built, "...which is the agent's current version");

  const again = await record("margot");
  check(again === built, "a redeploy of the unchanged agent publishes nothing new, and names the same version");
  check((await agents.bySlug(ctx, "margot"))?.current_version === built, "...so the agent has not moved on without it");

  // AND THE DEPLOY WRITES THAT VERSION ON ITS ROW, rather than the one it started from.
  const source = readFileSync(fileURLToPath(new URL("./deployManager.ts", import.meta.url)), "utf8");
  check(/const built = await this\.recordArtifacts\(id, req\.agentId\);\s*if \(built !== null\) await this\.deps\.store\.patch\(this\.ctxOf\(id\), id, \{ version: built \}\)/.test(source),
    "the deployment row is given the version its upload was built from");
}

await db.close();
rmSync(scratch, { recursive: true, force: true });
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
