// Checkpoint sweeping — and the one thing it must never do.
//
// Every run drops a resumable checkpoint db, which is correct for the interactive run and
// wasteful at eval scale (50 examples × 3 providers = 150 databases nobody will resume).
// But the checkpoint of an INTERACTIVE run is exactly what a user comes back to branch
// from, so the dangerous failure here isn't leaving a stale file — it's deleting the wrong
// one, which silently breaks pause/resume/branch for a run the user still cares about.
//
//   npm run test:cleanup

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceStore } from "./store.ts";
import { EvalStore } from "./evalStore.ts";
import { sweepEvalArtifacts, sweepOrphanedEvalArtifacts } from "./evalCleanup.ts";

let fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ok   ${n}`);
  else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); }
};

const DB = join(tmpdir(), `jaroku-sweep-${randomUUID()}.db`);
const CKPT = mkdtempSync(join(tmpdir(), "jaroku-ckpt-"));
const store = new TraceStore(DB);
const evalStore = new EvalStore(store.connection());

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

const ds = evalStore.createDataset("agent-c", "sweep");
const ex = evalStore.addExample(ds.id, "hello");
const rubric = evalStore.putRubric({ dataset_id: null, name: "r", criteria: [] });

// An eval whose runs are finished, and an INTERACTIVE run that must survive untouched.
const finishedEval = evalStore.createEvalRun({
  dataset_id: ds.id, agent_id: "agent-c", rubric_id: rubric.id,
  targets: [{ provider: "anthropic", model: "claude-haiku-4-5" }], budget_usd: null,
});
const jobs = evalStore.createJobs(finishedEval.id, [
  { example_id: ex.id, provider: "anthropic", model: "claude-haiku-4-5" },
  { example_id: ex.id, provider: "anthropic", model: "claude-haiku-4-5" },
]);
const evalRun1 = randomUUID(), evalRun2 = randomUUID();
evalStore.markJobRunning(jobs[0]!.id, evalRun1, 0);
evalStore.markJobRunning(jobs[1]!.id, evalRun2, 0);
evalStore.finishJob(jobs[0]!.id, "succeeded", { cost_usd: 0.001 });
evalStore.finishJob(jobs[1]!.id, "succeeded", { cost_usd: 0.001 });
artifacts(evalRun1);
artifacts(evalRun2);

// The one that matters: a run the user drove by hand and might branch from.
const interactiveRun = randomUUID();
const interactiveFiles = artifacts(interactiveRun);

// --- per-eval sweep --------------------------------------------------------------------
{
  const res = sweepEvalArtifacts(evalStore, CKPT, finishedEval.id);
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
  check("job rows survive the sweep", evalStore.jobsForEval(finishedEval.id).length === 2);
  check("job run_ids survive, so drill-down still resolves",
    evalStore.jobsForEval(finishedEval.id).every((j) => j.run_id !== null));
}

// --- idempotence -----------------------------------------------------------------------
{
  const again = sweepEvalArtifacts(evalStore, CKPT, finishedEval.id);
  check("sweeping twice removes nothing and fails nothing",
    again.removed === 0 && again.failed === 0);
}

// --- startup sweep of orphans ------------------------------------------------------------
{
  // A second eval, still RUNNING: its checkpoints are live and must be left alone.
  const liveEval = evalStore.createEvalRun({
    dataset_id: ds.id, agent_id: "agent-c", rubric_id: rubric.id,
    targets: [{ provider: "anthropic", model: "claude-haiku-4-5" }], budget_usd: null,
  });
  evalStore.setEvalStatus(liveEval.id, "running");
  const [liveJob] = evalStore.createJobs(liveEval.id, [
    { example_id: ex.id, provider: "anthropic", model: "claude-haiku-4-5" },
  ]);
  const liveRun = randomUUID();
  evalStore.markJobRunning(liveJob!.id, liveRun, 0);
  const liveFiles = artifacts(liveRun);

  // A third eval that finished but whose sweep never ran (crash / restart).
  const crashedEval = evalStore.createEvalRun({
    dataset_id: ds.id, agent_id: "agent-c", rubric_id: rubric.id,
    targets: [{ provider: "anthropic", model: "claude-haiku-4-5" }], budget_usd: null,
  });
  const [crashedJob] = evalStore.createJobs(crashedEval.id, [
    { example_id: ex.id, provider: "anthropic", model: "claude-haiku-4-5" },
  ]);
  const crashedRun = randomUUID();
  evalStore.markJobRunning(crashedJob!.id, crashedRun, 0);
  evalStore.finishJob(crashedJob!.id, "succeeded", {});
  evalStore.setEvalStatus(crashedEval.id, "completed");
  artifacts(crashedRun);

  const res = sweepOrphanedEvalArtifacts(evalStore, CKPT);
  check("startup sweep collects the crashed eval's leftovers", res.removed === 4, `removed ${res.removed}`);
  check("a RUNNING eval's checkpoints are left alone", liveFiles.every((p) => existsSync(p)));
  check("the interactive run is still untouched by the startup sweep",
    interactiveFiles.every((p) => existsSync(p)));
}

// --- never fatal --------------------------------------------------------------------------
{
  const missing = sweepOrphanedEvalArtifacts(evalStore, join(CKPT, "does-not-exist"));
  check("a missing checkpoint dir is a no-op, not a throw", missing.removed === 0);
}

store.close();
for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
rmSync(CKPT, { recursive: true, force: true });

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
