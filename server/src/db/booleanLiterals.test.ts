// An inline `0` is not a `false`, and only one of the two drivers says so.
//
// WHAT THIS EXISTS FOR, in one sentence: `ThreadStore.create` wrote `title_is_custom` as a literal
// `0` in its INSERT, that column is `INTEGER` on SQLite and `boolean` on Postgres, and Postgres
// refuses to assign an integer expression to a boolean column — so creating a thread threw on the
// production driver, and had done since the feature shipped:
//
//   column "title_is_custom" is of type boolean but expression is of type integer
//
// Nothing caught it because every thread suite opens SQLite, where a boolean IS an integer.
//
// WHY A LITERAL AND A PARAMETER DIFFER, which is the whole subtlety. A bound value leaves the driver
// untyped: Postgres resolves it against the target column and accepts `0` as false, which is why
// every other boolean in this codebase — `hand_written`, `configured`, `overridden` — works written
// exactly that way. A literal in the statement TEXT is typed `integer` before the column is
// consulted, and no coercion is attempted. The two are indistinguishable on SQLite.
//
// SO THIS IS A LINTER, NOT A PROOF, exactly as `expandContract.ts` says of itself. It reads the
// Postgres migrations for which columns are boolean, reads the production SQL for what is written
// into them, and fails on a literal where a parameter is needed. It can be argued with by SQL
// written to confuse it; what it catches is the real case — somebody adding a column to an INSERT
// and spelling its default `0` — on a laptop with no Postgres, which is where that gets written.
//
// TESTS AND CLIs ARE EXCLUDED ON PURPOSE. A suite that opens SQLite and only SQLite may spell a
// boolean `0`, and several do; what must not is the code that runs against both.
//
//   npm run test:boolean-literals

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
};

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PG_MIGRATIONS = join(SERVER_DIR, "migrations", "postgres");
const SRC = join(SERVER_DIR, "src");

// --- 1. which columns are boolean, per table, read from the schema ------------------------------

function booleanColumns(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (table: string, column: string): void => {
    const key = table.toLowerCase();
    if (!out.has(key)) out.set(key, new Set());
    out.get(key)!.add(column.toLowerCase());
  };

  for (const file of readdirSync(PG_MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    // Comments first: every one of these files argues with itself at length, and the word "boolean"
    // appears in that prose more often than it does in the schema.
    const sql = readFileSync(join(PG_MIGRATIONS, file), "utf8").replace(/--[^\n]*/g, "");

    for (const m of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_]+)\s*\(([\s\S]*?)\n\s*\);/gi)) {
      for (const line of m[2]!.split("\n")) {
        const col = /^\s*([a-z_]+)\s+boolean\b/i.exec(line);
        if (col) add(m[1]!, col[1]!);
      }
    }
    for (const m of sql.matchAll(/ALTER TABLE\s+([a-z_]+)\s+ADD COLUMN\s+([a-z_]+)\s+boolean\b/gi)) {
      add(m[1]!, m[2]!);
    }
  }
  return out;
}

const BOOLEANS = booleanColumns();

check(
  `read the boolean columns out of the Postgres schema (${BOOLEANS.size} tables)`,
  BOOLEANS.get("threads")?.has("title_is_custom") === true &&
    BOOLEANS.get("agents")?.has("hand_written") === true,
  BOOLEANS.size === 0 ? "nothing matched — the parser above is what broke, not the schema" : "",
);

// --- 2. what production SQL writes into them ----------------------------------------------------

/** A value expression that is fine in a boolean column position. Anything else is suspect. */
const SAFE = /^(\?|\$\d+|NULL|DEFAULT|TRUE|FALSE|[A-Z_]+\.[A-Z_]+)$/i;

interface Offence {
  file: string;
  table: string;
  column: string;
  value: string;
}

/** Split a VALUES tuple on top-level commas — a nested `(…)` must not end a field. */
function splitTopLevel(tuple: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of tuple) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  out.push(current.trim());
  return out;
}

