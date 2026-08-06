// The schema's forward-only migration runner.
//
// Numbered SQL files, applied once each, in order, inside a transaction, recorded in
// `schema_migrations`. There is no dependency here on purpose: this codebase already
// prefers a script it can read to a tool it has to trust — the test suites are plain tsx,
// the event transport is delimiters rather than a parser library — and a migration runner
// that does only what this one does is about a hundred lines.
//
// TWO DIRECTORIES, ONE NUMBERING. `migrations/postgres/` and `migrations/sqlite/` hold the
// same versions under the same names. The dialects genuinely disagree about what a uuid, a
// citext and a jsonb are, and SQL written to paper over that is portable and wrong. A
// version one dialect has nothing to do for is a comment-only file rather than a missing
// one, so the two sequences can never drift apart silently — `npm run migrate` on either
// driver walks the same version numbers.
//
// FORWARD-ONLY, AND CHECKSUMMED. There is no `down`. A migration that has run is history:
// every later migration was written against the database it produced, so "undo it and edit
// it" describes a database nobody has. Editing an applied file is therefore a hard failure
// naming the file — otherwise the schema in front of you and the schema the checkout
// describes drift apart with nothing saying so, which is the failure mode a migration tool
// exists to prevent in the first place.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type Dialect = "sqlite" | "postgres";

/**
 * What the runner needs from a database, and nothing more.
 *
 * Deliberately narrower than the `Db` interface the application uses: a migration runs
 * against one connection, held for the whole run, because it opens explicit transactions
 * and takes a lock that only means anything while a single session holds it. A pool that
 * handed out a different connection per call would silently break both.
 */
