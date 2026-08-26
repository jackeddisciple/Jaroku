// The fix loop, once an apply is a version bump and an undo is a pointer move.
//
// Every assertion here is about a property `copyProject` + `atomicSwap` + `history.json` used
// to provide on one machine, restated as something several machines can provide:
//
//   * a proposal never touches the live version — it lives under a staging id;
//   * apply publishes the next version, recording the instruction, the summary and the diff
//     stat that used to live in history.json;
//   * undo moves the pointer back and marks what it left behind, copying nothing;
//   * a proposal that fails validation is discarded and leaves no objects;
//   * the read-only set is enforced against object PATHS, which is the layout the block list
//     now has to match — it used to match on local paths.
//
// Driven by the recorded edit fixtures, so the whole loop is exercisable for free.
//
//   npm run test:edit-versions

import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { workspacePrefix } from "./storage/keys.ts";
import { Generator } from "./generator.ts";
import { Editor, type FileDiff } from "./editor.ts";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_DIR = resolve(SERVER_DIR, "..", "runtime");
const FIXTURES = join(SERVER_DIR, "fixtures");

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

type EditOutcome =
  | { kind: "proposal"; proposalId: string; summary: string; files: FileDiff[] }
  | { kind: "error"; message: string; problems?: string[] };

/** One `propose` call, resolved when it produces a proposal or an error. */
function propose(editor: Editor, ctx: TenantContext, agentId: string, instruction: string): Promise<EditOutcome> {
  return new Promise((done) => {
    const onProposal = (e: { proposalId: string; summary: string; files: FileDiff[] }): void => {
      editor.off("error", onError);
      done({ kind: "proposal", ...e });
    };
    const onError = (e: { message: string; problems?: string[] }): void => {
      editor.off("proposal", onProposal);
      done({ kind: "error", ...e });
    };
    editor.once("proposal", onProposal);
    editor.once("error", onError);
    void editor.propose(ctx, agentId, instruction);
  });
}

function apply(editor: Editor, ctx: TenantContext, proposalId: string): Promise<{ version?: number; error?: string }> {
  return new Promise((done) => {
    const onApplied = (e: { version: number }): void => {
      editor.off("error", onError);
      done({ version: e.version });
    };
    const onError = (e: { message: string }): void => {
      editor.off("applied", onApplied);
      done({ error: e.message });
    };
    editor.once("applied", onApplied);
    editor.once("error", onError);
    void editor.apply(ctx, proposalId);
  });
}

function undo(editor: Editor, ctx: TenantContext, agentId: string): Promise<{ version?: number; error?: string }> {
  return new Promise((done) => {
    const onUndone = (e: { version: number }): void => {
      editor.off("error", onError);
      done({ version: e.version });
    };
    const onError = (e: { message: string }): void => {
      editor.off("undone", onUndone);
      done({ error: e.message });
    };
    editor.once("undone", onUndone);
    editor.once("error", onError);
    void editor.undo(ctx, agentId);
  });
}

const db = new SqliteDb(join(tmpDir("db"), "edits.db"));
await migrate(db.migrationTarget(), join(SERVER_DIR, "migrations", "sqlite"), () => {});

const agents = new AgentRepository(db);
const objects = new FsObjectStore({ root: tmpDir("objects"), signingKey: randomBytes(32) });
const projects = new ProjectStore(objects, agents);
const runtimeDir = isolatedRuntime();
const generator = new Generator({ runtimeDir, agents, projects });
const editor = new Editor({ runtimeDir, agents, projects });

const identity = new IdentityRepository(db);
const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), { name: `edits ${randomUUID().slice(0, 6)}` });
const A: TenantContext = systemContextFor(ws.id, newRequestId());

