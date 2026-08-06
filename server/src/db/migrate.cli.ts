// `npm run migrate` — apply pending migrations and exit.
//
// The same code path the server runs at boot, available on its own so a schema change can
// be applied without starting anything. Nothing here is a second implementation: it opens a
// connection, calls the same `migrate()`, and prints what happened.

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { migrate } from "./migrate.ts";
import { sqliteMigrationTarget } from "./sqlite.ts";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS_DIR = join(SERVER_DIR, "migrations");
const DB_PATH = process.env.JAROKU_DB ?? join(SERVER_DIR, "jaroku.db");

const driver = process.env.JAROKU_DB_DRIVER ?? "sqlite";
if (driver !== "sqlite") {
  // Refuse rather than fall back. Silently migrating the SQLite file when someone asked for
  // Postgres would report success against a database they were not talking about.
  console.error(`[migrate] JAROKU_DB_DRIVER=${driver} is not supported yet — only "sqlite".`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
try {
  const result = await migrate(sqliteMigrationTarget(db), join(MIGRATIONS_DIR, "sqlite"));
  if (!result.applied.length) {
    console.log(`[migrate] ${DB_PATH} is already at the latest of ${result.alreadyApplied} migration(s)`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
} finally {
  db.close();
}
