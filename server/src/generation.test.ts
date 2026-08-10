// Generation, end to end, against the object store.
//
// The whole build path — stream, stage, validate, commit — for free, off the recorded fixture
// in fixtures/support_bot.txt. Which is why this suite can exist at all: it is the same path a
// paid generation takes, with the model call replaced and nothing else.
//
// What changed in Session 3 and is therefore what this asserts:
//
//   * STAGING IS THE OBJECT STORE. Files go to `…/staging/<staging id>/…`, not to
//     `runtime/agents/.staging/`. A generation in flight leaves nothing on a shared path.
//   * VALIDATION READS FROM THERE. The project is materialised out of the store and checked,
//     so the check runs against exactly the bytes that would be published.
//   * COMMIT IS A VERSION. A row plus a pointer, not a directory rename — and a REJECTED
//     generation leaves no version, no agent row, and no staging objects.
//   * THE SLUG IS UNIQUE PER WORKSPACE, not globally. Two workspaces may both hold a
//     `support_bot`, which is the change Session 1's schema made and nothing enforced yet.
//
//   npm run test:generation

import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { migrate } from "./db/migrate.ts";
import { SqliteDb } from "./db/sqlite.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { AgentRepository } from "./db/repositories/agents.ts";
import { FsObjectStore } from "./storage/fsObjectStore.ts";
import { ProjectStore } from "./storage/projectStore.ts";
import { agentPrefix, workspacePrefix } from "./storage/keys.ts";
import { Generator } from "./generator.ts";
import type { Db } from "./db/db.ts";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = resolve(SERVER_DIR, "..");
const RUNTIME_DIR = join(REPO_DIR, "runtime");
const MIGRATIONS = join(SERVER_DIR, "migrations");

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

/** Run one generation to completion, collecting what it emitted. */
function generate(
  gen: Generator,
  opts: Parameters<Generator["generate"]>[0],
): Promise<{ done?: { agentId: string; files: string[] }; error?: { message: string; problems?: string[] } }> {
  return new Promise((resolve_) => {
    const onDone = (e: { agentId: string; name: string; files: string[] }): void => {
      gen.off("error", onError);
      resolve_({ done: { agentId: e.agentId, files: e.files } });
    };
    const onError = (e: { message: string; problems?: string[] }): void => {
      gen.off("done", onDone);
      resolve_({ error: e });
    };
    gen.once("done", onDone);
    gen.once("error", onError);
    void gen.generate(opts);
  });
}

