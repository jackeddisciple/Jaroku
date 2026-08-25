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
  // The Inbox's two tables. The rule matters more here than almost anywhere: §6.3 calls the
  // reconciler the highest-risk code in the feature, because it is the one path that legitimately
  // touches many workspaces, and the only thing standing between "loop the workspaces and scope each
  // pass" and "run once as the server" is that no method on this class can be called without a scope.
  "inbox/inboxStore.ts",
  // The Activity tab's aggregates. The rule matters here as much as it does anywhere in this list:
  // §5.4 calls this the highest-risk surface in the product for the RLS class of bug, because every
  // previous instance of it was an aggregate over exactly the tables this file reads — and the only
  // thing standing between "one grouped query per module, scoped" and "one grouped query per
  // module, everybody's" is that no method on the class can be called without a scope.
  "activity/activityStore.ts",
  "db/repositories/agents.ts",
  // Per-agent access. The rule is at its strongest here, because what an unscoped method on this
  // class would return is not a row of somebody's data — it is somebody's PERMISSION, read by a
  // workspace that has no business knowing the agent exists. There is exactly one resolver and it
  // reads this repository; a `find` that could be called without a scope would be that resolver
  // answering a question about another tenant.
  "db/repositories/agentGrants.ts",
  "db/repositories/secretRefs.ts",
  "db/repositories/secretUsages.ts",
  "db/repositories/secretPasscodes.ts",
  "db/repositories/secretElevations.ts",
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
  sweep:
    "deletes EXPIRED elevations across every workspace, which is maintenance rather than a scoped " +
    "operation — it goes through asPlatform, and migration 033 grants it one DELETE-only policy",
  hydrateRubric: "pure row-shaping",
  hydrateEvalRun: "pure row-shaping",
  hydrateTool: "pure row-shaping",
  hydrateServer: "pure row-shaping",
  parseJson: "pure row-shaping",
  capabilitiesFrom: "pure row-shaping — one column into a capability set, deciding nothing",
  stored: "pure serialisation — the same column on the way back out, per dialect",
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
 * THE REASON IS THE POINT OF THIS MAP, not the exemption. "Unscoped on purpose" is what every
 * one of these said in a doc comment, and two statements that said exactly that were reaching no
 * rows at all in production until three commits ago — the intent was right, the mechanism was
 * missing, and a doc comment cannot tell those apart. An entry here is a specific claim that the
 * statement REACHES ITS ROWS under row-level security, and each names the policy or the driver
 * that makes it true.
 *
 * A statement that merely wants to cross workspaces does not belong here. It belongs in
 * `db.asPlatform`, which is the mechanism for that, and which this rule does not flag because
 * the handle inside it is a `tx`.
 */
