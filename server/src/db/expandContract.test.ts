// The gate: what it refuses, what it allows, and what it must not fail on.
//
// A LINTER'S TEST IS MOSTLY ABOUT FALSE POSITIVES. A gate that fails a legitimate migration is a
// gate somebody adds a flag to their deploy command to skip, and then it protects nothing — so
// half of this suite is ordinary migrations that must pass: adding a nullable column, creating a
// table, a `DO $$ … $$` block whose semicolons are not statement separators, and a comment that
// happens to contain the words DROP COLUMN.
//
//   npm run test:migration-gate

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OVERRIDE_MARKER, compareDialects, inspectMigration, splitStatements } from "./expandContract.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const inspect = (sql: string) => inspectMigration("test.sql", sql);

console.log("\nwhat breaks a version that is still serving");
{
  check(!inspect("DROP TABLE runs;").ok, "dropping a table");
  check(!inspect("ALTER TABLE runs DROP COLUMN cost;").ok, "dropping a column the old code still SELECTs");
  check(!inspect("ALTER TABLE runs RENAME TO run;").ok, "a rename, which is a drop and an add at once");
  check(!inspect("ALTER TABLE runs ALTER COLUMN cost SET NOT NULL;").ok, "tightening a column the old code writes null into");
  check(!inspect("ALTER TABLE runs ALTER COLUMN cost TYPE numeric;").ok, "changing a type under a running writer");
  check(!inspect("ALTER TABLE runs ADD COLUMN owner text NOT NULL;").ok, "adding a NOT NULL column with no default");
  check(!inspect("ALTER TABLE runs DROP CONSTRAINT runs_pkey;").ok, "dropping a constraint");

  const finding = inspect("ALTER TABLE runs DROP COLUMN cost;").findings[0]!;
  check(finding.compatibility === "breaking", "...classified as breaking");
  check(finding.reason.includes("next"), "...and the reason says what to do instead, not just that it is wrong");
}

console.log("\nwhat is compatible and must pass");
{
  check(inspect("ALTER TABLE runs ADD COLUMN note text;").ok, "adding a nullable column");
  check(inspect("ALTER TABLE runs ADD COLUMN note text NOT NULL DEFAULT '';").ok, "...or a NOT NULL one WITH a default");
  check(inspect("CREATE TABLE new_thing (id uuid PRIMARY KEY);").ok, "creating a table");
  check(inspect("CREATE INDEX new_thing_id ON new_thing (id);").ok, "indexing a small new table");
  check(inspect("CREATE INDEX CONCURRENTLY steps_extra ON steps (workspace_id);").ok, "...and a big one, concurrently");
  check(inspect("GRANT SELECT ON new_thing TO jaroku_app;").ok, "a grant");
  check(
    inspect(`CREATE POLICY tenant_isolation ON new_thing USING (workspace_id = current_setting('app.workspace_id')::uuid);`).ok,
    "an RLS policy",
  );
  check(
    inspect("-- this migration will DROP COLUMN cost in a later deploy\nALTER TABLE runs ADD COLUMN cost2 numeric;").ok,
    "a COMMENT mentioning a drop is not a drop",
  );
  // A NEW TABLE WITH INLINE CHECK CONSTRAINTS, which is what 063 is and which is the shape most
  // likely to be read as "a constraint change" by a gate that greps for the word. Adding a CHECK to
  // an EXISTING column is genuinely breaking — the version still serving writes values the new
  // constraint refuses — and the two look almost identical in text. Nothing is serving a table that
  // does not exist yet, so this must pass, and a gate that failed it is a gate somebody skips.
  check(
    inspect(`CREATE TABLE work_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status text NOT NULL CHECK (status IN ('queued','running','waiting','succeeded','failed','cancelled')),
      failure_kind text CHECK (failure_kind IN ('unauthorised','agent_error','rejected','unreachable','stopped_reporting','busy'))
    );`).ok,
    "a new table's inline CHECK constraints are not a constraint change",
  );
  check(
    inspect("CREATE INDEX work_items_ws_created ON work_items (workspace_id, created_at DESC);").ok,
    "...and indexing that new table needs no CONCURRENTLY, because it has no rows to lock",
  );
}

