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
import { join, relative } from "node:path";
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
  if (file.startsWith(DB_DIR + "/") || file === DB_DIR) continue;
  const text = readFileSync(file, "utf8");
  if (DRIVERS.some((re) => re.test(text))) offenders.push(relative(SRC, file));
}
if (offenders.length) fail(`a driver is imported outside src/db/: ${offenders.join(", ")}`);
else ok(`no file outside src/db/ imports node:sqlite or pg (${files.length} checked)`);

// The rule is only worth anything if the drivers are genuinely imported SOMEWHERE inside it —
// a pass because nothing imports them at all would be a green tick over a deleted feature.
const inside = files.filter((f) => f.startsWith(DB_DIR + "/")).filter((f) => {
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

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
