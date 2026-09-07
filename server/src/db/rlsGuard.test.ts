// The connection either has a second wall or it does not, and nothing else can tell you.
//
// THE BUG THIS PINS SHIPPED TO A REAL DEPLOYMENT. The first hosted Jaroku connected to Neon as
// `neondb_owner`, which carries `rolbypassrls`. Every policy was present, `relforcerowsecurity` was
// set on every tenant table, every migration had applied cleanly — and an unscoped
// `SELECT count(*) FROM threads` returned every row in the database, across every workspace.
// Switching to a role without the attribute took the same query to zero.
//
// `test:rls` already asserts the app role's attributes and could not run there: it needs SET ROLE,
// and the owner was not a member of the app role. So the check that matters moved to boot, against
// the connection the server actually opened — and this is that rule, as a pure function of three
// facts so it can be asserted without a database.
//
//   npm run test:rls-guard

import { rlsRefusal, readRoleFacts, type RoleFacts } from "./rlsGuard.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else { failures++; console.log(`  FAIL ${msg}`); }
};

const role = (over: Partial<RoleFacts> = {}): RoleFacts =>
  ({ role: "jaroku_api", superuser: false, bypassRls: false, ...over });

console.log("\nin production a connection that ignores the policies is refused");
{
  check(rlsRefusal(role({ bypassRls: true, role: "neondb_owner" }), true) !== null, "BYPASSRLS is refused");
  check(rlsRefusal(role({ superuser: true }), true) !== null, "a superuser is refused — it ignores policies whether forced or not");
  check(rlsRefusal(role(), true) === null, "a role with neither is allowed to serve");

  // THE MESSAGE HAS TO NAME THE ROLE, because the person reading it is looking at a connection
  // string with several plausible ones in it and the schema will tell them nothing.
  const msg = rlsRefusal(role({ bypassRls: true, role: "neondb_owner" }), true) ?? "";
  check(msg.includes("neondb_owner"), "...and says which role");
  check(msg.includes("jaroku_app"), "...and which one to use instead");
}

console.log("\noutside production it is not this check's business");
{
  // A developer against a local Postgres as a superuser is doing something ordinary. Refusing there
  // would make the check something people switch off, which is how it stops running in production.
  check(rlsRefusal(role({ superuser: true }), false) === null, "a superuser is fine in development");
  check(rlsRefusal(role({ bypassRls: true }), false) === null, "so is BYPASSRLS");
}

console.log("\nthe read copes with what each driver calls a boolean");
{
  // Postgres hands back real booleans; SQLite has no such type and the same column arrives as 0/1.
  // A truthiness test on the number would be right by accident and wrong for `0`.
  const asNumbers = { get: async () => ({ rolname: "r", rolsuper: 0, rolbypassrls: 1 }) };
  const facts = await readRoleFacts(asNumbers as never);
  check(facts?.superuser === false && facts?.bypassRls === true, "1 and 0 read as true and false");

  const asBooleans = { get: async () => ({ rolname: "r", rolsuper: false, rolbypassrls: true }) };
  const b = await readRoleFacts(asBooleans as never);
  check(b?.superuser === false && b?.bypassRls === true, "real booleans read the same way");

  // A driver that cannot answer must not be read as "safe": no row means no facts, and the caller
  // skips rather than concluding.
  const empty = { get: async () => undefined };
  check((await readRoleFacts(empty as never)) === null, "no row is null rather than a false negative");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
