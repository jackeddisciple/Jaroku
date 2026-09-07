// A uuid is not a text, and only one of the two drivers says so.
//
// WHAT THIS EXISTS FOR. `spendByThread` joined `thread_items.ref_id = work_items.id`. The first is
// TEXT — it points at whatever the row's kind column names, a run id or a work item id — and the
// second is a uuid. SQLite compares them happily; Postgres refuses outright:
//
//   operator does not exist: text = uuid
//
// And the cost was not the missing cost figure. That join is inside `threadSnapshot`, so the WHOLE
// snapshot threw, so the Threads list stopped refreshing on every hosted deployment — while working
// perfectly on every laptop, because every thread suite opens SQLite. It was found by reading a
// deployed log, which is the most expensive place to find anything.
//
// IT IS THE THIRD OF ITS KIND, and that is the argument for writing it. `test:boolean-literals`
// exists because an inline `0` is not a `false`; `test:timestamp-text` because a timestamptz is not
// a string. Same shape every time: SQLite has one type where Postgres has two, the SQL is written on
// a laptop, and the failure is invisible until it is in front of users.
//
// SO THIS IS A LINTER, NOT A PROOF, exactly as the other two say of themselves. It reads the
// Postgres migrations for which columns are uuid and which are text, reads the production SQL for
// comparisons between two COLUMNS, and fails where the two sides disagree. A comparison against a
// bound parameter is fine and is not examined: Postgres resolves an untyped parameter against the
// column, which is why `WHERE id = ?` works everywhere and is spelled that way throughout.
//
// TESTS, CLIs AND MIGRATIONS ARE EXCLUDED. A suite that opens only SQLite may do as it likes; what
// must not is the code that runs against both.
//
//   npm run test:uuid-text

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

let fail = 0;
// (ok, message) — the order `rateLimit.test.ts` uses. Worth stating because the sibling suites in
// this directory take (message, ok), and getting it backwards here made every assertion pass on a
// truthy string: the suite reported ALL CORRECT while checking nothing, which is the one failure a
// linter must not have.
const check = (ok: boolean, name: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
};

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PG_MIGRATIONS = join(SERVER_DIR, "migrations", "postgres");
const SRC = join(SERVER_DIR, "src");

// --- 1. the column types, read from the schema rather than from a list --------------------------

type Kind = "uuid" | "text";
const columns = new Map<string, Map<string, Kind>>();

function record(table: string, column: string, kind: Kind): void {
  const t = table.toLowerCase();
  if (!columns.has(t)) columns.set(t, new Map());
  // FIRST DECLARATION WINS, and later ones are ignored on purpose: a migration that ALTERs a column
  // to a new type would otherwise be read as a second opinion about the original. The suite is
  // conservative by construction — it can miss, it must not invent.
  const cols = columns.get(t)!;
  if (!cols.has(column.toLowerCase())) cols.set(column.toLowerCase(), kind);
}

for (const file of readdirSync(PG_MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
  // Comments stripped first: these files argue with themselves at length and the words "uuid" and
  // "text" appear in that prose far more often than in the schema.
  const sql = readFileSync(join(PG_MIGRATIONS, file), "utf8")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi)) {
    const table = m[1]!;
    for (const line of m[2]!.split("\n")) {
      const col = line.trim().match(/^([a-z_][a-z0-9_]*)\s+(uuid|text|varchar|citext)\b/i);
      if (!col) continue;
      const kind: Kind = col[2]!.toLowerCase() === "uuid" ? "uuid" : "text";
      record(table, col[1]!, kind);
    }
  }
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+(uuid|text|varchar|citext)\b/gi)) {
    record(m[1]!, m[2]!, m[3]!.toLowerCase() === "uuid" ? "uuid" : "text");
  }
}

console.log("\nthe schema is readable, which everything below depends on");
{
  check(columns.size >= 20, `read ${columns.size} tables out of the Postgres migrations`);
  check(columns.get("work_items")?.get("id") === "uuid", "work_items.id is a uuid");
  check(columns.get("thread_items")?.get("ref_id") === "text", "thread_items.ref_id is text");
  check(columns.get("usage_events")?.get("run_id") === "text", "usage_events.run_id is text");
}

// --- 2. the production SQL ----------------------------------------------------------------------

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sources(full, out);
      continue;
    }
    // The exclusions are the whole of the scope: a suite or a one-off script may open SQLite and
    // only SQLite, and several deliberately do.
    if (!entry.endsWith(".ts")) continue;
    if (entry.includes(".test.") || entry.endsWith(".cli.ts")) continue;
    out.push(full);
  }
  return out;
}

