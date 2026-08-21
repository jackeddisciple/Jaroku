// A `timestamptz` is not a string, and only one of the two drivers says so.
//
// WHAT THIS EXISTS FOR, in one sentence: the Activity pulse grouped its spend column with
// `SUBSTR(occurred_at, 1, ?)`, that column is `TEXT` on SQLite and a real `timestamptz` on
// Postgres, and Postgres has no `substr` that takes one — so the whole tab's cost band could never
// have run on the production driver:
//
//   function substr(timestamp with time zone, integer, unknown) does not exist
//
// Nothing caught it because every Activity suite opens SQLite, where a timestamp IS a string. It is
// the same failure `test:boolean-literals` was written for, one type over, and it was found the
// expensive way: a red CI, a fix, and then the NEXT error in the same statement, because Postgres
// reports one problem at a time and the GROUP BY it was also getting wrong came first.
//
// WHY THE TWO TYPES DIVERGED AT ALL, which is not an accident to be tidied up. The trace schema was
// frozen on ISO-8601 `text` in migration 002 and 029 argues that at length — `steps` is PARTITIONED
// on `started_at`, and the partition key is text on both drivers deliberately. Everything written
// after 003 uses `timestamptz` on Postgres, because that is the right type when nothing forces
// otherwise. So this codebase genuinely has both, forever, and the only defence is knowing which is
// which at the point somebody writes `SUBSTR(`.
//
// SO THIS IS A LINTER, NOT A PROOF, exactly as `expandContract.ts` and `booleanLiterals.test.ts`
// both say of themselves. It reads the Postgres migrations for which columns are `timestamptz`,
// reads the production SQL for string functions applied to them, and fails. It can be argued with
// by SQL written to confuse it; what it catches is the real case — somebody reaching for `substr`
// to get a date grain — on a laptop with no Postgres, which is exactly where that gets written.
//
// THE EXEMPTION IS THE REAL FIX, not a suppression. A statement that branches on `db.dialect` and
// spells the Postgres half with `to_char` is doing the correct thing, and this recognises it by
// looking for that branch in the same file rather than by a magic comment — a comment can be copied
// onto code that did not earn it, and a dialect branch cannot.
//
// TESTS AND CLIs ARE EXCLUDED ON PURPOSE, for the reason the boolean audit excludes them: a suite
// that opens SQLite and only SQLite may treat a timestamp as a string, and what must not is the
// code that runs against both.
//
//   npm run test:timestamp-text

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
};

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PG_MIGRATIONS = join(SERVER_DIR, "migrations", "postgres");
const SRC = join(SERVER_DIR, "src");

// --- 1. which columns are timestamps, and which are text, read from the schema ------------------
//
// BOTH SETS, because the answer that matters is "timestamp and never text". A column name that is
// `timestamptz` on one table and `text` on another cannot be judged without knowing which table a
// given statement meant, and this reader deliberately does not parse FROM clauses — so it says
// nothing about those rather than guessing. `started_at` is exactly that shape's opposite number:
// text on `runs`, `steps` and `eval_runs`, and the pulse's other two SUBSTRs are correct because
// of it.

function columnTypes(): { stamps: Set<string>; texts: Set<string> } {
  const stamps = new Set<string>();
  const texts = new Set<string>();

  for (const file of readdirSync(PG_MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    // Comments first. Every one of these files argues with itself at length, and the words
    // "timestamptz" and "text" appear in that prose more often than they do in the schema.
    const sql = readFileSync(join(PG_MIGRATIONS, file), "utf8").replace(/--[^\n]*/g, " ");

    for (const m of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+[a-z_]+\s*\(([\s\S]*?)\n\s*\)/gi)) {
      for (const line of m[1]!.split("\n")) {
        const stamp = /^\s*([a-z_]+)\s+timestamptz\b/i.exec(line);
        if (stamp) stamps.add(stamp[1]!.toLowerCase());
        const text = /^\s*([a-z_]+)\s+text\b/i.exec(line);
        if (text) texts.add(text[1]!.toLowerCase());
      }
    }
    for (const m of sql.matchAll(/ALTER TABLE\s+[a-z_]+\s+ADD COLUMN\s+([a-z_]+)\s+timestamptz\b/gi)) {
      stamps.add(m[1]!.toLowerCase());
    }
    for (const m of sql.matchAll(/ALTER TABLE\s+[a-z_]+\s+ADD COLUMN\s+([a-z_]+)\s+text\b/gi)) {
      texts.add(m[1]!.toLowerCase());
    }
  }
  return { stamps, texts };
}

