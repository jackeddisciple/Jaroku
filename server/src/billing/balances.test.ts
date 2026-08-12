// Ten runs, one balance, and no overdraft.
//
// The suite exists for one assertion and everything else is scaffolding around it: N
// simultaneous reservations against a balance that only covers some of them admit exactly as
// many as it covers, and no more. That is the whole reason a hold exists rather than a check —
// "read the balance, decide, spend" passes every sequential test ever written and overdraws the
// moment two requests overlap, which hosted they always do.
//
// The rest is the arithmetic that has to be right for the first assertion to mean anything:
// releasing frees what was held, settling deducts what was used, the two are different numbers,
// and a double release does not credit twice.
//
//   npm run test:balances

import { randomUUID } from "node:crypto";
import { openTestSqlite, testContext } from "../db/testDb.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { newRequestId, systemContext, systemContextFor } from "../db/tenant.ts";
import type { Db } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";
import { Balances } from "./balances.ts";

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

/** A workspace of its own per scenario, so one test's leftovers cannot fund another's. */
async function fundedWorkspace(usd: number): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `balance ${randomUUID().slice(0, 8)}`,
  });
  const ctx = systemContextFor(ws.id, newRequestId());
  if (usd > 0) await billing.addCredit(ctx, usd);
  return ctx;
}

console.log("\na balance starts empty and is created on demand");

{
  const ctx = await fundedWorkspace(0);
  const b = await billing.balance(ctx);
  check(b.balance_usd === 0 && b.reserved_usd === 0, "a workspace with no history has an empty balance");
  check(b.ceiling_usd === null, "and no ceiling of its own — null means 'whatever the plan says'");
  check((await balances.available(ctx)) === 0, "nothing available");
}

console.log("\na hold claims and a release frees");

{
  const ctx = await fundedWorkspace(10);
  check((await balances.available(ctx)) === 10, "credit is available before anything holds it");

  const r = await balances.reserve(ctx, { amountUsd: 4, purpose: "run", subjectId: "run-1" });
  check(r.ok, "a hold within the balance is granted");
  check(r.ok && r.available === 6, "and the available figure drops by exactly what was held");
  check((await billing.balance(ctx)).balance_usd === 10, "the balance itself has not moved — nothing is spent yet");
  check((await billing.liveHolds(ctx)).length === 1, "the hold is a row, so something can find it later");

  if (r.ok) {
    // The point of two movements: this run was estimated at $4 and cost $1.
    const out = await balances.release(ctx, r.holdId, { settleUsd: 1 });
    check(out.released && out.settledUsd === 1, "release settles what was actually used");
    const after = await billing.balance(ctx);
    check(after.reserved_usd === 0, "the hold is given back in full");
    check(after.balance_usd === 9, "and only the real cost leaves the balance, not the estimate");
    check((await balances.available(ctx)) === 9, "so the workspace has its unspent estimate back");
    check((await billing.liveHolds(ctx)).length === 0, "and no hold is left standing");
  }
}

console.log("\nten simultaneous runs cannot overdraw");

{
  // $10 of credit, ten runs each wanting $3. Three fit. The point is that all ten ask at once:
  // every one of them reads the same balance before any of them has written to it, which is
  // exactly the state a sequential test can never reach and a hosted deployment is always in.
  const ctx = await fundedWorkspace(10);
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      balances.reserve(ctx, { amountUsd: 3, purpose: "run", subjectId: `run-${i}` }),
    ),
  );
  const granted = results.filter((r) => r.ok);
  const refused = results.filter((r) => !r.ok);
  check(granted.length === 3, `exactly three of ten were granted (got ${granted.length})`);
  check(refused.length === 7, "and the other seven were refused rather than queued or thrown");

  const after = await billing.balance(ctx);
  check(after.reserved_usd === 9, "nine dollars are reserved, not thirty");
  check(after.reserved_usd <= after.balance_usd, "reserved never exceeds the balance — the overdraft the hold exists to prevent");
  check((await balances.available(ctx)) === 1, "one dollar is left, which is what did not fit a fourth run");
  check((await billing.liveHolds(ctx)).length === 3, "three hold rows, one per granted run");

  const first = refused[0];
  check(
    !first?.ok && first?.reason === "insufficient" && first.requested === 3,
    "a refusal names what was asked for",
  );
  check(!first?.ok && typeof first?.available === "number", "and what was available, so a message can say what would clear it");
}

console.log("\nreserving nothing is not a refusal");

