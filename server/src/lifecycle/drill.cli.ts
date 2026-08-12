// Perform a restore drill, and print what happened.
//
//   npm run drill:restore                     # against a scratch SQLite database it seeds
//   npm run drill:restore -- --db ./jaroku.db # against a real one, read-only
//   JAROKU_PG_URL=… npm run drill:restore     # against Postgres, into a scratch schema
//
// THE OUTPUT IS THE RUNBOOK'S SOURCE. `deploy/backup/RUNBOOK.md` is written from a real run of
// this — including the parts that were surprising — because a runbook written from what somebody
// imagined a restore would do is a runbook that is wrong in exactly the places that matter.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDb } from "../db/sqlite.ts";
import { migrate } from "../db/migrate.ts";
import { describeDrill, runRestoreDrill, seedForDrill } from "./restoreDrill.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dbArg = process.argv.indexOf("--db");
const sourcePath = dbArg >= 0 ? process.argv[dbArg + 1]! : null;

const tmp = mkdtempSync(join(tmpdir(), "jaroku-drill-"));
const migrationsDir = join(SERVER_DIR, "migrations", "sqlite");

const source = new SqliteDb(sourcePath ?? join(tmp, "source.db"));
await migrate(source.migrationTarget(), migrationsDir, () => {});
if (!sourcePath) {
  console.log("[drill] no --db given; seeding a scratch source");
  await seedForDrill(source);
}

const target = new SqliteDb(join(tmp, "restored.db"));

const report = await runRestoreDrill({ source, target, migrationsDir });
console.log(`\n${describeDrill(report)}\n`);

await source.close();
await target.close();
rmSync(tmp, { recursive: true, force: true });
process.exit(report.problems.length === 0 ? 0 : 1);