const { stamps, texts } = columnTypes();
/** Timestamp somewhere and text nowhere: the columns a string function is unambiguously wrong on. */
const ALWAYS_STAMP = new Set([...stamps].filter((c) => !texts.has(c)));

check(
  `read the column types out of the Postgres schema (${stamps.size} timestamp, ${texts.size} text)`,
  stamps.has("occurred_at") && texts.has("started_at"),
  stamps.size === 0 ? "nothing matched — the parser above is what broke, not the schema" : "",
);
check(
  "...and `started_at` is excluded from the rule, because 002 froze the trace schema on text",
  ALWAYS_STAMP.has("occurred_at") && !ALWAYS_STAMP.has("started_at"),
);

// --- 2. what production SQL does to them --------------------------------------------------------

/** Functions that take a string and have no timestamp overload on Postgres. */
const STRING_FUNCTIONS = ["substr", "substring", "lower", "upper", "trim", "ltrim", "rtrim", "replace"];

interface Offence {
  file: string;
  fn: string;
  column: string;
}

/** Exported so the fixture below can prove the detector detects. */
export function offencesIn(file: string, source: string): Offence[] {
  const found: Offence[] = [];
  const sql = source.replace(/--[^\n]*/g, " ");
  // A file that branches on the driver has done the work; the Postgres half of such a statement is
  // built by name and never contains the bare column. Looked for in the file rather than the
  // statement because the branch is conventionally a `const` a line or two above the template.
  if (/\bdialect\s*===\s*"postgres"/.test(sql) || /\bdialect\s*!==\s*"sqlite"/.test(sql)) return found;

  for (const fn of STRING_FUNCTIONS) {
    const re = new RegExp(`\\b${fn}\\s*\\(\\s*(?:[a-z_]+\\.)?([a-z_]+)\\b`, "gi");
    for (const m of sql.matchAll(re)) {
      const column = m[1]!.toLowerCase();
      if (ALWAYS_STAMP.has(column)) found.push({ file, fn, column });
    }
  }
  return found;
}

// --- 3. the sweep --------------------------------------------------------------------------------

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".cli.ts")) out.push(full);
  }
  return out;
}

{
  const files = sourceFiles(SRC);
  check(`swept the production sources (${files.length} files)`, files.length > 100);

  const offences = files.flatMap((f) =>
    offencesIn(relative(SERVER_DIR, f), readFileSync(f, "utf8")),
  );
  check(
    "no string function is applied to a column that is a timestamp on Postgres",
    offences.length === 0,
    offences.map((o) => `${o.file}: ${o.fn}(${o.column})`).join("\n       "),
  );
}

// --- 4. and the rule still fails on text designed to fail it -------------------------------------
//
// A pass has to mean the rule ran. `test:db-boundary` asserts the same thing about itself, and for
// the same reason: an audit whose detector silently stopped matching is an audit that reports
// success forever.

{
  const planted = offencesIn(
    "fixture.ts",
    "const q = `SELECT SUBSTR(occurred_at, 1, 10) AS k FROM usage_events GROUP BY k`;",
  );
  check("the detector detects a planted offence", planted.length === 1 && planted[0]!.column === "occurred_at");

  const exempt = offencesIn(
    "fixture.ts",
    'const iso = this.db.dialect === "postgres" ? "to_char(occurred_at, ...)" : "occurred_at";\n' +
      "const q = `SELECT SUBSTR(${iso}, 1, 10) AS k FROM usage_events`;",
  );
  check("...and a dialect-branched statement is not one", exempt.length === 0);

  const textColumn = offencesIn(
    "fixture.ts",
    "const q = `SELECT SUBSTR(started_at, 1, 10) AS day FROM runs`;",
  );
  check("...and a genuinely-text column is left alone", textColumn.length === 0);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
