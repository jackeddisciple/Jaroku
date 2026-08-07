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
  /** Overrides `process.env`. Tests pass this rather than mutating the environment. */
  env?: NodeJS.ProcessEnv;
}

export function driverFromEnv(override?: string, env: NodeJS.ProcessEnv = process.env): Dialect {
  const raw = (override ?? env.JAROKU_DB_DRIVER ?? "sqlite").trim().toLowerCase();
  if (raw !== "sqlite" && raw !== "postgres") {
    // Refuse rather than fall back. Falling back to SQLite when someone asked for Postgres
    // means a server that starts, works, and writes every row to a file nobody is looking at.
    throw new Error(`JAROKU_DB_DRIVER must be "sqlite" or "postgres", not "${raw}"`);
  }

  // SQLITE IS A DEVELOPMENT DRIVER, and in production that is not a choice, it is an
  // accident — the same judgement the local auth issuer makes about itself, and refused the
  // same way rather than merely warned about.
  //
  // The reason is not performance and not durability. It is that the two drivers DISAGREE, and
  // the disagreement is silent. `users.external_id` is `COLLATE NOCASE` on SQLite and
  // case-sensitive on Postgres, so two auth-provider `sub` claims differing only in case are
  // one person on SQLite and two on Postgres. That is an identity bug, it is invisible until
  // it is a breach, and fixing it properly needs a table rebuild. Refusing to boot here makes
  // it unreachable in production for the cost of this paragraph — and RLS, the backstop the
  // whole tenancy model leans on, exists only on Postgres at all.
  if (raw === "sqlite" && env["NODE_ENV"] === "production") {
    throw new Error(
      `JAROKU_DB_DRIVER=sqlite refuses to run under NODE_ENV=production. SQLite is the ` +
        `development driver: it has no row-level security, and its \`users.external_id\` is ` +
        `case-insensitive where Postgres is case-sensitive, so two provider subjects differing ` +
        `only in case are ONE person here and TWO there. Set JAROKU_DB_DRIVER=postgres and ` +
        `${PG_URL_ENV}.`,
    );
  }
  return raw;
}

export function openDb(opts: OpenOptions): Db {
  const env = opts.env ?? process.env;
  const dialect = driverFromEnv(opts.driver, env);
  if (dialect === "sqlite") return new SqliteDb(opts.sqlitePath);

  const url = opts.pgUrl ?? env[PG_URL_ENV];
  if (!url) {
    throw new Error(
      `JAROKU_DB_DRIVER=postgres needs ${PG_URL_ENV} (e.g. postgres://jaroku:jaroku@127.0.0.1:5433/jaroku). ` +
        `\`docker compose up -d postgres\` starts one locally.`,
    );
  }
  return new PostgresDb({ url });
}
