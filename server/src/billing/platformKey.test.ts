// Lending the platform's key, and the three things that take it back.
//
// This is the only path in the system where the platform's money is spent by somebody else's
// decision, so the suite is written around the ways that goes wrong rather than the way it goes
// right: a kill switch that only recognises one spelling, a ceiling that counts a workspace's
// own spending against it, and a plan gate that reports a limit to somebody who is not near one.
//
//   npm run test:platform-key

import { randomUUID } from "node:crypto";
import { openTestSqlite } from "../db/testDb.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { PlatformKeyGate, platformKeyEnabled } from "./platformKey.ts";
import { billingPeriod } from "./gate.ts";
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
const identity = new IdentityRepository(db);
const gate = new PlatformKeyGate(billing, identity);
const PERIOD = billingPeriod().start;

async function workspace(plan = "free"): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `platformkey ${randomUUID().slice(0, 8)}`,
  });
  const ctx = systemContextFor(ws.id, newRequestId());
  if (plan !== "free") await db.run(`UPDATE workspaces SET plan = ? WHERE id = ?`, [plan, ws.id]);
  return ctx;
}

async function spend(ctx: TenantContext, usd: number, payer: "platform" | "workspace"): Promise<void> {
  await billing.record(ctx, {
    kind: "llm.provider",
    idempotencyKey: `pk-${randomUUID()}`,
    runId: randomUUID(),
    costUsd: usd,
    payer,
  });
}

console.log("\nthe kill switch answers to more than one spelling");

{
  const before = process.env.JAROKU_PLATFORM_KEY;
  check(platformKeyEnabled({}), "unset means on — a deployment that never heard of it works");
  for (const off of ["off", "0", "false", "no", "OFF", " Off "]) {
    check(!platformKeyEnabled({ JAROKU_PLATFORM_KEY: off }), `"${off}" turns it off`);
  }
  for (const on of ["on", "1", "true", "yes"]) {
    check(platformKeyEnabled({ JAROKU_PLATFORM_KEY: on }), `"${on}" leaves it on`);
  }
  if (before === undefined) delete process.env.JAROKU_PLATFORM_KEY;
  else process.env.JAROKU_PLATFORM_KEY = before;
}

console.log("\nthe switch is read when asked, not at import");

{
  const ctx = await workspace();
  check((await gate.mayUsePlatformKey(ctx, PERIOD)).allowed, "allowed to begin with");
  process.env.JAROKU_PLATFORM_KEY = "off";
  const killed = await gate.mayUsePlatformKey(ctx, PERIOD);
  check(!killed.allowed, "and refused the moment the switch is flipped, with no restart");
  check(!killed.allowed && killed.reason === "killed", "for the reason that names the switch");
  check(
    !killed.allowed && !killed.message.toLowerCase().includes("budget") && !killed.message.includes("limit"),
    "and the message does not accuse the workspace of being over a limit it is not over",
  );
  check(
    !killed.allowed && killed.message.includes("connect your own"),
    "it offers the one thing that would keep them going",
  );
  delete process.env.JAROKU_PLATFORM_KEY;
  check((await gate.mayUsePlatformKey(ctx, PERIOD)).allowed, "and unflipping it works too");
}

console.log("\nthe ceiling counts what WE paid, and only that");

{
  const ctx = await workspace(); // free: platformKeyCeilingUsd = 2
  check(PLANS.free.platformKeyCeilingUsd === 2, "the free plan's exposure is the small number");

  // Ten dollars of the workspace's OWN spending. Not ours, and it must not count.
  await spend(ctx, 10, "workspace");
  const stillFine = await gate.mayUsePlatformKey(ctx, PERIOD);
  check(stillFine.allowed, "a workspace that spent ten dollars of its own money is not throttled");
  check(stillFine.allowed && stillFine.spentUsd === 0, "because none of it was ours");

  await spend(ctx, 1.5, "platform");
  check((await gate.mayUsePlatformKey(ctx, PERIOD)).allowed, "still under the ceiling at $1.50 of ours");

  await spend(ctx, 0.6, "platform");
  const over = await gate.mayUsePlatformKey(ctx, PERIOD);
  check(!over.allowed, "and over it at $2.10");
  check(!over.allowed && over.reason === "ceiling", "for the ceiling reason");
  check(!over.allowed && over.message.includes("$2.0000"), "naming the ceiling");
  check(!over.allowed && over.message.includes("2.1000"), "and what has been used against it");
  check(
    !over.allowed && over.message.toLowerCase().includes("connect your own key"),
    "and offering the way out that costs us nothing",
  );
}

console.log("\nthe platform ceiling and the budget ceiling are different numbers");

{
  // The whole reason they are two fields. A workspace can sit on one and be nowhere near the
  // other, in either direction, and a single number would make each mean the other's thing.
  check(
    PLANS.free.platformKeyCeilingUsd! < PLANS.free.budgetCeilingUsd!,
    "our money is the tighter constraint on the free plan",
  );
  check(
    PLANS.pro.platformKeyCeilingUsd! < PLANS.pro.budgetCeilingUsd!,
    "and on pro",
  );
  check(
    PLANS.scale.budgetCeilingUsd === null && PLANS.scale.platformKeyCeilingUsd !== null,
    "scale declines to guess about the customer's own money and still caps ours — there is no unlimited version of that",
  );

  const ctx = await workspace("pro");
  await spend(ctx, 60, "platform"); // over pro's $50 platform ceiling, well under its $200 budget
  const verdict = await gate.mayUsePlatformKey(ctx, PERIOD);
  check(!verdict.allowed, "a workspace over the platform ceiling is refused the platform key");
  check(
    !verdict.allowed && verdict.reason === "ceiling",
    "...while its budget ceiling, which bounds what it may START whoever pays, is untouched",
  );
}

console.log("\na plan without the feature says so rather than reporting a limit");

{
  const ctx = await workspace();
  // The negotiated case: a workspace moved off the platform key by agreement.
  await billing.setLimitOverrides(ctx, { features: { platformKey: false } });
  const verdict = await gate.mayUsePlatformKey(ctx, PERIOD);
  check(!verdict.allowed && verdict.reason === "plan", "refused for the plan reason");
  check(
    !verdict.allowed && !verdict.message.includes("$"),
    "with no figure in it — there is no limit here to be over, only an arrangement",
  );
  check(!verdict.allowed && verdict.message.includes("your own provider key"), "and it names the arrangement");
}

console.log("\nan unpriced platform-paid row makes the figure a floor");

{
  const ctx = await workspace();
  await billing.record(ctx, {
    kind: "llm.provider", idempotencyKey: `pk-${randomUUID()}`, costUsd: null, payer: "platform",
  });
  await spend(ctx, 2.5, "platform");
  const verdict = await gate.mayUsePlatformKey(ctx, PERIOD);
  check(!verdict.allowed, "over the ceiling on the known rows alone");
  check(!verdict.allowed && verdict.message.includes("at least"), "and the message says the figure is a floor");
}

console.log("\nthe rollup separates the two payers cleanly");

{
  const ctx = await workspace();
  await spend(ctx, 3, "workspace");
  await spend(ctx, 1, "platform");
  const ours = await billing.platformSpendSince(ctx, PERIOD);
  const all = await billing.spendSince(ctx, PERIOD);
  check(ours.usd === 1, "what we paid is what we paid");
  check(all.usd === 4, "the whole is still the whole");
  check(all.usd - ours.usd === 3, "and the difference is exactly what the workspace paid for itself");
}

await db.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
