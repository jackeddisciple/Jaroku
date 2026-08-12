// The two rules that make the tenancy layer structural rather than aspirational.
//
//   1. NOTHING OUTSIDE server/src/db/ IMPORTS A DRIVER. `node:sqlite` and `pg` are reachable
//      from exactly one directory. A module that imported one could open its own connection,
//      and a connection nobody scopes is every query nobody scoped.
//
//   2. A STORE OR REPOSITORY METHOD TAKES A CONTEXT FIRST. Not a convention: the parameter
//      is what makes a scope impossible to forget, because a WHERE clause you must remember
//      is one somebody eventually does not.
//
// THIS IS A tsx SCRIPT, NOT AN ESLINT RULE, and that is a deliberate departure from the
// spec's wording. There is no lint toolchain in this repository at all — no dependency, no
// config — and every test here is a plain script for the same reason the event transport is
// delimiters rather than a parser library. Adding eslint plus a custom-rule plugin to
// enforce two greps would be a larger change than the thing it enforces, and it would run in
// a different command from every other check.
//
//   npm run test:db-boundary

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_DIR = join(SRC, "db");

let failures = 0;
const fail = (msg: string): void => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const ok = (msg: string): void => console.log(`  ok   ${msg}`);
const check3 = (cond: boolean, msg: string): void => (cond ? ok(msg) : fail(msg));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(SRC);

// --- rule 1: the drivers live behind one door --------------------------------------------

console.log("\ndriver imports");

/** The modules only `server/src/db/` may reach for. */
const DRIVERS = [/from\s+["']node:sqlite["']/, /from\s+["']pg["']/, /require\(["'](node:sqlite|pg)["']\)/];

const offenders: string[] = [];
for (const file of files) {
  if (file.startsWith(DB_DIR + sep) || file === DB_DIR) continue;
  const text = readFileSync(file, "utf8");
  if (DRIVERS.some((re) => re.test(text))) offenders.push(relative(SRC, file));
}
if (offenders.length) fail(`a driver is imported outside src/db/: ${offenders.join(", ")}`);
else ok(`no file outside src/db/ imports node:sqlite or pg (${files.length} checked)`);

// The rule is only worth anything if the drivers are genuinely imported SOMEWHERE inside it —
// a pass because nothing imports them at all would be a green tick over a deleted feature.
const inside = files.filter((f) => f.startsWith(DB_DIR + sep)).filter((f) => {
  const t = readFileSync(f, "utf8");
  return DRIVERS.some((re) => re.test(t));
});
if (inside.length < 2) fail(`expected both drivers to be imported inside src/db/, found ${inside.length}`);
else ok(`and both are imported inside it (${inside.map((f) => relative(SRC, f)).join(", ")})`);

// --- rule 2: a scope is a parameter ------------------------------------------------------

console.log("\ncontext-first methods");

/**
 * Files whose classes hold tenant data.
 *
 * Listed rather than discovered, because "is this a repository" is a judgement and a wrong
 * guess in either direction is worse than a list somebody has to add to — which is exactly
 * what the CONTRIBUTING note asks for when a new table lands.
 */
const SCOPED_MODULES = [
  "store.ts",
  "evalStore.ts",
  "mcpStore.ts",
  "deployStore.ts",
  "db/repositories/agents.ts",
  "db/repositories/secretRefs.ts",
];

/**
 * Methods that legitimately take no context, each for a stated reason.
 *
 * An allowlist, so adding one is a decision somebody makes on purpose and a reviewer sees.
 */
const EXEMPT: Record<string, string> = {
  init: "declares or patches this driver's own tables; there is no tenant yet",
  close: "closes the connection",
  database: "hands back the shared Db so sibling stores use one connection",
  ensureColumn: "an additive ALTER for a database that predates a column",
  hydrate: "pure row-shaping",
  hydrateStep: "pure row-shaping",
  hydrateVersion: "pure row-shaping",
  touch: "takes a workspace id rather than a context: its caller is getForRun, which resolved one from a run",
  hydrateRubric: "pure row-shaping",
  hydrateEvalRun: "pure row-shaping",
  hydrateTool: "pure row-shaping",
  hydrateServer: "pure row-shaping",
  parseJson: "pure row-shaping",
  j: "pure serialisation",
  q: "the scoped-query helper itself; it TAKES the context",
  constructor: "takes the database, not a request",
};

/**
 * `async name(` / `name(` / `name<T>(` at method indentation, capturing the first parameter.
 *
 * The type-parameter list is optional and was originally missing, which made every GENERIC
 * method invisible to this rule — a hole the staleness check below is what surfaced. A rule
 * that silently skips a class of method is worse than no rule, because it reads as coverage.
 */
