// One way for a test to get a database, so no suite has to know the boot order.
//
// The order is real and it is easy to get wrong: migrations own the schema, so they run
// before any store is built, and the stores' `init()` only patches columns that predate a
// given migration. A suite that constructed a store first used to work and now fails on a
// table that does not exist yet — which is a worse way to learn the rule than having one
// function that encodes it.

import { join } from "node:path";
import { PostgresDb } from "./postgres.ts";
import { PG_URL_ENV } from "./open.ts";
import { migrate } from "./migrate.ts";
import { SqliteDb } from "./sqlite.ts";
import { LOCAL_WORKSPACE_ID, newRequestId, systemContextFor, type TenantContext } from "./tenant.ts";

const MIGRATIONS = join(new URL("../..", import.meta.url).pathname, "migrations");

/** An open, fully migrated SQLite database. `:memory:` unless a path is given. */
export async function openTestSqlite(path = ":memory:"): Promise<SqliteDb> {
  const db = new SqliteDb(path);
  await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});
  return db;
}

/**
 * A context in the local workspace — the one migration 004 creates.
 *
 * Every suite that writes a run or a step needs one, and it has to name a workspace that
 * actually exists: `runs.workspace_id` references `workspaces.id`, so a made-up id is a
 * foreign-key failure on Postgres and an unreachable row on SQLite.
 */
export function testContext(): TenantContext {
  return systemContextFor(LOCAL_WORKSPACE_ID, newRequestId());
}

/**
 * A Postgres database of its own, migrated and empty, dropped when the callback returns.
 *
 * A DATABASE, not a schema, and that distinction is the whole point. The obvious approach —
 * CREATE SCHEMA, put it first on the search_path, migrate into it — silently does not work,
 * because every migration is written `CREATE TABLE IF NOT EXISTS` and `public` is still on
 * the path behind it. The IF NOT EXISTS sees public's table, creates nothing, and every
 * query in the test then resolves to public. The suite passes, tests the developer's real
 * database, and leaves its fixtures in it.
 *
 * `public` cannot simply be dropped from the path either: extensions live per database, so
 * `CREATE EXTENSION IF NOT EXISTS citext` finds the one in public and does nothing, leaving
 * the type unreachable from a schema that excluded it.
 *
 * A separate database has neither problem: its own empty public schema, its own extensions,
 * and nothing to collide with.
 *
 * Returns null when there is no reachable Postgres or the role cannot create a database, so
 * a caller can skip out loud rather than fail.
 */
export async function withScratchPostgres<T>(
  /**
   * `url` is the scratch database's own connection string.
   *
   * Handed over because one suite needs to point something OTHER than this pool at the same
   * database: the checkpoint tests ask LangGraph's own `PostgresSaver.setup()` to create its
   * tables, from Python, so that the schema under test is the one LangGraph produces rather
   * than a hand-written imitation of it.
   */
  run: (db: PostgresDb, url: string) => Promise<T>,
): Promise<T | null> {
  const url = process.env[PG_URL_ENV];
  if (!url) {
    console.log(`(skipping Postgres: no ${PG_URL_ENV})`);
    return null;
  }
  const admin = new PostgresDb({ url });
  try {
    await admin.ping();
  } catch (err) {
    console.log(`(skipping Postgres: ${(err as Error).message})`);
    await admin.close();
    return null;
  }

  const name = `jaroku_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await admin.exec(`CREATE DATABASE ${name}`);
  } catch (err) {
    console.log(`(skipping Postgres: cannot create a scratch database — ${(err as Error).message})`);
    await admin.close();
    return null;
  }

  const scratchUrl = replaceDatabase(url, name);
  const db = new PostgresDb({ url: scratchUrl });
  try {
    await migrate(db.migrationTarget(), join(MIGRATIONS, "postgres"), () => {});
    return await run(db, scratchUrl);
  } finally {
    await db.close();
    // A database with a live connection cannot be dropped, and the pool's sockets linger for
    // a moment after end(). WITH (FORCE) closes them rather than racing the OS.
    await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(async () => {
      await admin.exec(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    });
    await admin.close();
  }
}

/** Point a connection string at a different database, leaving everything else alone. */
function replaceDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}
