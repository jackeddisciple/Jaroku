// May this workspace start this run?
//
// The one place that answers, so that "am I allowed to spend" is a decision made in a file
// somebody can read rather than a condition repeated at four call sites. The same reasoning as
// `requireCapability`: scattered checks are how you get a hole, and the hole is always in the
// call site nobody thought about.
//
// TWO CHECKS, AND THEY ARE NOT THE SAME QUESTION.
//
//   THE CEILING asks "has this workspace already spent more than it is allowed to this
//   period". It applies to every workspace on every plan, including one paying for its own
//   tokens with its own key — a spend cap somebody set is a cap they want honoured whoever the
//   money belongs to.
//
//   THE RESERVATION asks "is there platform credit to cover this". It applies only when there
//   is platform credit at stake. A workspace with no balance is not spending our money, so
//   there is nothing to hold and nothing to refuse — which is exactly the enforced default
//   (BYOK), and is also why `npm run dev` needs no billing configuration to run an agent.
//
// THE CEILING BOUNDS WHAT IS STARTED, NOT WHAT IS SPENT, and that is deliberate rather than
// unfinished. A workspace under its ceiling may start a run that takes it over; a run already
// going runs to completion. Stopping mid-graph would spend the money and throw away the
// result, and the eval budget has worked exactly this way since the eval engine landed. The
// consequence is stated rather than hidden: the final total can exceed the ceiling by at most
// the cost of what was already in flight.
//
// A REFUSAL SAYS WHAT WOULD CLEAR IT. "Budget exceeded" sends somebody to a dashboard to work
// out what happened; naming the figure, the limit, and the two things that would change it
// means the message is the answer. Every string this file produces is written to be read by
// the person who pressed the button.

import type { TenantContext } from "../db/tenant.ts";
import type { BillingRepository } from "../db/repositories/billing.ts";
import type { IdentityRepository } from "../db/repositories/identity.ts";
import { limitsFor, type PlanLimits } from "./plans.ts";
import { Balances, type ReserveRequest } from "./balances.ts";
import { round8 } from "../pricing.ts";

/**
 * When the current billing period began, and when it ends.
 *
 * THE CALENDAR MONTH, IN UTC, and stated rather than derived from a subscription's anniversary.
 * A period that moved with each workspace's signup date would mean two workspaces looking at
 * "this month's spend" are looking at different windows, and a support conversation about a
 * figure starts by working out which. A subscription's own period is what a payment provider
 * invoices against; this is what the ceiling counts, and keeping them separate is why
 * `subscriptions.current_period_end` exists as its own column.
 */
