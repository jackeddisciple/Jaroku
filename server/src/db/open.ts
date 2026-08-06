// Choosing a driver. The only place in the codebase that does.
//
// SQLite is the default and stays the default. `npm run dev` with nothing installed and
// nothing running has to keep working — the fixtures, the mock MCP server and the whole
// free-development path depend on it, and no hosted feature is allowed to cost that.

import { SqliteDb } from "./sqlite.ts";
import { PostgresDb } from "./postgres.ts";
import type { Db, Dialect } from "./db.ts";

/**
 * Jaroku's own database URL.
 *
 * Deliberately NOT `DATABASE_URL`. That name already means something in this product: it is
 * the credential the reviewed Postgres connector reads, the user's own database that their
 * agents query. Reusing it here would point every agent's `pg_query` at Jaroku's control
 * plane — at the traces, the eval results and the MCP registry of everyone on the box — and
 * it would do it silently, because both are valid Postgres URLs and nothing would error.
 */
export const PG_URL_ENV = "JAROKU_PG_URL";

export interface OpenOptions {
  /** Where the SQLite file lives. Ignored by the Postgres driver. */
  sqlitePath: string;
  /** Overrides `JAROKU_DB_DRIVER`. Tests pass this rather than mutating the environment. */
  driver?: string;
  /** Overrides `JAROKU_PG_URL`. */
  pgUrl?: string;
}

export function driverFromEnv(override?: string): Dialect {
  const raw = (override ?? process.env.JAROKU_DB_DRIVER ?? "sqlite").trim().toLowerCase();
  if (raw === "sqlite" || raw === "postgres") return raw;
  // Refuse rather than fall back. Falling back to SQLite when someone asked for Postgres
  // means a server that starts, works, and writes every row to a file nobody is looking at.
  throw new Error(`JAROKU_DB_DRIVER must be "sqlite" or "postgres", not "${raw}"`);
}

export function openDb(opts: OpenOptions): Db {
  const dialect = driverFromEnv(opts.driver);
  if (dialect === "sqlite") return new SqliteDb(opts.sqlitePath);

  const url = opts.pgUrl ?? process.env[PG_URL_ENV];
  if (!url) {
    throw new Error(
      `JAROKU_DB_DRIVER=postgres needs ${PG_URL_ENV} (e.g. postgres://jaroku:jaroku@127.0.0.1:5433/jaroku). ` +
        `\`docker compose up -d postgres\` starts one locally.`,
    );
  }
  return new PostgresDb({ url });
}
