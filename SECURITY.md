# Security Policy

Jaroku runs generated code, holds provider API keys, and stores traces whose payloads contain
whatever an agent touched: mailbox contents, database rows, prompts. A vulnerability here is not
abstract, and reports are treated accordingly.

This document describes what is in scope, how to report a vulnerability privately, what happens
after you do, and what is already known and therefore not a finding.

- [Reporting a vulnerability](#reporting-a-vulnerability)
- [What to include](#what-to-include)
- [What happens next](#what-happens-next)
- [Supported versions](#supported-versions)
- [Scope](#scope)
- [Known limitations that are not findings](#known-limitations-that-are-not-findings)
- [Severity](#severity)
- [Coordinated disclosure](#coordinated-disclosure)
- [Safe harbour](#safe-harbour)
- [Recognition](#recognition)
- [Hardening the deployment you run](#hardening-the-deployment-you-run)

---

## Reporting a vulnerability

**Do not open a public GitHub issue, pull request or discussion for a security problem.** A
public report is an exploit notice for everyone running the affected version before there is a
fix for them to install.

Use either private channel:

| Channel | How |
|---|---|
| **Email** (preferred) | **adarshhchoudhary1@gmail.com**, with the subject line prefixed `[SECURITY] Jaroku:` |
| **GitHub** | [Private vulnerability reporting](https://github.com/jackeddisciple/jaroku/security/advisories/new) on `jackeddisciple/jaroku` |

Report in English. If a public disclosure is already in motion elsewhere and you cannot wait, say
so in the first line of your report along with the date, so the fix can be sequenced against it
rather than discovered afterwards.

If you believe you have found a live compromise of a running instance rather than a flaw in the
code (active exfiltration, a leaked key in the wild), write `ACTIVE INCIDENT` in the subject line
and include the time window and what you observed.

---

## What to include

A report that can be reproduced is a report that can be fixed. The more of the following it
carries, the faster that happens:

1. **A one-sentence summary** of the flaw and its impact: what an attacker gains, and as whom.
2. **Affected component and version.** The release tag or commit SHA, plus the file paths if you
   have them (`server/src/auth/…`, `runtime/jaroku_runner/…`, `client/src/store/…`).
3. **Reproduction steps**, precise enough to follow from a clean `git clone`: configuration,
   environment variables, the exact requests, payloads or socket frames, and the observed result
   against the expected one.
4. **A proof of concept.** A script, a `curl` invocation, or a minimal patch to a test. Please
   keep it to the minimum that demonstrates the issue.
5. **Impact assessment.** Cross-tenant read or write, credential disclosure, remote code
   execution beyond what generation already implies, privilege escalation across the role matrix,
   denial of service, and who has to be authenticated for it to work.
6. **Any mitigation you know of**, including configuration that avoids the problem.
7. **How you would like to be credited**, or that you would prefer not to be.

Redact real secrets from logs and screenshots before attaching them. If a live key of yours was
exposed while testing, rotate it. Do not send it.

---

## What happens next

This project is maintained by one person, so the timelines below are commitments about
communication, not a support contract:

| Stage | Target |
|---|---|
| Acknowledgement that the report arrived | **within 48 hours** |
| Initial triage: reproduced or not, severity, scope | **within 5 business days** |
| Status update while work is ongoing | **at least every 7 days** |
| Fix or documented mitigation for critical and high severity | **target 30 days** from triage |
| Fix or documented mitigation for medium and low severity | **target 90 days**, or the next release |

You will be told which of these applies to your report, and told again if a date is going to slip
and why. If you have not heard anything within 5 days, please resend, and assume the mail was
lost rather than ignored.

When a fix ships you will get the commit or release it landed in, and the advisory text before it
is published, so you can correct anything the write-up gets wrong about your finding.

A report that turns out not to be a vulnerability still gets an answer explaining why. If that
reasoning is wrong, say so. The second look is worth more than the first.

---

## Supported versions

Jaroku is pre-1.0 and moves quickly. Security fixes land on the latest release; there are no
long-term support branches, and older minors are not backported.

| Version | Supported |
|---|---|
| `0.2.6` (current) | ✅ Fixes land here |
| `< 0.2.6` | ❌ Please upgrade before reporting |

Before reporting, confirm the issue still reproduces on the default branch. See
[CHANGELOG.md](CHANGELOG.md) for what has already changed.

---

## Scope

### In scope

Anything in this repository, and anything it produces:

- **The Node control plane** (`server/`): the HTTP surface, the WebSocket relay, the migration
  runner and the repositories.
- **Authentication, membership and tenancy** (`server/src/auth/`, `server/src/tenancy.ts`): OIDC
  token verification, the ws-ticket exchange, the origin check, the capability matrix, row-level
  security, and any cross-workspace read or write.
- **The Python runtime** (`runtime/`): the runner, the interceptor, the stdout guard and the
  checkpointed debug driver.
- **Reviewed connectors** (`runtime/tool_templates/`), in particular the Postgres connector's
  read-only guarantees, the Gmail connector's drafts-only behaviour, and SQL injection in
  generated tool code.
- **The MCP bridge.** Anything that lets a third-party MCP server exceed the grant in an agent's
  manifest, bypass the high-impact confirmation, or reach a credential value.
- **Credential handling.** Any path by which a provider key, an MCP token, a Railway token, a
  ws-ticket or an invitation reaches a log line, a database column, a generated project, a build
  log, or a browser.
- **The build and fix pipelines.** Path traversal, escape from the staging directory, and
  anything that lands unvalidated code without the review step.
- **Deploys.** The deployed agent's bearer check, secret scrubbing in build logs, and anything a
  `.dockerignore` miss would put in an image.
- **The React client** (`client/`): XSS, token handling, and any store that survives a workspace
  switch with the previous workspace's rows in it.
- **Supply chain.** A dependency with a known CVE that Jaroku actually reaches, or a build step
  that fetches something unpinned.

### Out of scope

- The **hosting platforms themselves** (Railway, the OIDC provider you configure, GitHub). Report
  those to their own programmes.
- **Third-party MCP servers.** Jaroku treats them as untrusted by design; a malicious MCP server
  behaving maliciously is the modelled case, not a bug. A way for one to *exceed* its grant is.
- Findings that require **physical access to the host, a local privileged shell, or a compromised
  developer machine**.
- **Social engineering**, phishing, or attacks on the maintainer.
- **Automated scanner output with no demonstrated impact**, missing hardening headers on
  endpoints that already have a documented limitation, version fingerprinting, or best-practice
  advice with no attack behind it.
- **Denial of service by volume** against a local instance. See the note on rate limiting below.
- Anything reachable **only** because an operator ignored an explicit warning the software prints
  at boot (`JAROKU_DEV_AUTH=1`, `JAROKU_SERVE_PUBLIC=1`).

---

## Known limitations that are not findings

These are documented, deliberate, and already scheduled. They are stated in
[the threat model](server/src/auth/THREAT-MODEL.md) and in the README's
[Security notes](README.md#security-notes). A report that restates one of them will be closed
with a pointer here. A report that *breaks past* one, or that shows the stated boundary is not
where the code actually draws it, is very much wanted.

- **Model-written Python executes on the control plane.** Validation imports the staged project
  and graph introspection spawns a Python module. The sandbox for this is planned work; until it
  lands, this server is not safe to point at strangers.
- **No rate limiting or volumetric protection.** There is a body cap on the HTTP routes and
  bounded waits on the JWKS fetch, and nothing else. No per-IP or per-workspace throttle.
- **No security headers, HTTP CORS, HSTS or CSP.** Planned. The CSP is also the real mitigation
  for the client token living in `localStorage`, which the client states rather than hides.
- **XSS defeats the auth model.** Script on the page can read the token or simply act as the
  user. A concrete XSS *vector* is in scope; the general observation is not.
- **A compromised OIDC issuer is trusted.** If the issuer signs a token for the wrong person,
  this server believes it. That is the trust implied by choosing an issuer.
- **Membership revocation has a bounded staleness window** of thirty seconds across replicas.
  Revocation is exact on the replica that performed it.
- **Prompt injection is not solved.** Framing MCP output is not a defence and is not claimed to
  be. An agent's blast radius is bounded by its grants; that is the mitigation.
- **The server binds localhost and should not be placed on a network.** Authentication exists,
  but it is not the whole of the hosted posture.
- **A deployed agent binds `0.0.0.0` on purpose**, which is why its bearer token is not optional.

---

## Severity

Severity is assessed with [CVSS v3.1](https://www.first.org/cvss/calculator/3.1) as a starting
point and then adjusted for what this system actually holds. Two adjustments are routine:

- **Cross-tenant access is rated up.** Any path that lets one workspace read or write another's
  rows is treated as high or critical regardless of how narrow the window is, because the asset
  is regulated data belonging to someone who never consented.
- **Credential disclosure is rated up.** Provider keys are spendable, MCP tokens reach
  third-party systems, and a Railway token is someone's hosting account.

| Severity | Shape of it |
|---|---|
| **Critical** | Unauthenticated remote code execution; cross-tenant data access from an ordinary account; disclosure of provider, MCP or hosting credentials |
| **High** | Authenticated privilege escalation across the role matrix; authentication or ticket bypass; a socket escaping its workspace scope; secrets reaching a log, a database column or a browser |
| **Medium** | Path confinement escape within a workspace; an MCP grant exceeded; a high-impact confirmation bypassed; stored XSS behind authentication |
| **Low** | Information disclosure with limited impact; an existence oracle in a refusal path; a missing defence-in-depth control with a demonstrated but minor attack |

---

## Coordinated disclosure

The request is simple: **give the fix time to exist before the exploit is public.**

- Please hold public disclosure until a fix has shipped, or **90 days** from acknowledgement,
  whichever comes first.
- If a fix is going to take longer than 90 days, you will be told why before day 90, and asked
  whether you are willing to extend rather than simply informed that the date has moved.
- If a vulnerability is already being exploited in the wild, that clock does not apply. Say so
  and the timeline becomes as short as the fix can be made.
- Advisories are published through
  [GitHub Security Advisories](https://github.com/jackeddisciple/jaroku/security/advisories) and
  recorded in [CHANGELOG.md](CHANGELOG.md), with a CVE requested where one is warranted.
- Please do not publish exploit code for a still-unpatched issue, and do not test against
  instances you do not own.

---

## Safe harbour

Good-faith security research on your own instance is authorised, and no legal action will be
pursued over it, provided that you:

- test only against instances **you own or have written permission to test**;
- avoid privacy violations, data destruction, and any degradation of a service others rely on;
- access only the minimum data needed to prove the finding, stop as soon as it is proven, and do
  not save, copy, transfer or otherwise retain what you saw;
- report promptly and privately through a channel above;
- give the coordinated disclosure window above a chance to run.

This authorisation covers this project only. It cannot waive the rights of third parties such as
your OIDC provider, your hosting account, or an MCP server operator, so do not test their systems
in the course of testing this one. If you are unsure whether something is in bounds, ask by email
first; a question is always in bounds.

---

## Recognition

There is **no paid bug bounty.** This is an open-source project with no security budget, and
saying so plainly is fairer than leaving it implied.

What is offered instead:

- **Credit in the security advisory and in [CHANGELOG.md](CHANGELOG.md)**, in whatever name or
  handle you choose, or anonymity if you prefer it.
- **A named acknowledgement in the release notes** for the version carrying the fix.
- **Public confirmation of the timeline** (when you reported, when it was fixed) for anyone who
  needs to demonstrate responsible disclosure practice.

Tell the maintainer which you want in your report; the default is credited by the name on the
report, and no name is published without asking first.

---

## Hardening the deployment you run

Not a substitute for the fixes above, but the difference between a safe instance and an exposed
one is mostly configuration:

- **Keep it on localhost.** The server binds localhost for a reason. Do not put it behind a
  public reverse proxy until the sandbox and rate limiting land.
- **Never set `JAROKU_DEV_AUTH=1` outside development.** It opens sockets with no credential at
  all. It refuses to start under `NODE_ENV=production` and announces itself at every boot;
  believe the announcement.
- **Never set `JAROKU_SERVE_PUBLIC=1`** unless you intend an unauthenticated agent endpoint
  running on your provider key. An open one is an unmetered way for a stranger to spend your
  money.
- **Set `NODE_ENV=production`** for anything that is not a laptop. Several development
  facilities, including the local issuer, refuse to run under it.
- **Keep `runtime/.env` at `chmod 600` and out of version control.** It is the development
  secret store and is one file with no workspace in it, which is why `JAROKU_SECRET_STORE=dotenv`
  refuses to run under `NODE_ENV=production` — see [storage isolation](README.md#storage-isolation).
  It is gitignored and
  `.dockerignore`d; keep it that way, and check any image you build.
- **Scope every provider and connector key to the minimum it needs**, and give agents the
  narrowest MCP grant that works. The manifest is the grant.
- **Rotate the deployed agent's bearer token** if it was ever shown on a shared screen. It is
  displayed once, by design.
- **Read an MCP server's tools before granting them.** Jaroku badges them as unreviewed because
  nobody here has reviewed them; you are the reviewer.
- **Rotate any key that appeared in a terminal, a screenshot or a bug report**, including ones
  you believe were redacted.

---

*Last reviewed: August 2026. Questions about this policy, as opposed to a vulnerability report,
are also welcome at **adarshhchoudhary1@gmail.com**.*
