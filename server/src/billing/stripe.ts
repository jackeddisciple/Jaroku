// Stripe, by hand.
//
// NO SDK, for the reason there is no OpenAI SDK on the Node side and no framework under the
// HTTP router: this needs one POST and one HMAC, and a dependency in the path a PAYMENT takes
// is a supply chain in the path a payment takes. What the SDK would give us here is a
// form-encoder and a signature check, and both are below and both are testable.
//
// THREE PROPERTIES, AND THE FIRST ONE IS THE SECURITY BOUNDARY.
//
//   1. THE SIGNATURE IS THE AUTHENTICATION. This endpoint is public and unauthenticated by
//      construction — Stripe cannot present a bearer token — so the HMAC is the only thing
//      between "Stripe says this workspace paid" and "anybody who can reach the URL says this
//      workspace paid". It is checked over the RAW BODY, before anything parses it, with a
//      constant-time comparison, against a timestamp that has to be recent.
//
//   2. THE TIMESTAMP IS PART OF WHAT IS SIGNED, WHICH IS WHAT MAKES REPLAY BOUNDED. A signed
//      payload stays validly signed forever; without a tolerance, a single captured
//      `invoice.paid` could be replayed a year later and would verify perfectly. Five minutes
//      is Stripe's own recommendation and is the number here.
//
//   3. ACTING ON AN EVENT IS IDEMPOTENT, RECORDED IN A TABLE. Stripe delivers at least once and
//      says so. Applying a state transition twice is worse than recording a row twice: a plan
//      change reapplied after a later one superseded it, a cancellation undone by its own
//      retry. See migration 025 for why that is its own table rather than another idempotency
//      key on `usage_events`.
//
// WHAT THIS FILE DOES NOT DO. It does not decide what a plan means, and it does not touch a
// balance directly. It resolves an event to a workspace and a plan id and hands both to the
// state machine below, which writes through the repository like everything else.

import { createHmac, timingSafeEqual } from "node:crypto";

/** How old a signed payload may be. Stripe's own recommendation, and the replay bound. */
export const SIGNATURE_TOLERANCE_S = 300;

export interface StripeConfig {
  /** `sk_live_…` / `sk_test_…`. Absent means this deployment has no payments configured. */
  secretKey?: string;
  /** `whsec_…`. The webhook's whole authentication — see the header. */
  webhookSecret?: string;
  /**
   * Where a completed checkout sends the BROWSER — and it is a browser, which is the whole reason
   * these are configured rather than derived.
   *
   * NEITHER MAY BE AN APP-RELATIVE PATH, and on a desktop app neither may be a `jaroku://` URL
   * either. Stripe redirects a real browser to a real web page; a custom scheme is not something a
   * payment provider will accept as a success_url, and `/billing/success` is a route no external
   * redirect can reach because the app is not served over HTTP at all. So both point at
   * Jaroku-owned pages (see `web/checkout/`) whose only job is to hop to the deep link, and
   * `checkoutUrlIsExternal` below is what stops a well-meaning edit from breaking that.
   *
   * ON THEIR OWN SUBDOMAIN, away from the auth callbacks: a misconfigured auth callback then cannot
   * intercept a payment redirect, and vice versa. Cheap to arrange, and the isolation is the point.
   */
  successUrl?: string;
  cancelUrl?: string;
  /** Overridable so a suite can point at a fixture server rather than at Stripe. */
  apiBase?: string;
}

export function stripeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StripeConfig {
  return {
    ...(env.STRIPE_SECRET_KEY ? { secretKey: env.STRIPE_SECRET_KEY } : {}),
    ...(env.STRIPE_WEBHOOK_SECRET ? { webhookSecret: env.STRIPE_WEBHOOK_SECRET } : {}),
    ...(env.STRIPE_SUCCESS_URL ? { successUrl: env.STRIPE_SUCCESS_URL } : {}),
    ...(env.STRIPE_CANCEL_URL ? { cancelUrl: env.STRIPE_CANCEL_URL } : {}),
    ...(env.STRIPE_API_BASE ? { apiBase: env.STRIPE_API_BASE } : {}),
  };
}

