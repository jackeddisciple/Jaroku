// The two HTTP surfaces billing needs, and why neither could be a WebSocket command.
//
//   POST /v1/billing/checkout — authenticated, and answers with a URL the browser must NAVIGATE
//   to. A socket could have carried the request, but the answer is a redirect target for a
//   third-party payment form, and putting it on the same channel as trace events would mean the
//   client has to hold "am I mid-checkout" across a reconnect.
//
//   POST /v1/billing/webhook — unauthenticated by construction. Stripe cannot present a bearer
//   token and has no socket. THE SIGNATURE IS THE AUTHENTICATION, and it is checked over the raw
//   bytes before anything parses them.
//
// THE RAW BODY IS THE WHOLE POINT OF THE SECOND ROUTE. A signature is over the bytes that were
// sent, and `JSON.parse` followed by `JSON.stringify` does not reproduce them — key order,
// number formatting and whitespace are all free to differ, and a verifier fed a re-serialised
// body fails on payloads that are perfectly genuine. So it reads `request.buffer()` and hands
// the string to the verifier, and parses only after it has passed.

import { badRequest, unauthorized, type Handler } from "./router.ts";
import type { HttpRequest, HttpResponse } from "./router.ts";
import type { TenantContext } from "../db/tenant.ts";
import { newRequestId, systemContextFor } from "../db/tenant.ts";
import type { BillingRepository } from "../db/repositories/billing.ts";
import type { IdentityRepository } from "../db/repositories/identity.ts";
import { applySubscription } from "../billing/subscriptions.ts";
import {
  createCheckoutSession, paymentsConfigured, verifyStripeSignature, type StripeConfig,
} from "../billing/stripe.ts";
import { isPlanId } from "../billing/plans.ts";

export interface BillingRoutesDeps {
  billing: BillingRepository;
  identity: IdentityRepository;
  config: () => StripeConfig;
  /** Resolve the asking request to a workspace, exactly as every other authenticated route does. */
  contextFor: (req: HttpRequest) => Promise<TenantContext>;
  /** Whose email prefills the payment form, when we know it. Never required. */
  emailFor?: (ctx: TenantContext) => Promise<string | null>;
  /** Tell a workspace something happened to its subscription. Fan-out is the caller's business. */
  notify?: (ctx: TenantContext, e: { kind: "attention" | "plan"; plan: string; status: string }) => void;
}

export function billingRoutes(deps: BillingRoutesDeps): { path: string; method: "POST"; handler: Handler }[] {
  return [
    { path: "/v1/billing/checkout", method: "POST", handler: checkoutHandler(deps) },
    { path: "/v1/billing/webhook", method: "POST", handler: webhookHandler(deps) },
  ];
}

function checkoutHandler(deps: BillingRoutesDeps): Handler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const cfg = deps.config();
    if (!paymentsConfigured(cfg)) {
      // A deployment with no payments is the local path and is not an error state. Saying so
      // plainly beats a 500 from a fetch to Stripe with no key.
      throw badRequest("payments are not configured on this deployment");
    }
    const ctx = await deps.contextFor(req);
    const body = await req.json<{ plan?: unknown }>();
    const planId = typeof body.plan === "string" ? body.plan : "";
    if (!isPlanId(planId)) throw badRequest(`"${String(planId).slice(0, 32)}" is not a plan`);

    // The price comes from the `plans` table, which is where deployment-specific configuration
    // lives — never from the client. A price id in a request body would let somebody subscribe
    // to whatever they could name.
    const plan = (await deps.billing.listPlans(ctx)).find((p) => p.id === planId);
    if (!plan) throw badRequest(`this deployment does not offer the ${planId} plan`);
    if (!plan.purchasable || !plan.external_price_id) {
      throw badRequest(`the ${plan.display_name} plan cannot be bought here`);
    }

    const existing = await deps.billing.liveSubscription(ctx);
    const session = await createCheckoutSession(cfg, {
      workspaceId: ctx.workspaceId,
      planId,
      priceId: plan.external_price_id,
      customerEmail: (await deps.emailFor?.(ctx)) ?? null,
      // Reuse the customer Stripe already knows, so a workspace that upgrades twice is one
      // customer with two subscriptions rather than two customers.
      externalCustomerId: existing?.external_customer_id ?? null,
    });
    return { status: 200, body: { url: session.url } };
  };
}

