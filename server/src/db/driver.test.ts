// Choosing a driver — the decision `open.ts` is the only place in the codebase allowed to make.
//
// Three rules, and all three are about the same failure: a server that STARTS, works, and is
// wrong. None of them produces an error at the point of the mistake, so each has to be refused
// at boot or it is not caught at all.
//
//   1. An unrecognised driver name is refused rather than fallen back to SQLite — a fallback
//      means somebody asked for Postgres and got a file nobody is looking at.
//   2. `postgres` with no URL is refused, for the same reason.
//   3. `sqlite` under NODE_ENV=production is refused, which is the one this file was added for.
//
// Rule 3 exists because the two drivers DISAGREE and the disagreement is silent. It is written
// down in the README under "What Session 2 deliberately did not do": `users.external_id` is
// `COLLATE NOCASE` on SQLite and case-sensitive on Postgres, so two auth-provider subjects
// differing only in case are ONE person on SQLite and TWO on Postgres. That is an identity
// bug — the kind that is invisible until it is a breach — and fixing it properly needs a table
// rebuild. Refusing the combination makes it unreachable in production instead of merely
// unlikely, at the cost of one comparison. It mirrors exactly what the local auth issuer and
// the dev tenancy middleware already do about themselves.
//
// And the second reason, which is larger: RLS is the backstop the whole tenancy model leans
// on, and it exists only on Postgres. SQLite in production is a deployment with the backstop
// silently absent.
//
//   npm run test:driver

import { driverFromEnv, openDb, PG_URL_ENV } from "./open.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

/** What was thrown, or null. Nothing here mutates process.env — the env is a parameter. */
function refusal(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

console.log("\nthe driver name itself");
{
  check(driverFromEnv(undefined, {}) === "sqlite", "nothing set means SQLite — the free development path is the default");
  check(driverFromEnv(undefined, { JAROKU_DB_DRIVER: "postgres" }) === "postgres", "JAROKU_DB_DRIVER=postgres selects Postgres");
  check(driverFromEnv(undefined, { JAROKU_DB_DRIVER: "  POSTGRES " }) === "postgres", "...case and whitespace insensitively");

  const bad = refusal(() => driverFromEnv(undefined, { JAROKU_DB_DRIVER: "mysql" }));
  check(bad !== null && /must be "sqlite" or "postgres"/.test(bad), "an unrecognised driver is REFUSED, not fallen back from", bad ?? "no error");
}

console.log("\nsqlite refuses to run in production");
{
  // The rule. Both spellings of "asked for SQLite" — explicitly, and by saying nothing.
  const explicit = refusal(() => driverFromEnv(undefined, { JAROKU_DB_DRIVER: "sqlite", NODE_ENV: "production" }));
  check(explicit !== null, "JAROKU_DB_DRIVER=sqlite + NODE_ENV=production REFUSES TO BOOT", "it started");
  check(
    explicit !== null && /NODE_ENV=production/.test(explicit) && /JAROKU_DB_DRIVER=postgres/.test(explicit),
    "...and the message names the setting and what to set instead",
    explicit ?? "",
  );
  check(
    explicit !== null && /case-insensitive/.test(explicit) && /row-level security/.test(explicit),
    "...and says WHY, because the reason is not guessable from the setting",
    explicit ?? "",
  );

  const implicit = refusal(() => driverFromEnv(undefined, { NODE_ENV: "production" }));
  check(implicit !== null, "...and the DEFAULT is refused too — SQLite in production is never a decision somebody made");

  // The refusal is about the driver, not about the environment variable that selected it, so
  // an explicit override argument gets the same answer. Otherwise the guard is one call site
  // away from being bypassed by whoever next needs to pass a driver in code.
  const override = refusal(() => driverFromEnv("sqlite", { NODE_ENV: "production" }));
  check(override !== null, "...and an in-code override of the driver does not escape it");

  // ...and it does not fire anywhere else, which is the half that keeps development working.
  check(refusal(() => driverFromEnv(undefined, { NODE_ENV: "development" })) === null, "development is untouched");
  check(refusal(() => driverFromEnv(undefined, {})) === null, "an unset NODE_ENV is untouched");
  check(refusal(() => driverFromEnv(undefined, { NODE_ENV: "test" })) === null, "so is a test environment");
  check(
    refusal(() => driverFromEnv(undefined, { JAROKU_DB_DRIVER: "postgres", NODE_ENV: "production" })) === null,
    "Postgres in production is exactly what this is asking for, and is allowed",
  );
}

console.log("\nthe guard is on the path the server actually boots through");
{
  // `driverFromEnv` being right is worth nothing if `openDb` reads a different environment.
  // This is the call `index.ts` and both CLIs make.
  const opened = refusal(() => openDb({ sqlitePath: ":memory:", env: { NODE_ENV: "production" } }));
  check(opened !== null && /NODE_ENV=production/.test(opened), "openDb refuses it too, not just the helper", opened ?? "it opened");

  const pgNoUrl = refusal(() =>
    openDb({ sqlitePath: ":memory:", env: { JAROKU_DB_DRIVER: "postgres", NODE_ENV: "production" } }),
  );
  check(
    pgNoUrl !== null && pgNoUrl.includes(PG_URL_ENV),
    "...and Postgres with no URL is refused by name, rather than starting against nothing",
    pgNoUrl ?? "it opened",
  );

  // The free development path, unchanged and asserted rather than assumed: this is the whole
  // reason the SQLite driver exists and stays the default.
  const db = openDb({ sqlitePath: ":memory:", env: {} });
  check(db !== undefined, "and SQLite still opens with nothing set at all");
  void db.close();
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