/** Whether payments are configured at all. Absent is the default and the local path. */
export function paymentsConfigured(cfg: StripeConfig): boolean {
  return Boolean(cfg.secretKey && cfg.webhookSecret);
}

/**
 * Whether a configured return URL is one a browser can actually be sent to.
 *
 * THREE WAYS TO GET THIS WRONG, and all three look plausible in a config file. A `jaroku://` URL is
 * refused by Stripe outright. An app-relative path — `/billing/success` — is a route that exists
 * only inside a webview and cannot be reached by an external redirect at all. And a plain-http URL
 * is a payment confirmation over a channel anybody on the path can rewrite.
 *
 * Checked at the point a checkout is created rather than at boot, because the config is read per
 * request — a deployment that fixes its URL should not need a restart, and one that breaks it
 * should find out from the first checkout rather than from a customer.
 */
export function checkoutUrlIsExternal(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export type SignatureVerdict =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "malformed" | "stale" | "mismatch" | "unconfigured" };

/**
 * Verify a `Stripe-Signature` header against the raw body.
 *
 * The header is `t=<unix>,v1=<hex>[,v1=<hex>…]`, and MORE THAN ONE `v1` IS NORMAL: during a
 * webhook-secret rotation Stripe signs with both, and a verifier that read only the first would
 * fail every request for whichever half of the rotation it did not match. Every candidate is
 * compared and any match is a pass.
 *
 * CONSTANT-TIME, and not because a timing attack on a webhook is likely — it is because the
 * alternative is `===` on a secret-derived value, which is the kind of thing that is correct
 * until somebody moves it somewhere it is not.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string | undefined,
  nowMs: number = Date.now(),
): SignatureVerdict {
  if (!secret) return { ok: false, reason: "unconfigured" };
  if (!header) return { ok: false, reason: "malformed" };

  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const n = Number(value);
      if (Number.isFinite(n)) timestamp = n;
    } else if (key === "v1") {
      candidates.push(value);
    }
  }
  if (timestamp === null || !candidates.length) return { ok: false, reason: "malformed" };

  // Checked BEFORE the HMAC. An ancient payload is refused whether or not it is signed, so a
  // captured request cannot be replayed by anybody who has it — and refusing it without
  // computing anything means a flood of stale replays costs no CPU.
  const ageS = Math.abs(nowMs / 1000 - timestamp);
  if (ageS > SIGNATURE_TOLERANCE_S) return { ok: false, reason: "stale" };

  // The signed payload is `<t>.<raw body>` — the timestamp is inside the MAC, which is what
  // stops somebody moving a valid signature onto a fresher timestamp.
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
  for (const candidate of candidates) {
    const given = Buffer.from(candidate, "hex");
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return { ok: true, timestamp };
    }
  }
  return { ok: false, reason: "mismatch" };
}

/** Sign a payload the way Stripe would. Exported for the suite, which has to produce one. */
export function stripeSignatureHeader(rawBody: string, secret: string, atMs: number = Date.now()): string {
  const t = Math.floor(atMs / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  return `t=${t},v1=${mac}`;
}

// --- the API call ---------------------------------------------------------------------------

export interface CheckoutRequest {
  workspaceId: string;
  planId: string;
  priceId: string;
  /** Prefills the payment form and is what a returning customer is matched on. */
  customerEmail?: string | null;
  /** Reuse the customer Stripe already knows, when there is one. */
  externalCustomerId?: string | null;
  /**
   * Seats, for a per-user price. One unless the caller says otherwise.
   *
   * THE QUANTITY ON THE LINE ITEM, which is how a per-seat plan is priced — not a separate product
   * and not a number we multiply ourselves. Stripe computes the total, prorates a mid-cycle change,
   * and renders the arithmetic on the invoice, which is three things worth not reimplementing.
   */
  seats?: number;
}

/**
 * A seat count Stripe will accept, or one.
 *
 * CLAMPED HERE RATHER THAN TRUSTED, because this number reaches a payment provider and comes from a
 * request body. A fractional quantity is a 400 from Stripe with a message about `line_items`; a
 * negative or enormous one is somebody trying something. The floor is one and the ceiling is the
 * largest workspace any tier allows — above that is an Enterprise conversation rather than a bigger
 * number, so there is no legitimate checkout for it.
 */
export function seatQuantity(requested: unknown): number {
  const n = typeof requested === "number" ? Math.trunc(requested) : Number.NaN;
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(20, n));
}

