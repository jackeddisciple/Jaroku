// The pre-dispatch gate: who may start a run, and what a refusal tells them.
//
// Two properties carry this suite. First, THE CEILING BOUNDS WHAT IS STARTED, NOT WHAT IS
// SPENT — a workspace under its limit may start a run that takes it over, and a run already
// going is never stopped. That is the same rule the eval budget has had since the eval engine
// landed, and it is deliberate rather than unfinished: killing mid-graph spends the money and
// throws away the result. Second, A REFUSAL NAMES WHAT WOULD CLEAR IT. "Budget exceeded" sends
// somebody to a dashboard to work out what happened; the strings here are asserted to contain
// the figure, the limit, the window and the way out, because that is the whole point of them.
//
//   npm run test:gate

import { randomUUID } from "node:crypto";
import { openTestSqlite } from "../db/testDb.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { Balances } from "./balances.ts";
import { BudgetGate, billingPeriod } from "./gate.ts";
import { PLANS } from "./plans.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const db = await openTestSqlite();
const billing = new BillingRepository(db);
const balances = new Balances(db, billing);
const identity = new IdentityRepository(db);
const gate = new BudgetGate(billing, balances, identity);

const NOW = new Date("2026-08-12T10:00:00.000Z");
const PERIOD = billingPeriod(NOW);

async function workspace(plan: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `gate ${randomUUID().slice(0, 8)}`,
  });
  const ctx = systemContextFor(ws.id, newRequestId());
  if (plan !== "free") await db.run(`UPDATE workspaces SET plan = ? WHERE id = ?`, [plan, ws.id]);
  return ctx;
}

/** Put `usd` of spend into the current period, the way the ingest path would. */
async function spend(ctx: TenantContext, usd: number, opts: { known?: boolean } = {}): Promise<void> {
  await billing.record(ctx, {
    kind: "llm.provider",
    idempotencyKey: `gate-${randomUUID()}`,
    runId: randomUUID(),
    costUsd: opts.known === false ? null : usd,
    totalTokens: 1_000,
    occurredAt: NOW.toISOString(),
  });
}

console.log("\nthe period is the calendar month, in UTC");

check(PERIOD.start === "2026-08-01T00:00:00.000Z", "it starts on the first");
check(PERIOD.end === "2026-09-01T00:00:00.000Z", "and ends when the next one starts");
check(
  billingPeriod(new Date("2026-12-31T23:59:59.999Z")).end === "2027-01-01T00:00:00.000Z",
  "December rolls into the next year rather than into month 12",
);

console.log("\nstatus reports the plan's ceiling until a workspace sets its own");

{
  const ctx = await workspace("free");
  const s = await gate.status(ctx, NOW);
  check(s.plan.id === "free", "the workspace's plan is resolved from its row");
  check(s.ceilingUsd === PLANS.free.budgetCeilingUsd, "and the ceiling is the plan's");
  check(s.spentUsd === 0 && s.headroomUsd === PLANS.free.budgetCeilingUsd, "with the whole of it as headroom");
  check(!s.overCeiling, "so nothing is refused");

  await billing.setCeiling(ctx, 1);
  check((await gate.status(ctx, NOW)).ceilingUsd === 1, "a workspace's own ceiling wins over the plan's");
  await billing.setCeiling(ctx, 0);
  check((await gate.status(ctx, NOW)).ceilingUsd === 0, "including zero, which is what suspending one sets");
  check((await gate.status(ctx, NOW)).overCeiling, "and zero refuses everything");
}

console.log("\nthe ceiling bounds what is started, not what is spent");

{
  const ctx = await workspace("free"); // $5 ceiling
  await spend(ctx, 4.99);
  const under = await gate.mayStart(ctx, { estimateUsd: 100, purpose: "run", subjectId: "r1" }, NOW);
  check(
    under.ok,
    "a workspace one cent under its ceiling may start a run estimated at twenty times the limit",
  );
  check(
    !(await gate.status(ctx, NOW)).overCeiling,
    "...because the estimate is not added to the period's spend before the check",
  );

  await spend(ctx, 0.02); // now $5.01, over
  const over = await gate.mayStart(ctx, { estimateUsd: 0.0001, purpose: "run", subjectId: "r2" }, NOW);
  check(!over.ok, "and once over, even a run estimated at a hundredth of a cent is refused");
}

console.log("\na refusal names the figure, the limit, the window and the way out");

