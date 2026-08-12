// Keeping the months ahead of the trace, and taking the ones behind it away.
//
// Migration 029 turned `steps` into one table per month. That buys retention as a catalogue
// update rather than a multi-hour DELETE — and it buys a new failure mode, which this module
// exists to prevent: an INSERT with no matching partition FAILS, and the row it fails on is a
// trace step. A deployment that ran out of partitions would not slow down; it would silently
// stop recording what its agents did.
//
// SO THERE ARE TWO DEFENCES, and neither is sufficient alone.
//
//   `ensure` creates months AHEAD of time — at boot and then daily — so the partition a run
//   needs at 00:00:01 on the first of the month has existed for two months.
//
//   The DEFAULT partition catches whatever falls through anyway. It is not a fallback anybody
//   should be relying on: rows in it cannot be dropped by month, so a default that is filling up
//   is a retention promise that is quietly not being kept. `defaultPartitionRows` is what commit
//   12 exports as a gauge with an alert on any non-zero value.
//
// THE MONTH ARITHMETIC IS PURE AND UTC. Partition bounds are ISO-8601 dates compared as text —
// see the migration for why that is correct rather than clever — and every function here that
// produces one takes an explicit date so it can be tested without waiting for a month to pass.
// Local time is deliberately absent: a bound computed in a timezone west of UTC would put the
// first hours of a month in the previous one, and the rows would land in whichever partition the
// server's clock believed in at insert time.
//
// AND ON SQLITE ALL OF IT IS A NO-OP, which is not a degraded mode. The local database holds a
// few thousand steps; `DELETE` over it is instantaneous, and a scheme that split it across files
// would be complexity bought for a problem this driver does not have. The sweeper in the next
// commit falls back to a scoped DELETE there, and the two paths promise the same thing.

import type { Db } from "../db/db.ts";

/** The table this module partitions. One, and unlikely to be two — see the migration. */
export const PARTITIONED_TABLE = "steps";

/** How many months ahead of today partitions are kept. */
export const MONTHS_AHEAD = 2;

/** The first instant of `date`'s month, in UTC. */
export function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** The month `n` months after `date`'s. Handles the year boundary, which `+1` on a month does not. */
export function addMonths(date: Date, n: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1));
}

/** `steps_2026_08`. The suffix is what makes a partition name sortable and parseable. */
export function partitionName(month: Date): string {
  const y = month.getUTCFullYear();
  const m = String(month.getUTCMonth() + 1).padStart(2, "0");
  return `${PARTITIONED_TABLE}_${y}_${m}`;
}

/** The month a partition name refers to, or null for a name that is not one of ours. */
export function monthOfPartition(name: string): Date | null {
  const m = new RegExp(`^${PARTITIONED_TABLE}_(\\d{4})_(\\d{2})$`).exec(name);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month - 1, 1));
}

/** `2026-08-01`. The bound as the migration writes it: a date, compared as text. */
export function bound(month: Date): string {
  return month.toISOString().slice(0, 10);
}

/**
 * Which partitions should exist for a database whose oldest step is `oldest`.
 *
 * Returns every month from `oldest` to `MONTHS_AHEAD` past `now`, inclusive. A database with no
 * steps at all still gets the current month and the ones ahead of it — the first run of a fresh
 * deployment must not be the thing that discovers there is nowhere to put a step.
 */
