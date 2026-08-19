// One way for a test to get a database, so no suite has to know the boot order.
//
// The order is real and it is easy to get wrong: migrations own the schema, so they run
// before any store is built, and the stores' `init()` only patches columns that predate a
// given migration. A suite that constructed a store first used to work and now fails on a
// table that does not exist yet — which is a worse way to learn the rule than having one
// function that encodes it.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, Queryable, WriteResult } from "./db.ts";
import { PostgresDb } from "./postgres.ts";
import { PG_URL_ENV } from "./open.ts";
import { migrate } from "./migrate.ts";
import { SqliteDb } from "./sqlite.ts";
import { LOCAL_WORKSPACE_ID, newRequestId, systemContextFor, type TenantContext } from "./tenant.ts";

// fileURLToPath, not `new URL(...).pathname` — the raw pathname of a file:// URL keeps its
// leading slash even in front of a Windows drive letter ("/C:/Users/..."), which path.join
// then normalises into "\C:\Users\..." - a path that does not exist. migrate() silently found
// nothing there and every suite using this helper ran against an unmigrated database, failing
// on the first table it touched. Every other module in this codebase already goes through
// fileURLToPath for exactly this reason; this was the one that didn't.
const MIGRATIONS = join(fileURLToPath(new URL("../..", import.meta.url)), "migrations");

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

/**
 * A `Db` that counts the statements that pass through it.
 *
 * HERE RATHER THAN INSIDE A SUITE, because a second aggregate now needs it and the first one's copy
 * cannot be imported: `agentGrid.test.ts` runs its whole suite at module scope, so importing a
 * helper out of it would execute the suite. The property both of them assert is the same one —
 * "the same number of statements for one agent as for forty" — and it deserves one implementation.
 *
 * A WRAPPER RATHER THAN A DRIVER FLAG, because what has to be counted is what the repositories
 * ACTUALLY send, including the statements a `forWorkspace` handle issues — which is every read an
 * aggregate makes. Wrapping `forWorkspace` as well as the top-level methods is the whole trick: a
 * counter that only saw the outer object would count zero and pass forever.
 */
export function countingDb(db: Db): { db: Db; count: () => number; reset: () => void } {
  let n = 0;
  const wrapQ = (q: Queryable): Queryable => ({
    // `dialect` is forwarded rather than omitted: it is part of `Queryable`, and a hydrator that
    // reads it to decide how to parse a json column would otherwise get `undefined` and take the
    // wrong branch — a counter that changed how rows are READ would be measuring a different query.
    dialect: q.dialect,
    get: <T>(sql: string, params?: readonly unknown[]) => { n++; return q.get<T>(sql, params); },
    all: <T>(sql: string, params?: readonly unknown[]) => { n++; return q.all<T>(sql, params); },
    run: (sql: string, params?: readonly unknown[]): Promise<WriteResult> => { n++; return q.run(sql, params); },
    exec: (sql: string) => { n++; return q.exec(sql); },
  });
  // EVERY METHOD IS FORWARDED BY NAME, and the spread that used to stand in for most of them is
  // gone. A `Db` is a class instance, so its methods live on the prototype and `{...db}` copies
  // none of them — which was invisible while the only caller went through `forWorkspace`, and
  // became `this.db.transaction is not a function` the moment a second suite wrapped a repository
  // that opens a transaction. A counter that silently removes half the interface is worse than no
  // counter, so the list is explicit and the compiler checks it.
  const wrapped: Db = {
    dialect: db.dialect,
    get: <T>(sql: string, params?: readonly unknown[]) => { n++; return db.get<T>(sql, params); },
    all: <T>(sql: string, params?: readonly unknown[]) => { n++; return db.all<T>(sql, params); },
    run: (sql: string, params?: readonly unknown[]) => { n++; return db.run(sql, params); },
    exec: (sql: string) => { n++; return db.exec(sql); },
    forWorkspace: (workspaceId: string) => wrapQ(db.forWorkspace(workspaceId)),
    scoped: <T>(workspaceId: string, fn: (tx: Queryable) => Promise<T>) =>
      db.scoped(workspaceId, (tx) => fn(wrapQ(tx))),
    transaction: <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction((tx) => fn(wrapQ(tx))),
    asPlatform: <T>(fn: (tx: Queryable) => Promise<T>) => db.asPlatform((tx) => fn(wrapQ(tx))),
    withAdvisoryLock: <T>(key: number, fn: () => Promise<T>) => db.withAdvisoryLock(key, fn),
    migrationTarget: () => db.migrationTarget(),
    close: () => db.close(),
  };
  return { db: wrapped, count: () => n, reset: () => { n = 0; } };
}

/** Point a connection string at a different database, leaving everything else alone. */
function replaceDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}
