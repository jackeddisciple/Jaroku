// What a payment provider tells us, turned into what this system believes.
//
// TWO FACTS, KEPT APART ON PURPOSE. `subscriptions` is what Stripe believes: a status, a period
// end, an id that came from them. `workspaces.plan` is what THIS system believes, and it is what
// every limit is read from. They are not the same fact — a subscription that lapsed on Tuesday
// and a workspace still on Pro until the period ends are both true at once — and conflating them
// is how a workspace ends up on a plan it stopped paying for, or off one it is still paying for.
// This module is the only place the first is allowed to move the second.
//
// THE STATE MACHINE, and what each transition does to the plan:
//
//   incomplete  the checkout started and has not been paid. The plan does NOT move yet. A
//               workspace that abandons a card form must not spend a month on Pro for free.
//   active      paid. The plan moves up here, and this is the only transition that grants
//               anything.
//   past_due    a renewal failed and Stripe is retrying — DUNNING. The plan does NOT move
//               down. This is the transition it is most tempting to get wrong: a card that
//               expired on renewal day is the ordinary case, Stripe retries for weeks, and
//               downgrading somebody mid-retry means their agents stop while their payment is
//               still being attempted. What happens instead is that they are told.
//   canceled    the end of it, whether they cancelled or the retries ran out. NOW the plan
//               moves down, to free.
//
// EVENTS ARRIVE OUT OF ORDER, AND THAT IS NOT AN EDGE CASE. Stripe retries on its own schedule,
// so a `created` can land after the `updated` that superseded it. Every write below is keyed on
// the PROVIDER's subscription id and carries the state the event describes rather than a
// delta — so a late event overwrites with something stale, and the only defence against that
// which actually works is that the next real event corrects it. What is defended structurally is
// the thing that cannot be corrected: a plan is never moved DOWN by an event about a
// subscription that is not the workspace's live one.

import type { TenantContext } from "../db/tenant.ts";
import type { BillingRepository } from "../db/repositories/billing.ts";
import type { IdentityRepository } from "../db/repositories/identity.ts";
import { isPlanId, type PlanId } from "./plans.ts";

/** Stripe's vocabulary, narrowed to what this system acts on. */
export type SubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "canceled";

/** What a workspace's plan should be, given a subscription in this state on this plan. */
export function planForStatus(status: string, planId: PlanId): PlanId | null {
  switch (status) {
    // Paid, or in a trial the provider is honouring. Both mean "give them the plan".
    case "active":
    case "trialing":
      return planId;
    // Retrying. Deliberately null — "do not move the plan" — rather than `free`. See the header.
    case "past_due":
    case "incomplete":
      return null;
    // Over, however it got there. `unpaid` is Stripe giving up on the retries; `incomplete_expired`
    // is a checkout nobody finished. Both end at the same place.
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
      return "free";
    default:
      // A status this system has never heard of does NOT move the plan. Stripe adds states; a
      // default that downgraded would turn a vocabulary change into an outage for paying
      // customers, and a default that upgraded would give the plan away.
      return null;
  }
}

/** Whether this status is one a person needs to be told about. Dunning is the whole list. */
export function needsAttention(status: string): boolean {
  return status === "past_due" || status === "unpaid" || status === "incomplete";
}

export interface SubscriptionUpdate {
  planId: string;
  status: string;
  externalSubscriptionId: string;
  externalCustomerId?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
}

export interface ApplyResult {
  /** What the workspace's plan is now. */
  plan: string;
  /** True when this event moved it. */
  planChanged: boolean;
  /** True when somebody should be told — a failed renewal, an unfinished checkout. */
  attention: boolean;
}

/**
 * Record what the provider says, and move the plan if — and only if — that state warrants it.
 *
 * ONE TRANSACTION IS NOT ENOUGH HERE AND IS NOT USED. The subscription row and the workspace's
 * plan are written separately, deliberately: `workspaces` carries no RLS policy (it is the table
 * every policy points AT) while `subscriptions` does, so the two writes have different scoping
 * requirements. What matters is the ORDER — the evidence is written before the conclusion drawn
 * from it, so a crash in between leaves a subscription row somebody can reconcile from, rather
 * than a plan nothing explains.
 */
export async function applySubscription(
  ctx: TenantContext,
  billing: BillingRepository,
  identity: IdentityRepository,
  update: SubscriptionUpdate,
): Promise<ApplyResult> {
  const planId: PlanId = isPlanId(update.planId) ? update.planId : "free";
  await billing.upsertSubscription(ctx, { ...update, planId });

  const workspace = await identity.workspaceById(ctx, ctx.workspaceId);
  const current = workspace?.plan ?? "free";
  const target = planForStatus(update.status, planId);

  if (target === null || target === current) {
    return { plan: current, planChanged: false, attention: needsAttention(update.status) };
  }
  await identity.setWorkspacePlan(ctx, target);
  return { plan: target, planChanged: true, attention: needsAttention(update.status) };
}
