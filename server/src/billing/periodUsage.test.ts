// A run is counted where it STARTS, once, and a pause does not cost a second one.
//
// EVERY ASSERTION HERE IS ABOUT A NUMBER THAT WOULD LOOK RIGHT. That is the whole reason the suite
// exists: a quota counter is never obviously wrong on a screen — it is a plausible integer beside a
// plausible limit, and the only way to know it is correct is to drive the transitions and count.
//
// THE THREE PLACES A RUN COULD BE COUNTED, and two of them are wrong:
//
//   on receipt      a refused request was not a run, so a workspace at its limit would spend next
//                   month's allowance on 402s
//   on completion   a killed or crashed run still spent the model calls it had made, so the
//                   expensive failures would be the free ones
//   at `running`    right, and where the money starts
//
// AND "ONCE" IS THE HALF THAT BREAKS LATER. A run reaches `running` more than once — pause and
// resume is ordinary, a redelivered `run_start` is expected — and a counter that moved each time
// would make pausing to think cost a run. The guard is a unique key in the database rather than a
// flag, because two replicas can watch the same run start and a check-then-write loses one of them
// silently.
//
//   npm run test:usage-periods

import { randomUUID } from "node:crypto";
import { openTestSqlite } from "../db/testDb.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { PeriodUsage } from "./periodUsage.ts";
import { billingPeriod } from "./gate.ts";
import { USAGE_KINDS } from "./usage.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const db = await openTestSqlite();
const identity = new IdentityRepository(db);
const billing = new BillingRepository(db);

