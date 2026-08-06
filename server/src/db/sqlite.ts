// The SQLite side of the database boundary.
//
// SQLite is the local development path and stays the default. Everything the README is
// proud of about developing here for free — the fixtures, the mock MCP server, `npm run
// dev` with no key and no network — depends on this file needing nothing installed and
// nothing running. `node:sqlite` is built into Node 22+, so it stays a dependency-free
// path, exactly as it was before there was an interface in front of it.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Dialect, MigrationTarget } from "./migrate.ts";

/** node:sqlite binds a narrow set of JS values. Anything else is a caller bug, loudly. */
function bind(params: readonly unknown[]): SQLInputValue[] {
  return params.map((p) => {
    if (p === null || p === undefined) return null;
    if (typeof p === "string" || typeof p === "number" || typeof p === "bigint") return p;
    if (typeof p === "boolean") return p ? 1 : 0; // SQLite has no boolean; Postgres does.
    if (p instanceof Uint8Array) return p;
    throw new TypeError(`[sqlite] cannot bind a ${typeof p} as a parameter`);
  });
}

/**
 * A `MigrationTarget` over an open SQLite connection.
 *
 * `withLock` is a documented no-op, and that is the correct answer rather than a missing
 * one. The lock exists for the hosted case — several stateless API replicas booting at
 * once, where exactly one must apply — and there is no such thing here: SQLite is one
 * process on one machine by construction. Two of them racing anyway (a `npm run migrate`
 * against a running `npm run dev`) is already handled a layer down, because SQLite
 * serialises writers on the file and `schema_migrations.version` is a primary key — the
 * loser's INSERT fails and its transaction rolls the migration back with it, rather than
 * applying anything twice.
 */
export function sqliteMigrationTarget(db: DatabaseSync): MigrationTarget {
  const dialect: Dialect = "sqlite";
  return {
    dialect,
    async exec(sql: string): Promise<void> {
      db.exec(sql);
    },
    async run(sql: string, params: unknown[]): Promise<void> {
      db.prepare(sql).run(...bind(params));
    },
    async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...bind(params)) as unknown as T[];
    },
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}
