// Month arithmetic, and the two mistakes that cost data.
//
// THE ARITHMETIC IS THE TEST. Everything this module does to a database is `CREATE TABLE … IF NOT
// EXISTS` and `DROP TABLE` — statements whose correctness is entirely in the name and the bounds
// handed to them. The two ways to get that wrong both destroy something: dropping a partition
// that still holds rows inside the retention window deletes traces a plan promised to keep, and
// failing to create next month's partition silently stops recording every agent's steps.
//
// Both are pure functions here on purpose. A test that needed a Postgres to prove that December
// is followed by January is a test that runs on one machine.
//
//   npm run test:partitions
//   JAROKU_PG_URL=postgres://… npm run test:partitions    # also exercises the real DDL

import { withScratchPostgres, openTestSqlite } from "../db/testDb.ts";
import {
  MONTHS_AHEAD,
  addMonths,
  bound,
  describePartitions,
  dropPartition,
  droppableMonths,
  ensurePartitions,
  monthOfPartition,
  monthStart,
  partitionName,
  requiredMonths,
} from "./partitions.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const utc = (iso: string): Date => new Date(iso);

console.log("\nmonths");
{
  check(bound(monthStart(utc("2026-08-12T09:14:22.001Z"))) === "2026-08-01", "a month starts at its first day, in UTC");
  check(bound(addMonths(monthStart(utc("2026-12-31T23:59:59Z")), 1)) === "2027-01-01", "December is followed by January");
  check(bound(addMonths(monthStart(utc("2026-01-15T00:00:00Z")), -1)) === "2025-12-01", "...and preceded by it");
  check(partitionName(monthStart(utc("2026-08-01T00:00:00Z"))) === "steps_2026_08", "a partition is named for its month");
  check(partitionName(monthStart(utc("2026-01-01T00:00:00Z"))) === "steps_2026_01", "...zero-padded, so names sort");

  check(monthOfPartition("steps_2026_08")?.toISOString().startsWith("2026-08-01") === true, "a name parses back");
  check(monthOfPartition("steps_default") === null, "the default partition is not a month");
  check(monthOfPartition("steps_2026_13") === null, "...nor is a thirteenth one");
  check(monthOfPartition("runs_2026_08") === null, "...nor another table's");
  check(monthOfPartition("steps; DROP TABLE users") === null, "...nor anything shaped like an attack");
}

console.log("\nUTC, not local time");
{
  // The first instant of a month in UTC. In any timezone west of UTC a local-time computation
  // puts this in the previous month, and the row lands in whichever partition the server's clock
  // believed in — which is a bug that only reproduces on servers in the Americas.
  const firstInstant = utc("2026-09-01T00:00:00.000Z");
  check(partitionName(monthStart(firstInstant)) === "steps_2026_09", "midnight on the first belongs to the month it starts");
  const lastInstant = utc("2026-08-31T23:59:59.999Z");
  check(partitionName(monthStart(lastInstant)) === "steps_2026_08", "...and the millisecond before it to the one it ends");
}

console.log("\nwhich partitions must exist");
{
  const now = utc("2026-08-12T00:00:00Z");
  const fresh = requiredMonths(now, null);
  check(fresh.length === MONTHS_AHEAD + 1, `a database with no steps still gets ${MONTHS_AHEAD + 1} months`);
  check(partitionName(fresh[0]!) === "steps_2026_08", "...starting with this one");
  check(partitionName(fresh.at(-1)!) === "steps_2026_10", "...and running ahead of today");

  const historic = requiredMonths(now, utc("2026-05-20T00:00:00Z"));
  check(partitionName(historic[0]!) === "steps_2026_05", "an existing trace's oldest month is covered");
  check(historic.length === 6, `...through to the months ahead (${historic.length})`);

  // A restored dump with a nonsense timestamp, or a clock skewed into the past. Ten thousand
  // partitions is a worse outcome than a few old rows staying where they already are.
  const absurd = requiredMonths(now, utc("1970-01-01T00:00:00Z"));
  check(absurd.length <= 64, `an absurd oldest timestamp is floored rather than obeyed (${absurd.length})`);
}

console.log("\nwhich may be dropped");
{
  const existing = ["steps_2026_05", "steps_2026_06", "steps_2026_07", "steps_2026_08", "steps_default"];
  // Retention has expired everything before 1 July.
  const dropped = droppableMonths(existing, utc("2026-07-01T00:00:00Z"));
  check(dropped.join(",") === "steps_2026_05,steps_2026_06", "months entirely past the cutoff are dropped");
  check(!dropped.includes("steps_default"), "the default partition is never a drop candidate");
  check(!dropped.includes("steps_2026_07"), "the month the cutoff FALLS IN is kept — it still holds rows inside retention");

  // A cutoff one millisecond into July: July is still partly inside retention, and dropping it
  // would delete a month of traces a plan promised to keep.
  check(
    !droppableMonths(existing, utc("2026-07-01T00:00:00.001Z")).includes("steps_2026_07"),
    "...and is still kept a millisecond later",
  );
  check(
    droppableMonths(existing, utc("2026-08-01T00:00:00Z")).includes("steps_2026_07"),
    "...and is dropped once the whole month is past",
  );
  check(droppableMonths(existing, utc("2020-01-01T00:00:00Z")).length === 0, "a cutoff before everything drops nothing");
}

console.log("\nSQLite does none of it");
{
  const db = await openTestSqlite();
  check((await ensurePartitions(db)).length === 0, "ensuring creates nothing on a driver with no partitions");
  const summary = await describePartitions(db);
  check(summary.months.length === 0 && summary.defaultRows === 0, "...and describing one answers empty rather than throwing");
  check((await dropPartition(db, "steps_2026_01")) === false, "...and dropping is a no-op rather than a DELETE in disguise");
  await db.close();
}

console.log("\nand a name is re-validated at the DROP");
{
  const db = await openTestSqlite();
  let refused = false;
  try {
    await dropPartition(db, "users");
  } catch {
    refused = true;
  }
  // On SQLite the no-op returns before the check, so this asserts the ORDER: validation cannot
  // be something the postgres branch does after deciding to run a DROP.
  check(!refused, "on SQLite nothing is dropped and nothing is validated, because nothing runs");
  await db.close();
}

await withScratchPostgres(async (db) => {
  console.log("\nthe real DDL");
  const created = await ensurePartitions(db, utc("2026-08-12T00:00:00Z"));
  check(created.includes("steps_2026_08"), "the current month exists");
  check(created.includes("steps_2026_10"), "...and two ahead of it");
  const again = await ensurePartitions(db, utc("2026-08-12T00:00:00Z"));
  check(again.length === created.length, "ensuring twice is idempotent rather than an error");

  const summary = await describePartitions(db);
  check(summary.months.includes("steps_2026_08"), "the catalogue agrees about what exists");
  check(summary.defaultRows === 0, "and nothing has fallen through to the default");

  check(await dropPartition(db, "steps_2026_08"), "a month can be dropped");
  check(!(await describePartitions(db)).months.includes("steps_2026_08"), "...and is gone from the catalogue");

  let refused = false;
  try {
    await dropPartition(db, "users");
  } catch {
    refused = true;
  }
  check(refused, "a name that is not a steps partition is refused before any DROP is built");
});

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
