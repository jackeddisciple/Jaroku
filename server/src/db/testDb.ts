// One way for a test to get a database, so no suite has to know the boot order.
//
// The order is real and it is easy to get wrong: migrations own the schema, so they run
// before any store is built, and the stores' `init()` only patches columns that predate a
// given migration. A suite that constructed a store first used to work and now fails on a
// table that does not exist yet — which is a worse way to learn the rule than having one
// function that encodes it.

import { join } from "node:path";
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
