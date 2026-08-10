// Sweeping the resumable-checkpoint state an eval leaves behind.
//
// Every run is driven through a checkpointed twin (jaroku_runner/debug.py) so it can be
// paused, resumed and branched — which means every run leaves durable checkpoints behind.
// That's the right trade for the interactive run the user is driving. It is the wrong trade
// at eval scale: fifty examples across three providers is 150 checkpointed runs, for runs
// nobody will ever resume.
//
// WHAT IS AND ISN'T DELETED, precisely:
//   * DELETED — the checkpoint state for an eval job's run. It exists only to make a run
//     resumable; the eval is over and nothing will resume it.
//   * KEPT — the run row, every step, the job row, the score, the trace. Drill-down still
//     opens the full timeline afterwards, which is the whole point of building eval jobs
//     on the ordinary run path.
//   * NEVER TOUCHED — anything belonging to an interactive run. Those are exactly the runs
//     a user might come back to and branch from.
//
// WHAT CHANGED IN SESSION 3. This used to unlink files under `runtime/.checkpoints/`, which is
// the only thing it could do when a checkpoint was a file. It now asks the CheckpointStore, so
// the sweep is a file unlink locally and a delete by thread hosted — and the rules above are
// enforced in one place rather than once per storage medium. The run ids it deletes come from
// the eval's own job rows either way, which is what makes "an interactive run is never swept"
// true by construction rather than by a filename pattern.
//
// The sweep is best-effort by design: something that will not delete is a warning, never a
// failure. Losing an eval's results to a cleanup error would be a far worse bug than
// leaving stale state behind.

import type { EvalStore } from "./evalStore.ts";
import type { TenantContext } from "./db/tenant.ts";
import type { CheckpointStore, SweepResult } from "./checkpoints/store.ts";

export type { SweepResult };

/**
 * Drop the checkpoint state for one finished eval's runs.
 *
 * Only touches runs recorded as this eval's jobs, so an interactive run can never be caught in
 * the sweep even if it happened to be executing at the same time.
 */
export async function sweepEvalArtifacts(
  ctx: TenantContext,
  evalStore: EvalStore,
  checkpoints: CheckpointStore,
  evalId: string,
): Promise<SweepResult> {
  const runIds: string[] = [];
  for (const job of await evalStore.jobsForEval(ctx, evalId)) {
    if (job.run_id) runIds.push(job.run_id);
  }
  if (!runIds.length) return { removed: 0, bytesFreed: 0, failed: 0 };
  return checkpoints.sweepRuns(ctx, runIds);
}

/**
 * Startup sweep: checkpoint state whose run belongs to a FINISHED eval.
 *
 * Catches evals interrupted by a crash or a restart, whose per-eval sweep never ran. State
 * whose run id isn't an eval job's is left strictly alone — that's either an interactive run
 * or something we don't understand, and neither is ours to delete.
 *
 * The intersection is what makes that true, and it is why the store's `runsHeld` is allowed to
 * be unscoped on the local path: whatever it reports, only the ids this workspace's finished
 * evals actually name are swept.
 */
export async function sweepOrphanedEvalArtifacts(
  contexts: TenantContext[],
  evalStore: EvalStore,
  checkpoints: CheckpointStore,
): Promise<SweepResult> {
  const out: SweepResult = { removed: 0, bytesFreed: 0, failed: 0 };

  // A workspace at a time, across all of them. The sweep still cleans a whole machine's state;
  // it just cannot do that with one unscoped query, because under RLS as the application role
  // an unscoped query returns nothing at all.
  for (const ctx of contexts) {
    // Run ids belonging to evals that are over. An eval still in flight keeps its checkpoints.
    const finished = new Set<string>();
    for (const run of await evalStore.finishedEvalRuns(ctx, 500)) {
      for (const job of await evalStore.jobsForEval(ctx, run.id)) {
        if (job.run_id) finished.add(job.run_id);
      }
    }
    if (!finished.size) continue;

    // Intersected with what the store is actually holding, so a run whose checkpoints were
    // already swept does not count as a deletion and the reported number stays honest.
    const held = (await checkpoints.runsHeld(ctx)).filter((id) => finished.has(id));
    if (!held.length) continue;
    const swept = await checkpoints.sweepRuns(ctx, held);
    out.removed += swept.removed;
    out.bytesFreed += swept.bytesFreed;
    out.failed += swept.failed;
  }
  return out;
}

/** "1.4 MB" / "812 KB" — for the one log line this feature produces. */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