{
  const ctx = await fundedWorkspace(0);
  const r = await balances.reserve(ctx, { amountUsd: 0, purpose: "run", subjectId: "free-run" });
  check(r.ok, "a free run reserves zero and is granted, even with no credit at all");
  check((await billing.liveHolds(ctx)).length === 1, "and still writes a hold");
  // The reason it matters: the caller's release path is the same shape either way, so nobody
  // has to remember whether they took a hold before giving one back.
  if (r.ok) check((await balances.release(ctx, r.holdId)).released, "which releases like any other");
}

console.log("\nsettling more than was held is allowed, and deducted in full");

{
  // The ceiling bounds what is STARTED, not what is spent. A run already going runs to
  // completion, so its cost can exceed its estimate — and the platform must not eat that.
  const ctx = await fundedWorkspace(10);
  const r = await balances.reserve(ctx, { amountUsd: 2, purpose: "run", subjectId: "run-x" });
  if (r.ok) {
    await balances.release(ctx, r.holdId, { settleUsd: 5 });
    const after = await billing.balance(ctx);
    check(after.balance_usd === 5, "the real cost comes out of the balance, not the estimate");
    check(after.reserved_usd === 0, "and the hold is still fully released");
  }
}

console.log("\na second release does not credit twice");

{
  const ctx = await fundedWorkspace(10);
  const r = await balances.reserve(ctx, { amountUsd: 6, purpose: "run", subjectId: "run-y" });
  if (r.ok) {
    const first = await balances.release(ctx, r.holdId, { settleUsd: 2 });
    const second = await balances.release(ctx, r.holdId, { settleUsd: 2 });
    check(first.released, "the first release moves the money");
    check(!second.released && second.settledUsd === 0, "the second is a no-op and says so");
    check((await billing.balance(ctx)).balance_usd === 8, "so the run is charged once, not twice");

    // Not hypothetical: a run that ends normally releases its own hold at the same moment a
    // sweeper may have decided the lease lapsed. Whichever arrives first is the one that moves
    // money; the other has to be harmless.
    const r2 = await balances.reserve(ctx, { amountUsd: 3, purpose: "run", subjectId: "run-z" });
    if (r2.ok) {
      const both = await Promise.all([
        balances.release(ctx, r2.holdId, { settleUsd: 1 }),
        balances.release(ctx, r2.holdId, { settleUsd: 1 }),
      ]);
      check(both.filter((x) => x.released).length === 1, "two releases racing each other settle exactly once");
      check((await billing.balance(ctx)).balance_usd === 7, "and the balance moved by one dollar, not two");
    }
  }
}

console.log("\nthe sweeper reclaims what nobody released");

{
  const ctx = await fundedWorkspace(10);
  const alive = await balances.reserve(ctx, { amountUsd: 2, purpose: "run", subjectId: "still-going" });
  const dead = await balances.reserve(ctx, {
    amountUsd: 5, purpose: "run", subjectId: "worker-died", ttlMs: -1,
  });
  check(alive.ok && dead.ok, "two holds, one of which has already lapsed");
  check((await billing.balance(ctx)).reserved_usd === 7, "both are reserved to begin with");

  const reclaimed = await balances.sweepExpired(ctx);
  check(reclaimed === 1, "the sweeper reclaims exactly the lapsed one");
  const after = await billing.balance(ctx);
  check(after.reserved_usd === 2, "the live hold is untouched");
  check(after.balance_usd === 10, "and a swept hold settles NOTHING — what was really spent is in usage_events");
  check((await balances.sweepExpired(ctx)) === 0, "sweeping again finds nothing to reclaim");
}

console.log("\na ceiling of zero is a workspace that may start nothing");

{
  const ctx = await fundedWorkspace(10);
  await billing.setCeiling(ctx, 0);
  const b = await billing.balance(ctx);
  check(b.ceiling_usd === 0, "0 is stored, and is not the same as null");
  await billing.setCeiling(ctx, null);
  check((await billing.balance(ctx)).ceiling_usd === null, "and can be cleared back to the plan's");
}

console.log("\nholds are the workspace's own");

{
  // The same assertion tenancy.test.ts makes, repeated here because this is the module that
  // moves money: a hold id from another workspace must release nothing.
  const a = await fundedWorkspace(10);
  const b = await fundedWorkspace(10);
  const theirs = await balances.reserve(b, { amountUsd: 4, purpose: "run", subjectId: "theirs" });
  if (theirs.ok) {
    const stolen = await balances.release(a, theirs.holdId, { settleUsd: 4 });
    check(!stolen.released, "another workspace's hold id releases nothing");
    check((await billing.balance(b)).reserved_usd === 4, "and their reservation still stands");
    check((await billing.balance(b)).balance_usd === 10, "with their balance untouched");
  }
}

await (db as Db).close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
