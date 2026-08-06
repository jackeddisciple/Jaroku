// `npm run migrate` — apply pending migrations and exit.
//
// The same code path the server runs at boot, available on its own so a schema change can be
// applied without starting anything. Nothing here is a second implementation: it opens a
// connection with the same factory the server uses, calls the same `migrate()`, and prints
// what happened.
//
//   npm run migrate
//   JAROKU_DB_DRIVER=postgres JAROKU_PG_URL=postgres://… npm run migrate

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { migrate } from "./migrate.ts";
import { openDb } from "./open.ts";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_PATH = process.env.JAROKU_DB ?? join(SERVER_DIR, "jaroku.db");

let code = 0;
const db = openDb({ sqlitePath: DB_PATH });
try {
  const where = db.dialect === "sqlite" ? DB_PATH : "the configured Postgres";
  const result = await migrate(db.migrationTarget(), join(SERVER_DIR, "migrations", db.dialect));
  if (!result.applied.length) {
    console.log(`[migrate] ${where} is already at the latest of ${result.alreadyApplied} migration(s)`);
  }
} catch (err) {
  console.error((err as Error).message);
  code = 1;
} finally {
  await db.close();
}
process.exit(code);