const METHOD =
  /^ {2}(?:private |public |protected )?(?:async )?([A-Za-z_][A-Za-z0-9_]*)(?:<[^>(]*>)?\s*\(\s*([^,)]*)/gm;

for (const rel of SCOPED_MODULES) {
  const text = readFileSync(join(SRC, rel), "utf8");
  const bad: string[] = [];
  let m: RegExpExecArray | null;
  METHOD.lastIndex = 0;
  while ((m = METHOD.exec(text))) {
    const name = m[1]!;
    const firstParam = (m[2] ?? "").trim();
    if (name in EXEMPT) continue;
    if (name === "if" || name === "for" || name === "while" || name === "switch" || name === "catch") continue;
    // A context, whichever kind — SystemContext is how a deliberately unscoped read says so.
    if (/Context\b/.test(firstParam)) continue;
    bad.push(`${name}(${firstParam || ""})`);
  }
  if (bad.length) fail(`${rel}: method(s) without a context first — ${bad.join(", ")}`);
  else ok(`${rel}: every method takes a context first`);
}

// --- rule 2b: the exemptions are real ----------------------------------------------------

console.log("\nthe allowlist is not a dumping ground");

// An exemption for a method that no longer exists is a rule quietly getting weaker. Each one
// has to still be a method somewhere, or it should have been deleted with the code.
const allText = SCOPED_MODULES.map((r) => readFileSync(join(SRC, r), "utf8")).join("\n");
const stale = Object.keys(EXEMPT).filter(
  // The `<T>` is why this needs to match a generic form too — see METHOD above.
  (name) => name !== "constructor" && !new RegExp(`\\b${name}(?:<[^>(]*>)?\\s*\\(`).test(allText),
);
if (stale.length) fail(`exemption(s) for methods that no longer exist: ${stale.join(", ")}`);
else ok(`all ${Object.keys(EXEMPT).length} exemptions still name real methods`);

// --- rule 2c: the rule can still fail ----------------------------------------------------

console.log("\nthe rule catches what it is for");

// A check that has quietly stopped matching anything reports "all correct" forever, which is
// the most expensive way for a rule to die. So it is run against text that MUST fail it.
{
  const SYNTHETIC = [
    "export class Bad {",
    "  async listThings(agentId: string): Promise<void> {}",
    "  async alsoBad<T>(id: string): Promise<T | undefined> { return undefined; }",
    "  async fine(ctx: TenantContext, id: string): Promise<void> {}",
    "  async alsoFine<T>(ctx: SystemContext, id: string): Promise<T | undefined> { return undefined; }",
    "}",
  ].join("\n");
  const caught: string[] = [];
  let m: RegExpExecArray | null;
  METHOD.lastIndex = 0;
  while ((m = METHOD.exec(SYNTHETIC))) {
    const name = m[1]!;
    if (name in EXEMPT) continue;
    if (!/Context\b/.test((m[2] ?? "").trim())) caught.push(name);
  }
  const expected = ["listThings", "alsoBad"];
  const same = caught.length === expected.length && expected.every((e) => caught.includes(e));
  if (same) ok(`an unscoped method is caught, generic or not (${caught.join(", ")})`);
  else fail(`the rule caught ${JSON.stringify(caught)}, expected ${JSON.stringify(expected)}`);
}


// --- rule 3: a policied table is reached through a scope ----------------------------------

console.log("\npolicied tables go through a scope");

// THE BUG THIS EXISTS FOR. `workspace_invites` carries an RLS policy, and every statement the
// invite flow made against it went through `this.db.transaction(...)` — an ordinary
// transaction, which does not `SET LOCAL app.workspace_id`. On SQLite that is identical to a
// scoped one; connected as the OWNER, as every test here is, it is identical too, because the
// owner is exempt from its own policies. As the application role a deployment actually uses,
// it is not identical at all: reads returned nothing and the INSERT failed the policy's WITH
// CHECK. So the whole feature worked everywhere except in production, and no test could see
// it — the tests and production disagreed about who was connected.
//
// A behavioural test cannot reach this: the repositories open their own connections, and the
// RLS suite's `SET LOCAL ROLE` only binds the transaction it is in. So the rule is structural,
// like the two above. It reads the policied tables out of the MIGRATIONS rather than from a
// list here, so a table that gains a policy is covered the day it does.

const MIGRATIONS_PG = resolve(SRC, "..", "migrations", "postgres");

function policiedTables(): Set<string> {
  const out = new Set<string>();
  for (const file of readdirSync(MIGRATIONS_PG)) {
    const sql = readFileSync(join(MIGRATIONS_PG, file), "utf8");
    // The explicit form: CREATE POLICY tenant_isolation ON <table>.
    for (const m of sql.matchAll(/CREATE POLICY tenant_isolation ON\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      out.add(m[1]!);
    }
    // And the loop form, where the table is `%I` and the names are in the ARRAY beside it.
    for (const block of sql.split("DO $$").slice(1)) {
      if (!/CREATE POLICY tenant_isolation/.test(block)) continue;
      const arr = /IN ARRAY ARRAY\[([\s\S]*?)\]/.exec(block);
      if (arr) for (const q of arr[1]!.matchAll(/'([a-z_]+)'/g)) out.add(q[1]!);
    }
  }
  out.delete("%I");
  return out;
}

/**
 * The unscoped ways to reach the database. `scoped`, `forWorkspace` and `q(ctx)` are the others.
 *
 * The optional type-parameter list is not decoration: `this.db.all<Invite>(…)` is how a typed
 * read is spelled everywhere here, and without it this rule skipped every one of them — which
 * is the same hole rule 2's METHOD pattern had, found the same way.
 *
 * `db.` as well as `this.db.`, because a raw handle taken out of a store — `const db =
 * store.database()` — is the same unscoped connection under a shorter name, and that is where
 * the eval aggregates were reading `steps` from. `tx.` is deliberately not matched: a `tx` only
 * exists inside `scoped` or `transaction`, and the call that opened it is what this judges.
 */
const UNSCOPED_CALLS = [
  /(?<![\w.])(?:this\.)?db\.(all|get|run|exec|transaction)(?:<[^>(]*>)?\s*\(/g,
  // `store.database().all(…)` — the trace store handing out its raw connection, which is how
  // the eval estimate and the eval aggregates were reading `runs` and `steps`.
  /\.database\(\)\s*\.(all|get|run|exec|transaction)(?:<[^>(]*>)?\s*\(/g,
];

/** The argument list of a call, from its opening paren to the matching close. */
function callArguments(text: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(openParen, i + 1);
  }
  return text.slice(openParen);
}

/**
 * Unscoped statements that are allowed to name a policied table, and why.
 *
 * Both are SQLite-only schema patches, guarded by `dialect !== "sqlite"` at the top of their
 * `init` — so they never run against a database that has policies at all.
 */
const UNSCOPED_OK: Record<string, string> = {
  "evalStore.ts:UPDATE eval_jobs SET position = rowid":
    "sqlite-only backfill in init(), which returns early on postgres",
  "deployStore.ts:UPDATE deployments SET created_seq = rowid":
    "sqlite-only backfill in init(), which returns early on postgres",
};

{
  const policied = policiedTables();
  check3(policied.size > 5, `the migrations name ${policied.size} policied tables`);
  check3(policied.has("workspace_invites") && policied.has("runs"), "...including the ones this rule was written for");

  const found: string[] = [];
  for (const file of files) {
    if (file.endsWith(".test.ts")) continue;
    const text = readFileSync(file, "utf8");
    for (const pattern of UNSCOPED_CALLS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text))) {
        const args = callArguments(text, m.index + m[0].length - 1);
        const table = [...policied].find((t) => new RegExp(`\\b${t}\\b`).test(args));
        if (!table) continue;
        // FORWARD SLASHES, ON EVERY PLATFORM. `relative` returns the host separator, and the
        // excuse lookup below takes a basename by splitting on "/" — which on Windows never
        // splits, so the whole path is compared against a key that is a filename and no
        // exemption for a file in a SUBDIRECTORY ever matched. `evalStore.ts` and
        // `deployStore.ts` are the two entries this map had, both sit directly in src/, and both
        // therefore worked by accident. The failure is one-directional and quiet in the worse
        // direction: a Windows developer sees excused statements reported as violations and
        // cannot tell them from real ones, so the rule reads as noise on the machine most likely
        // to be running it before a push.
        const name = relative(SRC, file).replaceAll(sep, "/");
        const excused = Object.keys(UNSCOPED_OK).find(
          (k) => k.startsWith(`${name.split("/").pop()}:`) && args.includes(k.slice(k.indexOf(":") + 1)),
        );
        if (excused) continue;
        found.push(`${name}:${text.slice(0, m.index).split("\n").length} — .${m[1]} names ${table}`);
      }
    }
  }
  if (found.length) fail(`a policied table reached without a scope: ${found.join("; ")}`);
  else ok(`every statement against a policied table goes through a scope (${policied.size} tables)`);

  // And the rule can still fail, for the same reason 2c exists.
  for (const [label, SYNTHETIC] of [
    ["an unscoped transaction", `class Bad { async x() { return this.db.transaction(async (tx) => tx.all("SELECT * FROM runs")); } }`],
    ["a raw handle out of a store", `async function bad() { return store.database().all<Row>("SELECT * FROM steps"); }`],
  ] as const) {
    const pattern = UNSCOPED_CALLS.find((p) => {
      p.lastIndex = 0;
      return p.test(SYNTHETIC);
    });
    pattern!.lastIndex = 0;
    const hit = pattern!.exec(SYNTHETIC)!;
    const args = callArguments(SYNTHETIC, hit.index + hit[0].length - 1);
    check3(/\b(runs|steps)\b/.test(args), `${label} naming a policied table is caught`);
  }
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