function webhookHandler(deps: BillingRoutesDeps): Handler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const cfg = deps.config();
    // RAW BYTES. See the file header: a re-serialised body does not reproduce what was signed.
    const raw = (await req.buffer()).toString("utf8");
    const verdict = verifyStripeSignature(raw, req.header("stripe-signature"), cfg.webhookSecret);
    if (!verdict.ok) {
      // 401 for every failure, and the reason only in the log. Telling a caller whether their
      // signature was stale or merely wrong tells them which half to fix.
      console.warn(`[billing] webhook rejected (${verdict.reason})`);
      throw unauthorized("that request is not signed by the payment provider");
    }

    const event = JSON.parse(raw) as {
      id?: unknown;
      type?: unknown;
      data?: { object?: Record<string, unknown> };
    };
    const id = typeof event.id === "string" ? event.id : null;
    const type = typeof event.type === "string" ? event.type : "";
    if (!id) throw badRequest("that event has no id");

    // AT LEAST ONCE, SO CLAIM BEFORE ACTING. A redelivery loses the race for the row and does
    // nothing, and returns 200 so the provider stops retrying — a duplicate is not a failure and
    // answering it with one earns more of them.
    if (!(await deps.billing.claimWebhookEvent(id, type))) {
      return { status: 200, body: { received: true, duplicate: true } };
    }

    const object = event.data?.object ?? {};
    const workspaceId = workspaceFrom(object);
    if (!workspaceId) {
      // Recorded rather than dropped: an event about a customer nobody recognises is the one
      // worth having a row for. 200, because retrying it will not make us recognise them.
      await deps.billing.finishWebhookEvent(id, null, "no workspace on the event");
      return { status: 200, body: { received: true, ignored: true } };
    }

    const ctx = systemContextFor(workspaceId, newRequestId());
    try {
      const outcome = await handleEvent(deps, ctx, type, object);
      await deps.billing.finishWebhookEvent(id, workspaceId, outcome);
      return { status: 200, body: { received: true } };
    } catch (err) {
      // The row is left UNPROCESSED on purpose — it is the queue an operator replays — and the
      // status is a 500 so the provider retries it for us. This is the one path where a failure
      // must not be swallowed into a 200.
      console.error(`[billing] webhook ${id} (${type}) failed:`, (err as Error)?.message ?? err);
      throw err;
    }
  };
}

/**
 * Which workspace an event object is about.
 *
 * Both places are checked because both are populated by `createCheckoutSession` and each is the
 * only one present on some events: `client_reference_id` rides the checkout session, and
 * `metadata.workspace_id` rides the subscription Stripe creates from it — which is what every
 * later renewal, failure and cancellation is about, long after the session is gone.
 */
function workspaceFrom(object: Record<string, unknown>): string | null {
  const ref = object["client_reference_id"];
  if (typeof ref === "string" && ref) return ref;
  const metadata = object["metadata"];
  if (metadata && typeof metadata === "object") {
    const fromMeta = (metadata as Record<string, unknown>)["workspace_id"];
    if (typeof fromMeta === "string" && fromMeta) return fromMeta;
  }
  return null;
}

function planFrom(object: Record<string, unknown>): string {
  const metadata = object["metadata"];
  if (metadata && typeof metadata === "object") {
    const plan = (metadata as Record<string, unknown>)["plan_id"];
    if (typeof plan === "string" && isPlanId(plan)) return plan;
  }
  return "free";
}

function str(object: Record<string, unknown>, key: string): string | null {
  const v = object[key];
  return typeof v === "string" && v ? v : null;
}

/** Stripe reports period ends as unix seconds. The schema stores ISO-8601, like everything else. */
function isoFromUnix(object: Record<string, unknown>, key: string): string | null {
  const v = object[key];
  return typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null;
}

