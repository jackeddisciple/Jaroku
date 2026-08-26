
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
import { fileURLToPath } from "node:url";

import { migrate } from "./db/migrate.ts";
import { SqliteDb } from "./db/sqlite.ts";
import { LOCAL_WORKSPACE_ID, newRequestId, systemContext, systemContextFor } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { AgentRepository } from "./db/repositories/agents.ts";
import { FsObjectStore } from "./storage/fsObjectStore.ts";
import { ProjectStore } from "./storage/projectStore.ts";
import { readAgentFiles, slugsOwnedElsewhere, type AgentFilesDeps } from "./agentFiles.ts";

let failures = 0;
const check = (msg: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else { failures++; console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`); }
};

const dir = mkdtempSync(join(tmpdir(), "jaroku-agentfiles-"));
const db = new SqliteDb(join(dir, "a.db"));
await migrate(db.migrationTarget(), join(fileURLToPath(new URL("..", import.meta.url)), "migrations", "sqlite"), () => {});
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
  ownedElsewhere: async (slug) => (await slugsOwnedElsewhere({ agents, identity }, SERVER.workspaceId)).has(slug),
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

// The boot reconciliation, and the same assumption from the other side. `syncFromDisk` used to
// read an absent directory as "this agent is gone" — true when the directory WAS the agent, and
// catastrophic now: a replica that never materialised anything, or a cleaned runtime directory,
// soft-deleted the whole workspace on startup while every version sat intact in the store.
console.log("\nreconciling against a disk that holds nothing");
{
  const published = await agents.bySlug(A, "support_bot");
  check("the agent has a version behind it", (published?.current_version ?? 0) > 1);

  const mirrored = await agents.upsertFromDisk(A, { slug: "mirror_only" });
  check("...and a second agent has none", (await agents.versions(A, mirrored.id)).length === 0);

  const after = await agents.syncFromDisk(A, []);
  check(
    "a published agent survives a sync that saw no directories at all",
    (await agents.bySlug(A, "support_bot")) !== undefined,
  );
  check(
    "...while a row the disk alone created is still swept",
    (await agents.bySlug(A, "mirror_only")) === undefined,
  );
  check(`...and that is what the sync returns (${after.map((a) => a.slug).join(", ")})`, after.length === 1 && after[0]!.slug === "support_bot");

  // And it still reads back — the point of not deleting it is that the files are elsewhere.
  const files = await readAgentFiles(deps, A, "support_bot");
  check("...with its files still readable from the store", files.source === "version" && files.files.length > 0);
}

// The adoption half. The boot scan runs as the workspace this process acts in and takes every
// directory it finds — including the ones A and B materialised, whose metadata and, once the row
// exists, whose source would become the local workspace's to read.
console.log("\nwhich directories the boot scan may adopt");
{
  const elsewhere = await slugsOwnedElsewhere({ agents, identity }, SERVER.workspaceId);
  check("a slug another workspace owns is named", elsewhere.has("support_bot"));
  check("...and a directory nobody has a row for is not", !elsewhere.has("hand_dropped"));

  const scanned = ["support_bot", "hand_dropped"].filter((slug) => !elsewhere.has(slug));
  check(`...so the scan adopts only the unclaimed one (${scanned.join(", ") || "none"})`, scanned.join(",") === "hand_dropped");

  await agents.syncFromDisk(SERVER, scanned.map((slug) => ({ slug })));
  check("the local workspace gets the hand-dropped agent", (await agents.bySlug(SERVER, "hand_dropped")) !== undefined);
  check("...and not the one A owns", (await agents.bySlug(SERVER, "support_bot")) === undefined);
  check("...whose own row is untouched", (await agents.bySlug(A, "support_bot")) !== undefined);

  // The consequence that made it worth fixing: without a row of its own, the local workspace
  // cannot reach A's materialised directory through the file read either.
  const leaked = await readAgentFiles(deps, SERVER, "support_bot");
  check("...so A's materialised source stays unreadable here", leaked.files.length === 0 && leaked.source === "none");
}

// ---------------------------------------------------------------------------------------------
// `runnable` — WHICH SOURCE ANSWERS "DOES THIS PROJECT HAVE AN agent.py".
//
// The comment above the derivation already gave the right answer — "which the version manifest
// answers for a published agent and the disk answers for one somebody dropped in by hand" — and
// the code asked the disk both times. So an agent published to the object store with no local
// directory reported `runnable: false` on every replica but the one that generated it, which is a
// fork, a restore elsewhere, a restored backup, and every hosted deployment with an ephemeral
// filesystem. The message it produced is the worst available: "it has no agent.py" is a statement
// about a filesystem the user cannot see, on a product whose whole model is that an agent is a
// versioned artifact in a store, and there was no recovery action anywhere.
//
// This file is the right home because it is the module that argues, at length, that the shared
// directory is not a valid source of truth for a workspace's own agent — and `runnable` was
// derived from exactly that directory.
// ---------------------------------------------------------------------------------------------
console.log("\nrunnable is answered by the manifest, and by the disk only for what it alone knows");
{
  const published = await agents.currentVersionHas(A, "agent.py");
  check("an agent published to the store is runnable with no directory here", published.has("support_bot"));

  // B owns the same slug and has published nothing. The DIRECTORY exists — A materialised it —
  // which is precisely the case where a disk-derived answer would hand B a truth about A's files.
  const theirs = await agents.currentVersionHas(B, "agent.py");
  check("...and a workspace with a row and no version is not", !theirs.has("support_bot"));

  // A published version WITHOUT an agent.py is not runnable either. Everything else about it is a
  // normal agent — a row, a version, a manifest, a byte total — and only the manifest's contents
  // distinguish it.
  const libAgent = await agents.upsertFromDisk(A, { slug: "helpers_only" });
  await projects.publish(A, libAgent.id, [{ path: "tools/notes.py", content: "NOTES = []\n" }], { source: "import" });
  const after = await agents.currentVersionHas(A, "agent.py");
  check("a published version with no agent.py is not runnable", !after.has("helpers_only"));
  check("...while the one beside it still is", after.has("support_bot"));

  // ONE QUERY FOR THE WORKSPACE. `test:agent-grid`'s load-bearing assertion is that the statement
  // count for one agent equals the count for forty; a per-agent manifest read here would be an
  // N+1 that is invisible in review and instantly visible in a real workspace.
  let statements = 0;
  const counting = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "forWorkspace") return Reflect.get(target, prop, receiver);
      return (workspaceId: string) => {
        const q = target.forWorkspace(workspaceId);
        return new Proxy(q, {
          get(t, p, r) {
            if (p !== "all" && p !== "get" && p !== "run") return Reflect.get(t, p, r);
            statements++;
            return (t[p as "all"] as (...a: unknown[]) => unknown).bind(t);
          },
        });
      };
    },
  });
  await new AgentRepository(counting).currentVersionHas(A, "agent.py");
  check(`the whole workspace costs one statement (${statements})`, statements === 1);

  // AND THE DISK STILL ANSWERS FOR THE ONE THING IT ALONE KNOWS. A hand-dropped project has no row
  // and no version, so the manifest cannot see it; dropping the disk half entirely would make that
  // agent unrunnable, which is a different regression wearing this fix's clothes.
  const handDropped = await agents.currentVersionHas(SERVER, "agent.py");
  check("a hand-dropped project is invisible to the manifest, which is why the disk half stays", !handDropped.has("hand_dropped"));
  check("...and it really is on the disk", fs.existsSync(join(runtimeDir, "agents", "hand_dropped", "agent.py")));

  // THE DERIVATION ITSELF, read as text: the manifest must be consulted, which is the whole bug.
  const index = fs.readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "index.ts"), "utf8");
  check(
    "the agent snapshot derives runnable from the manifest first, then the disk",
    /runnable: published\.has\(a\.slug\) \|\| \(onDisk\.get\(a\.slug\)\?\.runnable \?\? false\)/.test(index),
  );
  // AND ONE HELPER IS THE ONLY WAY ANYTHING OBTAINS A PROJECT DIRECTORY. The run, `planDeploy` and
  // the deploy each read `runtime/agents/<slug>` and only two paths ever wrote it, so a version
  // published anywhere else — a fork, a restore, another replica — left the disk behind.
  check("ensureProjectDir exists", /async function ensureProjectDir\(/.test(index));
  check(
    `...and the run and both deploy commands call it (${(index.match(/ensureProjectDir\(ctx, /g) ?? []).length})`,
    (index.match(/ensureProjectDir\(ctx, /g) ?? []).length === 3,
  );
  check(
    "...comparing a stamp rather than rewriting the project on every run",
    /\.jaroku-version/.test(index),
  );
}

await db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