export function requiredMonths(now: Date, oldest: Date | null, aheadMonths = MONTHS_AHEAD): Date[] {
  const last = addMonths(monthStart(now), aheadMonths);
  let cursor = oldest ? monthStart(oldest) : monthStart(now);
  // A clock skewed into the past, or a restored dump with a nonsense timestamp, must not ask for
  // ten thousand partitions. Anything older than five years is treated as five years old; the
  // rows are still readable in whichever partition already holds them.
  const floor = addMonths(monthStart(now), -60);
  if (cursor < floor) cursor = floor;
  const out: Date[] = [];
  while (cursor <= last) {
    out.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return out;
}

/**
 * The partitions that are entirely older than `cutoff` and may be dropped.
 *
 * ENTIRELY, which is why it compares the month's END. A partition covering the month a cutoff
 * falls inside still holds rows that are within retention, and dropping it would delete traces a
 * plan promised to keep — the difference between "roughly a month early" and "correct" here is
 * somebody's data.
 */
export function droppableMonths(existing: readonly string[], cutoff: Date): string[] {
  return existing
    .map((name) => ({ name, month: monthOfPartition(name) }))
    .filter((p): p is { name: string; month: Date } => p.month !== null)
    .filter((p) => addMonths(p.month, 1) <= cutoff)
    .map((p) => p.name)
    .sort();
}

export interface PartitionSummary {
  /** Partition names, oldest first. Empty on SQLite. */
  months: string[];
  /** Rows sitting in the DEFAULT partition, which is a number that should be zero. */
  defaultRows: number;
}

/**
 * Create whatever months are missing. Idempotent, and safe to run at every boot.
 *
 * `CREATE TABLE IF NOT EXISTS … PARTITION OF` is the whole of the concurrency handling: two
 * replicas booting together both try, one wins, and the loser's IF NOT EXISTS makes its attempt a
 * no-op rather than an error. That is a weaker guarantee than the migration runner's advisory
 * lock and it is the right one here — this is maintenance, not schema, and blocking a boot on a
 * lock held by another replica's maintenance would be a worse trade.
 */
export async function ensurePartitions(db: Db, now = new Date(), aheadMonths = MONTHS_AHEAD): Promise<string[]> {
  if (db.dialect !== "postgres") return [];
  const oldestRow = await db.get<{ oldest: string | null }>(
    `SELECT MIN(started_at) AS oldest FROM ${PARTITIONED_TABLE}`,
  );
  const oldest = oldestRow?.oldest ? new Date(oldestRow.oldest) : null;
  const created: string[] = [];
  for (const month of requiredMonths(now, Number.isNaN(oldest?.getTime() ?? NaN) ? null : oldest, aheadMonths)) {
    const name = partitionName(month);
    // Identifiers, never parameters: a partition bound cannot be bound as a parameter in DDL.
    // They are derived from a Date here and from a regex-validated name in `dropPartition`, so
    // nothing user-supplied reaches either — which is the rule that makes this string
    // interpolation acceptable where `db.ts`'s header says it never is.
    await db.exec(
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${PARTITIONED_TABLE} ` +
        `FOR VALUES FROM ('${bound(month)}') TO ('${bound(addMonths(month, 1))}')`,
    );
    created.push(name);
  }
  return created;
}

/** What exists now, and how many rows have fallen through to the default. */
export async function describePartitions(db: Db): Promise<PartitionSummary> {
  if (db.dialect !== "postgres") return { months: [], defaultRows: 0 };
  const rows = await db.all<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = ?
      ORDER BY c.relname ASC`,
    [PARTITIONED_TABLE],
  );
  const months = rows.map((r) => r.name).filter((n) => monthOfPartition(n) !== null);
  const fallen = await db.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${PARTITIONED_TABLE}_default`);
  return { months, defaultRows: Number(fallen?.n ?? 0) };
}

/**
 * Drop one month. The whole reason the table is partitioned.
 *
 * The name is re-validated here rather than trusted from the caller, even though the only caller
 * gets it from `droppableMonths`, which gets it from the catalogue. It is a `DROP TABLE` built by
 * string concatenation, and the distance between "this can only be called with a safe value" and
 * "this can only be called" is one refactor.
 */
export async function dropPartition(db: Db, name: string): Promise<boolean> {
  if (db.dialect !== "postgres") return false;
  if (monthOfPartition(name) === null) throw new Error(`not a steps partition: ${name}`);
  await db.exec(`DROP TABLE IF EXISTS ${name}`);
  return true;
}
