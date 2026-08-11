// Branching, once a checkpoint is a row rather than a file.
//
// The guarantee under test is the one `copyFileSync` used to buy in the crudest possible way:
// THE PARENT IS NEVER TOUCHED. A branch re-enters the parent's graph at a checkpoint and runs
// forward from it, and if that could write anything back into the parent's thread, the run the
// user branched from would quietly stop being the run they saw. So the parent's rows are hashed
// before and after, and compared.
//
// Plus the two properties a file copy did not have and a row copy has to earn:
//
//   * IT STOPS WHERE IT WAS TOLD. A file copy brought every checkpoint along, including ones
//     after the fork point, and the runner simply re-entered at the right one. A row copy is
//     bounded by `checkpoint_id <= target`, which relies on LangGraph minting ids that sort
//     chronologically — somebody else's property, so it is asserted rather than assumed.
//
//   * IT IS SCOPED. Two workspaces' threads share one table in a schema with no row-level
//     security, so a fork, a sweep and a listing must each refuse to reach past the prefix.
//
// It runs against tables LangGraph itself created, not against a hand-written imitation of
// them — the schema is discovered from `information_schema` at run time and is exactly what
// `PostgresSaver.setup()` produced, which is the only way a column LangGraph adds later shows up
// here as a change rather than as silence.
//
//   npm run test:branch          (Postgres half needs JAROKU_PG_URL; SQLite half always runs)

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Db } from "../db/db.ts";
import { withScratchPostgres } from "../db/testDb.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { FileCheckpointStore, PgCheckpointStore } from "./store.ts";
import { CHECKPOINT_SCHEMA, checkpointThreadId } from "./threads.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const scratch: string[] = [];
const tmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "jaroku-branch-"));
  scratch.push(d);
  return d;
};

// --- 1. the local store ------------------------------------------------------------------
console.log("\nFileCheckpointStore");
{
  const dir = tmpDir();
  const store = new FileCheckpointStore(dir);
  const ctx = systemContextFor(randomUUID(), newRequestId());
  const parent = randomUUID();
  const branch = randomUUID();

  check(!(await store.has(ctx, parent)), "a run with nothing on disk has no checkpoint");
  writeFileSync(join(dir, `${parent}.sqlite`), "the parent's checkpoints");
  writeFileSync(join(dir, `${parent}.control`), "pause");
  check(await store.has(ctx, parent), "...and one with a database does");

  const before = readFileSync(join(dir, `${parent}.sqlite`), "utf8");
  await store.fork(ctx, { fromRunId: parent, toRunId: branch, checkpointId: "1ef" });
  check(existsSync(join(dir, `${branch}.sqlite`)), "a fork produces the branch's own database");
  check(
    readFileSync(join(dir, `${parent}.sqlite`), "utf8") === before,
    "...leaving the parent's byte for byte",
  );
  writeFileSync(join(dir, `${branch}.sqlite`), "the branch diverged");
  check(
    readFileSync(join(dir, `${parent}.sqlite`), "utf8") === before,
    "...and writing the branch does not reach the parent, because it is a separate file",
  );

  const held = await store.runsHeld(ctx);
  check(held.includes(parent) && held.includes(branch), "both runs are held");
  const swept = await store.sweepRuns(ctx, [branch]);
  check(swept.removed === 1, `sweeping one run removes its artifacts (${swept.removed})`);
  check(existsSync(join(dir, `${parent}.sqlite`)), "...and leaves the other run alone");
  check(swept.bytesFreed > 0, "...reporting what it freed");
  check((await store.sweepRuns(ctx, [randomUUID()])).removed === 0, "sweeping a run with nothing is not an error");
}