async function newWorkspace(db: Db, label: string): Promise<TenantContext> {
  const identity = new IdentityRepository(db);
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `generation ${label} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

// A runtime directory of its own, so a generation cannot write into the repository's
// `runtime/agents/`. The connector templates and the catalogue are symlinked rather than
// copied — they are what the generation actually installs, byte for byte, and a copy would be
// a second version of a file whose whole point is that there is one.
function isolatedRuntime(): string {
  const dir = tmpDir("runtime");
  const { mkdirSync, symlinkSync } = fs;
  mkdirSync(join(dir, "agents"), { recursive: true });
  symlinkSync(join(RUNTIME_DIR, "tool_templates"), join(dir, "tool_templates"));
  symlinkSync(join(RUNTIME_DIR, "jaroku_runner"), join(dir, "jaroku_runner"));
  symlinkSync(join(RUNTIME_DIR, "jaroku_interceptor"), join(dir, "jaroku_interceptor"));
  symlinkSync(join(RUNTIME_DIR, "pyproject.toml"), join(dir, "pyproject.toml"));
  symlinkSync(join(RUNTIME_DIR, ".python-version"), join(dir, ".python-version"));
  if (existsSync(join(RUNTIME_DIR, "uv.lock"))) symlinkSync(join(RUNTIME_DIR, "uv.lock"), join(dir, "uv.lock"));
  if (existsSync(join(RUNTIME_DIR, ".venv"))) symlinkSync(join(RUNTIME_DIR, ".venv"), join(dir, ".venv"));
  return dir;
}

const dbDir = tmpDir("db");
const db = new SqliteDb(join(dbDir, "generation.db"));
await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});

const agents = new AgentRepository(db);
const objects = new FsObjectStore({ root: tmpDir("objects"), signingKey: randomBytes(32) });
const projects = new ProjectStore(objects, agents);
const runtimeDir = isolatedRuntime();
const generator = new Generator({ runtimeDir, agents, projects });

const A = await newWorkspace(db, "a");
const B = await newWorkspace(db, "b");

// --- 1. a generation that passes ---------------------------------------------------------
console.log("\na generation that validates");
{
  process.env.JAROKU_GEN_FIXTURE = join(SERVER_DIR, "fixtures", "support_bot.txt");
  const result = await generate(generator, {
    runtimeDir,
    ctx: A,
    prompt: "a support bot that answers questions from our database",
    // The fixture imports tools/postgres.py — see fixtures/README.md. A different selection
    // fails the import check, which is exactly what the next block relies on.
    connectors: ["postgres"],
    name: "Support Bot",
  });
  check(!result.error, "the fixture generation succeeds", result.error?.problems?.join(" | ") ?? result.error?.message);
  check(result.done?.agentId === "support_bot", `...as the slug it named (${result.done?.agentId})`);

  const agent = await agents.bySlug(A, "support_bot");
  check(agent !== undefined, "an agent row exists afterwards");
  check(agent!.connectors.includes("postgres"), "...recording the connectors it was built with");

  const version = await agents.version(A, agent!.id, agent!.current_version);
  check(version !== undefined, `a version row exists (v${agent!.current_version})`);
  check(version?.source === "generation", "...labelled as a generation, not an import");
  check(Object.keys(version!.manifest).length > 3, "...with a manifest of every file");

  const files = await projects.readVersion(A, agent!.id, agent!.current_version);
  const paths = files.map((f) => f.path);
  check(paths.includes("agent.py"), "the version holds the model's files");
  check(paths.includes("jaroku.json"), "...and the host-owned metadata");
  check(paths.includes("tools/postgres.py"), "...and the reviewed connector template");
  check(paths.includes("__init__.py"), "...and the package marker");

  // Byte-for-byte, which is the promise the README makes about a reviewed template and which
  // a read-and-write path could quietly break where a copyFileSync could not.
  const { readFileSync } = await import("node:fs");
  const template = readFileSync(join(RUNTIME_DIR, "tool_templates", "postgres.py"), "utf8");
  check(
    files.find((f) => f.path === "tools/postgres.py")?.content === template,
    "...copied byte for byte, not re-rendered",
  );

  // The staging objects are gone: a committed generation leaves a version and nothing else.
  const remaining = await objects.list(agentPrefix(A.workspaceId, agent!.id));
  check(
    remaining.every((o) => !o.key.includes("/staging/")),
    `no staging objects survive a commit (${remaining.filter((o) => o.key.includes("/staging/")).length} left)`,
  );

  // And the local materialisation, which is what the run path still imports from.
  check(existsSync(join(runtimeDir, "agents", "support_bot", "agent.py")), "the project is materialised for the local run path");
  check(!existsSync(join(runtimeDir, "agents", ".staging")), "...and nothing was staged on the shared runtime path");
}

// --- 2. a generation that is rejected ------------------------------------------------------
console.log("\na generation that fails validation");
{
  process.env.JAROKU_GEN_FIXTURE = join(SERVER_DIR, "fixtures", "rejected-tool-call-and-sql.txt");
  const before = (await agents.list(A)).length;
  const result = await generate(generator, {
    runtimeDir,
    ctx: A,
    prompt: "another one",
    connectors: ["postgres"],
    name: "Bad Bot",
  });
  check(Boolean(result.error), "a project that breaks the rules is rejected");
  check(
    (result.error?.problems ?? []).length > 0,
    "...with the problems named",
    result.error?.message,
  );
  check((await agents.list(A)).length === before, "...leaving no agent row behind");
  check((await agents.bySlug(A, "bad_bot")) === undefined, "...not even an empty one under its slug");

  const stray = (await objects.list(workspacePrefix(A.workspaceId))).filter((o) => o.key.includes("/staging/"));
  check(stray.length === 0, `...and no staging objects (${stray.length} left)`);
  check(!existsSync(join(runtimeDir, "agents", "bad_bot")), "...and nothing on disk");
}

// --- 3. two workspaces, one slug -----------------------------------------------------------
console.log("\ntwo workspaces may both have a support_bot");
{
  process.env.JAROKU_GEN_FIXTURE = join(SERVER_DIR, "fixtures", "support_bot.txt");
  const result = await generate(generator, {
    runtimeDir,
    ctx: B,
    prompt: "their own support bot",
    connectors: ["postgres"],
    name: "Support Bot",
  });
  check(!result.error, "B's generation succeeds", result.error?.message);
  // The DISK is still one namespace, so B's project materialises under a suffixed directory —
  // which is the honest limit of the local path and exactly why the object keys carry the
  // workspace instead of relying on the directory name.
  const theirs = await agents.list(B);
  check(theirs.length === 1, "B has exactly one agent");
  const mine = await agents.bySlug(A, "support_bot");
  check(mine !== undefined && theirs[0]!.id !== mine.id, "...with a different uuid from A's");

  check(
    (await projects.readVersion(A, theirs[0]!.id, theirs[0]!.current_version)).length === 0,
    "A cannot read B's agent by uuid",
  );
  const aKeys = await objects.list(workspacePrefix(A.workspaceId));
  check(
    aKeys.every((o) => !o.key.includes(theirs[0]!.id)),
    "...and none of B's objects live under A's prefix",
  );
}

delete process.env.JAROKU_GEN_FIXTURE;
await db.close();
for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
