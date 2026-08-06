// The SQLite side of the database boundary.
//
// SQLite is the local development path and stays the default. Everything the README is
// proud of about developing here for free — the fixtures, the mock MCP server, `npm run
// dev` with no key and no network — depends on this file needing nothing installed and
// nothing running. `node:sqlite` is built into Node 22+, so it stays a dependency-free
// path, exactly as it was before there was an interface in front of it.
//
// The whole driver is a thin async skin over a synchronous library. That is not a
// pretence: nothing here yields, so a statement genuinely cannot interleave with another
// one, and the promises exist so the same store code can run against a driver where it
// can. The one place the difference is load-bearing is `transaction`, whose callback is a
// real async function and can therefore be suspended halfway — see below.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Db, DbRow, Dialect, Tx, WriteResult } from "./db.ts";
import type { MigrationTarget } from "./migrate.ts";

const DIALECT: Dialect = "sqlite";

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

export class SqliteDb implements Db {
  readonly dialect = DIALECT;
  private readonly db: DatabaseSync;

  /**
   * Transactions run one at a time, chained here.
   *
   * SQLite has one connection and no nested transactions, so two overlapping `transaction()`
   * calls would put a second BEGIN inside the first — and the first COMMIT would then commit
   * both, including the half of the second one that had run so far. That could not happen
   * while the stores were synchronous, because nothing could suspend between a BEGIN and its
   * COMMIT. It can now: the callback is an async function and may await, which is the whole
   * reason this interface exists. Serialising them restores the guarantee the synchronous
   * code got for free.
   */
  private gate: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // WAL, as before: readers do not block the writer, which matters because a run is
    // streaming steps in while the UI reads history back out.
    this.db.exec("PRAGMA journal_mode = WAL;");
    // Wait for a lock rather than failing instantly. `npm run migrate` against a running
    // `npm run dev` is an ordinary thing to do, and SQLITE_BUSY is a worse answer than a pause.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    // FOREIGN KEYS ARE ON, and not by our choosing: `node:sqlite` enables them by default,
    // unlike the sqlite3 CLI and unlike what this comment used to claim. Worth knowing because
    // it changes what a migration may do — a table rebuild has to use `defer_foreign_keys`,
    // since dropping a parent while a child still references it fails. See migration 006.
    // They are left on: turning them off now would relax a constraint the database has in fact
    // been enforcing all along.
  }

  async all<T = DbRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...bind(params)) as unknown as T[];
  }

  async get<T = DbRow>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...bind(params)) as unknown as T | undefined;
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<WriteResult> {
    const r = this.db.prepare(sql).run(...bind(params));
    return { changes: Number(r.changes) };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const attempt = async (): Promise<T> => {
      // IMMEDIATE rather than the default deferred begin: these transactions write, and a
      // deferred one takes its write lock at the first write — by which point another
      // writer may hold it and the upgrade fails outright rather than waiting.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const out = await fn(this);
        this.db.exec("COMMIT");
        return out;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* Already rolled back by the failure itself. The original error is the one to raise. */
        }
        throw err;
      }
    };
    // Chained on settlement, not success: a transaction that threw has still finished, and
    // the next one must not be stranded behind it.
    const result = this.gate.then(attempt, attempt);
    this.gate = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * An ordinary transaction. SQLite has no row-level security to scope.
   *
   * The parameter is accepted and ignored on purpose rather than the method being absent:
   * repository code calls the same thing on both drivers, and a driver-specific branch at
   * every call site is how the two paths drift.
   */
  async scoped<T>(_workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /**
   * The connection itself. There is no RLS here to scope, and wrapping every read in a
   * transaction would take SQLite's write lock to answer a question.
   */
  forWorkspace(_workspaceId: string): Tx {
    return this;
  }

  /**
   * A `MigrationTarget` over this connection.
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
  migrationTarget(): MigrationTarget {
    return {
      dialect: DIALECT,
      exec: (sql) => this.exec(sql),
      run: async (sql, params) => {
        await this.run(sql, params);
      },
      all: (sql, params) => this.all(sql, params),
      withLock: (fn) => fn(),
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * The underlying handle.
   *
   * Only for code inside `server/src/db/` that genuinely needs SQLite itself: `PRAGMA
   * table_info` has no Postgres equivalent, and the importer in a later commit reads a
   * SQLite file as a *source* while writing Postgres as its destination. Everything else
   * goes through the interface — that is the rule the boundary check enforces.
   */
  unsafeHandle(): DatabaseSync {
    return this.db;
  }
}

/** @deprecated Superseded by `SqliteDb#migrationTarget`; kept while callers move over. */
export function sqliteMigrationTarget(db: DatabaseSync): MigrationTarget {
  return {
    dialect: DIALECT,
    async exec(sql: string): Promise<void> {
      db.exec(sql);
    },
    async run(sql: string, params: unknown[]): Promise<void> {
      db.prepare(sql).run(...bind(params));
    },
    async all<T = DbRow>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...bind(params)) as unknown as T[];
    },
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}