/** Exported so the fixture below can prove the detector detects. */
export function offencesIn(file: string, source: string): Offence[] {
  const found: Offence[] = [];
  const sql = source.replace(/--[^\n]*/g, " ");

  // INSERT INTO t (a, b, c) VALUES (?, 0, ?)
  for (const m of sql.matchAll(/INSERT\s+INTO\s+([a-z_]+)\s*\(([^)]*)\)\s*VALUES\s*\(([^;`]*?)\)/gi)) {
    const booleans = BOOLEANS.get(m[1]!.toLowerCase());
    if (!booleans) continue;
    const columns = m[2]!.split(",").map((c) => c.trim().toLowerCase());
    const values = splitTopLevel(m[3]!);
    // A shape this reader cannot align is one it says nothing about. A linter that guesses at
    // alignment would fail a statement for being written in a way it did not expect, which is how a
    // check like this ends up disabled.
    if (columns.length !== values.length) continue;
    columns.forEach((column, i) => {
      const value = values[i]!;
      if (booleans.has(column) && !SAFE.test(value)) found.push({ file, table: m[1]!, column, value });
    });
  }

  // `SET col = 0`, in an UPDATE or in an ON CONFLICT DO UPDATE. Only a BARE INTEGER is flagged: a
  // `CASE` or a column reference in a boolean position is ordinary SQL and types fine.
  for (const m of sql.matchAll(/(?:UPDATE|INSERT\s+INTO)\s+([a-z_]+)[\s\S]{0,4000}?SET([\s\S]*?)(?:WHERE|RETURNING|`)/gi)) {
    const booleans = BOOLEANS.get(m[1]!.toLowerCase());
    if (!booleans) continue;
    for (const set of m[2]!.matchAll(/([a-z_]+)\s*=\s*([^,\n]+)/gi)) {
      const column = set[1]!.toLowerCase();
      const value = set[2]!.trim().replace(/,$/, "");
      if (booleans.has(column) && /^\d+$/.test(value)) found.push({ file, table: m[1]!, column, value });
    }
  }

  // AND THE POSITION THE FIRST TWO SCANNERS MISSED: `WHERE ... col = 0`.
  //
  // Worth its own pass because it is the one that reads least like a type problem. A literal in a
  // SET or a VALUES is reported by Postgres as "column is of type boolean but expression is of type
  // integer", which names the column; in a WHERE the same mistake is `operator does not exist:
  // boolean = integer`, which reads as a missing operator. `autoTitle` had one, so the first user
  // message in any thread threw on the production driver — after `create` had already thrown.
  //
  // Scanned by column name across the whole statement rather than per table, because a WHERE may
  // name columns from anything the statement joined. The boolean names in this schema are all
  // distinctive, which is what makes that safe.
  const anyBoolean = new Set([...BOOLEANS.values()].flatMap((cols) => [...cols]));
  for (const m of sql.matchAll(/\bWHERE\b([\s\S]*?)(?:`|ORDER BY|GROUP BY|RETURNING|LIMIT)/gi)) {
    for (const cmp of m[1]!.matchAll(/([a-z_]+)\s*=\s*(\d+)\b/gi)) {
      const column = cmp[1]!.toLowerCase();
      if (anyBoolean.has(column)) found.push({ file, table: "(where)", column, value: cmp[2]! });
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

const files = sourceFiles(SRC);
const offences = files.flatMap((f) =>
  offencesIn(f.slice(SERVER_DIR.length + 1).replace(/\\/g, "/"), readFileSync(f, "utf8")),
);

check(
  `no production statement writes a literal into a boolean column (${files.length} files)`,
  offences.length === 0,
  offences
    .map((o) => `${o.file}: ${o.table}.${o.column} = ${o.value} — bind it as a parameter instead`)
    .join("\n       "),
);

// --- 4. and the detector detects -----------------------------------------------------------------
//
// A lint with no proof that it catches anything is decoration. This is the statement as it was
// written, verbatim, which threw on every thread creation against Postgres.
{
  const asItWas = [
    "await this.q(ctx).run(",
    "  `INSERT INTO threads (id, workspace_id, agent_id, agent_name_snapshot, title,",
    "                        title_is_custom, created_by, created_at, last_activity_at, status)",
    "   VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'idle')`,",
    ");",
  ].join("\n");

  const caught = offencesIn("fixture", asItWas);
  check(
    "the bug this file was written for is caught by it",
    caught.length === 1 && caught[0]?.column === "title_is_custom",
    JSON.stringify(caught),
  );

  // ...and the parameterised form is not, or the check would be unusable noise.
  const asItIs = asItWas.replace("?, ?, ?, ?, ?, 0,", "?, ?, ?, ?, ?, ?,");
  check("...and the form that replaced it is not", offencesIn("fixture", asItIs).length === 0);

  // The WHERE position, which the first version of this file did not scan and which was hiding a
  // third occurrence: `autoTitle`, where the failure reads as a missing operator rather than as a
  // type mismatch.
  const inAWhere = "`UPDATE threads SET title = ? WHERE workspace_id = ? AND title_is_custom = 0`,";
  check(
    "a boolean compared to an integer in a WHERE is caught as well",
    offencesIn("fixture", inAWhere).some((o) => o.column === "title_is_custom"),
  );
  const bound = inAWhere.replace("title_is_custom = 0", "title_is_custom = ?");
  check("...and the bound comparison is not", offencesIn("fixture", bound).length === 0);

}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
