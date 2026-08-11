
// Where an agent's files may be read from, and where they may not.
//
// The regression this defends: `runtime/agents/<slug>/` is one namespace shared by every
// workspace, while a slug is unique PER workspace. Falling back to that directory for a
// workspace whose own version is empty handed it another tenant's generated source — through a
// lookup that had correctly found the caller's own row, which is what made it invisible.
//
//   npm run test:agent-files

import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrate } from "./db/migrate.ts";
import { SqliteDb } from "./db/sqlite.ts";
import { LOCAL_WORKSPACE_ID, newRequestId, systemContext, systemContextFor } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { AgentRepository } from "./db/repositories/agents.ts";
import { FsObjectStore } from "./storage/fsObjectStore.ts";
import { ProjectStore } from "./storage/projectStore.ts";
import { readAgentFiles, type AgentFilesDeps } from "./agentFiles.ts";

let failures = 0;
const check = (msg: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else { failures++; console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`); }
};

const dir = mkdtempSync(join(tmpdir(), "jaroku-agentfiles-"));
const db = new SqliteDb(join(dir, "a.db"));
await migrate(db.migrationTarget(), join(new URL("..", import.meta.url).pathname, "migrations", "sqlite"), () => {});
const agents = new AgentRepository(db);
const projects = new ProjectStore(new FsObjectStore({ root: join(dir, "objects"), signingKey: randomBytes(32) }), agents);
const identity = new IdentityRepository(db);

const SERVER = systemContextFor(LOCAL_WORKSPACE_ID, newRequestId());
const mk = async (n: string) => systemContextFor((await identity.createWorkspaceUnowned(systemContext(newRequestId()), { name: n })).id, newRequestId());
const A = await mk("A"); const B = await mk("B");

// The shared directory. A materialised `support_bot` here; B has a row of the same name and
// nothing published — the exact state a workspace that shares a slug is in.
const runtimeDir = join(dir, "runtime");
fs.mkdirSync(join(runtimeDir, "agents", "support_bot"), { recursive: true });
fs.writeFileSync(join(runtimeDir, "agents", "support_bot", "agent.py"), "# A SOURCE, MATERIALISED BY A\n");
fs.mkdirSync(join(runtimeDir, "agents", "hand_dropped"), { recursive: true });
fs.writeFileSync(join(runtimeDir, "agents", "hand_dropped", "agent.py"), "# dropped in by hand\n");

const deps: AgentFilesDeps = {
  runtimeDir, agents, projects,
  connectorFilesFor: () => [],
  serverWorkspaceId: () => SERVER.workspaceId,
};

const aAgent = await agents.upsertFromDisk(A, { slug: "support_bot" });
await projects.publish(A, aAgent.id, [{ path: "agent.py", content: "# A SOURCE, MATERIALISED BY A\n" }], { source: "import" });
await agents.upsertFromDisk(B, { slug: "support_bot" });

console.log("\nthe published version");
{
  const r = await readAgentFiles(deps, A, "support_bot");
  check("A reads its own version", r.source === "version" && r.files.some((f) => f.path === "agent.py"));
  check("...with its own bytes", r.files[0]!.content.includes("A SOURCE"));
}

console.log("\na row with nothing published");
{
  const r = await readAgentFiles(deps, B, "support_bot");
  check("B, who owns the slug but has published nothing, gets nothing", r.files.length === 0);
  check("...reported as nothing rather than as a version", r.source === "none");
  check(
    "...and NOT the directory A materialised, which has the same name",
    !r.files.some((f) => f.content.includes("A SOURCE")),
  );
}

console.log("\na hand-dropped directory with no row");
{
  const server = await readAgentFiles(deps, SERVER, "hand_dropped");
  check("the workspace this process acts in adopts it", server.source === "disk" && server.files.length > 0);
  const theirs = await readAgentFiles(deps, B, "hand_dropped");
  check("no other workspace can see it", theirs.files.length === 0 && theirs.source === "none");
}

console.log("\nan agent nobody has");
{
  const r = await readAgentFiles(deps, A, "does_not_exist");
  check("answers empty rather than throwing", r.files.length === 0 && r.source === "none");
}

await db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