console.log("\nlocks, which are a different problem from compatibility");
{
  const blocking = inspect("CREATE INDEX steps_extra ON steps (workspace_id);");
  check(!blocking.ok, "an index built on `steps` without CONCURRENTLY is refused");
  check(blocking.findings[0]!.compatibility === "blocking", "...as blocking rather than breaking — nothing is incompatible, it is an outage");
  check(!inspect("UPDATE steps SET error = NULL;").ok, "an unqualified UPDATE of a huge table is refused");
  check(inspect("UPDATE steps SET error = NULL WHERE run_id = 'x';").ok, "...and a bounded one is fine");
}

console.log("\nthe override");
{
  const sql = `-- ${OVERRIDE_MARKER}: nothing has read this column since v0.2.9\nALTER TABLE runs DROP COLUMN legacy;`;
  const result = inspect(sql);
  check(result.ok, "a statement carrying the marker passes");
  check(result.overridden.length === 1, "...and is REPORTED rather than hidden, so the claim is visible in the deploy log");
  check(result.findings.length === 0, "...and is not also a finding");
  check(
    inspect("ALTER TABLE runs DROP COLUMN legacy;").ok === false,
    "...while the same statement without it does not pass",
  );
}

console.log("\nstatement splitting");
{
  const doBlock = `
    DO $$
    BEGIN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', 'runs');
      EXECUTE format('DROP POLICY IF EXISTS p ON %I', 'runs');
    END
    $$;
    CREATE TABLE after_the_block (id int);
  `;
  const statements = splitStatements(doBlock).map((s) => s.trim()).filter(Boolean);
  check(statements.length === 2, `a DO $$ … $$ body is one statement, not four (${statements.length})`);
  check(inspect(doBlock).ok, "...and a policy loop is not read as a DROP");
}

console.log("\nthe two dialects");
{
  check(compareDialects(["001_a.sql"], ["001_a.sql"]).length === 0, "matching directories are fine");
  check(compareDialects(["001_a.sql", "002_b.sql"], ["001_a.sql"]).length === 1, "a missing sqlite counterpart is a problem");
  check(compareDialects(["001_a.sql"], ["001_a.sql", "002_b.sql"]).length === 1, "...and so is a missing postgres one");
  check(
    compareDialects(["001_a.sql", "003_c.sql"], ["001_a.sql", "003_c.sql"]).some((p) => p.includes("jumps")),
    "a gap in the numbering is a deleted migration and is reported",
  );
  check(
    compareDialects(["001_a.sql", "001_b.sql"], ["001_a.sql", "001_b.sql"]).some((p) => p.includes("numbered")),
    "...and two people numbering in parallel is reported too",
  );
}

console.log("\nthis repository's own migrations, above the baseline");
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
  const baseline = Number(readFileSync(join(root, "gate-baseline"), "utf8").trim().split(/\s+/)[0]);
  check(Number.isFinite(baseline) && baseline > 0, `the baseline is a number (${baseline})`);

  const pg = readdirSync(join(root, "postgres")).filter((f) => f.endsWith(".sql")).sort();
  const lite = readdirSync(join(root, "sqlite")).filter((f) => f.endsWith(".sql")).sort();
  check(compareDialects(pg, lite).length === 0, "the two dialect directories agree, version for version");

  const above = pg.filter((f) => Number(f.slice(0, 3)) > baseline);
  const bad = above.flatMap((f) => inspectMigration(f, readFileSync(join(root, "postgres", f), "utf8")).findings);
  check(bad.length === 0, `every migration above the baseline passes the gate (${above.length} checked)`);
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