export interface CheckoutSession {
  id: string;
  url: string;
}

/**
 * Start a checkout.
 *
 * FORM-ENCODED, because that is what Stripe's API takes — it is not a JSON API, and a body
 * built with `JSON.stringify` is a 400 with a message about `payment_method_types` that sends
 * somebody looking in the wrong place.
 *
 * `client_reference_id` AND `metadata[workspace_id]` BOTH CARRY THE WORKSPACE. Not redundancy
 * for its own sake: `client_reference_id` comes back on the checkout session and `metadata`
 * propagates onto the subscription Stripe creates from it, so the two together mean every later
 * event about this subscription can be resolved to a workspace without a lookup table of our
 * own — including the ones that arrive when the checkout session is long gone.
 */
export async function createCheckoutSession(
  cfg: StripeConfig,
  req: CheckoutRequest,
): Promise<CheckoutSession> {
  if (!cfg.secretKey) throw new Error("payments are not configured on this deployment");
  const body = new URLSearchParams();
  body.set("mode", "subscription");
  body.set("line_items[0][price]", req.priceId);
  body.set("line_items[0][quantity]", String(seatQuantity(req.seats)));
  body.set("client_reference_id", req.workspaceId);
  body.set("metadata[workspace_id]", req.workspaceId);
  body.set("metadata[plan_id]", req.planId);
  body.set("subscription_data[metadata][workspace_id]", req.workspaceId);
  body.set("subscription_data[metadata][plan_id]", req.planId);
  // REFUSED HERE RATHER THAN PASSED ON. Stripe would reject a `jaroku://` success_url with a
  // message about the parameter, and would ACCEPT an `http://` one — so leaving this to the
  // provider catches one of the two mistakes and ships the other.
  if (cfg.successUrl && !checkoutUrlIsExternal(cfg.successUrl)) {
    throw new Error("STRIPE_SUCCESS_URL must be an https page a browser can reach, not an app route");
  }
  if (cfg.cancelUrl && !checkoutUrlIsExternal(cfg.cancelUrl)) {
    throw new Error("STRIPE_CANCEL_URL must be an https page a browser can reach, not an app route");
  }
  if (cfg.successUrl) body.set("success_url", cfg.successUrl);
  if (cfg.cancelUrl) body.set("cancel_url", cfg.cancelUrl);
  if (req.externalCustomerId) body.set("customer", req.externalCustomerId);
  else if (req.customerEmail) body.set("customer_email", req.customerEmail);

  const res = await fetch(`${cfg.apiBase ?? "https://api.stripe.com"}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      // Stripe's own idempotency: a retried checkout for the same workspace and plan within 24
      // hours returns the SAME session rather than a second one. Without it a double-clicked
      // Upgrade button is two checkout sessions and, if both are completed, two subscriptions.
      //
      // THE SEAT COUNT IS PART OF THE KEY, and leaving it out would have been a quiet bug rather
      // than a missing feature: Stripe returns the CACHED session for a repeated key, so somebody
      // who started a Team checkout at two seats, went back, and chose five would have been sent
      // to the two-seat page again — with the right number on our screen and the wrong one on the
      // invoice. The key has to name everything that changes what is being bought.
      "idempotency-key": `checkout:${req.workspaceId}:${req.priceId}:${seatQuantity(req.seats)}`,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // The status, not the body. Stripe's error body echoes parameters back, and this string is
    // about to be rendered in a browser and possibly pasted into an issue.
    throw new Error(`Stripe answered ${res.status} ${res.statusText} starting a checkout`);
  }
  const json = (await res.json()) as { id?: unknown; url?: unknown };
  if (typeof json.id !== "string" || typeof json.url !== "string") {
    throw new Error("Stripe returned a checkout session with no URL");
  }
  return { id: json.id, url: json.url };
}
