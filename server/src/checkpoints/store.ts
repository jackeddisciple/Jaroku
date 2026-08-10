// Branching, and sweeping, without a filesystem.
//
// Branching used to be `copyFileSync(parent.sqlite, branch.sqlite)`: a physical copy of the
// parent's whole checkpoint database, so that re-entering it could not possibly touch the
// parent. That is a good guarantee bought in the crudest possible way, and it does not survive
// the move — there is no file to copy when the checkpoints are rows in a shared table.
//
// So the guarantee is bought differently and is the SAME guarantee: the parent's rows are only
// ever read. A fork is an `INSERT … SELECT` of the parent's checkpoints up to the fork point
// into a new thread, and every statement that touches the parent is a SELECT. The test proves
// it by hashing the parent's rows before and after.
//
// COLUMNS ARE DISCOVERED, NOT DECLARED. These tables belong to LangGraph. Its migrations run on
// its timetable (see migration 017), and it has added columns before — `checkpoint_writes` grew
// a `task_path`. A copy written against a hard-coded column list would silently stop copying a
// column the day one is added, and the failure would be a branch whose state is subtly
// incomplete rather than an error. So the column list is read from `information_schema` and
// every column is copied by name, with `thread_id` rewritten. The only names this code knows
// are the three it has to reason about: `thread_id`, `checkpoint_id`, and the tables themselves.
//
// TWO IMPLEMENTATIONS, as everywhere else in this session. `FileCheckpointStore` is the local
// path and does exactly what it did before. `PgCheckpointStore` is the hosted one.

import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/db.ts";
import { asInt } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";
import {
  CHECKPOINT_SCHEMA, checkpointThreadId, runIdFromThread, workspaceThreadPrefix,
  type CheckpointerKind,
} from "./threads.ts";

export interface ForkRequest {
  /** The run being branched FROM. Read only, always. */
  fromRunId: string;
  /** The new run the copy belongs to. */
  toRunId: string;
  /** The boundary to copy up to, inclusive. */
  checkpointId: string;
}

export interface SweepResult {
  removed: number;
  bytesFreed: number;
  failed: number;
}

export interface CheckpointStore {
  readonly kind: CheckpointerKind;
  /** Whether this run has a durable checkpoint at all. What branching needs to know first. */
  has(ctx: TenantContext, runId: string): Promise<boolean>;
  /** Copy a parent's checkpoints up to the fork point into a new run's thread. */
  fork(ctx: TenantContext, req: ForkRequest): Promise<{ copied: number }>;
  /** Drop everything belonging to these runs. Best-effort, like the sweep it serves. */
  sweepRuns(ctx: TenantContext, runIds: string[]): Promise<SweepResult>;
  /** Every run id this store currently holds checkpoints for, within this workspace. */
  runsHeld(ctx: TenantContext): Promise<string[]>;
}

// --- the local one --------------------------------------------------------------------------

/** Artifacts a single run leaves in `.checkpoints/`. */
export function fileArtifactsFor(checkpointDir: string, runId: string): string[] {
  return [
    join(checkpointDir, `${runId}.sqlite`),
    // SQLite WAL sidecars — deleting only the main file would leave these orphaned.
    join(checkpointDir, `${runId}.sqlite-wal`),
    join(checkpointDir, `${runId}.sqlite-shm`),
    join(checkpointDir, `${runId}.control`),
    join(checkpointDir, `${runId}.edit.json`),
  ];
}

export class FileCheckpointStore implements CheckpointStore {
  readonly kind = "sqlite" as const;

  constructor(private readonly checkpointDir: string) {}

  async has(_ctx: TenantContext, runId: string): Promise<boolean> {
    return existsSync(join(this.checkpointDir, `${runId}.sqlite`));
  }

