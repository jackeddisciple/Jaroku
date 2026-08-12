// The rule that makes a rolling deploy survivable, checked rather than remembered.
//
// THE SITUATION IT IS ABOUT. Migrations run BEFORE the new version takes traffic — that is the
// only order that works, because a process starting against a database missing a column it
// expects fails at its first request rather than at boot. But for a window during every rolling
// deploy, the OLD code is running against the NEW schema: the old replicas are still serving
// while the new ones roll out, and if the migration removed something they use, they start
// failing — during the deploy, in a way that looks like the new version broke and is "fixed" by
// rolling back to code that no longer matches the database.
//
// SO: EXPAND, MIGRATE, CONTRACT. Three deploys, never one.
//
//   EXPAND    add the new column/table/index, nullable or defaulted. Old code ignores it.
//   MIGRATE   ship code that writes both and reads the new. Backfill.
//   CONTRACT  once no running version reads the old thing, remove it — in a LATER deploy.
//
// The discipline is ordinary and the failure is that somebody forgets it at 6pm on a Friday. This
// module is what turns "we agreed to do that" into a check the pipeline runs: it reads the
// migrations a deploy would apply, classifies each statement, and refuses the ones that break the
// version currently serving.
//
// IT IS A LINTER, NOT A PROOF. It reads SQL with regular expressions and it can be argued with by
// a statement written to confuse it. What it catches is the real case — somebody adding a `DROP
// COLUMN` to the same pull request as the code that stops using it — and what it cannot catch is
// somebody who has decided to defeat it. An override exists for the deploy that genuinely IS the
// contract step, and it is a comment in the migration file rather than a flag on a command, so
// the decision lives beside the statement and shows up in the diff somebody reviews.

/** How a statement relates to a version of the code that is still serving. */
export type Compatibility = "safe" | "breaking" | "blocking";

export interface Finding {
  /** Which migration file. */
  file: string;
  /** The statement, trimmed to something readable in a CI log. */
  statement: string;
  compatibility: Compatibility;
  /** Why it is a problem, and what to do instead. */
  reason: string;
}

/**
 * Statements that remove or narrow something the running version may still be using.
 *
 * These are the CONTRACT step, and a deploy containing one has to be a deploy in which nothing
 * still reads what it removes.
 */
const BREAKING: { re: RegExp; reason: string }[] = [
  {
    re: /\bDROP\s+TABLE\b/i,
    reason: "the version currently serving may still read this table — drop it in a later deploy",
  },
  {
    re: /\bDROP\s+COLUMN\b/i,
    reason:
      "the version currently serving still SELECTs this column — stop reading it in one deploy, " +
      "and drop it in the next",
  },
  {
    re: /\bALTER\s+TABLE\s+\S+\s+RENAME\b/i,
    reason: "a rename is a drop and an add at once — add the new name, migrate, then remove the old",
  },
  {
    re: /\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+NOT\s+NULL|TYPE)\b/i,
    reason:
      "the running version writes rows this would now reject — add a check-constraint-free " +
      "column, backfill, and tighten in a later deploy",
  },
  {
    re: /\bDROP\s+(?:CONSTRAINT|INDEX)\b/i,
    reason: "dropping a constraint or index the planner or the writer relies on can change behaviour mid-deploy",
  },
  {
    re: /\bADD\s+COLUMN\b[^;]*\bNOT\s+NULL\b(?![^;]*\bDEFAULT\b)/i,
    reason:
      "the running version's INSERTs do not name this column and would fail — add it nullable or " +
      "with a DEFAULT, and tighten in a later deploy",
  },
];

/**
 * Statements that hold a lock long enough to be an outage on a large table.
 *
 * Distinct from breaking, and worth its own name: nothing about the schema becomes incompatible,
 * but the deploy stops answering requests while it runs. On `steps` — the table this codebase
 * partitioned precisely because it gets huge — an unqualified `CREATE INDEX` is minutes of an
 * ACCESS EXCLUSIVE lock on the hottest write path in the system.
 */
const BLOCKING: { re: RegExp; reason: string }[] = [
  {
    re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+(?:steps|runs|usage_events|audit_log)\b/i,
    reason:
      "building an index on a large table takes a write lock for the whole build — use CREATE " +
      "INDEX CONCURRENTLY, outside the migration transaction",
  },
  {
    re: /\bUPDATE\s+(?:steps|runs|usage_events)\b(?![^;]*\bWHERE\b)/i,
    reason: "an unqualified UPDATE of a huge table rewrites every row while holding locks — batch it",
  },
];