{
  const ctx = await workspace("free");
  await spend(ctx, 6);
  const v = await gate.mayStart(ctx, { estimateUsd: 0.01, purpose: "run" }, NOW);
  const m = v.message ?? "";
  check(!v.ok, "refused");
  check(m.includes("$6.0000"), "it says what has been spent");
  check(m.includes("$5.0000"), "and what the limit is");
  check(m.includes("Free"), "and which plan set it");
  check(m.includes("2026-08-01"), "and when the window opened");
  check(m.includes("2026-09-01"), "and when it resets");
  check(m.toLowerCase().includes("raise"), "and that an owner can raise it");
  check(!m.includes("T00:00:00"), "as dates a person reads, not timestamps");
}

console.log("\na total that is a floor says so");

{
  const ctx = await workspace("free");
  await spend(ctx, 6);
  await spend(ctx, 0, { known: false }); // metered, unpriced
  const s = await gate.status(ctx, NOW);
  check(!s.costKnown, "an unpriced row makes the period's total incomplete");
  const v = await gate.mayStart(ctx, { estimateUsd: 0.01, purpose: "run" }, NOW);
  check((v.message ?? "").includes("at least"), "and the refusal says the figure is a floor");
  check((v.message ?? "").includes("could not be priced"), "and why");
}

console.log("\nno ceiling means no ceiling");

{
  const ctx = await workspace("team"); // budgetCeilingUsd: null
  await spend(ctx, 10_000);
  const s = await gate.status(ctx, NOW);
  check(s.ceilingUsd === null && s.headroomUsd === null, "the plan states no limit");
  check(!s.overCeiling, "so a large spend is not over one");
  check((await gate.mayStart(ctx, { estimateUsd: 5, purpose: "run" }, NOW)).ok, "and a run starts");
}

console.log("\nwith no platform credit, nothing is held");

{
  // The enforced default, and the local path: a workspace paying for its own tokens is not
  // spending platform money, so there is nothing to reserve against and nothing to refuse.
  const ctx = await workspace("free");
  const v = await gate.mayStart(ctx, { estimateUsd: 0.5, purpose: "run", subjectId: "r" }, NOW);
  check(v.ok, "a run starts with a zero balance");
  check(v.holdId === undefined, "and no hold was taken, because there was nothing to hold");
  check((await billing.liveHolds(ctx)).length === 0, "no hold rows at all");
}

console.log("\nwith platform credit, a hold is taken and bounded by the headroom");

{
  const ctx = await workspace("free"); // $5 ceiling
  await billing.addCredit(ctx, 20);
  const v = await gate.mayStart(ctx, { estimateUsd: 12, purpose: "run", subjectId: "big" }, NOW);
  check(v.ok && v.holdId !== undefined, "a hold is taken");
  const holds = await billing.liveHolds(ctx);
  check(holds[0]?.amount_usd === 5, "capped at the headroom, not the estimate");
  // Without the cap, one expensive estimate reserves the whole balance and refuses every other
  // run in the workspace — a self-inflicted outage rather than a budget.
  const second = await gate.mayStart(ctx, { estimateUsd: 12, purpose: "run", subjectId: "big2" }, NOW);
  check(second.ok, "so a second run still fits");
}

console.log("\nan unpriced estimate holds nothing rather than guessing");

{
  const ctx = await workspace("team"); // no ceiling, so the estimate would size the hold
  await billing.addCredit(ctx, 20);
  const v = await gate.mayStart(ctx, { estimateUsd: null, purpose: "run", subjectId: "unpriced" }, NOW);
  check(v.ok, "an unpriced run is not refused");
  check((await billing.liveHolds(ctx))[0]?.amount_usd === 0, "and holds nothing — a made-up hold refuses on a guess");
}

console.log("\nwhen credit runs out, the refusal says what it needs");

{
  const ctx = await workspace("team"); // no ceiling, so only credit binds
  await billing.addCredit(ctx, 1);
  const first = await gate.mayStart(ctx, { estimateUsd: 0.9, purpose: "run", subjectId: "a" }, NOW);
  check(first.ok, "the first run fits");
  const second = await gate.mayStart(ctx, { estimateUsd: 0.9, purpose: "run", subjectId: "b" }, NOW);
  const m = second.message ?? "";
  check(!second.ok, "the second does not");
  check(m.includes("$0.9000"), "the refusal says what the run needs");
  check(m.includes("$0.1000"), "and what is left");
  check(m.toLowerCase().includes("own provider key"), "and offers the way out that costs us nothing");
}

await db.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