async function workspace(): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `usage ${randomUUID().slice(0, 8)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

/** The counter, read the way a quota check reads it. */
const runsUsed = (ctx: TenantContext, at = new Date()): Promise<number> =>
  billing.usageCount(ctx, billingPeriod(at).start, "runs");

// ---------------------------------------------------------------------------------------------
console.log("\na run is counted once, at the moment it starts");
// ---------------------------------------------------------------------------------------------
{
  const ctx = await workspace();
  const usage = new PeriodUsage(billing);
  check((await runsUsed(ctx)) === 0, "a new workspace has started nothing");

  const run = randomUUID();
  await usage.countRun(ctx, run);
  check((await runsUsed(ctx)) === 1, "starting a run counts one");

  // THE RESUME. A paused run that comes back reaches `running` a second time, and counting it
  // again would mean pausing to think costs a run.
  await usage.countRun(ctx, run);
  check((await runsUsed(ctx)) === 1, "...and resuming it counts none");

  const second = randomUUID();
  await usage.countRun(ctx, second);
  check((await runsUsed(ctx)) === 2, "a different run counts one more");
}

// ---------------------------------------------------------------------------------------------
console.log("\nthe database is what makes it once, not the process");
// ---------------------------------------------------------------------------------------------
{
  // TWO INSTANCES, WHICH IS TWO REPLICAS. The in-process cache cannot see across them, so what has
  // to hold is the unique key — and this is the assertion that would fail if somebody ever
  // "simplified" the marker row away into a Set.
  const ctx = await workspace();
  const a = new PeriodUsage(billing);
  const b = new PeriodUsage(billing);
  const run = randomUUID();

  await a.countRun(ctx, run);
  await b.countRun(ctx, run);
  check((await runsUsed(ctx)) === 1, "two replicas watching one run start count one between them");

  // And the race, rather than the sequence: both arriving at once is the delivery pattern that
  // actually happens when a provider retries because a response was slow.
  const racing = randomUUID();
  await Promise.all([
    new PeriodUsage(billing).countRun(ctx, racing),
    new PeriodUsage(billing).countRun(ctx, racing),
    new PeriodUsage(billing).countRun(ctx, racing),
  ]);
  check((await runsUsed(ctx)) === 2, "...and three simultaneous claims on one run still count one");
}

// ---------------------------------------------------------------------------------------------
console.log("\neval work is counted per case, not per batch");
// ---------------------------------------------------------------------------------------------
{
  const ctx = await workspace();
  const usage = new PeriodUsage(billing);
  const evalsUsed = (): Promise<number> =>
    billing.usageCount(ctx, billingPeriod().start, "eval_runs");

  const batch = randomUUID();
  await usage.countEvalCases(ctx, batch, 100);
  check((await evalsUsed()) === 100, "a hundred-case batch counts a hundred, not one");

  await usage.countEvalCases(ctx, batch, 100);
  check((await evalsUsed()) === 100, "...and a redelivery of the same batch counts none");

  await usage.countEvalCases(ctx, randomUUID(), 0);
  check((await evalsUsed()) === 100, "an empty batch counts nothing at all");
  await usage.countEvalCases(ctx, randomUUID(), -5);
  check((await evalsUsed()) === 100, "...and a negative one is refused rather than subtracting");

  // The two metrics are separate counters. An eval batch must not consume the run allowance, or a
  // workspace comparing three providers over a dataset would be locked out of the composer.
  check((await runsUsed(ctx)) === 0, "and none of it touched the run counter");
}

// ---------------------------------------------------------------------------------------------
console.log("\nwhat is counted is quantity, and never money");
// ---------------------------------------------------------------------------------------------
{
  const ctx = await workspace();
  const usage = new PeriodUsage(billing);
  await usage.countRun(ctx, randomUUID());
  await usage.countEvalCases(ctx, randomUUID(), 12);

  // THE MARKER ROWS ARE IN THE LEDGER AND MUST ADD NOTHING TO IT. They are there for the unique
  // key; a spend figure that included them would be a bill with a line for "a run happened".
  const spend = await billing.spendSince(ctx, "1970-01-01T00:00:00.000Z");
  check(spend.usd === 0, "the markers add nothing to what this workspace has spent");
  // AND THEY ARE NOT UNPRICED EITHER, which is the subtler half. An unpriced row makes `costKnown`
  // false and puts "at least" in front of every figure on the Usage tab — so a marker written as
  // `cost_usd: null` would have quietly turned every workspace's total into a floor, for a row that
  // is not a call and has no price to be missing. Zero and KNOWN is what it is.
  check(spend.unpricedEvents === 0, "...and are not unpriced, which would put 'at least' on every total");
  check(spend.costKnown, "...so a workspace that has only started runs still has an exact spend of zero");

  // `period.marker` is a real kind rather than an unclassified string, or `isUsageKind` would
  // refuse it and the metering audit would have nothing to say about it.
  check(
    (USAGE_KINDS as readonly string[]).includes("period.marker"),
    "the marker kind is declared beside the others rather than smuggled in",
  );
}

// ---------------------------------------------------------------------------------------------
console.log("\nthe period is the calendar month, and a new one starts empty");
// ---------------------------------------------------------------------------------------------
{
  const ctx = await workspace();
  const july = new Date("2026-07-15T12:00:00.000Z");
  const august = new Date("2026-08-15T12:00:00.000Z");

  const inJuly = new PeriodUsage(billing, () => july);
  await inJuly.countRun(ctx, randomUUID());
  await inJuly.countRun(ctx, randomUUID());
  check((await runsUsed(ctx, july)) === 2, "two runs in July");

  const inAugust = new PeriodUsage(billing, () => august);
  await inAugust.countRun(ctx, randomUUID());
  check((await runsUsed(ctx, august)) === 1, "August starts from zero rather than inheriting July");
  // NOTHING WAS DELETED TO MAKE THAT TRUE, which is the property that makes "what did I use in
  // July" a question with an answer. A rollover that zeroed a counter would be a rollover that
  // destroyed the only record.
  check((await runsUsed(ctx, july)) === 2, "...and July's figure is exactly where it was");

  const snapshot = await inJuly.forCurrentPeriod(ctx);
  check(snapshot["runs"] === 2, "the period snapshot reads the month it was asked about");
  check(snapshot["eval_runs"] === undefined, "a metric with nothing in it is absent, not zero");
}

await db.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