const UNSCOPED_OK: Record<string, string> = {
  "evalStore.ts:UPDATE eval_jobs SET position = rowid":
    "sqlite-only backfill in init(), which returns early on postgres",
  "deployStore.ts:UPDATE deployments SET created_seq = rowid":
    "sqlite-only backfill in init(), which returns early on postgres",
  // The subject-keyed abuse signals, written and read before a workspace exists — signup
  // velocity is a question about an address. Their rows carry a NULL workspace_id and are
  // reached by `platform_subject_rows` (migration 027), whose predicate REQUIRES that no
  // workspace be in scope. Scoping these is what would break them.
  //
  // Keyed on the NULL and on the `subject` predicate rather than on the table name, so the
  // excuse covers THESE two statements and not the next unscoped one somebody writes against
  // `abuse_signals`. An exemption that names a table is a hole with a comment on it.
  "abuse.ts:VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)":
    "workspace_id NULL, admitted by platform_subject_rows, which requires the absence of a scope",
  "abuse.ts:WHERE subject = ?":
    "the same NULL-tenant rows read back by subject, under the same policy",
  // `seedForDrill` builds a source database for the restore drill and is only ever handed a
  // `SqliteDb` — drill.cli.ts constructs one and migrates it from migrations/sqlite. That driver
  // has no policies. It seeds two workspaces deliberately, so the restore has a tenancy boundary
  // to verify rather than one workspace's rows to count.
  "restoreDrill.ts:INSERT INTO runs":
    "drill fixture, only ever called with a SqliteDb source — see drill.cli.ts",
  "restoreDrill.ts:INSERT INTO steps":
    "drill fixture, only ever called with a SqliteDb source — see drill.cli.ts",
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

// --- rule 4: a table with a workspace_id has a policy, or a reason -------------------------

console.log("\nevery tenant table is policied, or says why not");

// WHAT THIS IS FOR. `test:rls` checks that the tenant tables carry a policy — against a list of
// twenty-odd names written by hand in that file. A table added with a `workspace_id` and no
// policy is not caught by it; it is simply absent from the list, and the check goes on reporting
// that everything it knows about is fine. That is the failure mode this session already hit
// once, when `steps` became a partitioned table and dropped out of a catalogue query silently.
//
// So the question is asked of the SCHEMA instead. Every table the migrations give a
// `workspace_id` is a table holding one tenant's rows, and it either has `tenant_isolation` or
// it appears below with a reason somebody wrote down.
//
// HERE RATHER THAN IN test:rls, because it needs no database. The behavioural half — that the
// policy is ENABLED, FORCEd and actually refuses a cross-tenant read — can only be asked of a
// real Postgres, and that suite skips entirely without one. This half is a property of the
// files, so it runs on every machine and in every CI job, which is where a rule about a table
// somebody just added needs to run.

/** Fold one migration's tables into `out`: those that gain a `workspace_id`, those that go. */
function collectTenantTables(rawSql: string, out: Set<string>): void {
  // Comments are stripped first: several of these tables are documented in prose that names
  // `workspace_id` while explaining why the table does NOT have one.
  const sql = rawSql.replace(/--[^\n]*/g, "");
  // IN FILE ORDER, one alternation rather than four passes, because these statements UNDO each
  // other and a pass per kind applies them in the wrong sequence. Migration 029 is the case that
  // proves it: `steps` is renamed aside, a new `steps` is created, and the old one is dropped.
  // Handling every CREATE before every RENAME turns that into "steps was renamed away" and loses
  // the largest tenant table in the schema.
  //
  // The four shapes are: a table created WITH a workspace_id (the closing paren may be followed
  // by `PARTITION BY …`, as `steps` is); a table given one later, which is how Session 4 added
  // tenancy to tables that predated it; a table dropped; and the rebuild idiom SQLite needs to
  // alter a table at all — create `x_new`, copy, drop `x`, rename `x_new` to `x`.
  const STATEMENT =
    /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\)[^;]*;|ALTER TABLE ([a-z_][a-z0-9_]*)\s+ADD COLUMN (?:IF NOT EXISTS )?workspace_id|DROP TABLE (?:IF EXISTS )?([a-z_][a-z0-9_]*)|ALTER TABLE ([a-z_][a-z0-9_]*)\s+RENAME TO ([a-z_][a-z0-9_]*)/gi;
  for (const m of sql.matchAll(STATEMENT)) {
    const [, created, body, altered, dropped, renamedFrom, renamedTo] = m;
    if (created) {
      if (/\bworkspace_id\b/.test(body ?? "")) out.add(created);
    } else if (altered) {
      out.add(altered);
    } else if (dropped) {
      out.delete(dropped);
    } else if (renamedFrom && renamedTo) {
      // Only carries tenancy across if the old name had it — a rebuild of a table with no
      // workspace_id must not invent one for its replacement.
      if (out.delete(renamedFrom)) out.add(renamedTo);
    }
  }
}

/** Every table the migrations give a `workspace_id`, and every one they take away. */
function tenantTables(): Set<string> {
  const out = new Set<string>();
  for (const file of readdirSync(MIGRATIONS_PG).sort()) {
    collectTenantTables(readFileSync(join(MIGRATIONS_PG, file), "utf8"), out);
  }
  return out;
}

