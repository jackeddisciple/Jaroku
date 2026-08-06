// The Postgres side of the database boundary.
//
// Postgres is production. Several stateless API replicas share it, so everything this driver
// does is shaped by there being more than one of us: a connection pool rather than a
// connection, an advisory lock so exactly one replica applies migrations at boot, and
// transactions that hold a checked-out client for their whole life because a transaction
// spread across two connections is not one.
//
// `pg` is the first runtime dependency this server has taken for storage, and it is the
// unavoidable one — there is no built-in Postgres client the way `node:sqlite` is a built-in
// SQLite one. It stays behind this file: nothing outside `server/src/db/` imports it.

import pgPkg from "pg";
import type { Db, DbRow, Dialect, Tx, WriteResult } from "./db.ts";
import type { MigrationTarget } from "./migrate.ts";

// `pg` is CommonJS with a default export, so the named classes come off that object.
const { Pool, types } = pgPkg;
type PoolClient = pgPkg.PoolClient;

const DIALECT: Dialect = "postgres";

/**
 * Numbers arrive as JavaScript numbers, not strings.
 *
 * `pg` parses int8, numeric and float8 to strings by default, because each can hold values a
 * JS number cannot. That default is right in general and wrong here: every one of these
 * columns is a token count, a step count, a latency or a USD cost, all of which are already
 * numbers in JavaScript everywhere else in this codebase — and a string arriving where the
 * SQLite driver hands back a number is exactly the silent cross-driver difference the
 * conformance suite exists to catch. Costs are stored as double precision rather than
 * numeric for the same reason (see the trace store), so this is not narrowing anything that
 * was ever wider.
 */
const INT8 = 20;
const NUMERIC = 1700;
const FLOAT8 = 701;
types.setTypeParser(INT8, (v) => Number(v));
types.setTypeParser(NUMERIC, (v) => Number(v));
types.setTypeParser(FLOAT8, (v) => Number(v));

/**
 * Timestamps come back as ISO-8601 UTC strings, not Date objects.
 *
 * The identity tables use timestamptz because Session 8 has to sweep and partition by month,
 * and date arithmetic against a text column is a sequential scan over the biggest table in
 * the system. But `pg` parses timestamptz into a JS Date, and SQLite — which has no such
 * type — hands back the string that was stored. A row that is a Date on one driver and a
 * string on the other is the same class of quiet difference as int8-as-string: it throws
 * nowhere, it just makes `row.created_at.slice(0, 10)` work locally and fail hosted.
 *
 * So the storage keeps a real instant and the boundary keeps one shape. Everything above
 * sees ISO-8601 UTC, exactly as the frozen event schema already does for a run's timestamps.
 */
const TIMESTAMPTZ = 1184;
const TIMESTAMP = 1114;
const toIso = (v: string | null): string | null => {
  if (v === null) return null;
  // A `timestamp without time zone` carries no offset; Postgres stores these in UTC and the
  // column type is the only thing that says so, so it is spelled out rather than left to the
  // parser's local timezone.
  const d = new Date(/[+-]\d\d:?\d\d$|Z$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
};
types.setTypeParser(TIMESTAMPTZ, toIso);
types.setTypeParser(TIMESTAMP, toIso);

/**
 * Rewrite `?` placeholders to `$1…$n`.
 *
 * One spelling is written throughout the stores — the SQLite one, because it was there
 * first — and this is where it is translated. Quoted text is skipped so a literal question
 * mark inside a string or an identifier is left alone; comments too.
 *
 * The one thing to know: Postgres's jsonb containment operators are spelled `?`, `?|` and
 * `?&`. None are used here, and if one ever is it must go through `jsonb_exists()` instead —
 * a bare `?` in a query is a placeholder as far as this function is concerned, and it cannot
 * tell the difference.
 */
export function toPositional(sql: string): string {
  let out = "";
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      // A SQL string literal or a quoted identifier. Doubling the quote escapes it.
      const quote = c;
      out += c;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "?") {
      out += `$${++n}`;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** A `Queryable` bound to one client — what a transaction hands its callback. */
function queryable(client: PoolClient): Tx {
  return {
    dialect: DIALECT,
    async all<T = DbRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      return (await client.query(toPositional(sql), [...params])).rows as T[];
    },
    async get<T = DbRow>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
      return (await client.query(toPositional(sql), [...params])).rows[0] as T | undefined;
    },
    async run(sql: string, params: readonly unknown[] = []): Promise<WriteResult> {
      const r = await client.query(toPositional(sql), [...params]);
      return { changes: r.rowCount ?? 0 };
    },
    async exec(sql: string): Promise<void> {
      await client.query(sql);
    },
  };
}

export interface PostgresOptions {
  url: string;
  /** Ceiling on connections from THIS replica. The server's own limit is the sum. */
  max?: number;
  /** How long a query may run before the server cancels it. Unbounded is not a policy. */
  statementTimeoutMs?: number;
}

export class PostgresDb implements Db {
  readonly dialect = DIALECT;
  private readonly pool: InstanceType<typeof Pool>;

