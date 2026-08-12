// Every plan is complete, the nesting actually nests, an override folds in without rewriting
// the plan, and the table and this file cannot disagree in silence.
//
// The last one is the point of the suite. `test:jobs` asserts every job class has a complete
// config so a class added without one fails rather than silently defaulting; this is the same
// assertion one layer up, and the failure it prevents is worse: a plan row with no definition
// resolves to FREE, so a workspace that paid for Scale gets a free workspace's ceiling and
// nothing anywhere says so.
//
//   npm run test:plans

import { openTestSqlite } from "../db/testDb.ts";
import {
  PLANS, PLAN_IDS, assertPlanRegistry, isPlanId, limitsFor, planConcurrency, planFor,
} from "./plans.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

console.log("\nevery plan is complete");

for (const id of PLAN_IDS) {
  const p = PLANS[id];
  check(p.id === id, `${id}: its id matches its key`);
  check(typeof p.label === "string" && p.label.length > 0, `${id}: has a label`);
  check(Number.isFinite(p.monthlyCreditsUsd) && p.monthlyCreditsUsd >= 0, `${id}: credits are a non-negative number`);
  check(
    p.budgetCeilingUsd === null || (Number.isFinite(p.budgetCeilingUsd) && p.budgetCeilingUsd >= 0),
    `${id}: the ceiling is null or a non-negative number`,
  );
  check(Number.isInteger(p.retentionDays) && p.retentionDays > 0, `${id}: retention is a positive whole number of days`);
  check(p.seats === null || (Number.isInteger(p.seats) && p.seats > 0), `${id}: seats are null or a positive count`);
  check(
    Object.values(p.concurrency).every((n) => typeof n === "number" && n > 0),
    `${id}: no concurrency limit is zero — that would admit nothing, ever`,
  );
  check(
    ["platformKey", "byok", "deploy", "mcp"].every(
      (f) => typeof (p.features as unknown as Record<string, unknown>)[f] === "boolean",
    ),
    `${id}: every feature flag is present`,
  );
}

console.log("\nthe nesting nests");

// The property the spread is for: a paid plan is never WORSE than a free one on any axis. If
// somebody adds a limit to FREE and forgets PRO, `...FREE` gives PRO the free value and this
// assertion is what notices.
check(PLANS.pro.monthlyCreditsUsd > PLANS.free.monthlyCreditsUsd, "pro grants more credit than free");
check(PLANS.scale.monthlyCreditsUsd > PLANS.pro.monthlyCreditsUsd, "scale grants more than pro");
check(PLANS.pro.retentionDays > PLANS.free.retentionDays, "pro keeps traces longer than free");
check(PLANS.scale.retentionDays > PLANS.pro.retentionDays, "scale keeps them longer still");
check(
  (PLANS.pro.concurrency["run.eval"] ?? 0) > (PLANS.free.concurrency["run.eval"] ?? 0),
  "pro runs more eval jobs at once than free",
);
check(PLANS.free.seats !== null && PLANS.pro.seats !== null && PLANS.pro.seats > PLANS.free.seats, "pro seats more people");
check(PLANS.scale.seats === null, "scale does not cap seats at all");
check(
  Object.keys(PLANS.free.features).every((f) => f in PLANS.scale.features),
  "every feature flag free knows about, scale knows about",
);
check(
  Object.entries(PLANS.free.features).every(
    ([f, on]) => !on || PLANS.pro.features[f as keyof typeof PLANS.pro.features],
  ),
  "nothing free enables is disabled on pro",
);

console.log("\nresolving a plan");

check(planFor("pro").id === "pro", "a known plan resolves to itself");
check(planFor("enterprise-gold").id === "free", "an unknown one falls back to free rather than throwing");
check(planFor(null).id === "free", "so does no plan at all");
check(isPlanId("scale") && !isPlanId("scale "), "isPlanId is exact");

console.log("\noverrides fold in without rewriting the plan");

