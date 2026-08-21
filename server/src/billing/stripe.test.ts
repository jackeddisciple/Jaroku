// The signature, the state machine, and the two ways a webhook goes wrong twice.
//
// This endpoint is public and unauthenticated by construction — a payment provider cannot
// present a bearer token — so the HMAC is the only thing standing between "Stripe says this
// workspace paid" and "anybody who can reach the URL says this workspace paid". Most of this
// suite is about that one sentence.
//
// The rest is the state machine, and specifically the transition it is most tempting to get
// wrong: a failed renewal does NOT downgrade. A card that expired on renewal day is the ordinary
// case, the provider retries for weeks, and stopping somebody's agents while their payment is
// still being attempted is a worse outcome than a fortnight of unpaid Pro.
//
//   npm run test:stripe

import { randomUUID } from "node:crypto";
import { openTestSqlite } from "../db/testDb.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import {
  SIGNATURE_TOLERANCE_S, paymentsConfigured, stripeSignatureHeader, verifyStripeSignature,
} from "./stripe.ts";
import { applySubscription, needsAttention, planForStatus } from "./subscriptions.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const SECRET = "whsec_test_0123456789abcdef";
const BODY = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", data: { object: {} } });

console.log("\nthe signature is the authentication");

{
  const now = Date.now();
  const header = stripeSignatureHeader(BODY, SECRET, now);
  check(verifyStripeSignature(BODY, header, SECRET, now).ok, "a genuine signature verifies");

  check(
    !verifyStripeSignature(BODY + " ", header, SECRET, now).ok,
    "one extra byte in the body fails — which is why the RAW body is what gets checked",
  );
  check(
    !verifyStripeSignature(BODY, header, "whsec_a_different_secret", now).ok,
    "the wrong secret fails",
  );
  check(
    !verifyStripeSignature(BODY, undefined, SECRET, now).ok,
    "no signature at all fails, rather than being treated as nothing to check",
  );
  check(
    verifyStripeSignature(BODY, header, undefined, now).ok === false,
    "and a deployment with no webhook secret verifies nothing rather than everything",
  );
  const unconfigured = verifyStripeSignature(BODY, header, undefined, now);
  check(!unconfigured.ok && unconfigured.reason === "unconfigured", "...and says which of the two it was");
}

console.log("\nreplay is bounded by the timestamp being inside the MAC");

{
  const now = Date.now();
  // A signature stays validly signed forever. Without a tolerance a single captured
  // `invoice.paid` could be replayed a year later and would verify perfectly.
  const old = stripeSignatureHeader(BODY, SECRET, now - (SIGNATURE_TOLERANCE_S + 60) * 1000);
  const verdict = verifyStripeSignature(BODY, old, SECRET, now);
  check(!verdict.ok, "a payload older than the tolerance is refused");
  check(!verdict.ok && verdict.reason === "stale", "for being stale rather than for being wrong");

  const justInside = stripeSignatureHeader(BODY, SECRET, now - (SIGNATURE_TOLERANCE_S - 30) * 1000);
  check(verifyStripeSignature(BODY, justInside, SECRET, now).ok, "one just inside it is fine");

  // Moving a valid signature onto a fresh timestamp: the timestamp is part of what is signed,
  // so this is exactly what the MAC covering `<t>.<body>` prevents.
  const mac = old.split("v1=")[1];
  const forged = `t=${Math.floor(now / 1000)},v1=${mac}`;
  check(!verifyStripeSignature(BODY, forged, SECRET, now).ok, "and an old MAC on a new timestamp does not verify");
}

console.log("\na rotation signs with two secrets, and both have to pass");

{
  const now = Date.now();
  const t = Math.floor(now / 1000);
  const good = stripeSignatureHeader(BODY, SECRET, now).split("v1=")[1];
  // What a real rotation looks like: several v1 values, only one of which is ours. A verifier
  // that read only the first would fail every request for half the rotation.
  const header = `t=${t},v1=deadbeef,v1=${good},v1=c0ffee`;
  check(verifyStripeSignature(BODY, header, SECRET, now).ok, "any matching candidate is a pass");
  check(
    !verifyStripeSignature(BODY, `t=${t},v1=deadbeef,v1=c0ffee`, SECRET, now).ok,
    "and none matching is still a refusal",
  );
}

console.log("\nmalformed headers are refused rather than parsed optimistically");

{
  const now = Date.now();
  for (const header of ["", "nonsense", "t=abc,v1=deadbeef", `t=${Math.floor(now / 1000)}`, "v1=deadbeef"]) {
    check(!verifyStripeSignature(BODY, header, SECRET, now).ok, `"${header.slice(0, 24)}" is refused`);
  }
}

console.log("\npayments are off until both halves are configured");

{
  check(!paymentsConfigured({}), "nothing configured means no payments");
  check(!paymentsConfigured({ secretKey: "sk_test" }), "a secret key alone is not enough");
  check(!paymentsConfigured({ webhookSecret: "whsec" }), "nor a webhook secret alone — an unverifiable webhook is worse than none");
  check(paymentsConfigured({ secretKey: "sk_test", webhookSecret: "whsec" }), "both, and it is on");
}

console.log("\nthe state machine, and the transition it is tempting to get wrong");