  constructor(opts: PostgresOptions) {
    this.pool = new Pool({
      connectionString: opts.url,
      max: opts.max ?? 10,
      // A statement that never returns holds a pool slot forever, and enough of them turn
      // one slow query into an outage for every other request on this replica.
      statement_timeout: opts.statementTimeoutMs ?? 30_000,
      // Long enough to survive a normal query, short enough that a wedged connection is
      // reclaimed rather than leaked.
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // An idle client erroring (the server restarted, the network dropped) emits on the pool,
    // and an unhandled 'error' event takes the process down. The pool discards the client
    // itself; all this has to do is not crash.
    this.pool.on("error", (err) => {
      console.error("[postgres] idle client error:", err.message);
    });
  }

  async all<T = DbRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await this.pool.query(toPositional(sql), [...params])).rows as T[];
  }

  async get<T = DbRow>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return (await this.pool.query(toPositional(sql), [...params])).rows[0] as T | undefined;
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<WriteResult> {
    const r = await this.pool.query(toPositional(sql), [...params]);
    return { changes: r.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  /**
   * One checked-out client for the whole transaction.
   *
   * Not optional: BEGIN and COMMIT are session state, so a transaction whose statements went
   * back to the pool between calls would commit somebody else's work and leave its own open.
   * Unlike the SQLite driver, transactions here genuinely run in parallel — that is the
   * point of a pool, and the interface promises atomicity and isolation, never that two of
   * them take turns.
   */
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(queryable(client));
      await client.query("COMMIT");
      return out;
    } catch (err) {
      // Postgres marks a session with a failed statement as aborted and rejects everything
      // until it is rolled back — so this is not tidiness, it is what makes the connection
      // safe to hand back to the pool.
      try {
        await client.query("ROLLBACK");
      } catch {
        /* The connection is already gone; releasing it below discards it. */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * A transaction with `app.workspace_id` set, which is what the RLS policies read.
   *
   * SET LOCAL takes effect for the rest of the transaction and is discarded at COMMIT or
   * ROLLBACK, so it cannot outlive the work it scopes. The value is bound as a parameter
   * rather than interpolated — `set_config` exists for exactly that, because SET LOCAL
   * itself takes no placeholders and building it by string concatenation would put a
   * client-supplied id into SQL text.
   */
  async scoped<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      const out = await fn(queryable(client));
      await client.query("COMMIT");
      return out;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* already gone; releasing below discards it */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * A `Queryable` that carries the scope on every statement.
   *
   * Each call is its own one-statement transaction with its own SET LOCAL, which is a real
   * cost — a round trip that a bare query would not pay — and it is what the backstop costs.
   * Work that issues several statements should use `scoped` instead and pay it once.
   */
  forWorkspace(workspaceId: string): Tx {
    return {
      dialect: DIALECT,
      all: (sql, params) => this.scoped(workspaceId, (tx) => tx.all(sql, params)),
      get: (sql, params) => this.scoped(workspaceId, (tx) => tx.get(sql, params)),
      run: (sql, params) => this.scoped(workspaceId, (tx) => tx.run(sql, params)),
      exec: (sql) => this.scoped(workspaceId, (tx) => tx.exec(sql)),
    };
  }

  /**
   * A `MigrationTarget` holding ONE client for the whole run.
   *
   * Both properties matter. The client is held because the runner opens explicit
   * transactions, and the advisory lock is session-scoped — it means nothing if the next
   * statement arrives on a different connection.
   *
   * `pg_advisory_lock` is the reason this exists. Several replicas boot at once and all of
   * them try to migrate; without the lock they race, and two of them running the same
   * CREATE TABLE is the good outcome — the bad one is two different migrations interleaving.
   * It blocks rather than fails, so the losers simply wait and then find there is nothing
   * pending, which is exactly what should happen.
   */
  migrationTarget(): MigrationTarget {
    const pool = this.pool;
    let held: PoolClient | null = null;
    const q = (): PoolClient => {
      if (!held) throw new Error("[postgres] migration target used outside withLock");
      return held;
    };
    return {
      dialect: DIALECT,
      async exec(sql: string): Promise<void> {
        await q().query(sql);
      },
      async run(sql: string, params: unknown[]): Promise<void> {
        await q().query(toPositional(sql), params);
      },
      async all<T = DbRow>(sql: string, params: unknown[] = []): Promise<T[]> {
        return (await q().query(toPositional(sql), params)).rows as T[];
      },
      async withLock<T>(fn: () => Promise<T>): Promise<T> {
        const client = await pool.connect();
        held = client;
        try {
          await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
          try {
            return await fn();
          } finally {
            await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
          }
        } finally {
          held = null;
          client.release();
        }
      },
    };
  }

  /** Prove the database is reachable and speaks Postgres, before anything depends on it. */
  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * The advisory-lock key migrations take.
 *
 * An arbitrary constant, but it has to be a constant everything agrees on: advisory locks
 * are a flat namespace across the whole database, so a second thing that ever takes a lock
 * must pick a different number or the two will block each other for no reason.
 */
export const MIGRATION_LOCK_KEY = 8_314_071;