// A real generated project to edit, off the recorded fixture.
process.env.JAROKU_GEN_FIXTURE = join(FIXTURES, "support_bot.txt");
await new Promise<void>((done) => {
  generator.once("done", () => done());
  generator.once("error", (e) => {
    console.log(`  FAIL could not generate the agent under test — ${e.message}`);
    failures++;
    done();
  });
  void generator.generate({ runtimeDir, ctx: A, prompt: "support bot", connectors: ["postgres"], name: "Support Bot" });
});
delete process.env.JAROKU_GEN_FIXTURE;

const agent = (await agents.bySlug(A, "support_bot"))!;
const generatedVersion = agent.current_version;
const originalAgentPy = (await projects.readVersion(A, agent.id, generatedVersion)).find((f) => f.path === "agent.py")!.content;

// --- 1. a proposal leaves the live version alone -------------------------------------------
console.log("\na proposal");
{
  process.env.JAROKU_EDIT_FIXTURE = join(FIXTURES, "edit-prompt-tweak.txt");
  const out = await propose(editor, A, "support_bot", "make the tone warmer");
  check(out.kind === "proposal", "the fixture edit produces a proposal", out.kind === "error" ? out.message : "");
  if (out.kind !== "proposal") throw new Error("cannot continue without a proposal");
  check(out.files.length > 0, `...with a diff (${out.files.length} file(s))`);
  check(out.files.every((f) => f.additions + f.deletions > 0), "...where every entry actually changed");

  check(
    (await agents.bySlug(A, "support_bot"))!.current_version === generatedVersion,
    "the live version has not moved",
  );
  check(
    (await projects.readVersion(A, agent.id, generatedVersion)).find((f) => f.path === "agent.py")!.content === originalAgentPy,
    "...and its bytes are untouched",
  );
  const staging = (await objects.list(workspacePrefix(A.workspaceId))).filter((o) => o.key.includes("/staging/"));
  check(staging.length > 0, "...while the proposal is staged in the object store");

  // --- 2. apply is a version bump ----------------------------------------------------------
  console.log("\napply");
  const applied = await apply(editor, A, out.proposalId);
  check(applied.version === generatedVersion + 1, `apply publishes the next version (v${applied.version})`, applied.error);

  const row = await agents.version(A, agent.id, applied.version!);
  check(row?.source === "edit", "...recorded as an edit");
  check(row?.instruction === "make the tone warmer", "...carrying the instruction that produced it");
  check((row?.summary ?? "").length > 0, "...and the summary the model gave");
  check(row!.file_stats.length === out.files.length, "...and the per-file diff stat history.json used to hold");
  check(
    row!.file_stats.every((f) => typeof f.additions === "number" && typeof f.deletions === "number"),
    "...with the numbers the diff bar renders",
  );

  check(
    (await objects.list(workspacePrefix(A.workspaceId))).filter((o) => o.key.includes("/staging/")).length === 0,
    "the staging copy is gone once it is a version",
  );
  check(
    (await projects.readVersion(A, agent.id, generatedVersion)).find((f) => f.path === "agent.py")!.content === originalAgentPy,
    "and the version it superseded is still exactly as it was",
  );
  check(
    existsSync(join(runtimeDir, "agents", "support_bot", "agent.py")),
    "the new version is materialised for the local run path",
  );
  check((await agents.editCounts(A)).get(agent.id) === 1, "one applied edit is available to undo");
}

// --- 3. undo is a pointer move --------------------------------------------------------------
console.log("\nundo");
{
  const before = (await agents.bySlug(A, "support_bot"))!.current_version;
  const undone = await undo(editor, A, "support_bot");
  check(undone.version === before, `undo reports the version it reverted (v${undone.version})`, undone.error);
  check((await agents.bySlug(A, "support_bot"))!.current_version === generatedVersion, "...and the pointer is back");
  check(
    readFileSync(join(runtimeDir, "agents", "support_bot", "agent.py"), "utf8") === originalAgentPy,
    "...with the local copy restored to match",
  );
  check((await agents.editCounts(A)).get(agent.id) === undefined, "...and there is nothing left to undo");

  const second = await undo(editor, A, "support_bot");
  check(second.error?.includes("nothing to undo") === true, "undoing again says so rather than failing obscurely", second.error);
}

