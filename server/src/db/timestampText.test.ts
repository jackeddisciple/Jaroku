// A `timestamptz` is not a string, and only one of the two drivers says so.
//
// WHAT THIS EXISTS FOR, in two sentences: the Activity pulse grouped its spend column with
// `SUBSTR(occurred_at, 1, ?)`, and the Activity feed unioned nine branches whose `at` came from
// `runs.started_at` in some and `agent_versions.created_at` in others. Both are fine on SQLite,
// where a timestamp IS a string, and neither could ever run on Postgres:
//
//   function substr(timestamp with time zone, integer, unknown) does not exist
//   UNION types text and timestamp with time zone cannot be matched
//   UNION types text and uuid cannot be matched
//
// The third message is the same rule two families over, and it is why this reads FAMILIES rather
// than a list of timestamp columns: `runs.id` is text and `agent_versions.id` is uuid, and the feed
// unioned those into one `target_id` as well. Fixing only the timestamps produced the third red CI
// in a row, which is what a rule stated too narrowly buys you.
//
// Every Activity suite opens SQLite, so the whole tab was unreachable on the production driver and
// nothing said so. It is the same failure `test:boolean-literals` was written for, one type over,
// and it was found the expensive way — a red CI, a fix, then the NEXT error in the same statement,
// because Postgres reports one problem at a time.
//
// WHY THE TWO TYPES DIVERGED AT ALL, which is not an accident to be tidied up. The trace schema was
// frozen on ISO-8601 `text` in migration 002, and 029 argues it at length: `steps` is PARTITIONED on
// `started_at`, so the partition key is text on both drivers deliberately. Everything written after
// 003 uses `timestamptz`, because that is the right type when nothing forces otherwise. So this
// codebase genuinely has both, forever.
//
// THE TYPE IS PER TABLE, NOT PER NAME, and that is the whole reason this reader parses FROM clauses
// instead of keeping a list of column names. `created_at` is `timestamptz` on `agent_versions`,
// `audit_log` and `threads`, and `text` on `deployments`, `datasets`, `rubrics` and `mcp_servers` —
// so a rule that judged by name alone would both miss the feed's real bug and fail four correct
// statements. It resolves `v.created_at` through `FROM agent_versions v` and answers about that
// column. That distinction is not academic: the first version of the feed's fix rendered
// `d.created_at` too, which would have been `to_char(text, …)` and just as broken the other way.
//
// SO THIS IS A LINTER, NOT A PROOF, exactly as `expandContract.ts` and `booleanLiterals.test.ts`
// both say of themselves. It can be argued with by SQL written to confuse it; what it catches is
// the real case — somebody reaching for `substr` to get a date grain, or adding a tenth branch to
// the feed — on a laptop with no Postgres, which is exactly where that gets written.
//
// THE EXEMPTION IS THE REAL FIX, not a suppression. A statement that branches on `db.dialect` and
// renders the timestamp half with `to_char` is doing the correct thing, and this recognises it by
// the wrapped expression no longer being a bare column reference. There is no magic comment,
// because a comment can be copied onto code that did not earn it.
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

// --- 1. the type of every column, per table, read from the schema -------------------------------

/**
 * The families a UNION has to agree within.
 *
 * FAMILIES RATHER THAN TYPE NAMES, because Postgres resolves `integer` against `bigint` happily and
 * refuses `text` against `uuid` — so a rule comparing type names would fail correct SQL, and one
 * comparing nothing would miss the real thing. Every pair this codebase has actually been bitten by
 * crosses a family boundary: `text` against `timestamptz` in the pulse, `text` against `uuid` in
 * the feed's `actor_user_id` and `target_id`.
 */
type ColType = "text" | "num" | "uuid" | "stamp" | "bool" | "json";

const FAMILY: Record<string, ColType> = {
  text: "text", citext: "text", varchar: "text",
  integer: "num", bigint: "num", bigserial: "num", numeric: "num",
  "double precision": "num", real: "num", smallint: "num",
  uuid: "uuid",
  timestamptz: "stamp", timestamp: "stamp", date: "stamp",
  boolean: "bool",
  json: "json", jsonb: "json",
};

/** Longest first, so `double precision` is not read as `double`. */
const TYPE_NAMES = Object.keys(FAMILY).sort((a, b) => b.length - a.length).join("|");