/**
 * The marker that says a statement is a deliberate contract step.
 *
 * A COMMENT IN THE MIGRATION, not a flag on the command line. A flag is invisible in review and
 * gets copied between deploys; a comment sits beside the statement it excuses, appears in the
 * diff, and has to be written by whoever is claiming that nothing still reads the thing.
 */
export const OVERRIDE_MARKER = "jaroku:contract-step";

export interface GateResult {
  findings: Finding[];
  /** Statements that would have been findings and carried the marker. Reported, never hidden. */
  overridden: Finding[];
  ok: boolean;
}

/**
 * Read one migration's SQL and report what it would do to a version still serving.
 *
 * Statements are split on semicolons OUTSIDE of `$$ … $$` blocks: several migrations here use a
 * `DO $$ … $$` body, whose semicolons are Lua-to-Postgres's business rather than statement
 * separators, and splitting naively would classify half a loop body as a statement.
 */
export function inspectMigration(file: string, sql: string): GateResult {
  const findings: Finding[] = [];
  const overridden: Finding[] = [];

  for (const raw of splitStatements(sql)) {
    const statement = raw.trim();
    if (!statement) continue;
    // Comments are stripped for MATCHING but the original is kept for the report and for the
    // override check — a `DROP COLUMN` inside a comment is not a drop, and the marker is only
    // ever inside a comment.
    const code = stripComments(statement);
    if (!code.trim()) continue;

    for (const { re, reason } of BREAKING) {
      if (!re.test(code)) continue;
      const finding: Finding = { file, statement: preview(statement), compatibility: "breaking", reason };
      (statement.includes(OVERRIDE_MARKER) ? overridden : findings).push(finding);
    }
    for (const { re, reason } of BLOCKING) {
      if (!re.test(code)) continue;
      const finding: Finding = { file, statement: preview(statement), compatibility: "blocking", reason };
      (statement.includes(OVERRIDE_MARKER) ? overridden : findings).push(finding);
    }
  }

  return { findings, overridden, ok: findings.length === 0 };
}

/**
 * The two dialect directories hold the same versions under the same names.
 *
 * Checked here as well as by the runner, because the runner only ever sees ONE of them: a
 * deployment on Postgres never opens `migrations/sqlite/`, so a version added to one and not the
 * other is invisible until somebody runs the other driver — which, on this codebase, is the
 * entire local development path and half the test suite.
 */
export function compareDialects(postgres: readonly string[], sqlite: readonly string[]): string[] {
  const problems: string[] = [];
  const inPg = new Set(postgres);
  const inLite = new Set(sqlite);
  for (const name of postgres) {
    if (!inLite.has(name)) problems.push(`migrations/postgres/${name} has no sqlite counterpart`);
  }
  for (const name of sqlite) {
    if (!inPg.has(name)) problems.push(`migrations/sqlite/${name} has no postgres counterpart`);
  }
  // And the numbering itself: a gap is a migration somebody deleted, and a duplicate is two
  // people numbering in parallel — both produce a database whose applied set depends on which
  // checkout ran first.
  const versions = postgres.map((n) => Number(n.slice(0, 3))).sort((a, b) => a - b);
  for (let i = 1; i < versions.length; i++) {
    if (versions[i] === versions[i - 1]) problems.push(`two migrations are numbered ${versions[i]}`);
    else if (versions[i]! !== versions[i - 1]! + 1) problems.push(`the numbering jumps from ${versions[i - 1]} to ${versions[i]}`);
  }
  return problems;
}

/** A statement, short enough for a CI log and long enough to recognise. */
function preview(statement: string): string {
  const oneLine = statement.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Split on semicolons, ignoring the ones inside a `$$ … $$` body. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "$" && sql[i + 1] === "$") {
      inDollar = !inDollar;
      current += "$$";
      i++;
      continue;
    }
    if (sql[i] === ";" && !inDollar) {
      out.push(current);
      current = "";
      continue;
    }
    current += sql[i];
  }
  if (current.trim()) out.push(current);
  return out;
}
