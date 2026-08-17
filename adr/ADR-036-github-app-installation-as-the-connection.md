# ADR-036: Connect GitHub as an App installation, and mint the credential per hour

## Status

Accepted — v0.2.16. Replaces the pasted personal access token that ADR-026's credential rule was
applied to in v0.2.15. The token path is retained in the server and disconnected from the UI; see
*Decision* for the two deployments that still need it.

## Context

v0.2.15 connected GitHub the way this codebase connects everything else that is not an OAuth
connector: a person pastes a token, it goes one way into the vault behind the Secrets passcode, and
what comes back is an account login. That was a defensible shape and it is the wrong one, for a
reason that is not about onboarding.

**The Checks API is only available to GitHub Apps.** `POST /repos/{repo}/check-runs` answers 403
"You must authenticate via a GitHub App." to every personal access token — classic or fine-grained,
`checks: write` ticked or not. Addendum B §B.1 is a check run carrying a rendered pass-rate table
on a pull request; under token auth it could not be posted at all. The product shipped a fallback
that squeezes the numbers into a commit status's 140-character description, which is a real gate
and is not the feature that was specified. No amount of scope-ticking reaches the capability,
because the capability is gated on the kind of actor rather than on a permission.

Three further defects were observed against real GitHub while testing the token path, and each is
a property of tokens rather than a bug that could be fixed:

- **A fine-grained token is scoped to repositories that already exist.** §2.2's flagship flow
  creates a new repository for an agent — one that did not exist when the token was minted. With
  "Only select repositories" the headline feature is unreachable by construction, and the only way
  out is "All repositories", which is the opposite of least privilege. The connect screen's own
  copy recommended the configuration that cannot work.
- **The permissions are four checkboxes on two different screens**, and missing any one surfaces
  three screens later: Contents for the push, Workflows for the generated `jaroku-build.yml`,
  Administration for repository creation, Checks for reading the gate back. This was hit twice in
  one testing session by the people who wrote the feature.
- **A token expires and nothing can renew it.** Every link goes ⚠ and the only recovery is a person
  pasting a new value.

The constraint that narrowed the field: whatever replaces this must not require a credential in a
text field at any point, including the deployment's own — otherwise the copy-paste has been moved
up a level rather than removed.

## Decision

Connect GitHub as a **GitHub App installation**, registered through GitHub's **app manifest flow**,
holding **two tokens** with a rule about which calls use which.

**Registration is a manifest, not a form.** The server serves a manifest describing the App —
name, callback URLs, webhook URL, permissions, events — and the browser POSTs it to
`github.com/settings/apps/new`. GitHub shows one confirmation screen; a person presses Create;
GitHub redirects to `/v1/github/app/registered` with a one-time code that is traded for the App's
id, slug, client secret, webhook secret and **private key**. The key is written to `runtime/.env`
base64-encoded — `setEnvVar` refuses a newline and a PEM is nothing but newlines — and into the
live process, so the next request can use it without a restart. **Nobody ever sees the key.** This
is the load-bearing detail of the whole record: registering an App by hand ends in downloading a
`.pem` and putting it somewhere, which is the copy-paste this decision exists to delete.

**Seven permissions, declared in source.** `contents: write`, `workflows: write`,
`administration: write`, `pull_requests: write`, `checks: write`, `statuses: write`,
`metadata: read`. `checks` is **write** and that is load bearing: §B.1 posts a check run, and a
read-only checks permission would leave the panel able to see checks and unable to publish one —
the exact failure this decision is being taken to end, arrived at from the other side.
`githubApp.test.ts` asserts each by name and asserts that there are exactly seven, so an eighth
cannot appear without an argument.

**Two tokens, because GitHub has two.** An installation access token can do everything to a
repository and nothing about a user: `GET /user`, `GET /user/repos` and `POST /user/repos` all
refuse it, and the third of those is "Create new repo". So the App also sets
`request_oauth_on_install`, the install redirect carries a `code` alongside the `installation_id`,
and that code is exchanged for a **user-to-server token**. Exactly three calls travel on it — the
account line, the repository picker's availability check, and repository creation. Everything that
touches a repository travels on the installation token.

**`apiFor()` remains the one place a token is resolved.** It branches on
`github_installations.github_installation_id`: present means mint from the private key, absent
means the personal-access-token path. `userApiFor()` is its sibling for the three user-scoped
calls and falls through to `apiFor()` on the token path, where the distinction does not exist.
`githubApi.ts` did not change — it is a transport that takes a token string, and it stays one.

**The installation token is cached against GitHub's own expiry and never longer**, with sixty
seconds of skew. This does not weaken ADR-033's discipline: what `githubIdentity` refuses to cache
is *authority* — whether the grant is still live, which is re-read from the database on every call
— and what is cached here is a credential GitHub will itself reject in an hour whatever this
process believes.

