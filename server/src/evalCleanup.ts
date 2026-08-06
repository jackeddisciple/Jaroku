// Sweeping the resumable-checkpoint blobs an eval leaves behind.
//
// Every run is driven through a checkpointed twin (jaroku_runner/debug.py) so it can be
// paused, resumed and branched — which means every run drops a `<run_id>.sqlite` under
// runtime/.checkpoints/. That's the right trade for the interactive run the user is
// driving. It is the wrong trade at eval scale: fifty examples across three providers is
// 150 checkpoint databases per eval, for runs nobody will ever resume.
//
// WHAT IS AND ISN'T DELETED, precisely:
//   * DELETED — the checkpoint db and control file for an eval job's run. These exist only
//     to make a run resumable; the eval is over and nothing will resume it.
//   * KEPT — the run row, every step, the job row, the score, the trace. Drill-down still
//     opens the full timeline afterwards, which is the whole point of building eval jobs
//     on the ordinary run path.
//   * NEVER TOUCHED — anything belonging to an interactive run. Those are exactly the runs
//     a user might come back to and branch from.
//
// The sweep is best-effort by design: a file that won't delete is a warning, never a
// failure. Losing an eval's results to a cleanup error would be a far worse bug than
// leaving a stale blob on disk.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EvalStore } from "./evalStore.ts";
import { systemContextFor, type SystemContext, type TenantContext } from "./db/tenant.ts";

export interface SweepResult {
  removed: number;
  bytesFreed: number;
  failed: number;
}

/** Artifacts a single run leaves in .checkpoints/. */
function artifactsFor(checkpointDir: string, runId: string): string[] {
  return [
    join(checkpointDir, `${runId}.sqlite`),
    // SQLite WAL sidecars — deleting only the main file would leave these orphaned.
    join(checkpointDir, `${runId}.sqlite-wal`),
    join(checkpointDir, `${runId}.sqlite-shm`),
    join(checkpointDir, `${runId}.control`),
    join(checkpointDir, `${runId}.edit.json`),
  ];
}

/**
 * Drop the checkpoint artifacts for one finished eval's runs.
 *
 * Only touches runs recorded as this eval's jobs, so an interactive run can never be
 * caught in the sweep even if it happened to be executing at the same time.
 */
export async function sweepEvalArtifacts(
  ctx: TenantContext,
  evalStore: EvalStore,
  checkpointDir: string,
  evalId: string,
): Promise<SweepResult> {
  const out: SweepResult = { removed: 0, bytesFreed: 0, failed: 0 };
  if (!existsSync(checkpointDir)) return out;

  for (const job of await evalStore.jobsForEval(ctx, evalId)) {
    if (!job.run_id) continue;
    for (const path of artifactsFor(checkpointDir, job.run_id)) {
      if (!existsSync(path)) continue;
      try {
        out.bytesFreed += statSync(path).size;
        rmSync(path, { force: true });
        out.removed++;
      } catch {
        // Best effort: a stale blob is a much smaller problem than a failed cleanup
        // taking down the path that reports an eval's results.
        out.failed++;
      }
    }
  }
  return out;
}

/**
 * Startup sweep: checkpoint blobs whose run belongs to a FINISHED eval.
 *
 * Catches evals interrupted by a crash or a restart, whose per-eval sweep never ran. A
 * checkpoint whose run id isn't an eval job's is left strictly alone — that's either an
 * interactive run or something we don't understand, and neither is ours to delete.
 */
export async function sweepOrphanedEvalArtifacts(
  ctx: SystemContext,
  evalStore: EvalStore,
  checkpointDir: string,
): Promise<SweepResult> {
  const out: SweepResult = { removed: 0, bytesFreed: 0, failed: 0 };
  if (!existsSync(checkpointDir)) return out;

  // Run ids belonging to evals that are over. An eval still in flight keeps its files.
  const finished = new Set<string>();
  // Across every workspace, deliberately. A startup sweep that only collected one tenant's
  // orphans would leave everyone else's checkpoint blobs on disk forever — the scope here is
  // "this machine", which is what a SystemContext means.
  for (const run of await evalStore.finishedEvalRunsAcrossWorkspaces(ctx, 500)) {
    for (const job of await evalStore.jobsForEval(
      systemContextFor(run.workspace_id, ctx.requestId),
      run.id,
    )) {
      if (job.run_id) finished.add(job.run_id);
    }
  }
  if (!finished.size) return out;

  for (const entry of readdirSync(checkpointDir)) {
    // Strip every known suffix to recover the run id the file belongs to.
    const runId = entry
      .replace(/\.sqlite(-wal|-shm)?$/, "")
      .replace(/\.control$/, "")
      .replace(/\.edit\.json$/, "");
    if (!finished.has(runId)) continue; // not an eval job's — leave it alone
    const path = join(checkpointDir, entry);
    try {
      out.bytesFreed += statSync(path).size;
      rmSync(path, { force: true });
      out.removed++;
    } catch {
      out.failed++;
    }
  }
  return out;
}

/** "1.4 MB" / "812 KB" — for the one log line this feature produces. */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
