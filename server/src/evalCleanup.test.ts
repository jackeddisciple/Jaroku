// Checkpoint sweeping — and the one thing it must never do.
//
// Every run drops a resumable checkpoint db, which is correct for the interactive run and
// wasteful at eval scale (50 examples × 3 providers = 150 databases nobody will resume).
// But the checkpoint of an INTERACTIVE run is exactly what a user comes back to branch
// from, so the dangerous failure here isn't leaving a stale file — it's deleting the wrong
// one, which silently breaks pause/resume/branch for a run the user still cares about.
//
// Session 3 moved the sweep behind the CheckpointStore, so it can delete rows as well as files.
// This suite still runs against the LOCAL store — the file half — because that is where the
// dangerous mistake lives: a filename pattern that catches a run it should not. The hosted
// store's own scoping is asserted in checkpoints/branch.test.ts, against real LangGraph tables.
//
//   npm run test:cleanup

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceStore } from "./store.ts";
import { openTestSqlite, testContext, withScratchPostgres } from "./db/testDb.ts";
import { newRequestId, systemContext, systemContextFor } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { EvalStore } from "./evalStore.ts";
import { sweepEvalArtifacts, sweepOrphanedEvalArtifacts } from "./evalCleanup.ts";
import { FileCheckpointStore, PgCheckpointStore } from "./checkpoints/store.ts";
import { CHECKPOINT_SCHEMA, checkpointThreadId } from "./checkpoints/threads.ts";

let fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ok   ${n}`);
  else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); }
};

const DB = join(tmpdir(), `jaroku-sweep-${randomUUID()}.db`);
const CKPT = mkdtempSync(join(tmpdir(), "jaroku-ckpt-"));
const db = await openTestSqlite(DB);
const store = new TraceStore(db);
await store.init();
const evalStore = new EvalStore(store.database());
await evalStore.init();
const ctx = testContext();
const sys = systemContext(newRequestId());
const checkpoints = new FileCheckpointStore(CKPT);

/** Lay down the full artifact set a real run leaves behind. */
function artifacts(runId: string): string[] {
  const paths = [
    join(CKPT, `${runId}.sqlite`),
    join(CKPT, `${runId}.sqlite-wal`),
    join(CKPT, `${runId}.sqlite-shm`),
    join(CKPT, `${runId}.control`),
  ];
  for (const p of paths) writeFileSync(p, "x".repeat(64));
  return paths;
}

const ds = await evalStore.createDataset(ctx, "agent-c", "sweep");
const ex = await evalStore.addExample(ctx, ds.id, "hello");
const rubric = await evalStore.putRubric(ctx, { dataset_id: null, name: "r", criteria: [] });

// An eval whose runs are finished, and an INTERACTIVE run that must survive untouched.
const finishedEval = await evalStore.createEvalRun(ctx, {
  dataset_id: ds.id, agent_id: "agent-c", rubric_id: rubric.id,
  targets: [{ provider: "anthropic", model: "claude-haiku-4-5" }], budget_usd: null,
});
const jobs = await evalStore.createJobs(ctx, finishedEval.id, [
  { example_id: ex.id, provider: "anthropic", model: "claude-haiku-4-5" },
  { example_id: ex.id, provider: "anthropic", model: "claude-haiku-4-5" },
]);
const evalRun1 = randomUUID(), evalRun2 = randomUUID();
await evalStore.markJobRunning(ctx, jobs[0]!.id, evalRun1, 0);
await evalStore.markJobRunning(ctx, jobs[1]!.id, evalRun2, 0);
await evalStore.finishJob(ctx, jobs[0]!.id, "succeeded", { cost_usd: 0.001 });
await evalStore.finishJob(ctx, jobs[1]!.id, "succeeded", { cost_usd: 0.001 });
artifacts(evalRun1);
artifacts(evalRun2);

// The one that matters: a run the user drove by hand and might branch from.
const interactiveRun = randomUUID();
const interactiveFiles = artifacts(interactiveRun);

// --- per-eval sweep --------------------------------------------------------------------
{
  const res = await sweepEvalArtifacts(ctx, evalStore, checkpoints, finishedEval.id);
  check("removes every artifact of the eval's runs", res.removed === 8, `removed ${res.removed}`);
  check("frees the bytes it reports", res.bytesFreed === 8 * 64, `${res.bytesFreed}`);
  check("eval checkpoint dbs are gone", !existsSync(join(CKPT, `${evalRun1}.sqlite`)));
  check("WAL sidecars are gone too, not orphaned",
    !existsSync(join(CKPT, `${evalRun1}.sqlite-wal`)) && !existsSync(join(CKPT, `${evalRun1}.sqlite-shm`)));
  check("control files are gone", !existsSync(join(CKPT, `${evalRun2}.control`)));

  // THE important assertion.
  check("the interactive run's checkpoint is UNTOUCHED",
    interactiveFiles.every((p) => existsSync(p)));

  // The traces themselves are not cleanup's business.
  check("job rows survive the sweep", (await evalStore.jobsForEval(ctx, finishedEval.id)).length === 2);
  check("job run_ids survive, so drill-down still resolves",
    (await evalStore.jobsForEval(ctx, finishedEval.id)).every((j) => j.run_id !== null));
}

// --- idempotence -----------------------------------------------------------------------
{
  const again = await sweepEvalArtifacts(ctx, evalStore, checkpoints, finishedEval.id);
  check("sweeping twice removes nothing and fails nothing",
    again.removed === 0 && again.failed === 0);
}

// --- startup sweep of orphans ------------------------------------------------------------
{
  // A second eval, still RUNNING: its checkpoints are live and must be left alone.
  const liveEval = await evalStore.createEvalRun(ctx, {
    dataset_id: ds.id, agent_id: "agent-c", rubric_id: rubric.id,
    targets: [{ provider: "anthropic", model: "claude-haiku-4-5" }], budget_usd: null,
  });
  await evalStore.setEvalStatus(ctx, liveEval.id, "running");
  const [liveJob] = await evalStore.createJobs(ctx, liveEval.id, [
    { example_id: ex.id, provider: "anthropic", model: "claude-haiku-4-5" },
  ]);
  const liveRun = randomUUID();
  await evalStore.markJobRunning(ctx, liveJob!.id, liveRun, 0);
  const liveFiles = artifacts(liveRun);

  // A third eval that finished but whose sweep never ran (crash / restart).
  const crashedEval = await evalStore.createEvalRun(ctx, {
    dataset_id: ds.id, agent_id: "agent-c", rubric_id: rubric.id,
    targets: [{ provider: "anthropic", model: "claude-haiku-4-5" }], budget_usd: null,
  });
  const [crashedJob] = await evalStore.createJobs(ctx, crashedEval.id, [
    { example_id: ex.id, provider: "anthropic", model: "claude-haiku-4-5" },
  ]);
  const crashedRun = randomUUID();
  await evalStore.markJobRunning(ctx, crashedJob!.id, crashedRun, 0);
  await evalStore.finishJob(ctx, crashedJob!.id, "succeeded", {});
  await evalStore.setEvalStatus(ctx, crashedEval.id, "completed");
  artifacts(crashedRun);

  const res = await sweepOrphanedEvalArtifacts([ctx], evalStore, checkpoints);
  check("startup sweep collects the crashed eval's leftovers", res.removed === 4, `removed ${res.removed}`);
  check("a RUNNING eval's checkpoints are left alone", liveFiles.every((p) => existsSync(p)));
  check("the interactive run is still untouched by the startup sweep",
    interactiveFiles.every((p) => existsSync(p)));
}

// --- never fatal --------------------------------------------------------------------------
{
  const absent = new FileCheckpointStore(join(CKPT, "does-not-exist"));
  const missing = await sweepOrphanedEvalArtifacts([ctx], evalStore, absent);
  check("a missing checkpoint dir is a no-op, not a throw", missing.removed === 0);
}

// --- the same rules, as a thread-prefix delete ----------------------------------------------
//
// The hosted store deletes rows rather than files, so the one thing that must not change is
// WHICH runs it reaches: an eval's, from the eval's own job rows, and never an interactive
// run's. Run against tables LangGraph itself created, for the reason branch.test.ts gives.
await withScratchPostgres(async (pg, url) => {
  console.log("\nthe hosted sweep");
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("uv", ["run", "python", "-c", [
      "import os, psycopg",
      "from langgraph.checkpoint.postgres import PostgresSaver",
      "conn = psycopg.connect(os.environ['URL'], autocommit=True)",
      `conn.execute('CREATE SCHEMA IF NOT EXISTS ${CHECKPOINT_SCHEMA}')`,
      `conn.execute('SET search_path TO ${CHECKPOINT_SCHEMA}')`,
      "PostgresSaver(conn).setup()",
    ].join("\n")], {
      cwd: join(new URL("../..", import.meta.url).pathname, "runtime"),
      env: { ...process.env, URL: url },
      stdio: "pipe",
    });
  } catch (err) {
    console.log(`  (skipping: LangGraph's tables could not be created — ${(err as Error).message.split("\n")[0]})`);
    return;
  }

  const identity = new IdentityRepository(pg);
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `sweep ${randomUUID().slice(0, 6)}`,
  });
  const pgCtx = systemContextFor(ws.id, newRequestId());
  const pgTrace = new TraceStore(pg);
  await pgTrace.init();
  const pgEvals = new EvalStore(pgTrace.database());
  await pgEvals.init();
  const pgCheckpoints = new PgCheckpointStore(pg);

  /** One checkpoint row for a run, in that run's thread. */
  const checkpointFor = async (runId: string): Promise<void> => {
    await pg.run(
      `INSERT INTO ${CHECKPOINT_SCHEMA}.checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        checkpointThreadId(pgCtx.workspaceId, runId, "postgres"), "",
        `1efb0000-0000-6000-8000-${randomUUID().slice(-12)}`, null, "msgpack", "{}", "{}",
      ],
    );
  };

  const pgDataset = await pgEvals.createDataset(pgCtx, "agent-p", "sweep");
  const pgExample = await pgEvals.addExample(pgCtx, pgDataset.id, "hello");
  const pgRubric = await pgEvals.putRubric(pgCtx, { dataset_id: pgDataset.id, name: "r", criteria: [] });
  const done = await pgEvals.createEvalRun(pgCtx, {
    dataset_id: pgDataset.id, agent_id: "agent-p", rubric_id: pgRubric.id,
    targets: [{ provider: "anthropic", model: "claude-haiku-4-5" }], budget_usd: null,
  });
  const [job] = await pgEvals.createJobs(pgCtx, done.id, [
    { example_id: pgExample.id, provider: "anthropic", model: "claude-haiku-4-5" },
  ]);
  const evalRun = randomUUID();
  await pgEvals.markJobRunning(pgCtx, job!.id, evalRun, 0);
  await pgEvals.finishJob(pgCtx, job!.id, "succeeded", {});
  await pgEvals.setEvalStatus(pgCtx, done.id, "completed");

  // The run a user might come back to branch from. It is nobody's eval job, and that — not a
  // filename — is what keeps it out of the sweep.
  const interactiveRun = randomUUID();
  await checkpointFor(evalRun);
  await checkpointFor(interactiveRun);

  const swept = await sweepEvalArtifacts(pgCtx, pgEvals, pgCheckpoints, done.id);
  check("the eval's checkpoint rows are deleted", swept.removed === 1, `removed ${swept.removed}`);
  check("...so the eval run holds nothing", !(await pgCheckpoints.has(pgCtx, evalRun)));
  check("the interactive run's checkpoints survive", await pgCheckpoints.has(pgCtx, interactiveRun));

  await checkpointFor(evalRun);
  const orphans = await sweepOrphanedEvalArtifacts([pgCtx], pgEvals, pgCheckpoints);
  check("the startup sweep collects a finished eval's leftovers", orphans.removed === 1, `removed ${orphans.removed}`);
  check("...and still never the interactive run", await pgCheckpoints.has(pgCtx, interactiveRun));
  const again = await sweepOrphanedEvalArtifacts([pgCtx], pgEvals, pgCheckpoints);
  check("...and running it twice removes nothing the second time", again.removed === 0);
});

await store.close();
for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
rmSync(CKPT, { recursive: true, force: true });

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