// --- 2. the hosted store, against LangGraph's own tables ------------------------------------
await withScratchPostgres(async (db: Db, url: string) => {
  console.log("\nPgCheckpointStore");
  const identity = new IdentityRepository(db);
  const makeWorkspace = async (label: string): Promise<TenantContext> => {
    const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
      name: `branch ${label} ${randomUUID().slice(0, 6)}`,
    });
    return systemContextFor(ws.id, newRequestId());
  };
  const A = await makeWorkspace("a");
  const B = await makeWorkspace("b");

  // LangGraph's schema, created by LangGraph. Not a hand-written imitation: a column it adds
  // later has to show up here as a change rather than as silence, which is the entire reason
  // the store reads its column list out of information_schema.
  const runtimeDir = join(fileURLToPath(new URL("../../..", import.meta.url)), "runtime");
  const { execFileSync } = await import("node:child_process");
  let langgraphReady = true;
  try {
    execFileSync("uv", ["run", "python", "-c", [
      "import os, psycopg",
      "from langgraph.checkpoint.postgres import PostgresSaver",
      "conn = psycopg.connect(os.environ['URL'], autocommit=True)",
      `conn.execute('CREATE SCHEMA IF NOT EXISTS ${CHECKPOINT_SCHEMA}')`,
      `conn.execute('SET search_path TO ${CHECKPOINT_SCHEMA}')`,
      "PostgresSaver(conn).setup()",
    ].join("\n")], {
      cwd: runtimeDir,
      env: { ...process.env, URL: url },
      stdio: "pipe",
    });
  } catch (err) {
    langgraphReady = false;
    console.log(`  (skipping: LangGraph's tables could not be created — ${(err as Error).message.split("\n")[0]})`);
  }
  if (!langgraphReady) return;

  const store = new PgCheckpointStore(db);
  const parentRun = randomUUID();
  const branchRun = randomUUID();
  const parentThread = checkpointThreadId(A.workspaceId, parentRun, "postgres");

  // Three checkpoints, with ids that sort in the order they were made — which is the property
  // the bounded copy leans on, so the fixture uses the same shape LangGraph's UUID6 ids have.
  const ids = ["1efa0000-0000-6000-8000-000000000001", "1efa0000-0000-6000-8000-000000000002", "1efa0000-0000-6000-8000-000000000003"];
  for (const [i, id] of ids.entries()) {
    await db.run(
      `INSERT INTO ${CHECKPOINT_SCHEMA}.checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [parentThread, "", id, i === 0 ? null : ids[i - 1], "msgpack", JSON.stringify({ step: i }), JSON.stringify({ step: i })],
    );
    await db.run(
      `INSERT INTO ${CHECKPOINT_SCHEMA}.checkpoint_writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob, task_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [parentThread, "", id, `task-${i}`, 0, "messages", "msgpack", Buffer.from(`write-${i}`), ""],
    );
  }
  await db.run(
    `INSERT INTO ${CHECKPOINT_SCHEMA}.checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [parentThread, "", "messages", "1", "msgpack", Buffer.from("blob")],
  );

  check(await store.has(A, parentRun), "a run with checkpoint rows has a checkpoint");
  check(!(await store.has(A, randomUUID())), "...and one without does not");
  check(!(await store.has(B, parentRun)), "...and neither does the same run id in another workspace");

  /** Everything the parent's thread holds, as one hash. What immutability means, concretely. */
  const fingerprint = async (): Promise<string> => {
    const h = createHash("sha256");
    for (const table of ["checkpoints", "checkpoint_writes", "checkpoint_blobs"]) {
      const rows = await db.all<Record<string, unknown>>(
        `SELECT * FROM ${CHECKPOINT_SCHEMA}.${table} WHERE thread_id = ? ORDER BY 1, 2, 3`,
        [parentThread],
      );
      h.update(JSON.stringify(rows));
    }
    return h.digest("hex");
  };

  const before = await fingerprint();
  const forked = await store.fork(A, { fromRunId: parentRun, toRunId: branchRun, checkpointId: ids[1]! });
  check(forked.copied > 0, `a fork copies rows (${forked.copied})`);
  check((await fingerprint()) === before, "...and the parent's rows are byte-identical afterwards");

  const branchThread = checkpointThreadId(A.workspaceId, branchRun, "postgres");
  const branchCheckpoints = await db.all<{ checkpoint_id: string }>(
    `SELECT checkpoint_id FROM ${CHECKPOINT_SCHEMA}.checkpoints WHERE thread_id = ? ORDER BY checkpoint_id`,
    [branchThread],
  );
  check(branchCheckpoints.length === 2, `the branch holds the prefix, not the whole thread (${branchCheckpoints.length} of 3)`);
  check(
    branchCheckpoints.every((r) => r.checkpoint_id <= ids[1]!),
    "...stopping at the fork point it was given",
  );
  const branchWrites = await db.all<{ checkpoint_id: string }>(
    `SELECT checkpoint_id FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes WHERE thread_id = ?`,
    [branchThread],
  );
  check(branchWrites.length === 2, "the writes are bounded the same way");
  const branchBlobs = await db.all(
    `SELECT channel FROM ${CHECKPOINT_SCHEMA}.checkpoint_blobs WHERE thread_id = ?`,
    [branchThread],
  );
  check(branchBlobs.length === 1, "...while the blobs come along whole, because they have no checkpoint to bound them");

  // A second fork of the same parent into the same branch must not double the rows. That is
  // what makes a retried dispatch safe, which is the same reason trace ingestion upserts.
  const again = await store.fork(A, { fromRunId: parentRun, toRunId: branchRun, checkpointId: ids[1]! });
  check(again.copied === 0, "forking the same branch again copies nothing");
  check(
    (await db.all(`SELECT 1 FROM ${CHECKPOINT_SCHEMA}.checkpoints WHERE thread_id = ?`, [branchThread])).length === 2,
    "...leaving the branch exactly as it was",
  );

  // Divergence: the branch runs forward and writes a checkpoint of its own.
  await db.run(
    `INSERT INTO ${CHECKPOINT_SCHEMA}.checkpoints
       (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [branchThread, "", "1efa0000-0000-6000-8000-00000000000a", ids[1], "msgpack", JSON.stringify({ step: "diverged" }), JSON.stringify({})],
  );
  check((await fingerprint()) === before, "a branch running forward still does not touch the parent");

  // --- resumed from another process ---------------------------------------------------------
  //
  // The point of the whole move. A second store, built against the same database and holding
  // none of the first one's state, sees the branch — which is what a worker that picks up a
  // resume on another machine is.
  const otherWorker = new PgCheckpointStore(db);
  check(await otherWorker.has(A, branchRun), "a process that has never seen this run finds its checkpoints");
  check(
    (await otherWorker.runsHeld(A)).includes(branchRun),
    "...and lists it among the workspace's runs",
  );

  // --- scoped ---------------------------------------------------------------------------
  console.log("\n  and scoped, in a schema with no row-level security");
  check(!(await store.runsHeld(B)).includes(parentRun), "B's listing holds none of A's runs");
  const crossFork = await store.fork(B, { fromRunId: parentRun, toRunId: randomUUID(), checkpointId: ids[2]! });
  check(crossFork.copied === 0, "B cannot fork A's run — the thread it names does not exist for B");
  const crossSweep = await store.sweepRuns(B, [parentRun]);
  check(crossSweep.removed === 0, "...nor sweep it");
  check((await fingerprint()) === before, "...and A's rows are untouched by either attempt");

  const swept = await store.sweepRuns(A, [branchRun]);
  check(swept.removed > 0, `sweeping a run removes its rows (${swept.removed})`);
  check((await store.has(A, branchRun)) === false, "...so it is gone");
  check(await store.has(A, parentRun), "...and the parent it came from is still there");
});

for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
