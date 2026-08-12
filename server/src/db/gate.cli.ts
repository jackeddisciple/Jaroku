// The check the deploy pipeline runs before it lets a migration near production.
//
//   npm run migrate:check                  # every migration this checkout has
//   npm run migrate:check -- --since 026   # only what a deploy would newly apply
//
// EXIT CODE IS THE POINT. This is a gate, and a gate that prints a warning is a suggestion. The
// pipeline runs it between "build" and "migrate", so a pull request adding a DROP COLUMN beside
// the code that stops using the column fails before anything touches a database.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareDialects, inspectMigration, OVERRIDE_MARKER, type Finding } from "./expandContract.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

// WHAT HAS ALREADY SHIPPED IS HISTORY. A migration that ran a year ago cannot be made
// compatible now, and a gate that fails on it is a gate somebody disables. The baseline is the
// highest version reviewed under this rule; everything above it has to pass. Raising it is a
// deliberate edit, in a file whose whole content is one number, visible in a diff.
const BASELINE = join(MIGRATIONS, "gate-baseline");
const baseline = Number(readFileSync(BASELINE, "utf8").trim().split(/\s+/)[0] ?? 0);
const sinceArg = process.argv.indexOf("--since");
const since = sinceArg >= 0 ? Number(process.argv[sinceArg + 1]) : baseline;

const list = (dialect: string): string[] =>
  readdirSync(join(MIGRATIONS, dialect))
    .filter((f) => f.endsWith(".sql"))
    .sort();

const postgres = list("postgres");
const sqlite = list("sqlite");

const dialectProblems = compareDialects(postgres, sqlite);
for (const problem of dialectProblems) console.error(`[gate] ${problem}`);

const findings: Finding[] = [];
const overridden: Finding[] = [];
// POSTGRES ONLY, and that is the rule rather than a shortcut. Expand/migrate/contract exists
// because a ROLLING DEPLOY leaves the old version serving against the new schema for a few
// minutes. SQLite is one local process holding one file: there is no second version serving, and
// its table-rebuild idiom — create, copy, drop, rename — is the only way that driver alters a
// table at all. Applying the rule there would fail every migration this codebase has and teach
// everybody to pass a flag. The sqlite half is still checked for dialect parity above.
for (const dialect of ["postgres"]) {
  for (const file of list(dialect)) {
    if (Number(file.slice(0, 3)) <= since) continue;
    const result = inspectMigration(`${dialect}/${file}`, readFileSync(join(MIGRATIONS, dialect, file), "utf8"));
    findings.push(...result.findings);
    overridden.push(...result.overridden);
  }
}

for (const f of overridden) {
  // Reported, never hidden. An override is a claim somebody made in a comment, and the deploy
  // log is where it should be visible when the claim turns out to have been wrong.
  console.log(`[gate] ALLOWED (${OVERRIDE_MARKER}) ${f.file}: ${f.statement}`);
}
for (const f of findings) {
  console.error(`\n[gate] ${f.compatibility.toUpperCase()} — ${f.file}`);
  console.error(`       ${f.statement}`);
  console.error(`       ${f.reason}`);
  console.error(`       If this deploy IS the contract step, say so in the migration: -- ${OVERRIDE_MARKER}`);
}

if (findings.length || dialectProblems.length) {
  console.error(`\n[gate] ${findings.length} incompatible statement(s), ${dialectProblems.length} dialect problem(s)`);
  process.exit(1);
}
console.log(
  `[gate] ${postgres.length} migration(s) per dialect, ${overridden.length} explicit contract step(s), nothing that breaks a running version`,
);
