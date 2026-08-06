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

// --- SQLite only ---------------------------------------------------------------------
//
// Serialisation is not part of the interface's contract — Postgres runs transactions in
// parallel on separate pooled connections and is right to. It IS part of this driver's
// contract, because there is one connection and SQLite has no nested transactions: a second
// BEGIN inside the first would make the first COMMIT commit both, including the half of the
// second that had run. That could not happen while the stores were synchronous. It can now,
// so it is asserted here rather than assumed.
{
  const one = new SqliteDb(":memory:");
  await one.exec(`CREATE TABLE t (k text PRIMARY KEY)`);
  const order: string[] = [];
  const a = one.transaction(async (tx) => {
    order.push("a:begin");
    await tx.run(`INSERT INTO t (k) VALUES (?)`, ["a"]);
    await new Promise((r) => setTimeout(r, 25));
    order.push("a:end");
  });
  const b = one.transaction(async (tx) => {
    order.push("b:begin");
    await tx.run(`INSERT INTO t (k) VALUES (?)`, ["b"]);
    order.push("b:end");
  });
  await Promise.all([a, b]);
  const ok = order.join(",") === "a:begin,a:end,b:begin,b:end";
  console.log(
    ok
      ? "  ok   overlapping transactions take turns on one connection"
      : `  FAIL overlapping transactions interleaved (${order.join(",")})`,
  );
  if (!ok) failures++;
  await one.close();
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
