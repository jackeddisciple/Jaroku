// The migration runner's guarantees, which are the ones nothing else can check for you.
//
// A migration tool is trusted with the only copy of the schema, and every way it can go
// wrong is quiet: a file skipped because its name did not parse, a second apply of
// something that already ran, a half-applied migration recorded as complete, an edited file
// whose database no longer matches it. None of those announce themselves — you find them
// later, in the shape of a column that isn't there.
//
//   npm run test:migrate

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, migrate, type MigrationTarget } from "./migrate.ts";
import { sqliteMigrationTarget } from "./sqlite.ts";

let fail = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    fail++;
    console.log(`  FAIL ${msg}`);
  }
};

const dirs: string[] = [];
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "jaroku-migrate-"));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

function target(): { t: MigrationTarget; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return { t: sqliteMigrationTarget(db), db };
}

const quiet = (): void => {};
const tables = (db: DatabaseSync): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as {
    name: string;
  }[]).map((r) => r.name);
const versions = (db: DatabaseSync): number[] =>
  (db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as {
    version: number;
  }[]).map((r) => Number(r.version));

console.log("\nloading");

// Lexical order and version order agree only because the numbers are zero-padded. Read them
// out of order on disk and the runner must still apply them in numeric order.
{
  const dir = fixture({
    "010_ten.sql": "SELECT 1;",
    "002_two.sql": "SELECT 1;",
    "001_one.sql": "SELECT 1;",
  });
  const got = loadMigrations(dir).map((m) => `${m.version}:${m.name}`);
  check(
    JSON.stringify(got) === JSON.stringify(["1:one", "2:two", "10:ten"]),
    `versions sort numerically, not lexically (${got.join(", ")})`,
  );
}

// A file the runner cannot parse a version out of must stop it. Skipping it silently is
// how a migration never runs and nobody finds out until something reads the column.
{
  let threw = "";
  try {
    loadMigrations(fixture({ "add_users.sql": "SELECT 1;" }));
  } catch (e) {
    threw = (e as Error).message;
  }
  check(threw.includes("NNN_lower_snake.sql"), "an unparseable filename is refused, not skipped");
}

{
  let threw = "";
  try {
    loadMigrations(fixture({ "003_a.sql": "SELECT 1;", "003_b.sql": "SELECT 1;" }));
  } catch (e) {
    threw = (e as Error).message;
  }
  check(threw.includes("two files claim version 003"), "two files at one version is refused");
}

check(loadMigrations(join(tmpdir(), "jaroku-does-not-exist")).length === 0, "a missing directory is empty, not an error");

console.log("\napplying");

{
  const dir = fixture({
    "001_a.sql": "CREATE TABLE a (id integer PRIMARY KEY);",
    "002_b.sql": "CREATE TABLE b (id integer PRIMARY KEY);",
  });
  const { t, db } = target();
  const first = await migrate(t, dir, quiet);
  check(first.applied.length === 2 && first.alreadyApplied === 0, "both migrations applied on a fresh database");
  check(tables(db).includes("a") && tables(db).includes("b"), "the tables they describe exist");

  // The property the whole mechanism is for: running again does nothing at all.
  const second = await migrate(t, dir, quiet);
  check(
    second.applied.length === 0 && second.alreadyApplied === 2,
    "a second run applies nothing and reports both as already applied",
  );
}

// A comment-only migration is a real migration. Both dialect directories share one
// numbering, so a version one of them has nothing to do for is a file full of prose — and
// it has to apply, record, and checksum like any other or the sequences drift.
{
  const dir = fixture({ "001_nothing.sql": "-- nothing to do on this dialect, and that is the point\n" });
  const { t, db } = target();
  const res = await migrate(t, dir, quiet);
  check(res.applied.length === 1 && versions(db)[0] === 1, "a comment-only migration applies and is recorded");
}

// Only the new one runs. An already-applied migration re-executing would be the same bug as
// never having tracked them at all — most DDL is not idempotent and the second CREATE
// throws, taking the boot with it.
{
  const dir = fixture({ "001_a.sql": "CREATE TABLE a (id integer PRIMARY KEY);" });
  const { t, db } = target();
  await migrate(t, dir, quiet);
  writeFileSync(join(dir, "002_b.sql"), "CREATE TABLE b (id integer PRIMARY KEY);");
  const res = await migrate(t, dir, quiet);
  check(
    res.applied.length === 1 && res.applied[0]!.name === "b" && versions(db).join(",") === "1,2",
    "adding a file applies only that one",
  );
}

console.log("\nrefusing");

// The checksum's whole job. Every migration numbered above this one was written against the
// schema the OLD text produced, so an edited file describes a database nobody has.
{
  const dir = fixture({ "001_a.sql": "CREATE TABLE a (id integer PRIMARY KEY);" });
  const { t } = target();
  await migrate(t, dir, quiet);
  writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (id integer PRIMARY KEY, extra text);");
  let threw = "";
  try {
    await migrate(t, dir, quiet);
  } catch (e) {
    threw = (e as Error).message;
  }
  check(
    threw.includes("has changed since it was applied") && threw.includes("001_a.sql"),
    "an edited applied migration is refused, by name",
  );
}

// The mirror image: an older checkout pointed at a newer database. Applying its "pending"
// work on top of a schema from the future is how you get a half-migrated one.
{
  const dir = fixture({ "001_a.sql": "CREATE TABLE a (id integer PRIMARY KEY);", "002_b.sql": "CREATE TABLE b (id integer PRIMARY KEY);" });
  const { t, db } = target();
  await migrate(t, dir, quiet);
  rmSync(join(dir, "002_b.sql"));
  let threw = "";
  try {
    await migrate(t, dir, quiet);
  } catch (e) {
    threw = (e as Error).message;
  }
  check(threw.includes("ahead of your code"), "a database ahead of the checkout is refused");
  check(tables(db).includes("b"), "and nothing was undone by refusing");
}

// Either it happened and is written down, or it did neither. Both dialects have
// transactional DDL, which is what makes the migration and the row recording it one unit.
{
  const dir = fixture({
    "001_a.sql": "CREATE TABLE a (id integer PRIMARY KEY);",
    "002_bad.sql": "CREATE TABLE b (id integer PRIMARY KEY);\nTHIS IS NOT SQL;",
  });
  const { t, db } = target();
  let threw = "";
  try {
    await migrate(t, dir, quiet);
  } catch (e) {
    threw = (e as Error).message;
  }
  check(threw.includes("002_bad failed"), "a broken migration fails by name");
  check(versions(db).join(",") === "1", "the good one before it stayed applied");
  check(!tables(db).includes("b"), "the broken one's half-finished work was rolled back");
  check(!versions(db).includes(2), "and it is not recorded as applied");
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
