# Flow — upgrade

| # | Step | Observed |
|---|---|---|
| 1 | Workspace panel → Billing | ✓ (Free) |
| 2 | Compare plans, choose seats, read a price — **all in the webview** | ✗ |
| 3 | `Continue to payment` → `open_checkout` → the OS browser | ✗ |
| 4 | Pay on Stripe | ✗ |
| 5 | Return via `jaroku://billing/success` | ✗ |
| 6 | The app polls `GET /v1/billing/subscription` until it agrees with the webhook | ✗ |

**The payment step is the one hop out of the window, and it is the only one.** `open_checkout`
(`src-tauri/src/deeplink.rs`) checks the URL against an exact-host allowlist first;
`capabilities/default.json` grants the page nothing.

With no `STRIPE_SECRET_KEY` configured, **the Upgrade control is absent** — not disabled.