/** `"agent_versions.created_at" -> "stamp"`. Keyed by table so a shared name is not one answer. */
function columnTypes(): Map<string, ColType> {
  const out = new Map<string, ColType>();
  const add = (table: string, column: string, type: ColType): void => {
    out.set(`${table.toLowerCase()}.${column.toLowerCase()}`, type);
  };

  for (const file of readdirSync(PG_MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    // Comments first. Every one of these files argues with itself at length, and the words
    // "timestamptz" and "text" appear in that prose more often than they do in the schema.
    const sql = readFileSync(join(PG_MIGRATIONS, file), "utf8").replace(/--[^\n]*/g, " ");

    for (const m of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_]+)\s*\(([\s\S]*?)\n\s*\)/gi)) {
      for (const line of m[2]!.split("\n")) {
        const col = new RegExp(`^\\s*([a-z_]+)\\s+(${TYPE_NAMES})\\b`, "i").exec(line);
        if (col) add(m[1]!, col[1]!, FAMILY[col[2]!.toLowerCase()]!);
      }
    }
    // A later ADD COLUMN wins over the CREATE, which is what forward-only migrations mean.
    for (const m of sql.matchAll(
      new RegExp(`ALTER TABLE\\s+([a-z_]+)\\s+ADD COLUMN\\s+(?:IF NOT EXISTS\\s+)?([a-z_]+)\\s+(${TYPE_NAMES})\\b`, "gi"),
    )) {
      add(m[1]!, m[2]!, FAMILY[m[3]!.toLowerCase()]!);
    }
  }
  return out;
}

const TYPES = columnTypes();

check(
  `read the column types out of the Postgres schema (${TYPES.size} columns)`,
  TYPES.get("usage_events.occurred_at") === "stamp" && TYPES.get("runs.started_at") === "text",
  TYPES.size === 0 ? "nothing matched — the parser above is what broke, not the schema" : "",
);
check(
  "...and the same column name is two answers on two tables, which is why this is keyed by table",
  TYPES.get("agent_versions.created_at") === "stamp" && TYPES.get("deployments.created_at") === "text",
);

// --- 2. what production SQL does to them --------------------------------------------------------

/** Functions that take a string and have no overload for the families below on Postgres. */
const STRING_FUNCTIONS = ["substr", "substring", "lower", "upper", "trim", "ltrim", "rtrim", "replace"];

/**
 * The families a string function or a `LIKE` cannot be applied to.
 *
 * `num` and `bool` are absent deliberately: Postgres will not implicitly cast those either, but
 * nothing in this codebase has ever tried, and every family added here is a family whose false
 * positives somebody has to argue with. These three are the ones that have actually broken —
 * `stamp` in the pulse, `uuid` in the feed, `json` in the tool leaderboard's truncation count.
 */
const NOT_A_STRING: ReadonlySet<ColType> = new Set<ColType>(["stamp", "uuid", "json"]);

interface Offence {
  file: string;
  /** The string operation with no overload for that family, or `UNION` for disagreeing branches. */
  fn: string;
  what: string;
}

/**
 * Which table each alias in a statement names.
 *
 * `FROM agent_versions v` and `JOIN agents a ON …` both count; a table used without an alias maps
 * to itself, so `FROM runs` resolves a bare `started_at` too. Keywords that can follow a table name
 * are excluded, or `FROM runs WHERE` would register an alias called `where`.
 */
const NOT_AN_ALIAS = new Set(["where", "on", "group", "order", "limit", "union", "left", "inner", "join", "as", "using", "having"]);

function aliasMap(statement: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of statement.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)(?:\s+(?:AS\s+)?([a-z_]+))?/gi)) {
    const table = m[1]!.toLowerCase();
    out.set(table, table);
    const alias = m[2]?.toLowerCase();
    if (alias && !NOT_AN_ALIAS.has(alias)) out.set(alias, table);
  }
  return out;
}

/** The type of a possibly-qualified reference, or null when this reader cannot say. */
function typeOf(ref: string, aliases: Map<string, string>): ColType | null {
  const dot = ref.indexOf(".");
  if (dot > 0) {
    const table = aliases.get(ref.slice(0, dot).toLowerCase());
    return table ? TYPES.get(`${table}.${ref.slice(dot + 1).toLowerCase()}`) ?? null : null;
  }
  // Unqualified. Only answerable when the statement names exactly one table — otherwise this reader
  // says nothing rather than guessing, which is the same posture it takes towards a FROM it cannot
  // parse. A linter that guesses fails correct statements, and that is how a check gets disabled.
  const tables = new Set(aliases.values());
  if (tables.size !== 1) return null;
  return TYPES.get(`${[...tables][0]}.${ref.toLowerCase()}`) ?? null;
}