// --- 3b. a restore reaches both places the product reads a version from ----------------------
//
// A RESTORE IS A FORWARD PUBLISH, and it was writing neither of the two things a forward publish
// has to write. The reasoning for going forward is right and is spelled out at the call site —
// moving `current_version` backwards would make the version list stop describing what happened,
// and would leave the pointer on objects a retention sweep is entitled to consider superseded.
// What was wrong was the mechanism.
//
//   THE OBJECT STORE. A key carries the version it was written under — `…/agents/<id>/v<n>/<path>`
//   — so a manifest handed to `addVersion` reserves v5 and names paths that exist only under v3.
//   Every read of the restored version asks for `v5/agent.py` and gets nothing. This is GAP-001's
//   defect one axis over: there a manifest crossed an AGENT boundary, here a VERSION one.
//
//   THE DISK. `runtime/agents/<slug>` is what a local run spawns from, what `planDeploy` checks
//   for an `agent.py`, and what the deploy upload sends. Nothing in this path wrote it, so the
//   next run executed the version the history said was replaced, a deploy shipped those bytes
//   while recording the NEW number — the drift badge reading "up to date" over a URL serving the
//   retired code — and `recordArtifacts` then republished the stale directory as a newer version,
//   undoing the restore in the history as well.
//
// Both are asserted from the broken end first, because an assertion that only exercised the fixed
// path would have passed on the shipped code as well. The handler is module-local, so the
// property is proven here and the call site is read as text below.
console.log("\na restore reaches both places the product reads a version from");
{
  // ITS OWN AGENT, because a restore MOVES `current_version` — that is what it is — and the
  // sections below assert that the shared `support_bot` pointer has not moved. Borrowing it here
  // would make this section's correctness a fact about test ordering.
  const slug = "restore_target";
  const dir = join(runtimeDir, "agents", slug);
  const created = await agents.upsertFromDisk(A, { slug, display_name: "Restore Target" });
  const seeded = await projects.publish(A, created.id, [{ path: "agent.py", content: originalAgentPy }], {
    source: "generation", summary: "first cut",
  });
  const live = (await agents.bySlug(A, slug))!;
  // Publish something clearly different, so "it did not move" is visible rather than inferred.
  const edited = `${originalAgentPy}\n# a later version\n`;
  const wanted = seeded.version;
  const laterFiles = (await projects.readVersion(A, live.id, wanted))
    .map((f) => (f.path === "agent.py" ? { ...f, content: edited } : f));
  const later = await projects.publish(A, live.id, laterFiles, { source: "edit", summary: "a later version" });
  await projects.materialise(A, live.id, later.version, dir);
  check(readFileSync(join(dir, "agent.py"), "utf8") === edited, "the later version is what the disk holds");

  // THE DEFECT, both halves. A bare row carrying the old manifest.
  const oldRow = (await agents.versions(A, live.id, true)).find((v) => v.version === wanted)!;
  const bare = await agents.addVersion(A, live.id, oldRow.manifest, { source: "import", summary: `restored v${wanted}` });
  let bareThrew = false;
  try {
    await projects.readVersion(A, live.id, bare);
  } catch {
    bareThrew = true;
  }
  check(bareThrew, "a manifest copied onto a NEW version number resolves to nothing — the objects are keyed by version");
  check(
    readFileSync(join(dir, "agent.py"), "utf8") === edited,
    "...and the disk is still on the version the history now says was replaced",
  );

  // THE FIX, both halves. The old version's FILES, published under the new number, then written out.
  const restoredFiles = await projects.readVersion(A, live.id, wanted);
  const restored = await projects.publish(A, live.id, restoredFiles, { source: "import", summary: `restored v${wanted}` });
  check(
    (await projects.readVersion(A, live.id, restored.version)).find((f) => f.path === "agent.py")!.content === originalAgentPy,
    "publishing the old version's FILES makes the restored version readable",
  );
  await projects.materialise(A, live.id, restored.version, dir);
  check(
    readFileSync(join(dir, "agent.py"), "utf8") === originalAgentPy,
    "...and materialising it puts the restored bytes where a run spawns from and a deploy uploads",
  );
  check(
    (await projects.readVersion(A, live.id, later.version)).find((f) => f.path === "agent.py")!.content === edited,
    "...while the version it replaced keeps its own objects, so the history still describes what happened",
  );

  // AND THE PRODUCTION PATH STILL DOES BOTH. Read as text: the handler is module-local, and what
  // makes this come back is somebody adding a broadcast beside the ones already there without
  // noticing that neither the store nor the disk was ever in that list.
  const restoreFn = /async function restoreAgentVersion\([\s\S]*?\n\}/.exec(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8"),
  )?.[0] ?? "";
  check(restoreFn.length > 0, "restoreAgentVersion exists to be read");
  check(
    /projects\.publish\(ctx, agent\.id, restoredFiles/.test(restoreFn),
    "...and publishes the restored version's files rather than copying its manifest onto a new number",
  );
  check(
    /projects\.materialise\(ctx, agent\.id, published/.test(restoreFn),
    "...then materialises it, as generate, apply and undo all do",
  );
}

// --- 4. a proposal that fails validation ----------------------------------------------------
console.log("\na proposal that does not validate");
{
  process.env.JAROKU_EDIT_FIXTURE = join(FIXTURES, "edit-syntax-error.txt");
  const out = await propose(editor, A, "support_bot", "break it");
  check(out.kind === "error", "a syntactically broken edit is refused");
  check(
    out.kind === "error" && (out.problems ?? []).length > 0,
    "...with the problems named",
    out.kind === "error" ? out.message : "",
  );
  check(
    (await objects.list(workspacePrefix(A.workspaceId))).filter((o) => o.key.includes("/staging/")).length === 0,
    "...and no staging objects survive it",
  );
  check(
    (await agents.bySlug(A, "support_bot"))!.current_version === generatedVersion,
    "...and the live version never moved",
  );
}

// --- 5. the read-only set, against the object layout ----------------------------------------
console.log("\nread-only files, matched as object paths");
{
  process.env.JAROKU_EDIT_FIXTURE = join(FIXTURES, "edit-touches-connector.txt");
  const out = await propose(editor, A, "support_bot", "rewrite the postgres connector");
  check(out.kind === "error", "an edit that opens a reviewed connector template is refused");
  check(
    out.kind === "error" && out.message.includes("reviewed connector template"),
    "...naming what it is and what to ask for instead",
    out.kind === "error" ? out.message : "",
  );

  // The other half of the same rule, from the other side. This fixture is a REAL response to
  // an instruction that asked for a connector rewrite: the model declined and explained why,
  // emitting no files at all. It has to stay a clean no-op rather than becoming an error —
  // "the model said no and told you why" is a proposal with an empty diff, and turning it into
  // a failure would hide the explanation the user actually needs.
  process.env.JAROKU_EDIT_FIXTURE = join(FIXTURES, "edit-real-connector-bait.txt");
  const bait = await propose(editor, A, "support_bot", "make the postgres connector writable");
  check(bait.kind === "proposal" && bait.files.length === 0, "a model that declines the same request is a no-op, not a failure");
  check(
    bait.kind === "proposal" && bait.summary.toLowerCase().includes("read-only"),
    "...with its reason carried through as the summary",
    bait.kind === "proposal" ? bait.summary : "",
  );
  check(
    (await objects.list(workspacePrefix(A.workspaceId))).filter((o) => o.key.includes("/staging/")).length === 0,
    "...leaving nothing staged either way",
  );
}

// --- 6. a no-op proposal ---------------------------------------------------------------------
console.log("\na proposal with nothing in it");
{
  process.env.JAROKU_EDIT_FIXTURE = join(FIXTURES, "edit-noop.txt");
  const out = await propose(editor, A, "support_bot", "do nothing");
  check(out.kind === "proposal", "a declined edit is a proposal, not an error");
  check(out.kind === "proposal" && out.files.length === 0, "...with an empty diff");
  check(
    (await objects.list(workspacePrefix(A.workspaceId))).filter((o) => o.key.includes("/staging/")).length === 0,
    "...and nothing staged for it",
  );
}

// --- 7. another workspace cannot edit it -----------------------------------------------------
console.log("\nanother workspace");
{
  const theirs = await identity.createWorkspaceUnowned(systemContext(newRequestId()), { name: `edits other ${randomUUID().slice(0, 6)}` });
  const B: TenantContext = systemContextFor(theirs.id, newRequestId());
  process.env.JAROKU_EDIT_FIXTURE = join(FIXTURES, "edit-prompt-tweak.txt");
  const out = await propose(editor, B, "support_bot", "edit somebody else's agent");
  check(out.kind === "error", "an agent in another workspace cannot be proposed against");
  check(
    out.kind === "error" && out.message.includes("was not found"),
    "...and is reported as absent rather than as forbidden",
    out.kind === "error" ? out.message : "",
  );
  const theirUndo = await undo(editor, B, "support_bot");
  check(theirUndo.error?.includes("was not found") === true, "...nor undone", theirUndo.error);
  check(
    (await agents.bySlug(A, "support_bot"))!.current_version === generatedVersion,
    "...leaving A's pointer where it was",
  );

  // A PROPOSAL IS AN ID, AND AN ID IS ALL THE COMMAND CARRIES. Proposing was refused above
  // because it names an agent; applying names a proposal, whose record has a context of its own
  // — so the handler used to act in THAT context and publish a version of A's agent on B's
  // command. The same for discarding, which would have thrown A's reviewed diff away.
  process.env.JAROKU_EDIT_FIXTURE = join(FIXTURES, "edit-prompt-tweak.txt");
  const mine = await propose(editor, A, "support_bot", "a proposal of A's own");
  check(mine.kind === "proposal", "A makes a proposal of its own", mine.kind === "error" ? mine.message : "");
  if (mine.kind !== "proposal") throw new Error("cannot continue");
  const before = (await agents.bySlug(A, "support_bot"))!.current_version;

  const stolen = await apply(editor, B, mine.proposalId);
  check(stolen.error !== undefined, "another workspace holding the id cannot apply it");
  check(
    (stolen.error ?? "").includes("no longer available"),
    "...and is told it is not there, rather than that it is not theirs",
    stolen.error,
  );
  check((await agents.bySlug(A, "support_bot"))!.current_version === before, "...and A's pointer did not move");

  // Nor discard it. Asserted through the staging objects rather than by applying, because
  // applying would spend the proposal and this is a question about whether it is still there.
  await editor.discard(B, mine.proposalId);
  const afterTheirs = (await objects.list(workspacePrefix(A.workspaceId))).filter((o) => o.key.includes("/staging/"));
  check(afterTheirs.length > 0, `...nor discard it — A's staged copy is still there (${afterTheirs.length} object(s))`);
  await editor.discard(A, mine.proposalId);
  const afterOwn = (await objects.list(workspacePrefix(A.workspaceId))).filter((o) => o.key.includes("/staging/"));
  check(afterOwn.length === 0, "...while the workspace that made it can", `${afterOwn.length} left`);
}

// --- 8. a proposal whose base moved underneath it --------------------------------------------
//
// The window between propose and apply is unbounded, and something else can publish inside it —
// a deploy does exactly that, adding four artifacts and moving the pointer. Applying a copy
// assembled from the older version would drop them, silently, because the staged copy is
// complete and validates perfectly well.
console.log("\na proposal whose base version moved");
{
  process.env.JAROKU_EDIT_FIXTURE = join(FIXTURES, "edit-prompt-tweak.txt");
  const out = await propose(editor, A, "support_bot", "warmer again");
  check(out.kind === "proposal", "a proposal is made", out.kind === "error" ? out.message : "");
  if (out.kind !== "proposal") throw new Error("cannot continue");

  const before = (await agents.bySlug(A, "support_bot"))!.current_version;
  const baseFiles = await projects.readVersion(A, agent.id, before);
  await projects.publish(A, agent.id, [...baseFiles, { path: "serve.py", content: "# a deploy wrote this\n" }], {
    source: "deploy",
    summary: "deploy artifacts",
  });
  const moved = (await agents.bySlug(A, "support_bot"))!.current_version;
  check(moved > before, `something else published in between (v${before} -> v${moved})`);

  const applied = await apply(editor, A, out.proposalId);
  check(applied.error !== undefined, "applying the stale proposal is refused");
  check(
    (applied.error ?? "").includes(`v${before}`) && (applied.error ?? "").includes(`v${moved}`),
    "...naming both versions, so the message says what changed",
    applied.error,
  );
  const now = (await agents.bySlug(A, "support_bot"))!;
  check(now.current_version === moved, "...leaving the pointer where the other publish put it");
  const files = await projects.readVersion(A, agent.id, now.current_version);
  check(files.some((f) => f.path === "serve.py"), "...and the file it added still there");
  check(
    (await objects.list(workspacePrefix(A.workspaceId))).filter((o) => o.key.includes("/staging/")).length === 0,
    "...with the refused proposal's staging cleared",
  );
}

// --- one proposal publishes ONE version, however many times Apply is pressed ----------------
console.log("\na double-click on Apply");
{
  // The record used to be deleted AFTER two awaits — an agent lookup and the publish — so both
  // applies read the same `current_version`, both passed the staleness guard directly above them,
  // and both published. `current_version` jumped by two, the history showed the same edit twice,
  // and Undo had to be pressed twice to get back. `discard` has always deleted before its first
  // await, which is what made this an oversight rather than a design.
  const out = await propose(editor, A, "support_bot", "make the tone warmer again");
  if (out.kind !== "proposal") throw new Error("cannot continue without a proposal");
  const before = (await agents.bySlug(A, "support_bot"))!.current_version;
  const undosBefore = (await agents.editCounts(A)).get(agent.id) ?? 0;

  // An `error` with no listener is a throw on an EventEmitter, and the second apply is expected to
  // refuse — so the refusals are collected rather than left to blow up the suite.
  const refusals: string[] = [];
  const onError = (e: { message: string }): void => { refusals.push(e.message); };
  editor.on("error", onError);
  // Both in flight before either resolves, which is exactly what a double-click produces.
  await Promise.all([editor.apply(A, out.proposalId), editor.apply(A, out.proposalId)]);
  editor.off("error", onError);

  const after = (await agents.bySlug(A, "support_bot"))!.current_version;
  check(after === before + 1, `one proposal publishes ONE version (v${before} -> v${after})`, String(after));
  check(
    (await agents.versions(A, agent.id)).filter((v) => v.version === after).length === 1,
    "...and the history holds one row for it, not two",
  );
  check(
    ((await agents.editCounts(A)).get(agent.id) ?? 0) === undosBefore + 1,
    "...so Undo has to be pressed once, not twice, to get back",
  );
  check(
    refusals.length === 1 && refusals[0] === "that proposal is no longer available",
    "...and the second click is told the proposal is gone, which is what discard already said",
    refusals.join(" / "),
  );
}

delete process.env.JAROKU_EDIT_FIXTURE;
await db.close();
for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
