// `npm run migrate` — apply pending migrations and exit.
//
// The same code path the server runs at boot, available on its own so a schema change can be
// applied without starting anything. Nothing here is a second implementation: it opens a
// connection with the same factory the server uses, calls the same `migrate()`, and prints
// what happened.
//
//   npm run migrate
//   JAROKU_DB_DRIVER=postgres JAROKU_PG_URL=postgres://… npm run migrate
//
//   JAROKU_PG_MIGRATION_URL overrides the URL for this command only, so the application can
//   connect as a role that row-level security actually applies to while migrations keep the
//   owner's rights. See migrations/postgres/009_rls.sql.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { migrate } from "./migrate.ts";
import { openDb } from "./open.ts";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_PATH = process.env.JAROKU_DB ?? join(SERVER_DIR, "jaroku.db");

let code = 0;
// MIGRATIONS RUN AS THE OWNER, THE APPLICATION DOES NOT — which is 009_rls.sql's design in one
// line: "The app connects as this role; migrations run as the owner." The application's role must
// not be able to ignore row-level security, and a role that cannot ignore it also cannot CREATE
// TABLE. Those are two different credentials and this is the only place that needs the second.
//
// FALLS BACK TO `JAROKU_PG_URL`, so a development machine and a single-role deployment carry on
// working with one variable and never meet this at all.
const MIGRATION_URL = process.env.JAROKU_PG_MIGRATION_URL?.trim() || undefined;
if (MIGRATION_URL) {
  console.log("[migrate] using JAROKU_PG_MIGRATION_URL (the owner) rather than the application's role");
}
const db = openDb({ sqlitePath: DB_PATH, pgUrl: MIGRATION_URL });
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
