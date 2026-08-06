// Move a local single-user install into a workspace on the hosted database.
//
//   npm run import -- --workspace "Ada's Team" --dry-run
//   JAROKU_DB_DRIVER=postgres JAROKU_PG_URL=postgres://… npm run import -- --workspace "Ada's Team"
//
// The one migration path that matters to somebody who has been using Jaroku already. They
// have traces they care about, eval comparisons they paid for, MCP servers they connected
// and deployments that are still running — and none of it is in the hosted database. This
// reads the SQLite file and writes it into one named workspace.
//
// THREE PROPERTIES, and each is here because of what goes wrong without it:
//
//   IDEMPOTENT. Every insert is ON CONFLICT DO NOTHING on a primary key the source already
//   assigned, so running it twice imports nothing the second time. That is what makes it
//   safe to re-run after a failure without first working out how far it got.
//
//   RESUMABLE, which falls out of the above rather than needing a cursor. An import that
//   dies at step 40,000 is resumed by running it again: the rows already there conflict and
//   are skipped, and the ones that are not are written.
//
//   DRY-RUN FIRST. `--dry-run` reads everything, resolves the workspace, counts what would
//   move, and writes nothing at all. The point is not caution for its own sake — it is that
//   "how much is in here" is the question somebody asks before they trust this, and the
//   honest way to answer it is to do the whole read.
//
// Rows keep their ids. A run id appears in eval_jobs.run_id, a dataset id in eval_runs, an
// mcp server id in an agent's manifest on disk — remapping any of them would mean rewriting
// all of them, including the ones inside files this command does not own.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { migrate } from "./migrate.ts";
import { openDb, PG_URL_ENV } from "./open.ts";
import { SqliteDb } from "./sqlite.ts";
import { IdentityRepository, slugify } from "./repositories/identity.ts";
import { newRequestId, systemContext, systemContextFor } from "./tenant.ts";
import type { Db } from "./db.ts";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Args {
  from: string;
  workspace: string;
  dryRun: boolean;
  batch: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    from: join(SERVER_DIR, "jaroku.db"),
    workspace: "Imported",
    dryRun: false,
    batch: 500,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--from") args.from = argv[++i] ?? args.from;
    else if (a === "--workspace") args.workspace = argv[++i] ?? args.workspace;
    else if (a === "--batch") args.batch = Math.max(1, Number(argv[++i] ?? args.batch) || args.batch);
    else if (a === "--help" || a === "-h") {
      console.log(
        `usage: npm run import -- [--from <sqlite.db>] [--workspace <name>] [--batch N] [--dry-run]\n` +
          `  --from       the SQLite file to read (default: server/jaroku.db)\n` +
          `  --workspace  the workspace to import into, created if absent\n` +
          `  --dry-run    read and count, write nothing\n`,
      );
      process.exit(0);
    } else if (a?.startsWith("-")) {
      console.error(`unknown option: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

/**
 * The tables to copy, in dependency order.
 *
 * Order matters on Postgres, where the foreign keys are real: a step cannot arrive before its
 * run, an eval job before its eval. It costs nothing on SQLite, where they are not enforced.
 *
 * `columns` is written out rather than discovered, so a column added to one dialect and not
 * the other cannot silently make this copy the wrong shape.
 */
const TABLES: { name: string; columns: string[]; conflict: string }[] = [
  {
    name: "agents",
    columns: [
      "id", "slug", "display_name", "description", "connectors", "mcp_tools", "required_env",
      "default_provider", "hand_written", "current_version", "creation_cost", "created_at",
      "deleted_at",
    ],
    conflict: "(workspace_id, slug)",
  },
  {
    name: "runs",
    columns: [
      "id", "agent_id", "provider", "model", "status", "started_at", "ended_at", "cost",
      "tokens", "error", "parent_run_id", "branch_from_seq",
    ],
    conflict: "(id)",
  },
  {
    name: "steps",
    columns: [
      "id", "run_id", "seq", "type", "name", "input", "output", "state_before", "state_after",
      "tokens", "cost", "latency_ms", "error", "parent_step_id", "started_at", "checkpoint_id",
    ],
    conflict: "(id)",
  },
  { name: "datasets", columns: ["id", "agent_id", "name", "created_at", "updated_at"], conflict: "(id)" },
  {
    name: "dataset_examples",
    columns: ["id", "dataset_id", "input", "expected", "notes", "position", "created_at"],
    conflict: "(id)",
  },
  {
    name: "rubrics",
    columns: ["id", "dataset_id", "name", "criteria", "created_at", "updated_at"],
    conflict: "(id)",
  },
  {
    name: "eval_runs",
    columns: [
      "id", "dataset_id", "agent_id", "rubric_id", "status", "targets", "budget_usd",
      "judge_cost_usd", "started_at", "ended_at", "error",
    ],
    conflict: "(id)",
  },
  {
    name: "eval_jobs",
    columns: [
      "id", "eval_id", "example_id", "provider", "model", "status", "attempt", "run_id",
      "cost_usd", "tokens", "latency_ms", "cost_complete", "error", "started_at", "ended_at",
      "retry_not_before", "spent_usd", "position",
    ],
    conflict: "(id)",
  },
  {
    name: "eval_scores",
    columns: [
      "id", "job_id", "score", "per_criterion", "rationale", "judge_model", "judge_cost_usd",
      "error", "created_at",
    ],
    conflict: "(id)",
  },
  {
    name: "mcp_servers",
    columns: [
      "id", "label", "endpoint", "transport", "auth_env_key", "server_name", "server_version",
      "protocol_version", "status", "last_error", "discovered_at", "created_at",
    ],
    conflict: "(workspace_id, id)",
  },
  {
    name: "mcp_tools",
    columns: [
      "id", "server_id", "name", "description", "input_schema", "schema_hash", "impact",
      "impact_reason", "impact_override", "override_schema_hash", "annotations", "discovered_at",
    ],
    conflict: "(workspace_id, server_id, name)",
  },
  {
    name: "deployments",
    columns: [
      "id", "agent_id", "target", "status", "url", "provider", "model", "env_keys",
      "railway_project_id", "railway_service_id", "railway_environment_id",
      "railway_deployment_id", "error", "created_at", "updated_at", "ended_at", "created_seq",
    ],
    conflict: "(id)",
  },
  {
    name: "deployment_logs",
    columns: ["deployment_id", "seq", "ts", "stage", "stream", "text"],
    conflict: "(deployment_id, seq)",
  },
];

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.from)) {
    console.error(`[import] no such file: ${args.from}`);
    return 1;
  }

  const driver = process.env.JAROKU_DB_DRIVER ?? "sqlite";
  if (driver === "sqlite" && !process.env.JAROKU_DB) {
    // Importing a database into itself is a no-op at best and a confusing one. Say so rather
    // than doing thirteen tables' worth of nothing.
    console.error(
      `[import] JAROKU_DB_DRIVER is sqlite and no separate JAROKU_DB is set, so the source\n` +
        `         and the destination are the same file. Set ${PG_URL_ENV} and\n` +
        `         JAROKU_DB_DRIVER=postgres, or point JAROKU_DB at a different file.`,
    );
    return 1;
  }

  // Existing is not the same as readable. `--from` is a path a person typed, so the wrong
  // one is the common case: a `.db-wal` beside the database, a half-finished download, a
  // text file, an encrypted database. Opening any of those throws out of the constructor
  // before the try block below exists, and the user gets a Node stack trace naming
  // sqlite.ts:57 — a line in our code, about a file of theirs.
  let source: SqliteDb;
  try {
    source = new SqliteDb(args.from);
  } catch (err) {
    console.error(
      `[import] ${args.from} could not be opened as a SQLite database — ` +
        `${(err as Error).message}.\n` +
        `         --from wants a jaroku.db itself, not its -wal or -shm sidecar.`,
    );
    return 1;
  }

  const dest = openDb({ sqlitePath: process.env.JAROKU_DB ?? join(SERVER_DIR, "jaroku.db") });

  try {
    // The destination has to be current, or a column this copies has nowhere to land.
    await migrate(dest.migrationTarget(), join(SERVER_DIR, "migrations", dest.dialect), () => {});

    const sys = systemContext(newRequestId());
    const identity = new IdentityRepository(dest);
    const slug = slugify(args.workspace);

    let workspace = await identity.workspaceBySlug(sys, slug);
    if (!workspace && args.dryRun) {
      console.log(`[import] would create workspace "${args.workspace}" (${slug})`);
    } else if (!workspace) {
      // No owner: nobody has signed in yet, and inventing a user to hold this would put a
      // person in the members list who does not exist. Session 2's first sign-in adopts it.
      workspace = await identity.createWorkspaceUnowned(sys, { name: args.workspace, kind: "team" });
      console.log(`[import] created workspace "${workspace.name}" (${workspace.slug})`);
    } else {
      console.log(`[import] importing into existing workspace "${workspace.name}" (${workspace.slug})`);
    }

    const ctx = systemContextFor(workspace?.id ?? "00000000-0000-0000-0000-000000000000", sys.requestId);
    let total = 0;
    let skipped = 0;

    for (const table of TABLES) {
      const read = await readAll(source, table.name, table.columns);
      if (!read) {
        console.log(`  ${table.name.padEnd(18)} — no such table in this source`);
        continue;
      }
      const { rows, missing, present } = read;
      const note = missing.length ? ` (source has no ${missing.join(", ")}; defaulted)` : "";
      if (!rows.length) {
        console.log(`  ${table.name.padEnd(18)} 0`);
        continue;
      }
      if (args.dryRun || !workspace) {
        console.log(`  ${table.name.padEnd(18)} ${rows.length} would be imported${note}`);
        total += rows.length;
        continue;
      }
      if (missing.length) console.log(`  ${table.name.padEnd(18)} ${note.trim()}`);

      let wrote = 0;
      for (let i = 0; i < rows.length; i += args.batch) {
        const batch = rows.slice(i, i + args.batch);
        // One transaction per batch, with the scope set once for all of it — the reason
        // `scoped` exists alongside `forWorkspace`. Restartable at batch granularity, which
        // is what makes a very large `steps` table survive an interruption.
        await dest.scoped(ctx.workspaceId, async (tx) => {
          for (const row of batch) {
            // Only the columns the source actually had. A missing one is OMITTED rather than
            // passed as NULL, because an explicit NULL overrides the destination's DEFAULT —
            // which is how `position`, NOT NULL with a default of 0, fails on a source that
            // predates it. Omitting is what "defaulted" has to mean.
            const cols = ["workspace_id", ...present];
            const placeholders = cols.map(() => "?").join(", ");
            const res = await tx.run(
              `INSERT INTO ${table.name} (${cols.join(", ")}) VALUES (${placeholders})
               ON CONFLICT ${table.conflict} DO NOTHING`,
              [ctx.workspaceId, ...present.map((c) => row[c] ?? null)],
            );
            if (res.changes > 0) wrote++;
          }
        });
      }
      skipped += rows.length - wrote;
      total += wrote;
      console.log(
        `  ${table.name.padEnd(18)} ${wrote}` +
          (rows.length - wrote ? ` (${rows.length - wrote} already there)` : ""),
      );
    }

    console.log(
      args.dryRun
        ? `\n[import] dry run: ${total} row(s) would move. Nothing was written.`
        : `\n[import] ${total} row(s) imported${skipped ? `, ${skipped} already present` : ""}.`,
    );
    if (!args.dryRun) {
      console.log(
        `[import] runtime/agents/ was NOT copied — the projects still live on this machine's\n` +
          `         disk. Session 3 moves them to the object store; until then a hosted server\n` +
          `         needs them on its own filesystem.`,
      );
    }
    return 0;
  } finally {
    await source.close();
    await dest.close();
  }
}

/**
 * Read a table, taking whatever of it this source actually has.
 *
 * The source is somebody's real jaroku.db and it can be any age: a table added last month is
 * simply absent, and a column added last week is missing from a table that is otherwise full
 * of rows. Selecting the current column list and giving up on an error would throw away
 * every eval job because `position` — added in the port off SQLite's rowid — is not there.
 *
 * So the columns are intersected with what the source declares, and the rest arrive as NULL,
 * where the destination's own defaults take over. An absent table is genuinely nothing to
 * import and says so once.
 */
async function readAll(
  source: Db,
  table: string,
  columns: string[],
): Promise<{ rows: Record<string, unknown>[]; present: string[]; missing: string[] } | null> {
  const info = await source.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!info.length) return null; // no such table in this source
  const have = new Set(info.map((c) => c.name));
  const present = columns.filter((c) => have.has(c));
  const missing = columns.filter((c) => !have.has(c));
  const rows = await source.all<Record<string, unknown>>(
    `SELECT ${present.join(", ")} FROM ${table}`,
  );
  return { rows, present, missing };
}

process.exit(await main());
