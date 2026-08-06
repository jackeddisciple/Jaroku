// Postgres against the shared driver conformance suite, plus the one piece of this driver
// that is pure and can be tested without a server: the placeholder rewriter.
//
// The rewriter runs first and always. It is the single most dangerous function in the
// driver — every query in the codebase passes through it, and a mistake does not throw, it
// binds the wrong value to the wrong column.
//
// The conformance half needs a real Postgres. It SKIPS, loudly, when there isn't one, and
// that is deliberate: `npm run dev` and every other suite work with nothing installed, and a
// test that failed the build on a laptop without Docker would make the free-development path
// a lie. A skip that says so is honest; a green tick that ran nothing is not.
//
//   docker compose up -d postgres
//   JAROKU_PG_URL=postgres://jaroku:jaroku@127.0.0.1:5433/jaroku npm run test:db-postgres

import { runConformance } from "./conformance.ts";
import { PostgresDb, toPositional } from "./postgres.ts";
import { PG_URL_ENV } from "./open.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

console.log("\nplaceholder rewriting");

check(
  toPositional("SELECT * FROM runs WHERE id = ? AND status = ?") ===
    "SELECT * FROM runs WHERE id = $1 AND status = $2",
  "placeholders number from one, in order",
);

check(toPositional("SELECT 1") === "SELECT 1", "a query with no placeholders is untouched");

// A question mark inside a string literal is data, not a placeholder. Getting this wrong
// shifts every subsequent parameter by one — which binds real values to the wrong columns and
// throws nothing at all.
check(
  toPositional("SELECT ? WHERE note = 'what? really'") === "SELECT $1 WHERE note = 'what? really'",
  "a question mark inside a string literal is left alone",
);
check(
  toPositional("SELECT ?, 'it''s ok?', ?") === "SELECT $1, 'it''s ok?', $2",
  "a doubled quote inside a literal does not end it",
);
check(
  toPositional(`SELECT ? FROM "weird?column"`) === `SELECT $1 FROM "weird?column"`,
  "a question mark inside a quoted identifier is left alone",
);
check(
  toPositional("SELECT ? -- is this ?\nAND x = ?") === "SELECT $1 -- is this ?\nAND x = $2",
  "a line comment is skipped",
);
check(
  toPositional("SELECT ? /* really? */ , ?") === "SELECT $1 /* really? */ , $2",
  "a block comment is skipped",
);

// The exact shape the stores emit, since that is what actually has to work.
check(
  toPositional(
    `INSERT INTO steps (id, run_id, input) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  ) === `INSERT INTO steps (id, run_id, input) VALUES ($1, $2, $3) ON CONFLICT(id) DO NOTHING`,
  "a real store insert rewrites correctly",
);

// --- the conformance suite, if there is a server ---------------------------------------

const url = process.env[PG_URL_ENV];
if (!url) {
  console.log(
    `\nSKIPPED: no ${PG_URL_ENV}. Start one with \`docker compose up -d postgres\` and set\n` +
      `  ${PG_URL_ENV}=postgres://jaroku:jaroku@127.0.0.1:5433/jaroku\n` +
      `to run the conformance suite against Postgres.`,
  );
} else {
  const db = new PostgresDb({ url });
  try {
    await db.ping();
  } catch (err) {
    console.log(`\nSKIPPED: ${PG_URL_ENV} is set but unreachable — ${(err as Error).message}`);
    await db.close();
    console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
    process.exit(failures === 0 ? 0 : 1);
  }
  try {
    failures += (await runConformance("PostgresDb", db)).failures;
  } finally {
    await db.close();
  }
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
