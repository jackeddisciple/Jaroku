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
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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


// --- 066, against a database with something in it ---------------------------------------------
//
// §14 ASKS FOR THIS BY NAME: "the CHECK-constraint rebuild is the risky migration here. Run it
// against a populated database, both dialects, and confirm indexes and foreign keys survived."
// Everything above this line runs against invented two-line migrations, which is the right way to
// test the RUNNER and cannot see anything about the schema it carries. This section runs the real
// files.
//
// WHY IT IS POPULATED RATHER THAN EMPTY, and it is the whole point. `DROP TABLE thread_items`
// performs an implicit `DELETE FROM`, and five tables reference it `ON DELETE CASCADE` — so on an
// empty database the naive rebuild and the correct one are indistinguishable, and every assertion
// about indexes and constraints passes either way. The rows below are what tell them apart: a note,
// a pin, a rating, an attachment and a variant, each of which the naive version deletes on its way
// past and leaves a schema nothing would complain about.
//
// APPLIED IN TWO PASSES — everything up to 065, then 066 alone — because that is what a deployment
// does. Migrating an empty database in one go would let 066 run against a `thread_items` that was
// created moments earlier in the same session; here it runs against one that already holds rows.
{
  const real = join(fileURLToPath(new URL("../..", import.meta.url)), "migrations", "sqlite");
  const upTo = (limit: number): string => {
    const dir = mkdtempSync(join(tmpdir(), "jaroku-066-"));
    dirs.push(dir);
    for (const f of readdirSync(real)) {
      if (!f.endsWith(".sql") || Number(f.slice(0, 3)) > limit) continue;
      copyFileSync(join(real, f), join(dir, f));
    }
    return dir;
  };

  const { t, db } = target();
  await migrate(t, upTo(65), quiet);

  const WS = "00000000-0000-4000-8000-0000000000aa";
  const USER = "00000000-0000-4000-8000-0000000000bb";
  const THREAD = "00000000-0000-4000-8000-0000000000cc";
  const TURN = "00000000-0000-4000-8000-0000000000dd";
  const now = "2026-01-01T00:00:00.000Z";
  db.exec(`
    INSERT INTO workspaces (id, slug, name, kind, plan, created_at)
      VALUES ('${WS}', 'parity', 'Parity', 'personal', 'free', '${now}');
    INSERT INTO users (id, external_id, email, created_at)
      VALUES ('${USER}', 'ext-parity', 'parity@example.com', '${now}');
    INSERT INTO threads (id, workspace_id, agent_id, agent_name_snapshot, title, title_is_custom,
                         created_by, created_at, last_activity_at, status)
      VALUES ('${THREAD}', '${WS}', NULL, 'tracey', 'Tracey', 0, '${USER}', '${now}', '${now}', 'idle');
    INSERT INTO thread_items (id, workspace_id, thread_id, kind, ref_id, role, body, created_at)
      VALUES ('${TURN}', '${WS}', '${THREAD}', 'message', NULL, 'user', 'did that mail go out?', '${now}');
    INSERT INTO turn_attachments (id, workspace_id, turn_id, kind, ref, resolved_at, token_estimate)
      VALUES ('a1', '${WS}', '${TURN}', 'file', '{}', '${now}', 7);
    INSERT INTO turn_variants (id, workspace_id, turn_id, ordinal, created_at)
      VALUES ('v1', '${WS}', '${TURN}', 1, '${now}');
    INSERT INTO turn_notes (id, workspace_id, turn_id, author_id, body, created_at, updated_at)
      VALUES ('n1', '${WS}', '${TURN}', '${USER}', 'a note', '${now}', '${now}');
    INSERT INTO turn_pins (workspace_id, conversation_id, turn_id, user_id, created_at)
      VALUES ('${WS}', '${THREAD}', '${TURN}', '${USER}', '${now}');
    INSERT INTO turn_feedback (workspace_id, turn_id, user_id, rating, reasons, comment, created_at, updated_at)
      VALUES ('${WS}', '${TURN}', '${USER}', 1, '[]', NULL, '${now}', '${now}');
  `);

  await migrate(t, upTo(66), quiet);

  const one = (sql: string): number => Number((db.prepare(sql).get() as { n: number | bigint }).n);
  // THE ROWS THE CASCADE WOULD HAVE TAKEN. Five assertions, one per referencing table, because a
  // rebuild that got four of them out of the way and forgot the fifth is a rebuild that loses one
  // feature's data and passes any test that only counted the parent's rows.
  check(one(`SELECT COUNT(*) n FROM thread_items`) === 1, "066: the item survived the rebuild");
  check(one(`SELECT COUNT(*) n FROM turn_attachments`) === 1, "066: its attachment was not cascaded away");
  check(one(`SELECT COUNT(*) n FROM turn_variants`) === 1, "066: its variant was not cascaded away");
  check(one(`SELECT COUNT(*) n FROM turn_notes`) === 1, "066: its note was not cascaded away");
  check(one(`SELECT COUNT(*) n FROM turn_pins`) === 1, "066: its pin was not cascaded away");
  check(one(`SELECT COUNT(*) n FROM turn_feedback`) === 1, "066: its rating was not cascaded away");

  const idx = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='thread_items' ORDER BY name`,
  ).all() as { name: string }[]).map((r) => r.name);
  check(idx.includes("thread_items_thread"), "066: thread_items_thread was recreated");
  check(idx.includes("thread_items_ref"), "066: thread_items_ref was recreated — §5's reverse lookup");
  // THE ONE 059'S HEADER WARNS ABOUT. Its absence is not an error at any statement: it is five
  // foreign keys pointing at a pair of columns with nothing unique behind them.
  check(idx.includes("thread_items_ws_id_unique"), "066: the unique index five foreign keys need was recreated");

  const dupe = ((): string => {
    try {
      db.exec(`INSERT INTO thread_items (id, workspace_id, thread_id, kind, created_at)
               VALUES ('${TURN}', '${WS}', '${THREAD}', 'message', '${now}')`);
      return "";
    } catch (e) { return (e as Error).message; }
  })();
  check(dupe !== "", "066: and it still refuses a second row for the same (workspace, id)");

  // THE WIDENING ITSELF, from both directions: the seventh word is accepted and an eighth is not.
  // Only the second of those could pass on a table whose CHECK had been dropped and not replaced.
  db.exec(`INSERT INTO thread_items (id, workspace_id, thread_id, kind, ref_id, created_at)
           VALUES ('w1', '${WS}', '${THREAD}', 'work', 'some-work-item', '${now}')`);
  check(one(`SELECT COUNT(*) n FROM thread_items WHERE kind = 'work'`) === 1, "066: a work item may be written into a thread");
  const bogus = ((): string => {
    try {
      db.exec(`INSERT INTO thread_items (id, workspace_id, thread_id, kind, created_at)
               VALUES ('x1', '${WS}', '${THREAD}', 'nonsense', '${now}')`);
      return "";
    } catch (e) { return (e as Error).message; }
  })();
  check(bogus.includes("CHECK"), "066: and the CHECK still refuses a kind that is not one of the seven");

  // AND THE FOREIGN KEYS THEMSELVES, asked of the database rather than inferred from the schema
  // text. `foreign_key_check` walks every row of every referencing table and reports the ones whose
  // parent is missing — which is the assertion that would fail if the rename had left the five
  // children pointing at something that no longer resolves.
  check(
    (db.prepare(`PRAGMA foreign_key_check`).all() as unknown[]).length === 0,
    "066: every foreign key in the database still resolves",
  );

  db.close();
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