  /**
   * A physical copy of the parent's database.
   *
   * Unchanged, and deliberately not "improved" into a row copy. The parent's file is opened
   * read-only by `copyFileSync` and the branch then runs against its own copy, which is a
   * stronger immutability guarantee than any query could give — and this is the path a
   * developer with no database runs, so making it cleverer would be making the local path
   * carry a risk it has no reason to.
   *
   * `checkpointId` is unused here: the copy contains every checkpoint, and the runner re-enters
   * at the one it was told to. Present in the signature because the hosted store cannot copy
   * everything and must be told where to stop.
   */
  async fork(_ctx: TenantContext, req: ForkRequest): Promise<{ copied: number }> {
    const parent = join(this.checkpointDir, `${req.fromRunId}.sqlite`);
    if (!existsSync(parent)) return { copied: 0 };
    copyFileSync(parent, join(this.checkpointDir, `${req.toRunId}.sqlite`));
    return { copied: 1 };
  }

  async sweepRuns(_ctx: TenantContext, runIds: string[]): Promise<SweepResult> {
    const out: SweepResult = { removed: 0, bytesFreed: 0, failed: 0 };
    if (!existsSync(this.checkpointDir)) return out;
    for (const runId of runIds) {
      for (const path of fileArtifactsFor(this.checkpointDir, runId)) {
        if (!existsSync(path)) continue;
        try {
          out.bytesFreed += statSync(path).size;
          rmSync(path, { force: true });
          out.removed++;
        } catch {
          // Best effort: a stale blob is a much smaller problem than a failed cleanup taking
          // down the path that reports an eval's results.
          out.failed++;
        }
      }
    }
    return out;
  }

  /**
   * Every run with something on disk.
   *
   * NOT scoped, and cannot be: a filename is a run id and nothing else. That is the honest
   * limit of the local path — the caller intersects this with the runs its workspace owns,
   * which is what the sweep does and what makes the shape identical on both stores.
   */
  async runsHeld(_ctx: TenantContext): Promise<string[]> {
    if (!existsSync(this.checkpointDir)) return [];
    const ids = new Set<string>();
    for (const entry of readdirSync(this.checkpointDir)) {
      ids.add(
        entry
          .replace(/\.sqlite(-wal|-shm)?$/, "")
          .replace(/\.control$/, "")
          .replace(/\.edit\.json$/, ""),
      );
    }
    return [...ids];
  }
}

// --- the hosted one -------------------------------------------------------------------------

/** The tables LangGraph writes. `checkpoint_migrations` is its own bookkeeping and is not ours. */
const CHECKPOINT_TABLES = ["checkpoints", "checkpoint_blobs", "checkpoint_writes"] as const;

export class PgCheckpointStore implements CheckpointStore {
  readonly kind = "postgres" as const;
  /** table -> columns, read once. LangGraph does not change its schema inside a process. */
  private columns = new Map<string, string[]>();

  constructor(private readonly db: Db) {}

  private thread(ctx: TenantContext, runId: string): string {
    return checkpointThreadId(ctx.workspaceId, runId, "postgres");
  }