async function handleEvent(
  deps: BillingRoutesDeps,
  ctx: TenantContext,
  type: string,
  object: Record<string, unknown>,
): Promise<string> {
  switch (type) {
    // The checkout finished. The subscription itself arrives as its own event; what this one
    // uniquely carries is the CUSTOMER, which every later event is keyed to.
    case "checkout.session.completed": {
      const subscriptionId = str(object, "subscription");
      if (!subscriptionId) return "checkout with no subscription";
      const result = await applySubscription(ctx, deps.billing, deps.identity, {
        planId: planFrom(object),
        // Deliberately not `active`. A completed checkout session means the form was submitted,
        // not that the charge settled — `customer.subscription.updated` is what says that, and
        // granting the plan here would give a month away to a card that declines a second later.
        status: "incomplete",
        externalSubscriptionId: subscriptionId,
        externalCustomerId: str(object, "customer"),
      });
      deps.notify?.(ctx, { kind: "plan", plan: result.plan, status: "incomplete" });
      return "checkout recorded";
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscriptionId = str(object, "id");
      if (!subscriptionId) return "subscription with no id";
      // `deleted` arrives with whatever status the object had; the event type is the truth.
      const status = type === "customer.subscription.deleted"
        ? "canceled"
        : (str(object, "status") ?? "incomplete");
      const result = await applySubscription(ctx, deps.billing, deps.identity, {
        planId: planFrom(object),
        status,
        externalSubscriptionId: subscriptionId,
        externalCustomerId: str(object, "customer"),
        currentPeriodEnd: isoFromUnix(object, "current_period_end"),
        cancelAtPeriodEnd: object["cancel_at_period_end"] === true,
      });
      if (result.planChanged || result.attention) {
        deps.notify?.(ctx, { kind: result.attention ? "attention" : "plan", plan: result.plan, status });
      }
      return `${status}${result.planChanged ? ` — plan now ${result.plan}` : ""}`;
    }

    // DUNNING. A failed renewal does not move the plan — see billing/subscriptions.ts on why —
    // but it is the moment somebody has to be told, because the retries run for weeks and the
    // first they would otherwise hear is the cancellation at the end of them.
    case "invoice.payment_failed": {
      const subscriptionId = str(object, "subscription");
      if (subscriptionId) {
        // THE STATUS, AND NOTHING ELSE. `object` here is an INVOICE, and an invoice carries no
        // plan: `createCheckoutSession` sets `metadata.plan_id` on the session and on the
        // subscription, never on an invoice. So `planFrom(object)` fell through to its `"free"`
        // default and wrote it over the paid plan the workspace was still on — and because the two
        // optional fields were omitted, `current_period_end` was nulled and `cancel_at_period_end`
        // reset with them. The workspace's actual plan was safe only because `planForStatus`
        // returns null for `past_due`; the stored subscription was not, and it is the row a support
        // query, an invoice screen or anybody debugging a dunning case reads.
        await deps.billing.upsertSubscription(ctx, {
          status: "past_due",
          externalSubscriptionId: subscriptionId,
          externalCustomerId: str(object, "customer"),
        });
      }
      deps.notify?.(ctx, { kind: "attention", plan: "", status: "past_due" });
      return "payment failed — dunning";
    }

    // A renewal settled. Credit is granted here rather than on `subscription.updated`, because
    // this is the event that means money moved: a plan change mid-cycle produces an `updated`
    // and no payment, and granting a month's credit on it would let somebody switch plans back
    // and forth for free credit.
    case "invoice.paid": {
      const grant = Number(object["amount_paid"]);
      if (Number.isFinite(grant) && grant > 0) {
        // Stripe reports in the smallest currency unit. A hundredth of a dollar is a cent, and
        // reading `amount_paid` as dollars would credit a $20 invoice with $2,000.
        await deps.billing.addCredit(ctx, grant / 100);
      }
      return "invoice paid";
    }

    default:
      // Stripe sends a great deal we do not act on. Recorded as ignored rather than as an error,
      // so the table distinguishes "we saw it and it was not ours to act on" from "we never saw
      // it" — which are different answers to the same support question.
      return `ignored (${type})`;
  }
}