/** Every backtick template in a source file, which is where this codebase keeps its SQL. */
function templates(source: string): string[] {
  return [...source.matchAll(/`([^`]*)`/g)].map((m) => m[1]!).filter((t) => /\bSELECT\b|\bFROM\b/i.test(t));
}

/** Exported so the fixtures below can prove the detector detects. */
export function offencesIn(file: string, source: string): Offence[] {
  const found: Offence[] = [];
  const cleaned = source.replace(/--[^\n]*/g, " ");

  for (const statement of templates(cleaned)) {
    const aliases = aliasMap(statement);
    if (aliases.size === 0) continue;

    for (const fn of STRING_FUNCTIONS) {
      const re = new RegExp(`\\b${fn}\\s*\\(\\s*([a-z_]+(?:\\.[a-z_]+)?)\\b`, "gi");
      for (const m of statement.matchAll(re)) {
        const type = typeOf(m[1]!, aliases);
        if (type && NOT_A_STRING.has(type)) found.push({ file, fn, what: `${m[1]!} is ${type}` });
      }
    }

    // AND `LIKE`, WHICH IS A STRING FUNCTION SPELLED AS AN OPERATOR. Postgres reports it as
    // "operator does not exist: json ~~ unknown", which reads as a missing operator rather than as
    // a type problem — the same disguise `booleanLiterals.test.ts` notes about a boolean compared
    // to an integer in a WHERE. `steps.output` is `json` there and `text` on SQLite, so the tool
    // leaderboard's truncation count was another statement that could only ever run on one driver.
    for (const m of statement.matchAll(/([a-z_]+(?:\.[a-z_]+)?)\s+(?:NOT\s+)?LIKE\b/gi)) {
      const type = typeOf(m[1]!, aliases);
      if (type && NOT_A_STRING.has(type)) found.push({ file, fn: "LIKE", what: `${m[1]!} is ${type}` });
    }

    // A UNION whose branches disagree about the TYPE of one output column. Detected by ALIAS rather
    // than by splitting the union, because the alias is what makes two branches the same column:
    // every branch of the feed ends `… AS at`, `… AS target_id`, `… AS actor_user_id`.
    //
    // TWO SHAPES CONTRIBUTE. A bare column reference, whose type comes from the schema — and an
    // explicit `CAST(x AS TYPE)`, whose type is stated. Both matter, and the second is not just for
    // completeness: `CAST(NULL AS TEXT) AS actor_user_id` is how the branches that record nobody
    // fill that column, so a reader that ignored casts would see only the uuid branches, find them
    // unanimous, and pass the exact statement Postgres refuses.
    //
    // A `${...}` interpolation is neither shape and contributes nothing, which is how a
    // dialect-rendered half stays silent — the fix being recognised rather than suppressed.
    const byAlias = new Map<string, Map<ColType, string>>();
    const note = (alias: string, type: ColType, source: string): void => {
      if (!byAlias.has(alias)) byAlias.set(alias, new Map());
      const seen = byAlias.get(alias)!;
      if (!seen.has(type)) seen.set(type, source);
    };

    for (const m of statement.matchAll(/CAST\s*\(\s*[^()]*?\s+AS\s+([a-z ]+?)\s*\)\s+AS\s+([a-z_]+)\b/gi)) {
      const type = FAMILY[m[1]!.trim().toLowerCase()];
      if (type) note(m[2]!.toLowerCase(), type, `CAST(… AS ${m[1]!.trim()})`);
    }
    for (const m of statement.matchAll(/(?:^|[\s,(])([a-z_]+(?:\.[a-z_]+)?)\s+AS\s+([a-z_]+)\b/gi)) {
      // `CAST(l.id AS TEXT)` also matches this shape, and its "alias" is a type name. Reading it as
      // one invents a column called `text` holding every casted column in the statement, which is a
      // failure with no bug behind it — the cast loop above has already recorded that expression
      // correctly. A real output column is never named after a type.
      if (FAMILY[m[2]!.toLowerCase()]) continue;
      const type = typeOf(m[1]!, aliases);
      if (type) note(m[2]!.toLowerCase(), type, m[1]!);
    }

    for (const [alias, seen] of byAlias) {
      if (seen.size > 1) {
        const how = [...seen].map(([type, source]) => `${source} is ${type}`).join(", ");
        found.push({ file, fn: "UNION", what: `${alias}: ${how}` });
      }
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

  const offences = files.flatMap((f) => offencesIn(relative(SERVER_DIR, f), readFileSync(f, "utf8")));
  check(
    "no statement treats a Postgres timestamp as a string, and no UNION mixes two type families",
    offences.length === 0,
    offences.map((o) => `${o.file}: ${o.fn} — ${o.what}`).join("\n       "),
  );
}

// --- 4. and the rule still fails on text designed to fail it -------------------------------------
//
// A pass has to mean the rule ran. `test:db-boundary` asserts the same thing about itself, and for
// the same reason: an audit whose detector silently stopped matching reports success forever.

{
  const planted = offencesIn(
    "fixture.ts",
    "const q = `SELECT SUBSTR(occurred_at, 1, 10) AS k FROM usage_events GROUP BY k`;",
  );
  check(
    "the detector detects a string function on a timestamp",
    planted.some((o) => o.fn === "substr" && o.what.startsWith("occurred_at is")),
  );

  // `LIKE` is a string function spelled as an operator, and Postgres disguises it as a missing one.
  const likedJson = offencesIn(
    "fixture.ts",
    "const q = `SELECT COUNT(CASE WHEN s.output LIKE ? THEN 1 END) FROM steps s`;",
  );
  check(
    "...and a LIKE against a json column, which Postgres reports as a missing operator",
    likedJson.some((o) => o.fn === "LIKE" && o.what.startsWith("s.output is json")),
  );

  const likedText = offencesIn(
    "fixture.ts",
    "const q = `SELECT COUNT(CASE WHEN s.error LIKE ? THEN 1 END) FROM steps s`;",
  );
  check("...while the same predicate on a text column is fine", likedText.length === 0);

  const wrapped = offencesIn(
    "fixture.ts",
    "const q = `SELECT SUBSTR(${occurredIso}, 1, 10) AS k FROM usage_events GROUP BY k`;",
  );
  check("...and a rendered one is not an offence", wrapped.length === 0);

  const textColumn = offencesIn("fixture.ts", "const q = `SELECT SUBSTR(started_at, 1, 10) AS day FROM runs`;");
  check("...and a genuinely-text column is left alone", textColumn.length === 0);

  const mixedUnion = offencesIn(
    "fixture.ts",
    "const q = `SELECT r.started_at AS at FROM runs r" +
      " UNION ALL SELECT v.created_at AS at FROM agent_versions v`;",
  );
  check(
    "a UNION whose branches disagree about what a moment is fails",
    mixedUnion.some((o) => o.fn === "UNION" && o.what.startsWith("at:")),
  );

  // The feed's OTHER divergence, which is the same rule two families over: `runs.id` is text and
  // `agent_versions.id` is uuid, and Postgres refuses that union with its own message.
  const mixedIds = offencesIn(
    "fixture.ts",
    "const q = `SELECT r.id AS target_id FROM runs r" +
      " UNION ALL SELECT v.id AS target_id FROM agent_versions v`;",
  );
  check(
    "...and so does one that disagrees about text against uuid",
    mixedIds.some((o) => o.fn === "UNION" && o.what.startsWith("target_id:")),
  );

  // A CAST is a stated type and counts as a branch. This is the case a reader that skipped casts
  // would pass: the uuid branches agree with each other, and the NULL that fills the column
  // everywhere else is text.
  const castNull = offencesIn(
    "fixture.ts",
    "const q = `SELECT CAST(NULL AS TEXT) AS actor_user_id FROM runs r" +
      " UNION ALL SELECT v.created_by AS actor_user_id FROM agent_versions v`;",
  );
  check(
    "...and a CAST(NULL AS TEXT) beside a uuid column is caught, not skipped",
    castNull.some((o) => o.fn === "UNION" && o.what.startsWith("actor_user_id:")),
  );

  // And the same statement with the uuid rendered to match is silent, which is the fix.
  const castBoth = offencesIn(
    "fixture.ts",
    "const q = `SELECT CAST(NULL AS TEXT) AS actor_user_id FROM runs r" +
      " UNION ALL SELECT CAST(v.created_by AS TEXT) AS actor_user_id FROM agent_versions v`;",
  );
  check("...while casting both sides to one family is not an offence", castBoth.length === 0);

  // `integer` against `bigint` is not a divergence: Postgres resolves those, and a rule that
  // reported them would fail correct SQL until somebody switched it off.
  const numbers = offencesIn(
    "fixture.ts",
    "const q = `SELECT r.tokens AS num FROM runs r" +
      " UNION ALL SELECT v.version AS num FROM agent_versions v`;",
  );
  check("a bigint beside an integer is one family and not an offence", numbers.length === 0);

  const wrappedUnion = offencesIn(
    "fixture.ts",
    "const q = `SELECT r.started_at AS at FROM runs r" +
      " UNION ALL SELECT ${iso(`v.created_at`)} AS at FROM agent_versions v`;",
  );
  check("...and one whose timestamp half is rendered to match does not", wrappedUnion.length === 0);

  // The same column name on two tables, which is the case that makes this reader table-aware.
  const sameName = offencesIn("fixture.ts", "const q = `SELECT SUBSTR(created_at, 1, 10) AS day FROM deployments`;");
  check("`created_at` on a table where it is text is not an offence", sameName.length === 0);
  const otherTable = offencesIn(
    "fixture.ts",
    "const q = `SELECT SUBSTR(created_at, 1, 10) AS day FROM agent_versions`;",
  );
  check("...while the same name on a table where it is a timestamp is", otherTable.length === 1);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
