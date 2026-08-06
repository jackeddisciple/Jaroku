// The database boundary. Everything that reaches a database goes through this interface,
// and nothing outside `server/src/db/` may import a driver.
//
// TWO IMPLEMENTATIONS, ALWAYS. SQLite stays the local development path and stays the
// default — the fixtures, the mock MCP server and `npm run dev` must keep working with
// nothing installed and nothing running, which is a property the README is rightly proud of
// and which no hosted feature is allowed to cost. Postgres is production. Selected by
// `JAROKU_DB_DRIVER`, and the application cannot tell which it got.
//
// ASYNC, EVEN THOUGH SQLITE IS NOT. `node:sqlite` is synchronous and every store in this
// codebase was written against that. No Postgres client is, and an interface shaped around
// the synchronous one cannot have a Postgres implementation at all — so the asynchrony is
// not overhead added to the local path, it is the only shape both drivers can satisfy. The
// cost is real and lands in the next commit: every call site has to await, and writes that
// used to be uninterruptible now need to say so.
//
// `?` PLACEHOLDERS EVERYWHERE. Both dialects are written against the SQLite spelling and
// the Postgres driver rewrites them to `$1…$n`. One spelling, chosen because it is the one
// already in the codebase, so porting a store is a signature change rather than a rewrite
// of every query in it. String interpolation into SQL is not an alternative here for the
// same reason validation rule 10 rejects it in generated agents.

import type { Dialect, MigrationTarget } from "./migrate.ts";

export type { Dialect };

/** What a row looks like before a store gives it a type. */
export type DbRow = Record<string, unknown>;

/** How many rows a write touched. Enough to tell "updated" from "no such row". */
export interface WriteResult {
  changes: number;
}

/**
 * The read/write surface. A `Db` and a transaction inside one both provide it, so a query
 * helper can be written once and used in either — which is what keeps the repository layer
 * from growing a scoped and an unscoped copy of every method.
 */
export interface Queryable {
  readonly dialect: Dialect;
  /** One statement. Every row. */
  all<T = DbRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** One statement. The first row, or undefined when there is none. */
  get<T = DbRow>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
  /** One statement that writes. */
  run(sql: string, params?: readonly unknown[]): Promise<WriteResult>;
  /**
   * Multi-statement, no parameters. DDL only — this is the one method that cannot bind a
   * value, so it must never be handed anything a user supplied.
   */
  exec(sql: string): Promise<void>;
}

/**
 * A transaction. Distinct from `Db` so a function that must run inside one can say so in
 * its signature rather than in a comment, and so nothing can hand a bare connection to
 * something that needs atomicity.
 */
export type Tx = Queryable;

export interface Db extends Queryable {
  /**
   * Run `fn` inside a single transaction on a single connection: committed if it returns,
   * rolled back if it throws, and never partly either.
   *
   * What is promised is atomicity and isolation. What is deliberately NOT promised is that
   * two overlapping transactions take turns — that is a driver's business, and the two
   * drivers answer it differently for good reasons. SQLite has one connection and must
   * serialise them or a second BEGIN lands inside the first. Postgres gives each one its own
   * pooled connection and runs them in parallel, which is the entire point of having a pool;
   * making it queue would turn a hosted server into a single-writer one.
   */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** The narrower surface the migration runner wants: one connection, held, plus a lock. */
  migrationTarget(): MigrationTarget;
  close(): Promise<void>;
}

/**
 * SQLite has no boolean type and stores 0/1; Postgres has one and returns true/false. A
 * column that means yes-or-no therefore reads back as two different things depending on the
 * driver, and `if (row.configured)` is true for the number 0's absence and false for it —
 * which is exactly the kind of difference that shows up as a feature working locally and
 * not in production.
 */
export function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === 1n || v === "1" || v === "t" || v === "true";
}

/**
 * SQLite returns integers as numbers (or bigints past 2^53); Postgres returns `bigint`
 * columns as strings, because a JS number cannot hold all of them. Every count and every
 * sequence value in this codebase is comfortably inside a safe integer, so normalising is
 * correct — but it has to be done deliberately rather than by letting `+row.n` happen to
 * work on one driver.
 */
export function asInt(v: unknown, fallback = 0): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** The same, for a column that is allowed to be genuinely absent. Unknown is not zero. */
export function asIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return asInt(v, 0);
}

/**
 * Read a JSON column back as the value that was written.
 *
 * The drivers hand this back differently and the difference is not cosmetic. SQLite stores
 * the payload as TEXT, so it arrives as a string that has to be parsed. Postgres stores it as
 * jsonb and the driver has already parsed it, so it arrives as the value itself.
 *
 * A parser that decided by looking at the value — "if it is a string, parse it" — is wrong on
 * Postgres in a way nobody would find for months: a step whose payload is the JSON string
 * `"123"` comes back from Postgres as the JavaScript string `123`, and re-parsing turns it into
 * the number 123. Same query, same code, different type, one driver. So the dialect is passed
 * in rather than inferred.
 */
export function jsonFromColumn(dialect: Dialect, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (dialect === "postgres") return v; // jsonb: the driver already parsed it
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v; // Not JSON (shouldn't happen) — hand back the raw text rather than throw.
  }
}
