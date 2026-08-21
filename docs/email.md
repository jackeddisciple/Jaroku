# Sign-in email: the half that is not code

§8 of the onboarding specification is the shortest section in it and the one most likely to sink the
feature. Its argument is one sentence — **"an email that lands in spam is an unusable sign-in
flow"** — and almost none of the work it implies is code. The code is a POST to a provider's API and
it is about forty lines in `server/src/email/transport.ts`. What makes the mail *arrive* is three
DNS records and a decision about which domain sends them.

This document is that half. Nothing here can be tested by a suite, which is exactly why it is
written down: the failure mode is silent, delayed, and reported as "the app didn't email me".

## Why this is production-blocking

§8.2 says so in as many words, and the reason is arithmetic rather than principle. Gmail is
somewhere north of 60% of the addresses this product will ever send to. Gmail applies SPF, DKIM and
DMARC checks to every message it receives, and a message failing them from a domain with no DMARC
policy goes to spam at a rate that makes an email sign-in path effectively not exist.

There is no gradual version of this. A domain either passes or it does not, and until it does, every
person who chooses the email path over Google is a person who cannot sign in and has no way to find
out why.

## The sending domain

Send from a **subdomain**, not the apex. `auth.jaroku.dev` or `mail.jaroku.dev`, never
`jaroku.dev` itself.

The reason is reputation isolation. A sending domain accumulates a reputation with every large
mailbox provider, and that reputation is shared by everything sending from it. Sending transactional
mail from the apex means the day somebody sends a newsletter, or a support tool starts auto-replying,
or a compromised form starts relaying — the sign-in mail inherits whatever that did. A subdomain
dedicated to authentication is a reputation nobody else can spend.

It also means the apex keeps a strict DMARC policy of its own without the two interacting.

## The three records

The provider generates the exact values; what follows is what each one is for and the shape it
takes. Configure the domain in the provider's dashboard first — both Resend and Postmark hand back
the records to publish, and both verify them before they will send.

### SPF — which servers may send as this domain

```
auth.jaroku.dev.   TXT   "v=spf1 include:<provider's include> ~all"
```

One TXT record, and **exactly one**. A domain with two SPF records fails SPF entirely — the
specification says a permanent error rather than "use the first one" — which is the single most
common way this is broken by somebody being helpful.

`~all` (softfail) rather than `-all` (hardfail) while you are establishing the domain. Softfail
means a message from an unlisted server is marked rather than rejected, which leaves room to
discover a forwarder you did not know about. Tighten to `-all` once the DMARC reports below are
quiet.

### DKIM — proof the message was not altered

```
<selector>._domainkey.auth.jaroku.dev.   TXT   "v=DKIM1; k=rsa; p=<public key>"
```

The provider holds the private half and signs every message; the public half goes in DNS. This is
what survives forwarding, which SPF does not: a message forwarded through a mailing list fails SPF
at the destination and still passes DKIM.

Both providers rotate keys. Use the CNAME form if the provider offers one — it lets them rotate
without a DNS change, and a rotation that needs a human is a rotation that happens late.

### DMARC — what to do when the first two fail

```
_dmarc.auth.jaroku.dev.   TXT   "v=DMARC1; p=none; rua=mailto:dmarc@jaroku.dev; pct=100; adkim=s; aspf=s"
```

**Start at `p=none` for a week.** §8.2 asks for this explicitly and it is not caution for its own
sake: `p=none` changes nothing about delivery and turns on the aggregate reports (`rua`), which are
the only way to discover that something legitimate has been sending as this domain all along. Going
straight to `p=quarantine` means finding that out from the thing that stops working.

After a week of clean reports, tighten:

```
v=DMARC1; p=quarantine; rua=mailto:dmarc@jaroku.dev; pct=100; adkim=s; aspf=s
```

`p=quarantine` is §8.2's stated minimum. `p=reject` is stricter and is the right destination once
the domain has a history.

`adkim=s` and `aspf=s` are strict alignment: the domain in the `From:` header must match the domain
that passed DKIM and SPF exactly, rather than merely sharing an organisational domain. Relaxed
alignment would let anything under `jaroku.dev` pass for `auth.jaroku.dev`, which gives back the
isolation the subdomain was chosen for.

## The sender address

```
JAROKU_EMAIL_FROM="Jaroku <sign-in@auth.jaroku.dev>"
```

§8.3: a real, monitored address, **not `noreply@`**. Three reasons, in increasing order of
importance:

1. Gmail and Outlook both weight `noreply@` against a sender's reputation.
2. Several corporate filters quarantine it outright.
3. Somebody who replies to a sign-in email with *"I didn't request this"* is telling you about an
   attack in progress. `noreply@` is where that message goes to die.

Point that mailbox somewhere a person reads.

## Bounce and complaint webhooks

`server/src/http/magicLink.ts` mounts `POST /webhooks/email/<secret>`, and both providers can be
configured to call it. Set the secret:

```
JAROKU_EMAIL_WEBHOOK_SECRET=<a long random value>
```

An unconfigured secret refuses every webhook rather than accepting them — see
`webhookSecretMatches`, which explains why that direction is the safe one.

What it does with what arrives is §8.4, and the interesting half is what it *refuses* to do: a soft
bounce, an undetermined bounce, a delivery receipt and a payload it does not recognise all leave the
address alone. Blocking is irreversible from the person's point of view — they simply cannot sign in
any more, with no way to tell us — so "we are not sure" is never a reason to do it.

## Verifying it worked

The suite cannot check any of this. What can:

1. Send a sign-in link to a Gmail address you control.
2. Open the message, **Show original**.
3. Confirm three lines read `PASS`:
   ```
   SPF:   PASS with IP <provider's>
   DKIM:  PASS with domain auth.jaroku.dev
   DMARC: PASS
   ```
4. Confirm it is in the **Primary** tab, not Promotions and not Spam.

§12's criterion 16 is exactly this check. Repeat it for Outlook and for one corporate Microsoft 365
tenant if you have access to one — those three are most of the world's mail and they disagree about
enough to be worth checking separately.

## Configuration, in one place

| Variable | What it is |
| --- | --- |
| `JAROKU_EMAIL_PROVIDER` | `resend`, `postmark`, or `log`. Absent in development means `log`. |
| `JAROKU_EMAIL_API_KEY` | The provider's key. Required for the two real providers. |
| `JAROKU_EMAIL_FROM` | `Jaroku <sign-in@auth.jaroku.dev>`. Name and address. |
| `JAROKU_EMAIL_WEBHOOK_SECRET` | The path segment a delivery webhook must present. |
| `JAROKU_AUTH_ORIGIN` | The public origin the link points at. Shared with Google's callback. |

`log` writes the link to the server's own log and sends nothing. It is what `npm run dev` uses so a
developer needs no mail account, no domain and no API key — and it **refuses to be selected under
`NODE_ENV=production`**, because a server that quietly logged sign-in links instead of sending them
would be a server where every account is openable by whoever can read the log.