{
  const l = limitsFor("free", { budgetCeilingUsd: 100 });
  check(l.budgetCeilingUsd === 100, "a negotiated ceiling wins over the plan's");
  check(l.monthlyCreditsUsd === PLANS.free.monthlyCreditsUsd, "and nothing else moved");
  check(PLANS.free.budgetCeilingUsd === 5, "the plan itself was not mutated");
}
{
  // null is a real answer, not an absence. A plan whose ceiling is 5 and a workspace that
  // negotiated "no ceiling" must not read the same as one that negotiated nothing.
  const l = limitsFor("free", { budgetCeilingUsd: null });
  check(l.budgetCeilingUsd === null, "an override of null means no ceiling, not 'use the plan's'");
  check(limitsFor("free", {}).budgetCeilingUsd === 5, "...which an absent key does not");
}
{
  const l = limitsFor("free", { budgetCeilingUsd: 0 });
  check(l.budgetCeilingUsd === 0, "an override of zero is kept — it is what suspending a workspace sets");
}
{
  const l = limitsFor("pro", { concurrency: { "run.eval": 20 }, features: { deploy: false } });
  check(l.concurrency["run.eval"] === 20, "a per-class concurrency override is read");
  check(l.concurrency["run.interactive"] === PLANS.pro.concurrency["run.interactive"], "and the other classes keep the plan's");
  check(l.features.deploy === false, "a feature can be taken away from one workspace");
  check(l.features.mcp === PLANS.pro.features.mcp, "without touching the others");
  check(PLANS.pro.features.deploy === true, "and the plan is still what it was");
}
{
  const l = limitsFor("free", {
    somethingFromAnOlderVersion: 12,
    budgetCeilingUsd: "lots",
    retentionDays: -3,
    concurrency: { "run.eval": 0 },
    seats: "many",
  });
  check(l.budgetCeilingUsd === 5, "a non-numeric ceiling is ignored rather than becoming NaN");
  check(l.retentionDays === PLANS.free.retentionDays, "a negative retention is ignored");
  check(l.concurrency["run.eval"] === 2, "a concurrency of zero is ignored — it would admit nothing, ever");
  // AND A RETENTION OF ZERO, which is the same trap pointed at the data instead of at the work.
  // The sweeper reads this as `now - 0` and deletes every run, step, checkpoint and export older
  // than NOW — the whole trace history, including the run that finished a second ago, on the next
  // nightly pass. Minus three was already refused; zero is what an empty field, a parsed empty
  // string and a misplaced default all produce, and it was accepted.
  check(
    limitsFor("free", { retentionDays: 0 }).retentionDays === PLANS.free.retentionDays,
    "a retention of ZERO is ignored too — it is a typo's value and its effect is unrecoverable",
  );
  check(
    limitsFor("free", { retentionDays: 400 }).retentionDays === 400,
    "...while a longer negotiated retention still applies",
  );
  check(l.seats === PLANS.free.seats, "so is a seat count that is not a number");
  check(l.id === "free", "and an unrecognised key does not void the whole override object");
}

console.log("\nplan concurrency composes with the job class's own");

check(planConcurrency(PLANS.free, "run.eval") === 2, "a class the plan speaks about gets the plan's number");
check(
  planConcurrency(PLANS.free, "generate") === null,
  "a class it does not gets null, so the caller falls through to jobClassConfig rather than to an invented limit",
);

console.log("\nthe registry and this file cannot disagree in silence");

{
  const db = await openTestSqlite();
  try {
    const rows = await db.all<{ id: string }>(`SELECT id FROM plans ORDER BY id`);
    check(rows.length === PLAN_IDS.length, `migration 020 seeded ${PLAN_IDS.length} plans`);
    let ok = true;
    try {
      assertPlanRegistry(rows);
    } catch (err) {
      ok = false;
      console.log(`       ${(err as Error).message}`);
    }
    check(ok, "the shipped table matches the definitions in billing/plans.ts");

    // Both directions of the mismatch, since the boot check has to catch either.
    let extraRefused = false;
    try {
      assertPlanRegistry([...rows, { id: "enterprise" }]);
    } catch {
      extraRefused = true;
    }
    check(extraRefused, "a plan row nothing defines is refused at boot, not resolved to free");

    let missingRefused = false;
    try {
      assertPlanRegistry(rows.filter((r) => r.id !== "scale"));
    } catch {
      missingRefused = true;
    }
    check(missingRefused, "a defined plan with no row is refused too — nobody could subscribe to it");
  } finally {
    await db.close();
  }
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
