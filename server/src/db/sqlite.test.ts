// SQLite against the shared driver conformance suite.
//
// The Postgres driver runs the same file's suite when it arrives. Anything asserted here is
// asserted about both, which is the only way "the application cannot tell which driver it
// got" is a claim rather than a hope.
//
//   npm run test:db

import { runConformance } from "./conformance.ts";
import { SqliteDb } from "./sqlite.ts";

const db = new SqliteDb(":memory:");
let failures = 0;
try {
  failures = (await runConformance("SqliteDb (:memory:)", db)).failures;
} finally {
  await db.close();
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