/**
 * Tables that hold a `workspace_id` and deliberately carry no policy.
 *
 * Every one of these is already argued in its own migration. Restated here because a reason in a
 * migration is prose nothing reads, and the point of this rule is that adding the SIXTH one has
 * to be a decision somebody writes down rather than a column somebody adds.
 */
const NO_POLICY_BY_DESIGN: Record<string, string> = {
  audit_log:
    "the record of what was denied; a policy on it would scope the evidence to the tenant it is evidence about — 004",
  workspace_members:
    "the query that PRODUCES app.workspace_id. A policy reading it could only be satisfied by already knowing the answer — 009",
  ws_tickets:
    "same as workspace_members: redeeming a ticket is the operation that produces the scope — 010",
  oauth_states:
    "the CSRF state of a flow that has not resolved to a workspace yet, and says so — 026",
  billing_webhook_events:
    "a platform-level log of what the provider sent; its workspace_id is nullable and informational, filled in once resolved, and an event for a customer nobody recognises is the row that matters most — 025",
};

{
  const policied = policiedTables();
  const tenant = tenantTables();
  check3(tenant.size > 20, `the migrations give ${tenant.size} tables a workspace_id`);
  check3(tenant.has("steps") && tenant.has("runs"), "...including the two that hold the most of it");

  const unguarded = [...tenant].filter((t) => !policied.has(t) && !(t in NO_POLICY_BY_DESIGN)).sort();
  check3(
    unguarded.length === 0,
    `every tenant table has tenant_isolation or a stated reason (${unguarded.join(", ") || "none missing"})`,
  );

  // AND `agent_grants` BY NAME, from its first migration, which is the one exception this file
  // makes to discovering everything. The rule above already covers it and would already fail if it
  // lost its policy — but this table is the one that decides who may do what, and "covered because
  // the discovery happened to find it" and "covered because somebody asserted it" are the same
  // green tick until the day the reader stops recognising a CREATE TABLE. The synthetic check at
  // the end of this block guards that for every table in general; this guards it for the table
  // where the failure is an authorisation answer crossing a tenant boundary.
  check3(tenant.has("agent_grants"), "the migrations give agent_grants a workspace_id");
  check3(policied.has("agent_grants"), "...and tenant_isolation, which is what stops a grant being read or WRITTEN across the boundary");
  {
    const pg = readFileSync(join(MIGRATIONS_PG, "060_agent_grants.sql"), "utf8");
    const sqlite = readFileSync(
      join(resolve(SRC, "..", "migrations", "sqlite"), "060_agent_grants.sql"),
      "utf8",
    );
    // THE PAIR, ON BOTH DRIVERS. A bare `REFERENCES agents(id)` is satisfied by any tenant's agent
    // — `agents.id` is a globally unique uuid — which is precisely the hole migration 018 closed on
    // `secret_refs`. Asserted as text on both files rather than behaviourally, because the
    // behavioural half needs a database and this rule has to run on every machine.
    const pairFk = /FOREIGN KEY \(workspace_id, agent_id\)\s*\n?\s*REFERENCES agents \(workspace_id, id\)/;
    check3(pairFk.test(pg), "...and its foreign key is the (workspace_id, agent_id) pair on postgres");
    check3(pairFk.test(sqlite), "...and on sqlite, where foreign keys are on by default and enforce it");
  }

  // And the reasons are not a graveyard. An entry for a table that no longer exists is a rule
  // getting quietly weaker, exactly as rule 2b says of the method allowlist above.
  const stale = Object.keys(NO_POLICY_BY_DESIGN).filter((t) => !tenant.has(t));
  check3(stale.length === 0, `every stated reason still names a real tenant table (${stale.join(", ") || "all do"})`);

  // A table cannot be both excused and policied — that means somebody added the policy and left
  // the excuse behind, and the next reader believes the excuse.
  const both = Object.keys(NO_POLICY_BY_DESIGN).filter((t) => policied.has(t)).sort();
  check3(both.length === 0, `and nothing is both excused and policied (${both.join(", ") || "none is"})`);

  // And the rule can still fail, for the same reason 2c and 3 carry one. A reader of migrations
  // that has quietly stopped recognising a CREATE TABLE reports that every tenant table is
  // policied, forever, and the sentence is true only because it can no longer see any.
  const synthetic = new Set<string>();
  collectTenantTables(
    [
      "CREATE TABLE lonely_table (",
      "  id uuid PRIMARY KEY,",
      "  workspace_id uuid NOT NULL REFERENCES workspaces(id)",
      ");",
      "CREATE TABLE partitioned_table (",
      "  id text NOT NULL,",
      "  workspace_id uuid NOT NULL,",
      "  started_at text NOT NULL",
      ") PARTITION BY RANGE (started_at);",
      "CREATE TABLE no_tenant_here (id uuid PRIMARY KEY, note text",
      ");",
      "ALTER TABLE older_table ADD COLUMN workspace_id uuid;",
      "CREATE TABLE gone_again (id uuid, workspace_id uuid",
      ");",
      "DROP TABLE gone_again;",
      // The rebuild idiom, in the order the migrations actually write it. Read out of order this
      // leaves `rebuilt_table` deleted and `rebuilt_table_new` standing — which is what it did.
      "CREATE TABLE rebuilt_table_new (id uuid, workspace_id uuid",
      ");",
      "DROP TABLE rebuilt_table;",
      "ALTER TABLE rebuilt_table_new RENAME TO rebuilt_table;",
      // And a rename of a table that never had tenancy must not invent it.
      "ALTER TABLE plain_thing RENAME TO plain_thing_v2;",
    ].join("\n"),
    synthetic,
  );
  const expected = ["lonely_table", "older_table", "partitioned_table", "rebuilt_table"];
  check3(
    [...synthetic].sort().join(",") === expected.join(","),
    `the reader still finds a tenant table, partitioned or altered into one ([${[...synthetic].sort().join(", ")}])`,
  );
  check3(!synthetic.has("no_tenant_here"), "...and does not invent one that has no workspace_id");
  check3(!synthetic.has("gone_again"), "...nor keep one that was dropped");
  check3(!synthetic.has("rebuilt_table_new"), "...nor mistake a rebuild's scaffolding for the table itself");
  check3(!synthetic.has("plain_thing_v2"), "...nor give tenancy to a renamed table that never had it");

  // --- and the two dialects agree about which tables those are ------------------------------
  //
  // `compareDialects` already checks that both directories hold the same VERSIONS. It says
  // nothing about what those versions do, and a version is free to create a table on one driver
  // and not the other — several deliberately do exactly that, which is why the parity worth
  // checking is over the tenant tables rather than over every table.
  //
  // WHAT DRIFT WOULD COST, and it is not this rule. `export.test.ts` asks the same question a
  // different way: it reads a live SQLite schema, finds every table with a `workspace_id`, and
  // fails if one is neither exported nor explicitly excluded — the assertion that keeps "a
  // workspace can download everything it has" true as tables are added. Read from SQLite, it
  // cannot see a table that exists only on Postgres. That table would be tenant data, in the
  // hosted driver, silently outside a portability export and outside the check that exists to
  // prevent exactly that.
  //
  // Twenty-nine each and identical today. This is what keeps the export's check trustworthy on
  // the driver it does not read.
  const sqliteTenant = new Set<string>();
  const MIGRATIONS_LITE = resolve(SRC, "..", "migrations", "sqlite");
  for (const file of readdirSync(MIGRATIONS_LITE).sort()) {
    collectTenantTables(readFileSync(join(MIGRATIONS_LITE, file), "utf8"), sqliteTenant);
  }
  const pgOnly = [...tenant].filter((t) => !sqliteTenant.has(t)).sort();
  const litOnly = [...sqliteTenant].filter((t) => !tenant.has(t)).sort();
  check3(
    pgOnly.length === 0,
    `no tenant table exists on postgres alone, where the export's own check cannot see it (${pgOnly.join(", ") || "none does"})`,
  );
  check3(
    litOnly.length === 0,
    `...nor on sqlite alone, which would be a table the hosted driver never got (${litOnly.join(", ") || "none does"})`,
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