/** Every alias in a statement, mapped to the table it stands for. */
function aliases(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\s+(?:AS\s+)?([a-z_][a-z0-9_]*)\b/gi)) {
    const table = m[1]!.toLowerCase();
    const alias = m[2]!.toLowerCase();
    // `FROM runs WHERE` — the "alias" is a keyword, not a name.
    if (["on", "where", "set", "using", "group", "order", "left", "inner", "join", "as", "limit"].includes(alias)) continue;
    out.set(alias, table);
  }
  // A table used without an alias refers to itself.
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\b/gi)) {
    const table = m[1]!.toLowerCase();
    if (!out.has(table)) out.set(table, table);
  }
  return out;
}

function kindOf(alias: string, column: string, map: Map<string, string>): Kind | undefined {
  const table = map.get(alias.toLowerCase());
  if (!table) return undefined;
  return columns.get(table)?.get(column.toLowerCase());
}

interface Offence {
  file: string;
  text: string;
  left: string;
  right: string;
}

const offences: Offence[] = [];

for (const file of sources(SRC)) {
  const body = readFileSync(file, "utf8");
  // Template literals are how every statement in this codebase is written.
  for (const lit of body.matchAll(/`([^`]*)`/g)) {
    const sql = lit[1]!;
    if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(sql)) continue;
    if (!/\b(FROM|JOIN)\b/i.test(sql)) continue;
    const map = aliases(sql);

    // COLUMN TO COLUMN ONLY. A comparison against `?`, a literal or a function is not examined:
    // an untyped bound parameter is resolved against the column by Postgres, which is exactly why
    // `WHERE id = ?` is correct everywhere and is how nearly every statement here is written.
    for (const cmp of sql.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*=\s*([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi)) {
      const [, la, lc, ra, rc] = cmp;
      const lk = kindOf(la!, lc!, map);
      const rk = kindOf(ra!, rc!, map);
      if (!lk || !rk || lk === rk) continue;
      // An explicit CAST on either side is the fix, and the regex above cannot see it because the
      // cast wraps the operand. Checking the surrounding text is enough and keeps this readable.
      const around = sql.slice(Math.max(0, cmp.index! - 40), cmp.index! + cmp[0]!.length + 40);
      if (/CAST\s*\(/i.test(around) || /::\s*(text|uuid)/i.test(around)) continue;
      offences.push({
        file: file.slice(SERVER_DIR.length + 1),
        text: cmp[0]!,
        left: `${map.get(la!.toLowerCase())}.${lc} ${lk}`,
        right: `${map.get(ra!.toLowerCase())}.${rc} ${rk}`,
      });
    }
  }
}

console.log("\nno statement compares a uuid column to a text one");
{
  check(
    offences.length === 0,
    "every column-to-column comparison agrees on type",
    offences.map((o) => `${o.file}: ${o.text}  (${o.left} vs ${o.right})`).join("\n       "),
  );
}

// --- 3. the linter can still see the bug it was written for -------------------------------------

console.log("\nand the check itself still catches the original");
{
  // THE ASSERTION THAT KEEPS THIS HONEST. A linter that silently stops matching is worse than no
  // linter, because it reports success. This re-runs the detection over the statement as it was
  // written, and expects a hit.
  const original = `SELECT ti.thread_id
       FROM usage_events u
       JOIN work_items w ON w.workspace_id = u.workspace_id AND w.run_id = u.run_id
       JOIN thread_items ti ON ti.workspace_id = u.workspace_id
                           AND ti.kind = 'work' AND ti.ref_id = w.id`;
  const map = aliases(original);
  let caught = false;
  for (const cmp of original.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*=\s*([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi)) {
    const lk = kindOf(cmp[1]!, cmp[2]!, map);
    const rk = kindOf(cmp[3]!, cmp[4]!, map);
    if (lk && rk && lk !== rk) caught = true;
  }
  check(caught, "the ti.ref_id = w.id join is still recognised as text against uuid");

  // And the fixed form must NOT be reported, or the suite is unfixable and somebody turns it off.
  const fixed = original.replace("ti.ref_id = w.id", "ti.ref_id = CAST(w.id AS TEXT)");
  let stillFlagged = false;
  for (const cmp of fixed.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*=\s*([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi)) {
    const around = fixed.slice(Math.max(0, cmp.index! - 40), cmp.index! + cmp[0]!.length + 40);
    if (/CAST\s*\(/i.test(around)) continue;
    const lk = kindOf(cmp[1]!, cmp[2]!, map);
    const rk = kindOf(cmp[3]!, cmp[4]!, map);
    if (lk && rk && lk !== rk) stillFlagged = true;
  }
  check(!stillFlagged, "...and the CAST form is accepted, so the fix is reachable");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