export interface MigrationTarget {
  readonly dialect: Dialect;
  /** Multi-statement, no parameters. This is how a migration file's own SQL is run. */
  exec(sql: string): Promise<void>;
  /** One statement, parameterised with `?` placeholders. The target adapts them. */
  run(sql: string, params: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Serialise migration across processes, so exactly one instance applies at boot. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateResult {
  /** Migrations this call applied, in order. Empty when the database was already current. */
  applied: Migration[];
  /** How many were already recorded. `applied.length + alreadyApplied` is the total. */
  alreadyApplied: number;
}

/** `001_extensions.sql`. Three digits so a plain lexical sort is also a version sort. */
const FILENAME = /^(\d{3})_([a-z0-9_]+)\.sql$/;

// `applied_at` is text rather than a timestamp: this table is the runner's own bookkeeping,
// it must exist before any dialect-specific migration has run, and an ISO-8601 string means
// the same thing in both databases without either of them having to be asked.
const BOOKKEEPING = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    integer PRIMARY KEY,
    name       text NOT NULL,
    checksum   text NOT NULL,
    applied_at text NOT NULL
  );
`;

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const label = (m: { version: number; name: string }): string =>
  `${String(m.version).padStart(3, "0")}_${m.name}`;

/**
 * Read a dialect's migration directory. Sorted by version, with the filename convention
 * enforced rather than assumed — a file the runner cannot parse a version out of would
 * otherwise be skipped in silence, which is the one outcome worse than refusing to start.
 */
export function loadMigrations(dir: string): Migration[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // A dialect with no migrations yet is not an error.
  }

  const out: Migration[] = [];
  const claimed = new Map<number, string>();
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const m = FILENAME.exec(entry);
    if (!m) {
      throw new Error(`[migrate] ${entry}: migration files must be named NNN_lower_snake.sql`);
    }
    const version = Number(m[1]);
    const prior = claimed.get(version);
    if (prior) {
      throw new Error(`[migrate] two files claim version ${m[1]}: ${prior} and ${entry}`);
    }
    claimed.set(version, entry);
    const sql = readFileSync(join(dir, entry), "utf8");
    out.push({ version, name: m[2]!, sql, checksum: sha256(sql) });
  }
  return out.sort((a, b) => a.version - b.version);
}

/**
 * Apply every migration the database has not seen, in version order.
 *
 * Each one runs in its own transaction together with the row recording it, so a migration
 * either happened and is written down or did neither. Both dialects have transactional DDL,
 * which is what makes that true rather than aspirational.
 */
export async function migrate(
  target: MigrationTarget,
  dir: string,
  log: (msg: string) => void = console.log,
): Promise<MigrateResult> {
  const migrations = loadMigrations(dir);

  return target.withLock(async () => {
    // Read before write.
    //
    // A production connection is the APPLICATION role, which by design cannot create or
    // alter tables — that is what makes RLS a backstop rather than a suggestion. But a
    // correctly-migrated database still has to boot on it, so a database that is already
    // current must not need a single DDL statement to find that out. So: try to read the
    // bookkeeping table; only create it if reading said it is not there.
    let rows: { version: number | bigint; name: string; checksum: string }[];
    try {
      rows = await target.all(`SELECT version, name, checksum FROM schema_migrations ORDER BY version`);
    } catch {
      // Either it does not exist yet, or this connection cannot read it. Creating it answers
      // both — and fails with the privilege error below if it is the second.
      try {
        await target.exec(BOOKKEEPING);
      } catch (err) {
        throw new Error(
          `[migrate] this connection cannot create schema_migrations — ` +
            `${(err as Error)?.message ?? String(err)}. Migrations run as the database OWNER; ` +
            `run \`npm run migrate\` with an owner connection before starting the server.`,
          { cause: err },
        );
      }
      rows = await target.all(`SELECT version, name, checksum FROM schema_migrations ORDER BY version`);
    }
    const applied = new Map(rows.map((r) => [Number(r.version), r]));

    // A file that changed after it ran. Every migration numbered above it was written
    // against the schema the OLD text produced, so the file no longer describes this
    // database and re-running it is not on the table either.
    for (const m of migrations) {
      const prior = applied.get(m.version);
      if (prior && prior.checksum !== m.checksum) {
        throw new Error(
          `[migrate] ${label(m)}.sql has changed since it was applied ` +
            `(recorded ${prior.checksum.slice(0, 12)}…, file ${m.checksum.slice(0, 12)}…). ` +
            `Migrations are forward-only — write a new one rather than editing this.`,
        );
      }
    }

    // And the mirror image: a database that has run something this checkout does not have.
    // Usually an older branch pointed at a newer database, and applying "pending" work on
    // top of a schema from the future is how you get a half-migrated one.
    for (const r of applied.values()) {
      const version = Number(r.version);
      if (!migrations.some((m) => m.version === version)) {
        throw new Error(
          `[migrate] the database has ${label({ version, name: r.name })} applied, but this ` +
            `checkout has no such file. It is ahead of your code — do not migrate it.`,
        );
      }
    }

    const pending = migrations.filter((m) => !applied.has(m.version));
    if (!pending.length) {
      return { applied: [], alreadyApplied: applied.size };
    }

    const done: Migration[] = [];
    // Everything below writes. If this connection is not allowed to, say which migrations are
    // owed and who has to apply them — a raw "permission denied for schema public" at boot
    // tells a deployer nothing about what is actually wrong.
    const owed = (): string => pending.map((m) => `${label(m)}.sql`).join(", ");
    for (const m of pending) {
      log(`[migrate] applying ${label(m)}`);
      await target.exec("BEGIN");
      try {
        await target.exec(m.sql);
        await target.run(
          `INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
          [m.version, m.name, m.checksum, new Date().toISOString()],
        );
        await target.exec("COMMIT");
      } catch (err) {
        // Best-effort: the transaction may already be aborted, and the original error is
        // the one worth raising.
        await target.exec("ROLLBACK").catch(() => {});
        const message = (err as Error)?.message ?? String(err);
        if (/permission denied|must be owner/i.test(message)) {
          throw new Error(
            `[migrate] this connection cannot apply migrations (${message}). ` +
              `${pending.length} pending: ${owed()}. Migrations run as the database OWNER — ` +
              `run \`npm run migrate\` with an owner connection before starting the server.`,
            { cause: err },
          );
        }
        throw new Error(`[migrate] ${label(m)} failed: ${message}`, { cause: err });
      }
      done.push(m);
    }
    log(`[migrate] applied ${done.length} migration(s); schema at ${label(done[done.length - 1]!)}`);
    return { applied: done, alreadyApplied: applied.size };
  });
}