{
  check(planForStatus("active", "pro") === "pro", "active grants the plan");
  check(planForStatus("trialing", "pro") === "pro", "so does a trial the provider is honouring");
  check(
    planForStatus("incomplete", "pro") === null,
    "an unfinished checkout grants nothing — a workspace that abandons a card form must not get a free month",
  );
  check(
    planForStatus("past_due", "pro") === null,
    "a failed renewal does NOT downgrade — the retries run for weeks and stopping their agents mid-retry is the worse outcome",
  );
  check(planForStatus("canceled", "pro") === "free", "a cancellation does");
  check(planForStatus("unpaid", "pro") === "free", "and so does the provider giving up on the retries");
  check(planForStatus("incomplete_expired", "pro") === "free", "as does a checkout nobody finished");
  check(
    planForStatus("some_state_stripe_invented_last_tuesday", "pro") === null,
    "a status nothing recognises moves nothing — a vocabulary change must not become an outage or a giveaway",
  );

  check(needsAttention("past_due") && needsAttention("unpaid") && needsAttention("incomplete"), "dunning is the whole list");
  check(!needsAttention("active"), "and a paid subscription is not on it");
}

console.log("\napplying an event moves the plan, and only when it should");

const db = await openTestSqlite();
const billing = new BillingRepository(db);
const identity = new IdentityRepository(db);

async function workspace(): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `stripe ${randomUUID().slice(0, 8)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

{
  const ctx = await workspace();
  const sub = `sub_${randomUUID()}`;
  check((await identity.workspaceById(ctx, ctx.workspaceId))?.plan === "free", "a new workspace is free");

  let r = await applySubscription(ctx, billing, identity, {
    planId: "pro", status: "incomplete", externalSubscriptionId: sub, externalCustomerId: "cus_1",
  });
  check(!r.planChanged && r.plan === "free", "a started checkout does not move the plan");
  check(r.attention, "but it is something to tell somebody about");
  check((await billing.liveSubscription(ctx))?.status === "incomplete", "and the evidence is recorded");

  r = await applySubscription(ctx, billing, identity, {
    planId: "pro", status: "active", externalSubscriptionId: sub, currentPeriodEnd: "2026-09-01T00:00:00.000Z",
  });
  check(r.planChanged && r.plan === "pro", "the payment settling is what grants it");
  check((await identity.workspaceById(ctx, ctx.workspaceId))?.plan === "pro", "and the workspace is on pro");

  r = await applySubscription(ctx, billing, identity, {
    planId: "pro", status: "past_due", externalSubscriptionId: sub,
  });
  check(!r.planChanged && r.plan === "pro", "a failed renewal leaves them on pro");
  check(r.attention, "and flags it for a person");
  check((await billing.liveSubscription(ctx))?.status === "past_due", "while the subscription records the truth");

  // WHAT AN INVOICE EVENT KNOWS, WHICH IS THE STATUS AND NOTHING ELSE. `invoice.payment_failed`
  // carries no plan — `metadata.plan_id` is set on the checkout session and on the subscription,
  // never on an invoice — so reading one defaulted it to `free` and wrote that over the paid plan
  // the workspace was still on, nulling the period end and resetting the cancellation flag with it.
  await billing.upsertSubscription(ctx, { status: "past_due", externalSubscriptionId: sub });
  const patched = await billing.liveSubscription(ctx);
  check(patched?.status === "past_due", "an invoice event patches the status");
  check(patched?.plan_id === "pro", "...and leaves the plan it does not know about alone");
  check(
    patched?.current_period_end === "2026-09-01T00:00:00.000Z",
    "...and the period end it does not carry",
  );

  r = await applySubscription(ctx, billing, identity, {
    planId: "pro", status: "canceled", externalSubscriptionId: sub,
  });
  check(r.planChanged && r.plan === "free", "the end of the retries is what downgrades");
  check((await billing.liveSubscription(ctx)) === undefined, "and there is no live subscription left");
  check((await billing.subscriptions(ctx)).length === 1, "though the cancelled one is kept as evidence");

  const audit = await identity.listAudit(ctx);
  check(
    audit.filter((a) => a.action === "workspace.plan_changed").length === 2,
    "both plan moves left an audit row — 'why am I on the free plan' is asked weeks later",
  );
}

console.log("\na plan change mid-cycle is an update, not a second subscription");

{
  const ctx = await workspace();
  const sub = `sub_${randomUUID()}`;
  await applySubscription(ctx, billing, identity, { planId: "pro", status: "active", externalSubscriptionId: sub });
  await applySubscription(ctx, billing, identity, { planId: "team", status: "active", externalSubscriptionId: sub });
  check((await identity.workspaceById(ctx, ctx.workspaceId))?.plan === "team", "the plan follows");
  check((await billing.subscriptions(ctx)).length === 1, "on the same subscription row, keyed by the provider's id");
}

console.log("\nan event is claimed once, whatever arrives");

{
  check(await billing.claimWebhookEvent("evt_dupe", "customer.subscription.updated"), "the first delivery claims it");
  check(!(await billing.claimWebhookEvent("evt_dupe", "customer.subscription.updated")), "a redelivery does not");
  check((await billing.unprocessedWebhookEvents()).some((e) => e.id === "evt_dupe"), "and it is unprocessed until something finishes it");

  await billing.finishWebhookEvent("evt_dupe", null, "ignored");
  check(!(await billing.unprocessedWebhookEvents()).some((e) => e.id === "evt_dupe"), "finishing takes it off the replay queue");

  // Two claims racing. The primary key is the only thing that can arbitrate, which is why this
  // is an INSERT rather than a check followed by one.
  const both = await Promise.all([
    billing.claimWebhookEvent("evt_race", "invoice.paid"),
    billing.claimWebhookEvent("evt_race", "invoice.paid"),
  ]);
  check(both.filter(Boolean).length === 1, "exactly one of two simultaneous claims wins");
}

await db.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