**The token path is kept and disconnected from the UI.** Two deployments still need it and neither
can use an App: **GitHub Enterprise Server**, and a **self-hosted install with no callback URL a
browser can reach**. `POST /v1/github/connect` and `connectGithub()` are intact, documented as the
Enterprise answer, and reachable from nothing the user can click.

## Alternatives Considered

### Option 1: A GitHub App installation, registered by manifest — the option that was chosen

- Pros: the Checks API becomes reachable, which is the only way §B.1 exists as specified;
  repository selection happens in GitHub's own UI and can be changed later without re-issuing
  anything; the webhook arrives configured, so §B.1.2's trigger stops being per-repository manual
  setup; installation tokens are short-lived and server-minted, so nothing long-lived is stored and
  nothing expires under a user; commits are attributed to a bot identity rather than to a person;
  the manifest means the permission list lives in this repository under review rather than in
  instructions a user follows.
- Cons: a callback URL a browser can reach is now a deployment requirement; a private key exists on
  the server and is a thing to protect; the flow has three round trips rather than one paste, and
  the first person on a fresh deployment sees one extra confirmation screen; two token types is
  genuinely more machinery than one.

### Option 2: An OAuth App

- Pros: one token type, no private key, no installation concept, and the same "log in and
  authorise" front door — which is most of the onboarding benefit for a fraction of the work.
- Cons: **an OAuth App cannot write check runs either.** It is a user-shaped actor, exactly as a
  personal access token is, so §B.1 stays unreachable and the entire motivation is unmet. It also
  grants across every repository the user can reach rather than a selected set, which is the same
  blast-radius problem the fine-grained token was introduced to avoid.

### Option 3: Keep the personal access token and fix the copy

- Pros: no new moving parts, no callback URL, no key to hold, and it works on GitHub Enterprise
  Server today. The connect screen's misleading recommendation is a one-line fix.
- Cons: §B.1 remains permanently degraded to a commit status; "Create new repo" still forces "All
  repositories" or a manual add step GitHub offers no API for; the four-checkbox setup keeps
  producing failures three screens from their cause; and tokens keep expiring with a paste as the
  only recovery.

## Consequences

### Positive

- §B.1's eval check posts as a check run, with the title and summary GitHub renders inline. This is
  the capability the decision was taken for and it is asserted end to end in
  `githubAppFlow.test.ts`.
- `github_installations` holds no repository credential on the App path. `token_secret_name` carries
  the sentinel `__github_app_installation__`, so a database dump contains an installation id and
  nothing that can be turned into access.
- A person connects by pressing one button and choosing repositories on GitHub's screens. What they
  approve is described by GitHub, in GitHub's words, from a manifest under version control.
- Repository access can be widened or revoked from GitHub settings without touching Jaroku.

### Negative

- A deployment must be reachable at a stable URL before it can register an App. `JAROKU_PUBLIC_URL`
  exists for this and defaults to `http://localhost:{PORT}`, which is correct for a laptop and
  wrong for production if nobody sets it.
- The private key is a platform secret in `runtime/.env`. It is not in the vault, because the vault
  is per workspace and this key belongs to the deployment; storing it per tenant would mean writing
  one secret many times and answering "whose is it" with a lie.
- Two token types is a rule somebody will eventually try to simplify away. The three user-scoped
  calls are named in `githubApp.ts`'s header and asserted in the flow suite for that reason.
- A repository created a moment ago is **outside** a "selected repositories" installation, and
  GitHub's add-a-repository endpoint takes only a classic PAT — an App's user token cannot call it.
  `link()` therefore verifies visibility after creating and refuses with the settings URL rather
  than letting the push 404 later. Recommending "All repositories" at install avoids it entirely.

### Trade-offs

- Given up: a connect flow that works with no callback URL and no registration. Bought: the Checks
  API, revocable per-repository scope, and credentials that expire on a clock instead of on a
  person noticing.
- Given up: one credential path to reason about. Bought: GitHub Enterprise Server support, which
  the App flow cannot serve.

## Implementation Notes

- `server/src/githubApp.ts` — the App's identity: manifest, JWT (RS256, `iat` backdated sixty
  seconds because it is compared against GitHub's clock), installation-token minting and cache,
  user-token exchange and refresh, and the single-use round-trip states.
- `server/src/http/githubApp.ts` — three routes. `/v1/github/app/start` is **guarded** and takes
  its workspace from the caller's own token; the two callbacks are redirect targets with no
  Authorization header available to them, and the single-use state issued by `/start` is what
  stands in for one.
- `server/src/githubIdentity.ts` — `installApp()`, `apiFor()`, `userApiFor()`. This is the only
  file that knows there are two kinds of grant.
- Migration `042_github_app_installation` adds `github_installation_id` and the three user-token
  columns. `token_secret_name` stays `NOT NULL` so the token path is untouched.