  /**
   * The columns a LangGraph table actually has, right now.
   *
   * Read rather than declared — see the note at the top of this file. A table that does not
   * exist yet answers empty, which is correct: nothing has run against this database, so there
   * is nothing to fork or sweep.
   */
  private async columnsOf(table: string): Promise<string[]> {
    const cached = this.columns.get(table);
    if (cached) return cached;
    const rows = await this.db.all<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
      [CHECKPOINT_SCHEMA, table],
    );
    const cols = rows.map((r) => r.column_name);
    this.columns.set(table, cols);
    return cols;
  }

  async has(ctx: TenantContext, runId: string): Promise<boolean> {
    if (!(await this.columnsOf("checkpoints")).length) return false;
    const row = await this.db.get<{ n: unknown }>(
      `SELECT COUNT(*) AS n FROM ${CHECKPOINT_SCHEMA}.checkpoints WHERE thread_id = ?`,
      [this.thread(ctx, runId)],
    );
    return asInt(row?.n, 0) > 0;
  }

  /**
   * Copy the parent's checkpoints up to the fork point into a new thread.
   *
   * ONE TRANSACTION, so a branch either has a complete prefix or none of it — a half-copied
   * thread is a graph that resumes into a state that never existed.
   *
   * `checkpoint_id <= $target` is the prefix, and it works because LangGraph mints checkpoint
   * ids as UUID6: they sort lexically in the order they were created. That is a property of
   * somebody else's id scheme, so it is stated here rather than assumed silently — and the test
   * asserts the branch stops where it was told rather than trusting the comparison.
   *
   * `checkpoint_blobs` has no `checkpoint_id` and is copied whole. Its rows are addressed by
   * channel and version, a later checkpoint's blobs are simply unreferenced by an earlier one,
   * and copying them all is what makes the fork's channel reads resolve.
   */
  async fork(ctx: TenantContext, req: ForkRequest): Promise<{ copied: number }> {
    const from = this.thread(ctx, req.fromRunId);
    const to = this.thread(ctx, req.toRunId);
    let copied = 0;

    await this.db.transaction(async (tx) => {
      for (const table of CHECKPOINT_TABLES) {
        const cols = await this.columnsOf(table);
        if (!cols.length) continue;
        const select = cols.map((c) => (c === "thread_id" ? "?" : `"${c}"`)).join(", ");
        const bounded = cols.includes("checkpoint_id");
        const result = await tx.run(
          `INSERT INTO ${CHECKPOINT_SCHEMA}.${table} (${cols.map((c) => `"${c}"`).join(", ")})
           SELECT ${select} FROM ${CHECKPOINT_SCHEMA}.${table}
            WHERE thread_id = ?${bounded ? " AND checkpoint_id <= ?" : ""}
           ON CONFLICT DO NOTHING`,
          bounded ? [to, from, req.checkpointId] : [to, from],
        );
        copied += result.changes;
      }
    });
    return { copied };
  }

  async sweepRuns(ctx: TenantContext, runIds: string[]): Promise<SweepResult> {
    const out: SweepResult = { removed: 0, bytesFreed: 0, failed: 0 };
    if (!runIds.length || !(await this.columnsOf("checkpoints")).length) return out;
    const threads = runIds.map((id) => this.thread(ctx, id));
    const holes = threads.map(() => "?").join(", ");
    for (const table of CHECKPOINT_TABLES) {
      if (!(await this.columnsOf(table)).length) continue;
      try {
        const result = await this.db.run(
          `DELETE FROM ${CHECKPOINT_SCHEMA}.${table} WHERE thread_id IN (${holes})`,
          threads,
        );
        out.removed += result.changes;
      } catch {
        // Best effort, exactly as the file sweep is. Losing an eval's results to a cleanup
        // error would be a far worse bug than leaving rows behind.
        out.failed++;
      }
    }
    // Rows, not bytes. The file store reports what it freed because it can stat a file; asking
    // Postgres would be a pg_column_size sum per row, which costs more than the number is worth.
    return out;
  }

  /**
   * Every run this workspace has checkpoints for.
   *
   * A prefix scan, which is the whole reason the workspace is in the thread id: there is no
   * row-level security in this schema and no workspace column to filter on, so the key is the
   * only thing that separates one tenant's threads from another's.
   */
  async runsHeld(ctx: TenantContext): Promise<string[]> {
    if (!(await this.columnsOf("checkpoints")).length) return [];
    const rows = await this.db.all<{ thread_id: string }>(
      `SELECT DISTINCT thread_id FROM ${CHECKPOINT_SCHEMA}.checkpoints WHERE thread_id LIKE ?`,
      [`${workspaceThreadPrefix(ctx.workspaceId)}%`],
    );
    return rows.map((r) => runIdFromThread(r.thread_id));
  }
}

/** The store this process uses. One place, like every other `open`. */
export function openCheckpointStore(
  kind: CheckpointerKind,
  opts: { checkpointDir: string; db: Db },
): CheckpointStore {
  return kind === "sqlite" ? new FileCheckpointStore(opts.checkpointDir) : new PgCheckpointStore(opts.db);
}