export function billingPeriod(now: Date = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/** A calendar date, for a message a person reads. Never a timestamp — nobody needs the ms. */
function asDate(iso: string): string {
  return iso.slice(0, 10);
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export interface GateDecision {
  ok: boolean;
  /** Set when a reservation was taken, so the caller knows there is something to release. */
  holdId?: string;
  /** Why not, written for the person who pressed the button. Absent when `ok`. */
  message?: string;
}

/** What the dashboard renders and what a refusal is built from. One shape, one computation. */
export interface BudgetStatus {
  plan: PlanLimits;
  periodStart: string;
  periodEnd: string;
  /** Spend this period, from usage_events. A FLOOR when `costKnown` is false. */
  spentUsd: number;
  costKnown: boolean;
  /** The effective ceiling: the workspace's own, else the plan's. Null means none. */
  ceilingUsd: number | null;
  /** Ceiling minus spend, or null when there is no ceiling. Never negative. */
  headroomUsd: number | null;
  /** Whether a run started right now would be refused by the ceiling. */
  overCeiling: boolean;
  balanceUsd: number;
  reservedUsd: number;
  availableUsd: number;
}

export class BudgetGate {
  constructor(
    private billing: BillingRepository,
    private balances: Balances,
    private identity: IdentityRepository,
  ) {}

  /**
   * Everything a decision or a dashboard needs, computed once.
   *
   * The refusal messages below are built from this rather than from their own queries, so the
   * number a user is refused against and the number the dashboard shows them cannot differ —
   * which is the failure mode that makes a budget feature untrustworthy even when it is right.
   */
  async status(ctx: TenantContext, now: Date = new Date()): Promise<BudgetStatus> {
    const period = billingPeriod(now);
    const balance = await this.billing.balance(ctx);
    const workspace = await this.identity.workspaceById(ctx, ctx.workspaceId);
    const plan = limitsFor(workspace?.plan, balance.limit_overrides);
    const spend = await this.billing.spendSince(ctx, period.start);
    // The workspace's own ceiling wins when set — including 0, which is what an abuse response
    // sets and which `??` would correctly keep but `||` would silently discard.
    const ceiling = balance.ceiling_usd ?? plan.budgetCeilingUsd;
    return {
      plan,
      periodStart: period.start,
      periodEnd: period.end,
      spentUsd: round8(spend.usd),
      costKnown: spend.costKnown,
      ceilingUsd: ceiling,
      headroomUsd: ceiling === null ? null : round8(Math.max(0, ceiling - spend.usd)),
      overCeiling: ceiling !== null && spend.usd >= ceiling,
      balanceUsd: round8(balance.balance_usd),
      reservedUsd: round8(balance.reserved_usd),
      availableUsd: round8(Math.max(0, balance.balance_usd - balance.reserved_usd)),
    };
  }

  /**
   * Decide, and take a hold if one is warranted.
   *
   * `estimateUsd` is what the run is expected to cost. It is a projection and is treated as
   * one — it sizes the hold and nothing else. It is deliberately NOT added to the period's
   * spend before checking the ceiling, because that would make the ceiling bound what is spent
   * rather than what is started, which is a different rule with different behaviour at the
   * boundary and is not the one this system has.
   *
   * `estimateUsd: null` means unpriced — an agent on a model with no pricing entry. The hold is
   * then zero, because holding a made-up number against somebody's balance is worse than
   * holding nothing: it refuses runs on the strength of a guess. The ceiling still applies, and
   * so does the settle at the end, which is where a real figure eventually arrives.
   */
  async mayStart(
    ctx: TenantContext,
    req: { estimateUsd: number | null; purpose: ReserveRequest["purpose"]; subjectId?: string | null },
    now: Date = new Date(),
  ): Promise<GateDecision> {
    const s = await this.status(ctx, now);

    if (s.overCeiling) return { ok: false, message: ceilingRefusal(s) };

    // Nothing to hold against. A workspace with no platform credit is not spending platform
    // money — the BYOK default, and the local path. The ceiling above still applied.
    if (s.balanceUsd <= 0) return { ok: true };

    const hold = await this.balances.reserve(ctx, {
      amountUsd: s.ceilingUsd === null
        ? (req.estimateUsd ?? 0)
        // Never hold more than the ceiling would have let through anyway. Without this a single
        // expensive estimate could reserve a whole balance and refuse every other run in the
        // workspace, which is a self-inflicted outage rather than a budget.
        : Math.min(req.estimateUsd ?? 0, s.headroomUsd ?? 0),
      purpose: req.purpose,
      subjectId: req.subjectId ?? null,
    });
    if (!hold.ok) return { ok: false, message: creditRefusal(req.estimateUsd, hold.available) };
    return { ok: true, holdId: hold.holdId };
  }
}

/** The ceiling message. Names the figure, the limit, the window, and both ways out. */
export function ceilingRefusal(s: BudgetStatus): string {
  const spent = s.costKnown ? usd(s.spentUsd) : `at least ${usd(s.spentUsd)}`;
  return (
    `this workspace has spent ${spent} of its ${usd(s.ceilingUsd ?? 0)} ceiling ` +
    `since ${asDate(s.periodStart)} — the ${s.plan.label} plan's limit on what may be started. ` +
    `It resets on ${asDate(s.periodEnd)}; an owner can raise it before then in Billing.` +
    // Said only when it is true. A total that is a floor is a total somebody may reasonably
    // dispute, and they should hear it from us rather than work it out from the itemisation.
    (s.costKnown ? "" : " Some usage could not be priced, so the figure above is a floor.")
  );
}

/** The credit message. Same discipline: the number, the shortfall, and what would change it. */
export function creditRefusal(estimateUsd: number | null, availableUsd: number): string {
  const need = estimateUsd === null ? "an unknown amount" : `about ${usd(estimateUsd)}`;
  return (
    `this run needs ${need} and this workspace has ${usd(availableUsd)} of credit left. ` +
    `Add credit, or connect your own provider key so the run bills to your account instead.`
  );
}
