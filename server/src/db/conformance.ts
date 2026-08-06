// One suite, run against every driver.
//
// An interface with two implementations is a promise that the application cannot tell which
// one it got, and that promise is only as good as the cases somebody thought to check. The
// ways SQLite and Postgres differ are almost all quiet: one has no boolean, one returns
// bigints as strings, one takes `?` and the other `$1`, one rolls a transaction back on a
// constraint failure and leaves the session usable while the other marks it aborted. None
// of those throw at the boundary. They surface as a feature that works locally and does not
// work hosted, which is the single most expensive kind of bug this migration can produce.
//
// So the suite lives apart from either driver and both must pass it identically. A driver
// added later has a definition of done.

import { asBool, asInt, asIntOrNull, type Db } from "./db.ts";

export interface ConformanceResult {
  failures: number;
}

/**
 * Run the suite against an open `Db`. The caller owns opening and closing it, because
 * "open a database" is the one thing that cannot be written once for both drivers.
 */
export async function runConformance(label: string, db: Db): Promise<ConformanceResult> {
  let failures = 0;
  const check = (ok: boolean, msg: string): void => {
    if (ok) console.log(`  ok   ${msg}`);
    else {
      failures++;
      console.log(`  FAIL ${msg}`);
    }
  };

  // A distinct name per run, so the suite can be pointed at a shared Postgres without two
  // of them colliding, and so a crashed run leaves nothing that breaks the next one.
  const T = `conformance_${Math.random().toString(36).slice(2, 10)}`;
  console.log(`\n${label}`);

  // Deliberately portable DDL: text, a nullable number, a nullable float, a boolean.
  // Everything this suite asserts is about values crossing the boundary, not about types
  // either database is clever about — those get their own dialect-specific migrations.
  //
  // `flag` is declared `boolean` rather than `integer`, and the difference is not cosmetic.
  // Postgres has a real boolean type and rejects a JS `true` bound into an integer column
  // outright; SQLite has none and gives the declaration INTEGER affinity, storing 1 and 0.
  // Writing this column as an integer and binding a boolean is therefore a query that works
  // on one driver and errors on the other, which is precisely the class of bug this file
  // exists to catch — and it caught this one.
  await db.exec(`
    CREATE TABLE ${T} (
      k      text PRIMARY KEY,
      n      integer,
      f      double precision,
      body   text,
      flag   boolean
    );
  `);

  try {
    check(db.dialect === "sqlite" || db.dialect === "postgres", `reports a dialect (${db.dialect})`);

    // --- reads and writes ------------------------------------------------------------

    {
      const r = await db.run(`INSERT INTO ${T} (k, n, f, body, flag) VALUES (?, ?, ?, ?, ?)`, [
        "one",
        42,
        1.5,
        "hello",
        1,
      ]);
      check(r.changes === 1, "an insert reports one changed row");
    }

    {
      const row = await db.get<{ k: string; n: unknown; f: unknown }>(
        `SELECT k, n, f FROM ${T} WHERE k = ?`,
        ["one"],
      );
      check(row?.k === "one", "a parameterised read finds it");
      check(asInt(row?.n) === 42, "an integer survives the round trip");
      // Cost is a float and is compared against a bill. A driver that quietly rounded it
      // would produce a dashboard that disagrees with the invoice by a fraction of a cent
      // per step, which is worse than disagreeing loudly.
      check(Number(row?.f) === 1.5, "a float survives the round trip exactly");
    }

    check(
      (await db.get(`SELECT k FROM ${T} WHERE k = ?`, ["nope"])) === undefined,
      "get returns undefined for no rows, not null and not an empty row",
    );
    check((await db.all(`SELECT k FROM ${T} WHERE k = ?`, ["nope"])).length === 0, "all returns an empty array");

    {
      const r = await db.run(`UPDATE ${T} SET n = ? WHERE k = ?`, [43, "nope"]);
      check(r.changes === 0, "an update that matched nothing reports zero changes, not one");
    }

    // --- null is not zero ------------------------------------------------------------

    // The product's oldest rule, at the level it has to hold first. An unpriced model's cost
    // and an unscored judge verdict are both NULL columns, and a driver that handed either
    // back as 0 would make "we don't know" indistinguishable from "it was free".
    {
      await db.run(`INSERT INTO ${T} (k, n, f, body, flag) VALUES (?, ?, ?, ?, ?)`, [
        "nulls",
        null,
        null,
        null,
        null,
      ]);
      const row = await db.get<{ n: unknown; f: unknown; body: unknown }>(
        `SELECT n, f, body FROM ${T} WHERE k = ?`,
        ["nulls"],
      );
      check(row?.n === null, "a NULL integer reads back as null, not 0");
      check(row?.f === null, "a NULL float reads back as null, not 0");
      check(row?.body === null, "a NULL text reads back as null, not an empty string");
      check(asIntOrNull(row?.n) === null && asInt(row?.n) === 0, "the coercions keep unknown and zero apart");
    }

    // --- booleans --------------------------------------------------------------------

    // SQLite stores 0/1 and Postgres stores true/false, so a yes-or-no column reads back as
    // two different JavaScript values. Both must answer the same question the same way.
    {
      await db.run(`INSERT INTO ${T} (k, flag) VALUES (?, ?)`, ["yes", true]);
      await db.run(`INSERT INTO ${T} (k, flag) VALUES (?, ?)`, ["no", false]);
      const yes = await db.get<{ flag: unknown }>(`SELECT flag FROM ${T} WHERE k = ?`, ["yes"]);
      const no = await db.get<{ flag: unknown }>(`SELECT flag FROM ${T} WHERE k = ?`, ["no"]);
      check(asBool(yes?.flag) === true && asBool(no?.flag) === false, "a boolean survives whatever the driver stores it as");
    }

    // --- json payloads ---------------------------------------------------------------

    // Step payloads are JSON and the store's guarantee is that a step read back out of
    // history is the same shape as the one that streamed live. At this level that means a
    // serialised payload comes back byte-identical — the parse belongs to the store, and it
    // cannot fix text the driver mangled on the way through.
    {
      const payload = JSON.stringify({
        messages: [{ role: "user", content: "what's 17 * 23?" }],
        unicode: "ünïcödé — ✓",
        quotes: `he said "hi" and 'bye'`,
        newlines: "a\nb\r\nc",
        nested: { deep: [1, null, { x: 0.1 }] },
      });
      await db.run(`INSERT INTO ${T} (k, body) VALUES (?, ?)`, ["json", payload]);
      const row = await db.get<{ body: unknown }>(`SELECT body FROM ${T} WHERE k = ?`, ["json"]);
      check(row?.body === payload, "a JSON payload round-trips byte for byte, quotes and newlines included");
    }

    // --- transactions ----------------------------------------------------------------

    {
      await db.transaction(async (tx) => {
        await tx.run(`INSERT INTO ${T} (k, n) VALUES (?, ?)`, ["committed", 1]);
      });
      check(
        (await db.get(`SELECT k FROM ${T} WHERE k = ?`, ["committed"])) !== undefined,
        "a transaction that returns is committed",
      );
    }

    {
      let raised = "";
      try {
        await db.transaction(async (tx) => {
          await tx.run(`INSERT INTO ${T} (k, n) VALUES (?, ?)`, ["rolled-back", 1]);
          throw new Error("deliberate");
        });
      } catch (e) {
        raised = (e as Error).message;
      }
      check(raised === "deliberate", "a throwing transaction re-raises the original error");
      check(
        (await db.get(`SELECT k FROM ${T} WHERE k = ?`, ["rolled-back"])) === undefined,
        "and its writes are gone",
      );
    }

    // Two transactions that overlap in time must both land, whole.
    //
    // Note what is NOT asserted: that they take turns. SQLite has one connection and has to
    // serialise them; Postgres gives each its own and runs them at once. Both are correct,
    // and a suite that demanded one shape would be testing an implementation rather than the
    // contract. What both must deliver is that neither transaction loses work to the other's
    // COMMIT — the failure mode a single connection has if nothing serialises it.
    {
      const a = db.transaction(async (tx) => {
        await tx.run(`INSERT INTO ${T} (k, n) VALUES (?, ?)`, ["par-a", 1]);
        await new Promise((r) => setTimeout(r, 25));
        await tx.run(`UPDATE ${T} SET n = ? WHERE k = ?`, [2, "par-a"]);
      });
      const b = db.transaction(async (tx) => {
        await tx.run(`INSERT INTO ${T} (k, n) VALUES (?, ?)`, ["par-b", 1]);
      });
      await Promise.all([a, b]);
      const rows = await db.all<{ k: string; n: unknown }>(
        `SELECT k, n FROM ${T} WHERE k IN (?, ?) ORDER BY k`,
        ["par-a", "par-b"],
      );
      check(
        rows.length === 2 && asInt(rows[0]?.n) === 2 && asInt(rows[1]?.n) === 1,
        `overlapping transactions both commit in full (${JSON.stringify(rows)})`,
      );
    }

    // A failed transaction must not poison the connection. Postgres marks a session with a
    // failed statement as aborted until it is rolled back, and a driver that forgot the
    // rollback would turn one constraint violation into every later query failing.
    {
      let raised = false;
      try {
        await db.transaction(async (tx) => {
          await tx.run(`INSERT INTO ${T} (k, n) VALUES (?, ?)`, ["one", 99]); // duplicate key
        });
      } catch {
        raised = true;
      }
      check(raised, "a constraint violation inside a transaction throws");
      const after = await db.get<{ n: unknown }>(`SELECT n FROM ${T} WHERE k = ?`, ["one"]);
      check(asInt(after?.n) === 42, "the connection still works afterwards, and the original row is untouched");
    }

    // --- upsert ----------------------------------------------------------------------

    // Both dialects speak ON CONFLICT, and the stores rely on it — a run row is written once
    // at run_start and updated at run_end through the same statement, and a step arriving
    // twice must be ignored rather than duplicated. SQLite's INSERT OR IGNORE spelling is
    // not portable; this one is, which is why the stores move onto it.
    {
      await db.run(
        `INSERT INTO ${T} (k, n) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET n = excluded.n`,
        ["one", 100],
      );
      const row = await db.get<{ n: unknown }>(`SELECT n FROM ${T} WHERE k = ?`, ["one"]);
      check(asInt(row?.n) === 100, "ON CONFLICT DO UPDATE updates in place");

      await db.run(`INSERT INTO ${T} (k, n) VALUES (?, ?) ON CONFLICT (k) DO NOTHING`, ["one", 7]);
      const again = await db.get<{ n: unknown }>(`SELECT n FROM ${T} WHERE k = ?`, ["one"]);
      check(asInt(again?.n) === 100, "ON CONFLICT DO NOTHING leaves the existing row alone");
    }
  } finally {
    await db.exec(`DROP TABLE IF EXISTS ${T}`);
  }

  return { failures };
}
