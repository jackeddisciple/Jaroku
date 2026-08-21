# The three pages that are not the app

Jaroku is a desktop application. These are the only Jaroku surfaces that live on the open web, and
each one exists because something outside the app has to be able to reach a URL.

| File | Hosted at | Why it cannot be an app route |
|---|---|---|
| `pricing.html` | `jaroku.dev/pricing` | It is read **before** anything is installed. The app's first screen is first-run setup or sign-in; it has no unauthenticated state to render a pricing page into. |
| `checkout/success.html` | `checkout.jaroku.dev/success` | Stripe redirects a **browser**. It will not accept a `jaroku://` URL as a `success_url`, and `/billing/success` is a route no external redirect can reach. |
| `checkout/canceled.html` | `checkout.jaroku.dev/canceled` | The same, for somebody who backed out. |

## Why the checkout pages are on their own subdomain

Away from wherever auth callbacks land, so a misconfigured or compromised auth callback cannot
intercept a payment redirect and vice versa. It costs one DNS record and the isolation is the whole
of the reason.

## What they do, and what they deliberately do not

Both checkout pages redirect to a `jaroku://` deep link after a short beat, and render a manual
button that does the same thing. The button is not decoration: an operating system may ask before
handing a custom scheme to an application, and somebody who dismisses that prompt has no other way
back. It is also the only honest route on a machine where the app is not installed, where it points
at the download page instead.

**Neither page is the source of truth about anything.** Arriving at `success` means the payment form
was submitted, not that the subscription is active — the webhook settles that, and it travels
independently of the redirect. So the wording is "payment received", never "welcome to Pro", and the
app shows *confirming your subscription…* until `GET /v1/billing/subscription` agrees. A page that
congratulated somebody on a tier they did not have yet would be lying a noticeable fraction of the
time.

**`pricing.html` contains no payment integration of any kind.** Every call to action downloads the
app — Free, Pro and Team alike — and the one exception is Team's "Contact", which is a `mailto:`.
A visitor who wants Pro downloads the app, signs in, and upgrades from inside it, through the same
flow every other upgrade uses. Building a second checkout entry point here would mean getting
webhook linking, workspace association and every edge case right in two places instead of one.

## Configuration

The server reads its return URLs from the environment and refuses a checkout whose URLs are not
`https` pages — a `jaroku://` link, an app-relative path and a plain-http URL are all rejected
before the request reaches Stripe, and the third of those is the one Stripe itself would accept.

```
STRIPE_SUCCESS_URL=https://checkout.jaroku.dev/success?session_id={CHECKOUT_SESSION_ID}
STRIPE_CANCEL_URL=https://checkout.jaroku.dev/canceled
```

`{CHECKOUT_SESSION_ID}` is Stripe's own placeholder and is substituted by Stripe, not by us. The
success page passes the value straight through to the deep link after checking it looks like a
session id, and never parses it.

## Hosting

Three static files with no build step, no framework and no runtime. Any static host will do; there
is nothing here that needs a server. Keep them on the two hostnames above, because those strings are
in the server's configuration and in Stripe's dashboard.
