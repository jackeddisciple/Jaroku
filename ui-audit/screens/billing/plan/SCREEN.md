# SCREEN — Billing

| | |
|---|---|
| **Screen ID** | `BILL-01` |
| **Screen name** | Billing |
| **Route / path** | Workspace panel → Billing |
| **Parent area** | Billing |
| **Purpose** | What this workspace is on, what it has spent, and how to change it |

## Plans

Three rows in the `plans` table. The seed has every workspace on **Free**.

## The payment hop

This is the **only** point in the product that leaves the window. `Continue to payment` calls the
`open_checkout` command in `src-tauri/src/deeplink.rs`, which checks the URL against an exact-host
allowlist before handing it to the OS. The browser returns through `jaroku://billing/success`, and
the app polls `GET /v1/billing/subscription` until it agrees with the webhook
(`docs/tauri.md`).

**When `STRIPE_SECRET_KEY` is absent, the Upgrade control is absent** — not disabled. It is absent
in every screenshot in this package.

## State list

| State | Screenshot | Notes |
|---|---|---|
| free | `free.png` | Observed |
| active paid | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `BillingSection.tsx`, `PlanCard.tsx` |
| trial | — | `NOT FOUND` — no trial state exists in `PlanCard.tsx` or the `plans` table |
| usage warning | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `EnforcementStrip.tsx`, `store/enforcementStore.ts` |
| limit reached | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `workspace_enforcements` (1 row in the seed) |
| payment issue | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `store/billingStore.ts` |
| upgrade prompt | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `UpsellCard.tsx`; absent without a Stripe key |

## Implementation references

`BillingSection.tsx` (22 KB) · `PlanCard.tsx` (30 KB) · `UpsellCard.tsx` · `EnforcementStrip.tsx` ·
`store/billingStore.ts` · `store/entitlementStore.ts` · `store/enforcementStore.ts` ·
channels `billing`, `enforcement` · `server/src/billing/` · `web/pricing.html`, `web/checkout/`