- `/start` requires `secret:manage` but **no elevation**, deliberately. Storing a pasted token wrote
  a credential and therefore needed an unlocked Secrets session, which meant the first thing a new
  user saw after pressing Connect was "this needs an unlocked Secrets session". Starting an install
  writes nothing; the credentials arrive later, from GitHub, on a callback.
- The easy mistake: capturing `githubAppConfig()` at boot. Registration writes into the live
  process, so a captured config leaves the server believing it has no App on the request that just
  created one. It is read through a function for that reason.

## Security Considerations

- The private key signs a JWT and is not held beyond the call. It is never logged, never returned,
  and never placed in an error message.
- The manifest conversion code is single-use on GitHub's side. The fixture enforces the same rule,
  because a replayable conversion hands the App's private key to whoever replays it.
- The round-trip state is single-use with a ten-minute life and carries the workspace **server
  side**. A callback that took a workspace from its query string would let anybody who can reach
  the port attach an installation to a tenant they are not in.
- The installation id in the install callback arrives from a browser and is therefore untrusted:
  the account it belongs to is established by asking GitHub, which also proves the App can address
  the installation before a row claims it can.
- **What this does not protect against:** anybody who can read `runtime/.env` on the server can act
  as the App for every workspace on that deployment. That is the same exposure the Anthropic key
  and the Stripe secret already have, and it is the reason the file is chmod 600 — but it is a
  wider blast radius than a per-workspace token, and it is the honest cost of a platform
  credential.

## Performance Considerations

- One token mint per installation per hour, cached in memory per process. A push that previously
  cost one vault read now costs one vault read's worth of nothing and, at most once an hour, one
  extra round trip to GitHub.
- The cache is per process. Several replicas mint separately, which is correct rather than wasteful:
  a shared cache would be a shared credential store with a coherence problem.

## Operational Considerations

- Set `JAROKU_PUBLIC_URL` before registering in production. The manifest bakes the callback URLs in
  at registration, so a change means re-running the one-click registration — thirty seconds, and no
  code change.
- Re-registering writes fresh `JAROKU_GITHUB_APP_*` values. Clear the old ones first, or the server
  will keep using the App it already knows about.
- `JAROKU_GITHUB_API` and `JAROKU_GITHUB_WEB` point the whole flow at the fixture, which implements
  the App surface including GitHub's two browser screens. The install path can therefore be
  exercised on a laptop with no GitHub account at all.
- Three in the morning: the panel says ⚠ and the reason names the installation. Either somebody
  uninstalled the App on GitHub — the row is revoked with GitHub's own refusal quoted — or this
  server has forgotten which App it is, which means `runtime/.env` lost its `JAROKU_GITHUB_APP_*`
  lines and the fix is to register again.

## Rejected Alternatives

**Do not propose an OAuth App as a simpler equivalent.** It is simpler, and it does not have the
one property this decision exists to obtain: check runs are App-only, and an OAuth App is not an
App in that sense. Adopting it would mean re-shipping the commit-status fallback as the permanent
answer for §B.1, which is the state this record is superseding.

**Do not propose deleting the personal access token path** on the grounds that nothing in the UI
reaches it. It is the only answer for GitHub Enterprise Server, whose users cannot register an App
against github.com, and for a self-hosted deployment behind a firewall with no callback URL a
browser can reach. It costs one branch in `apiFor()` and it is tested.

**Do not propose caching the installation token for longer than GitHub's expiry** to save a round
trip. The expiry is the security property: a credential that outlives the grant is exactly what
this decision replaced.

## Related Decisions

- ADR-026: Handle credentials so that names travel and values do not — the rule the token path was
  built to satisfy, and the reason the installation path stores no credential at all.
- ADR-033: Give the secret store no method that returns a plaintext value — why the user token goes
  into the vault and the App's private key does not.
- ADR-020: Provider agnostic OIDC with a local issuer — the resolver `/start` uses to take a
  workspace from a caller rather than from a query string.
- ADR-027: Deploy into the user's own hosting account — the same principle one layer over: the
  user's account holds the thing, and Jaroku is granted access to it.

## References

- `server/src/githubApp.ts`, `server/src/http/githubApp.ts`, `server/src/githubIdentity.ts`
- `server/migrations/{postgres,sqlite}/042_github_app_installation.sql`
- `server/src/githubApp.test.ts` (`npm run test:github-app`) — the permission list as an assertion
- `server/src/githubAppFlow.test.ts` (`npm run test:github-app-flow`) — register, install, mint,
  post a check run
- `server/fixtures/github/mockGithubApi.ts` — the App surface and GitHub's two browser screens
- `CHANGELOG.md`, v0.2.16
- GitHub REST documentation: "Create a check run" (write access to checks is available only to
  GitHub Apps); "Create a repository for the authenticated user"; "Registering a GitHub App from a
  manifest"; "Add a repository to an app installation"
