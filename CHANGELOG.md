# Changelog

All notable changes to Jaroku are recorded here, newest release first.

The format follows [Keep a Changelog](https://keepachangelog.com/) conventions, and versions
follow [Semantic Versioning](https://semver.org/). Every entry is drawn from the published
release notes and the commits in that release's range.

---

## v0.2.17 : Threads, Documented — and Thirty-One Defects an Adversarial Read Found

v0.2.16's release was shipped on a green suite and then pointed at real GitHub, and nine defects
fell out in the order a user would hit them. This release is the same exercise run against source
rather than against a server: four adversarial passes over the whole repository, deepest on the
newest surface, with every finding anchored to a file and a line and three of them reproduced with
runnable scripts.

The pattern the passes kept finding is not "this function is wrong". Every unit under review had a
suite and passed it. What failed was the wiring between units: a guard separated from the flag it
reads by an `await`, a client that never sent a field the server had accepted from the first day, a
broadcast wired to the events that *start* work and to almost nothing that ends it, three
subsystems that assert idempotency in a comment and do not have it in the code. Sixteen suites were
extended to hold each of those down, several of them structurally — over the source rather than over
a function — because a green test about an unwired thing is worse than no test.

Threads also stops being undocumented, which was itself one of the findings: a sidebar destination,
a full-screen view, two tables, a channel and six commands, invisible to anybody reading the docs.

### Added

- **A `## Threads` section in the README**, between the fix loop and Debug depth: what a build
  session is, §3.3's five statuses and their precedence, why ownership and liveness come from
  different places, why a thread is archived and never deleted, and how a per-session cost is
  attributed and made to move while work does.
- **The `threads` and `github` channels in the WebSocket protocol reference**, with their six and
  eighteen commands. Both were missing — the table listed nineteen channels where the relay defines
  twenty-one — and the GitHub omission was a release older than the Threads one.
- **The twelve thread suites in the tests index**, six server and six client, each with the line
  that says what it is for.
- **`live_eval_ids` on a thread row and `spentDeltaUsd` on `evalProgress`**, which is what makes
  §4.3.3's own worked example reachable — see below.
- **Migration 045**: one live check run per `(workspace, agent, pull request, commit)`, as a
  partial unique index.
- **Migration 046**: `github_events.delivery_id` with a partial unique index, and
  `github_links.remote_seen_at`.
- **A schema-driven completeness audit for retention**, the one `export.test.ts` already had: every
  workspace-scoped table is swept or explicitly exempted with a stated reason, and the suite reads
  the schema rather than a list somebody maintains by remembering.
- **A structural audit that every §3.3 transition refreshes the thread list**, by handler rather
  than by counting call sites — and that eval progress does *not*, which would make a full-snapshot
  channel a polling one.

### Fixed

**Cross-tenant state.**

- **Single-slot guards were TOCTOU checks.** `editAgent`, `planAgent` and the planned half of
  `generateAgent` read `editor.inFlight` / `planner.inFlight` / `generating` and then awaited a
  provider-key lookup before anything set them — so two workspaces both passed, and the second
  repointed the scope the first was still streaming source files and proposal diffs into. The slot
  is taken in the same synchronous statement as the guard, every refusal hands it back, and
  `test:channels` now fails on an `await` between the two rather than only on their ordering.
- **One pending plan for the whole process.** `plan()` cleared the slot regardless of owner, so
  workspace B describing an agent silently destroyed A's plan card — A's Generate answered "that
  plan is no longer available" with nothing to explain it, and the `discarded` event carrying A's
  plan id was routed by the planner's current scope, which by then was B's. One slot per workspace;
  superseding scoped to the asker; the event names its own tenant.
- **A run's trace was attributed by envelope and trusted by body.** The pool attributes every line
  to the slot that produced it, and nothing compared that against the ids *inside* the event —
  `insertStep` binds `step.run_id` verbatim and `upsertRun`'s `ON CONFLICT` is scoped only by
  workspace. A sandbox holding its own valid run token could flip another run in the same workspace
  to `completed`, restate its cost, or inject steps into it. The two are reconciled at both ingest
  boundaries, and `isTraceEvent` checks the payload it used to accept as a bare `kind`.

**Threads, which was half-wired.**

- **Two threads on one agent showed one conversation.** The relay defined `threadId` on six
  commands and the server honoured it; no client sender ever set one, `chatStore` keyed
  conversations by agent id, and `loadThread` answered a row with no turns. So work landed in
  whichever session was touched last, and reopening a thread after a reload showed nothing. Every
  event on the gen / edit / reply channels now names its session on the envelope, the conversation
  is keyed by it, `loadThread` carries the thread's items, and selecting an agent resolves the same
  session `ensureForAgent` would.
- **A refused generation blocked its thread forever.** The mark was keyed by generation id, and the
  only id in hand when a generation starts is the one just minted — so the clearing `delete` was a
  guaranteed no-op and the §2.1 badge only ever counted up. Keyed by thread instead.
- **A momentarily-absent agent directory detached its threads permanently.** The sweep is a *soft*
  delete that `upsertFromDisk` reverses; nulling `threads.agent_id` was not, so a replica that had
  not materialised the directory left a live agent's sessions reading `(deleted)` forever and
  opened a duplicate beside each. §3.2 is a join now.
- **A failed run left its thread reading `● running` indefinitely.** `noteThreadItem` was the only
  broadcast point and an item is written when work *begins*; fourteen of the transitions §3.3
  derives from pushed nothing at all. Run end, exit, spawn error, both MCP-confirm edges, plan
  discard, eval finish and deploy settle all refresh now, coalesced on a short timer.
- **§4.3.3's live and projected cost was structurally unreachable for an eval.** Eval runs are kept
  off `trace` so a sweep cannot steal the timeline's focus, and `trace` is the only channel the
  client incremented from; `evalProgress` carried counts and no cost; and the sole snapshot is taken
  at eval start, where `done` is 0 and `projectCost` correctly refuses to extrapolate. The two
  halves were mutually exclusive in the shipped product.
- **Opening Threads scanned the workspace twice.** The snapshot builder and the fact collector each
  listed every thread and read the whole `thread_items` table, and `runOutcomes` read every run plus
  a `GROUP BY` over every errored run's steps to answer about the handful a thread owns. One read of
  each, shared; the run query narrowed to the ids already in hand; the status write-back batched per
  status instead of awaited per row.
- **`thread_items` had no retention path**, which made it the one table in the schema that only ever
  grew — and it is read in full on every snapshot. Rows outlived the runs they named, and §3.3 gives
  up on a run it cannot find, so a thread that ended in error quietly became `idle` the day its run
  expired.
- **Auto-titling lost a race into no title at all.** It read the message count back and fired only
  on exactly one, so two first messages landing before either read left the row `Untitled thread`
  permanently, unfindable by §4.4's text filter. It titles from the first message row instead, which
  is idempotent.
- **A rename that kept the auto-title was discarded.** Somebody who opened the editor, agreed with
  the title and pressed Enter left `title_is_custom` at 0, and the next message re-ran `autoTitle`
  over a title they had chosen.
- **§5's `⌘Enter` rename was never implemented**, leaving renaming mouse-only in the one view whose
  §4.7 rule is that it must not be.
- **`+ New thread` created a row nothing could be filed into.** The server already answers the
  asking socket with the row it just made; the client only filed it, so every press added a
  permanently empty, permanently untitled thread.
- **"Go to thread…" listed archived rows**, which is the one place §3.4 says they must not appear.
- **The Team author column had no names.** `sendListMembers` was exported and never called, and
  `setMembers`' only caller is the broadcast that fires after a membership *mutation* — so the list
  was empty for the life of a tab and §4.3's author rendered nothing in exactly the case §6 built it
  for. The initial snapshot carries it for a Team workspace.
- **Thread refusals were broadcast to the whole workspace**, carrying raw driver text: one member's
  malformed command painted a red strip across every teammate's view. They go to the asking socket,
  with a fixed sentence and the real one in the log.
- **A disconnected user was told a thread was archived that was not.** `send` dropped writes with no
  signal and §3.4's notice was written *before* it.
- **The resume scroll re-ran on every change to the conversation**, so typing a follow-up into a
  thread with a pending diff yanked the view back to the old diff on every streamed frame.
- **The agent chip went stale on rename**, showing the old name beside a sidebar showing the new one.
- **A thread title had no length bound**, and a non-string rename was coerced into `"[object
  Object]"`.
- **`ThreadStore.list`'s comment promised a driver-parity ordering the query did not have.**
- **The collision marker counts `errored` and its own wire documentation said it did not.** Both
  deviations from the spec's letter are now stated where they are read.

**Idempotency that was claimed rather than enforced.**

- **Double-clicking Apply published two versions from one proposal.** The pending record was deleted
  after two awaits, so both clicks read the same `current_version`, both passed the staleness guard
  directly above them, and both published — `current_version` jumped by two and Undo had to be
  pressed twice. It is claimed synchronously now, and the diff card disables its own buttons.
- **A redelivered `pull_request` webhook opened a rival check and a second paid eval.** Superseding
  excludes the same head sha by construction, and the only dedup was a per-process `Set` no restart
  or second replica survives.
- **A redelivered push appeared twice in History**, and two delivered out of order left the earlier
  head — with the panel's behind/ahead badge measuring against it.
- **The MCP confirmation modal had no in-flight state**, so a second click (or a held Escape, which
  repeats) put "that confirmation is no longer waiting" in front of every teammate. A closed socket
  also dropped the answer in silence, and `mcp_bridge`'s clock denied the call somebody watched
  themselves allow.
- **A reconnect timer armed before a workspace switch opened a second socket.** Both dispatched every
  broadcast into the same stores, and the orphan's close nulled the shared handle, silently dropping
  every command after it. `addStepCost` also carries the step id now, so duplicate delivery from any
  cause counts once — it was the one consumer of `trace` that accumulated blindly.
- **`invoice.payment_failed` read an invoice's metadata as a subscription's**, writing
  `plan_id = 'free'` over the paid plan and nulling the period end with it.

### Removed

- **`hoursOutstanding` and `STALE_HOURS`**, which existed for §4.2's "exact age past a day" and had
  exactly one reader: their own test. The refinement is served without them — `relTime` renders
  `4d ago` whatever the age — and a green suite over something nothing imports is worse than none.

---

## v0.2.16 : The GitHub App, and the Integration's First Contact With Real GitHub

The GitHub feature was written against a fixture and merged on a green suite. This release is what
happened when it was pointed at github.com: a repository created through the panel, pushed to,
opened as a pull request, and watched through a build check. Nine of the defects below were found
that way, in the order a user would have hit them, and each one is a case where the fixture was
more permissive than the thing it stood in for.

The headline change follows from the same exercise. `POST /check-runs` answers 403 "You must
authenticate via a GitHub App." to every personal access token — classic or fine-grained, scope
ticked or not — so §B.1's eval check could not be posted at all under the credential model v0.2.15
shipped. Connecting GitHub is now a GitHub App installation. There is nothing to paste, including
for the deployment's own key.

### Added

- **Connect GitHub as an App installation**, registered through GitHub's app manifest flow. The
  server serves a manifest; the browser POSTs it; a person presses Create on GitHub's own screen;
  GitHub redirects back with a one-time code that is traded for the App's id, client secret,
  webhook secret and private key. The key is written to `runtime/.env` base64-encoded — `setEnvVar`
  refuses a newline and a PEM is nothing but newlines — and into the live process, so the next
  request can use it without a restart. **Nobody ever sees it.** Registering an App by hand ends in
  downloading a `.pem` and putting it somewhere, which is the copy-paste this release deletes,
  moved up one level.
- **Seven permissions, declared in source and asserted in a suite**: `contents`, `workflows`,
  `administration`, `pull_requests`, `checks`, `statuses` write, `metadata` read. `checks` is
  **write**, which is the whole point — a read-only checks permission leaves the panel able to see
  check runs and unable to publish one. `test:github-app` asserts each by name and that there are
  exactly seven, so an eighth cannot appear without an argument.
- **Two tokens, because GitHub has two.** An installation access token can do everything to a
  repository and nothing about a user: `GET /user`, `GET /user/repos` and `POST /user/repos` all
  refuse it, and the last is "Create new repo". The App requests user authorization at install, and
  exactly three calls — the account line, the availability check, repository creation — travel on
  the resulting user-to-server token. `apiFor()` is still the one place a token is resolved, and
  `githubApi.ts` did not change: it takes a token string and stays a transport.
- **Installation tokens minted per hour and cached against GitHub's own expiry**, with sixty
  seconds of skew. Nothing long-lived is stored: on the App path `github_installations` holds an
  installation id and the sentinel `__github_app_installation__`, so a database dump contains no
  repository credential at all.
- **The fixture speaks the App protocol**, including GitHub's two browser screens — manifest
  conversion with a real generated RSA key, token minting with GitHub's one-hour expiry,
  `/installation/repositories`, the OAuth exchange, and the create and install pages. The whole
  connect flow runs on a laptop with no GitHub account. `JAROKU_GITHUB_WEB` joins
  `JAROKU_GITHUB_API`, because GitHub has a web host as well as an API host and the token exchange
  lives on the first.
- Suites: `test:github-app`, `test:github-app-flow`, `test:github-first-push`,
  `test:github-checks-line`, `test:check-runner`.
- ADR-036 records the decision, the two alternatives, and what it costs.

### Changed

- **The connect screen is one button.** The password field is gone, and so are the two paragraphs
  telling people which token to make. Those paragraphs recommended a fine-grained token scoped to
  selected repositories — the one configuration that cannot create a repository, which is the
  option immediately beside them. The permissions are now declared by a manifest under review and
  described by GitHub on its own approval screen.
- **The personal access token path is retained and disconnected from the UI.** It is the only
  answer for GitHub Enterprise Server and for a self-hosted deployment with no callback URL a
  browser can reach. `POST /v1/github/connect` and `connectGithub()` are intact and documented as
  such; nothing the user can click reaches them.
- **Starting an install needs no elevation.** Storing a pasted token wrote a credential and
  therefore required an unlocked Secrets session, which meant the first thing a new user saw after
  pressing Connect was "this needs an unlocked Secrets session". An install writes nothing — the
  credentials arrive later, from GitHub, on a callback — so the capability check is the gate.
- **CI runs the GitHub suites.** `package.json` had a script for every one of Addendum B's twelve
  and the workflow listed three, so the secret scanner, the provider boundary, the restack and the
  eleven live rules merged on whoever last ran them by hand. All of them now run, plus
  `test:mcp-impact`, which the Agent diff reads directly.

### Fixed

- **The first push into a repository Jaroku had just created could not work.** GitHub's Git Data
  API answers 409 "Git Repository is empty" to blobs, trees and commits against a repository with
  no commits, and `createRepo` asks for one with `auto_init: false`. The initial commit is now
  written through the Contents API — the one endpoint GitHub accepts there — to the repository's
  own default branch, never to `jaroku/<slug>`, because seeding Jaroku's branch in an empty
  repository makes it the default branch.
- **A first push wrote a commit with no parents**, which is an orphan branch. GitHub refuses to
  open a pull request between one and `main` (422, no merge base) and refuses to compare them
  (404) — so §3.9's PR card, §3.7's divergence detection and the entire reconciliation path §3.1
  calls the only one were unreachable, while every screen still read as though they worked. The
  branch is now rooted on the default branch's head.
- **"✓ checks passing" read an endpoint that cannot see checks.** The combined-status API returns
  commit statuses; GitHub Actions and §B.1 both write *check runs*. Measured against this
  repository's own latest commit: statuses `total_count: 0`, check-runs 2, both failing. Both
  mechanisms are read now, and failure outranks pending outranks success.
- **A token that may not *read* checks is not a repository without any.** A 403 from the check-runs
  endpoint rendered as "no checks reported" — word for word what a repository with no CI shows —
  over a build that had just gone red. It says so, and names the permission.
- **Every pull request got a second check run stuck at `queued`.** The GitHub id was read off the
  row object before `attachGithubId` wrote it, so the in-progress update created rather than
  patched. On a repository where the check is required, that is a merge button that never unlocks.
- **Cancelling a superseded check renamed it.** A PATCH carrying a `name` renames the run, and the
  cancel path sent a generic one because `check_runs` stores an id rather than a title. It sends
  none, and GitHub keeps the name.
- **One repository refusing a write revoked the workspace's whole GitHub grant.** 403 and 401 shared
  a failure kind, so a fine-grained token scoped elsewhere — a credential working perfectly
  everywhere else — tripped `markRevoked`. The panel dropped to "Connect GitHub" and took every
  other agent's link with it. A 401 means the credential is gone; a 403 means it is not allowed
  *here*.
- **"Include Dockerfile & pyproject" pushed no Dockerfile.** It was a filter over files the deploy
  path only synthesises when a deploy is prepared, so an agent nobody had deployed pushed nothing
  extra — and the workflow §B.6.2 generates then ran `docker build` against a Dockerfile that was
  not there. The first pull request the feature ever opened went red for that reason. The artifacts
  are rendered at push time into the tree, never into `agent_versions`.
- **The build check was never written for the repositories it exists for.** `link()` writes the
  workflow to the default branch, and a repository created a moment earlier has none — so it
  correctly declined and nothing followed up. It is now ensured after the first push, idempotently.
- **`036` and `037` could not apply on Postgres.** `ci_dataset_id` and `eval_run_id` were declared
  `uuid` against `datasets.id` and `eval_runs.id`, which are `text` from migration 002 — a foreign
  key with no equality operator between its sides, which Postgres refuses as "cannot be
  implemented" without naming which column it means. This failed the entire server job, which is
  why every commit since had a red cross.
- **The workspace export was missing Addendum B's five tables.** `agent_ci_config`, `check_runs`,
  `shadow_runs`, `pr_comments` and `secret_scan_findings` are the measurement history, the
  provenance of a run, a review, and the only record that anybody ever pushed over a credential.
- **`diagnosticsStore` was not emptied on a workspace switch.** Its keys are `agentId\0path` — a
  path out of another tenant's project — and the agent uuid in one can never be asked for again, so
  nothing would ever overwrite it.
- **Two suites skipped on the wrong question.** They tested for `runtime/pyproject.toml`, which is
  in every checkout including one with no Python, and the analysis they need fails *silently* by
  design. They now ask by running it.
- **`history()` had no order.** Replacing an enforcement rung lifts the previous row with the new
  row's timestamp, so two rows share `applied_at` whenever the ladder moves — and the reader that
  asks "what is this workspace under" got the lifted one about half the time. Visible as one suite
  failing on one driver and passing on the other inside a single CI run.

### Migrations

- `042_github_app_installation` — `github_installation_id` and three columns for the user-to-server
  token on `github_installations`. `token_secret_name` stays `NOT NULL` so the token path is
  untouched; an App row writes a sentinel rather than a null, because a person reading this table
  in a console should get a sentence.
- `036` and `037` are corrected in place rather than superseded. Neither had ever applied
  successfully on Postgres — the CI job died on the first of them — so no database anywhere holds a
  checksum for the old text.

### Verification

- The whole flow was exercised against github.com: a repository created through the panel, an
  initial commit, a branch rooted on it, a push carrying §B.8.1's trailer block, the generated
  workflow written to `main`, a pull request opened from the panel, and a build check observed
  going from red to green once the artifacts fix landed.
- The App flow was exercised end to end against the fixture — register, install, mint, and post a
  check run that is a check run rather than the commit-status fallback.
- CI is green, and runs nineteen GitHub suites where it previously ran three.

---

## v0.2.15 : GitHub Integration

Jaroku already had a version lineage. Git has one too. This release is not "git inside Jaroku" —
it is the place where the relationship between the two is legible at every moment, and every
decision in it follows from treating GitHub as a second lineage rather than as a file store.
Jaroku owns `agent_versions`; the repository owns its commits; the panel's job is to say what each
side has that the other does not, and to never resolve that on anybody's behalf.

### Added

- **A GitHub tab**, per agent, with four regions in one deliberate order — identity, verdict,
  changes, history. "Am I okay?" is answered in the second region without scrolling, and everything
  below it exists to explain that answer. All four are views of ONE reconciliation, computed
  together and sent as one snapshot, because a panel that can show "in sync" above two unpushed
  versions has broken the only promise the feature makes.
- **Linking**, to a repository created on the spot or an existing one, with a branch, an optional
  subdirectory for monorepos, and a checkbox for the deploy artifacts. The existing-repo list is
  filtered server-side to repositories the token can WRITE to — offering a read-only one would
  produce a successful link whose first push fails, which moves a refusal from the moment of
  choosing to the moment of working.
- **Six sync states and exactly six**, each with one primary action: `unlinked`, `in_sync`,
  `ahead`, `behind`, `diverged`, `broken`, plus `syncing` while a request is in flight. Ahead is
  counted in VERSIONS, locally, exactly. Behind is counted in COMMITS, remotely, and is only ever
  approximate until somebody fetches — so an uncounted "behind" renders as `↓` rather than as `↓0`,
  which is a different claim.
- **Push, as the Git Data API and not the contents endpoint.** `PUT /contents` writes one file per
  commit, so a version touching three files would be three commits and two intermediate states that
  never existed. A tree, a commit object and one ref move means the whole version lands or none of
  it does. One commit per version by default; squash is opt-in per push and never a stored
  preference, because the lineage is the product's own record and a default that collapsed it would
  be the feature undoing its own premise.
- **Pull, held to the identical bar as generated code.** The remote tree is staged as a candidate
  version and put through the same parse · import · contract validation every generation passes.
  A failure is a refusal, not a warning: the candidate is discarded, the pointer never moves, and
  the card says which file, which check, and that the agent is unchanged.
- **Protected paths**, enforced against a third door. Reviewed connector templates, the MCP bridge
  and its manifest are read-only in the edit loop and in the object store; a pull is the one route
  into them that comes from outside the product entirely, and a remote hand-edit to them is refused
  rather than applied.
- **Divergence detection with no merge editor.** A rewritten remote is `diverged` and never
  `behind` — the watermark is compared rather than the last pushed sha, so a force-push reads as
  "the remote moved sideways" instead of inviting a pull that would adopt a history in which
  Jaroku's commits never existed. Reconciliation is a pull request, because every file resolved in
  a hand-rolled merge UI is a file that bypassed the validator on the way in.
- **Migration 034**: separate tables for the grant, the per-agent link, and an append-only event
  log with no update counterpart. Every statement carries `workspace_id` in its WHERE even where
  the uuid alone would do — on SQLite there is no RLS, so that clause IS the tenancy boundary.
- **Composer attachments** (`#` a commit, `@` a file at a ref, `!` what changed since the last
  sync), resolved server-side at send time so an attachment made five minutes ago describes the
  repository as it IS. Attaching brings context in and nothing on that path can trigger a write.
- **A Synced filter** in the sidebar, a tab badge carrying the delta so nobody opens the tab to
  find out there is nothing to do, and per-agent collapse state keyed by workspace.
- Suites: `test:github-sync` and `test:github-push`, plus `test:truncate-path` and
  `test:composer-triggers` on the client.

### Changed

- **The credential is a pasted token in the existing vault**, not a catalogue OAuth connector. It
  goes one way, over HTTPS, into the same store behind the same passcode gate, and what comes back
  is an account login. Connect and disconnect are HTTP routes rather than socket commands, because
  a browser cannot set an elevation header on a WebSocket and a GitHub token can read every private
  repository somebody owns.
- **Jaroku pushes to `jaroku/<slug>` and never to a default branch.** A user may point a link at
  `main` — it is their repository — but nothing in the product proposes it.
- **A disabled control states its reason.** Commit, Push, Commit & push and Pull each name the
  exact thing that is wrong instead of greying out, which is the silent failure the rest of this
  product avoids by name. Push stays visible and disabled when a token is revoked, because hiding
  it makes an agent with two unpushed versions look finished.
- **Fetch and the panel's own refresh are one read.** Two commands would be two answers about one
  remote. It moves what Jaroku last SAW and never what it last DID, which is what makes it safe to
  fire on panel open.

### Fixed

- **A force-push is `diverged`, not `behind`.** Zero commits between the two heads reads as in
  sync, and is the one case where a pull destroys work.
- **Deletions are derived from the tree comparison.** `file_stats` has no `deleted` status, so a
  tool the user removed would otherwise live on in their repository forever.
- **A subdirectory push inherits everything outside itself.** Without `base_tree` the new tree is
  the WHOLE repository, so pushing `agents/weather/` into a monorepo would delete every other
  directory in one commit.
- **A truncated recursive tree is an error rather than a diff.** GitHub cuts the response off at
  its own limit and says so in one boolean; ignoring it would report the missing half as deleted.
- **A commit sha is not a tree sha.** Both are forty hex characters, so the mistake typechecks and
  arrives as a mysterious 422 at the step of a push where a mysterious failure costs most.
- **A rate limit is told apart from a permission failure by the header, not the body.** GitHub
  answers 403 for both, and getting it wrong sends somebody to re-authorise a token that works.
- **Paths truncate in the middle.** A right-edge fade makes `tools/we…` and `tools/tr…` the same
  string to anybody scanning a list for a filename.
- **`#`, `@` and `!` fire only where they are triggers** — a picker that opens while somebody is
  typing an email address is worse than no shortcut at all.

---

## v0.2.14 : The Secrets Tab

A credential surface, and the gate in front of it. Session 9 is not a new store — the vault, its
envelope encryption and its no-read rule have been there since Session 3. What it adds is the
metadata a person needs to manage credentials, an elevated-session gate that is enforced in
middleware rather than in a React component, and one deliberate reversal of a rule this codebase
had held for six sessions.

### Added

- **A Secrets tab**, beside Connections and Deploy, with three groups because credentials arrive
  three ways and each needs different verbs: user-pasted provider keys (rotate, test, reveal),
  connector-managed tokens (reconnect only — Jaroku does not own their lifecycle, so "rotate" would
  be a button that writes a value the far end has never heard of), and custom names an agent reads.
- **An elevated session**, ten minutes, absolute and never sliding — a sliding window means an idle
  open tab stays elevated all day. Keyed on a digest of the bearer token, which gets sign-out right
  for nothing: a new token is a new session, so the old elevation is unreachable without anything
  watching for it. Two tabs of one session share it and lock together; a second tab inherits the
  first's expiry rather than starting a new ten minutes.
- **A passcode**, per user and never per workspace, because `audit_log` has to be able to name a
  person. scrypt from `node:crypto` with `algo` and `params` stored beside each hash, so the cost
  can be raised later and every passcode migrates itself on its owner's next correct answer. Wrong
  and never-set are indistinguishable in the response **and in timing** — the no-record path hashes
  against a dummy salt at full cost, and `test:secret-passcode` measures that it does.
- **A backoff ladder** enforced server-side at every step, including the small ones: three free
  attempts, then 2s, 8s and 30s, then fifteen minutes and an audit row. A backoff the client is
  asked to observe is not a control.
- **A guarded route group.** This router has one global `beforeHandle` and its own comment refuses a
  middleware chain, so the group is a route table whose every handler comes from `guarded()` —
  defaulting to the strictest level, with opting out spelled out loud. `guardLevelOf()` lets
  `test:secret-routes` assert that mechanically, and the suite builds an unguarded route to prove
  the assertion can still fail.
- **A workspace policy**, `tab` or `mutations`, both implemented and shipping as `tab`. One line in
  the guard because it was designed in rather than bolted on.
- **Blast radius** (`secret_usages`): a static scan of the agent's current version tree and a record
  of runtime reads, shown separately and labelled. Neither is sufficient — a scan misses a name
  built at runtime, and a read record misses code that has never run — so merging them into one
  count would produce a number nobody could act on. Revoking a referenced credential requires typing
  its name.
- **Import** from a `.env`, a flat JSON object, Doppler's richer JSON or a HashiCorp KV-v2 document.
  The nested shapes are detected before the flat one, because a KV-v2 document IS a valid flat
  object whose one key is `data` — read as flat it would import one credential called `data` and
  silently drop every real one.
- **Google as a third provider**, end to end: `GOOGLE_API_KEY` (the name `langchain_google_genai`
  actually reads), a models-list probe, three Gemini entries in `pricing.json`, and a branch in the
  Python runtime's model resolution.
- Suites: `test:secret-schema`, `test:secret-passcode`, `test:secret-routes`, `test:secret-import`,
  `test:provider-key-migration`, `test:secrets-e2e`, and `test:secrets-store` on the client.

### Changed

- **Provider keys left onboarding.** A key-paste wall before anybody has seen the product is a bad
  first screen. Onboarding is welcome → prompt → run; a browser stopped on the removed step resumes
  at `prompt` rather than being sent back to a welcome screen it has already seen. Models whose
  provider has no key render **disabled with a stated reason**, never hidden — a hidden model reads
  as one Jaroku does not support, which is both false and unfixable from the user's side.
- **`AuthContext` gained `authenticatedAt`**, from `auth_time` and falling back to `iat`, for the
  step-up gate on the passcode routes. A token refreshed in the background carries a fresh `iat` and
  proves nobody was there; null is deliberately not fresh.
- **The deploy panel asks the vault what is configured**, not `process.env`. On the hosted driver
  those are different questions — whether the SERVER holds a variable, rather than whether this
  WORKSPACE holds the credential — and it was wrong in both directions, including reading the
  platform's own key as every workspace's.

### Fixed

- **`RateRule.scope` gained `user`.** A per-workspace limit on unlock attempts would let one member
  lock out their colleagues; a per-IP one would let a team behind one office NAT do it to each
  other. What is being bounded is one person's guessing.

### Migrations

- `033_secrets_tab` — eight columns on `secret_refs` rather than a second `secrets` table beside it,
  which is 016's own argument ("two copies of one fact is how they disagree"). Four new tables:
  `user_secret_passcodes`, `secret_elevations`, `secret_usages` and `secret_rotations`, all
  workspace-scoped with RLS. Plus one DELETE-only `platform_sweep` policy on `secret_elevations`,
  because an unscoped delete under RLS removes nothing and reports that to nobody.

---

## v0.2.13 : Hardening, Abuse, Data Lifecycle, Observability, Deploy

Session 8 of the hosted migration, and the last one. Nothing here is a feature: it is the layers
that decide what happens when somebody is hostile, when data has outlived its promise, when a
deploy goes wrong, and when nobody is watching.

### Added

- **A policy on every response.** A content policy that permits nothing, `nosniff`, `no-referrer`,
  a permissions policy and the framing headers — on the 200s, the 429s, the preflights and the 500
  nobody remembers. `debug-client.html` gets its own, admitting its two inline blocks. HSTS rides
  on an explicit `JAROKU_PUBLIC_TLS=1` rather than on `NODE_ENV`, because sent by a deployment
  reached at `localhost` behind a proxy it refuses plain HTTP to that host for two years.
- **Two rate limits, because one address and one workspace are different problems.** Token
  buckets, Redis when there is one and a Map when there is not, with `Retry-After` computed from
  the refill rate — a guessed wait that is too short is how a limit becomes a retry storm.
  `/healthz` and the sandbox control plane are exempt at every layer.
- **The edge, as data in this repository** (`deploy/edge/`), rendered to a provider's
  configuration with a `--check` in CI. `test:edge-rules` asserts its exempt list and the
  application's are the same list.
- **`abuse_signals`** (migration 027): observations with the weight each carried at the time, and
  a score that decays with a day-long half-life. Signup velocity is recorded against an HMAC of
  the address, before any workspace exists.
- **An enforcement ladder** (migration 028), append-only with a `lifted_at`. The machine may climb
  three rungs; `suspended` and `blocked` require a human recorded by name. A human's decision never
  lapses — a suspended workspace produces no signals, so an automatic lift would un-suspend
  everything it ever suspended.
- **`steps` partitioned by month** (migration 029), so retention is a catalogue update rather than
  a multi-hour DELETE. Partitioned on the ISO-8601 `text` column, which sorts lexicographically as
  it sorts chronologically — converting to `timestamptz` would change the shape a step reads back
  as. Months are created two ahead, with a DEFAULT partition behind them and an alert on it.
- **A retention sweeper**, per workspace, on each plan's own clock: steps then runs, checkpoints
  with their runs, exports on the plan's clock and staging on hours regardless of plan.
- **A workspace export** — one tar of NDJSON per table plus every agent's current source, with no
  credential of any kind in it, behind an hour-long presigned link. The status check needs no job
  table: the worker writes at a key derived from the export id.
- **Workspace and account deletion**, across rows, objects, checkpoints, the queue and the grants
  at the providers themselves, with a receipt in `audit_log` that survives the deletion and names
  every provider that could not be told.
- **A redaction filter installed over `console` itself**, so the hundreds of existing log calls are
  covered without being rewritten. Registered values, secret field names, and vendor shapes — but
  not uuids or digests, which would make the logs useless in the incident that needs them.
- **Tracing across four tiers**, W3C `traceparent` and OTLP/HTTP JSON, with `jaroku.run_id` on
  every span. A job carries the traceparent that enqueued it; a run's environment carries one under
  the name the OTel SDKs already read.
- **Metrics on `/metrics`**, Prometheus text exposition, with an undeclared label refused at the
  call site. SLOs and alerts are a table in code; `CrossTenantDenial` pages on any non-zero value,
  immediately, with no threshold.
- **A migration gate** (`npm run migrate:check`) enforcing expand/migrate/contract, with the
  override as a comment in the migration rather than a flag on a command.
- **IaC and a pipeline** (`deploy/fly/`, `.github/workflows/`): migrations run in the release
  command before any new machine takes traffic; the gateway rolls, the workers are replaced at
  once.
- **A restore drill that was performed** (`npm run drill:restore`), and a runbook written from
  what it found rather than from what a restore was imagined to do.
- Sixteen suites: `test:security-headers`, `test:rate-limit`, `test:edge-rules`,
  `test:abuse-signals`, `test:enforcement`, `test:partitions`, `test:retention`,
  `test:workspace-export`, `test:deletion`, `test:log-redaction`, `test:tracing`, `test:metrics`,
  `test:migration-gate`, plus `migrate:check`, `edge:render --check` and `obs:render --check` as
  gates that are not tests.

### Changed

- **The README's network posture.** "The server binds to localhost and is not built to be exposed
  to a network" was true for seven sessions and is now false. It is replaced by what actually
  defends each thing, plus a paragraph on what the local mode still assumes — which has not
  changed at all.
- **`QueueBackend` gains `purgeWorkspace`**, distinct from `purgePending`: deletion knows a
  workspace is gone and knows nothing about the payloads it had queued.
- **`PlatformKeyGate` consults the abuse ladder**, applied after the plan and after any negotiated
  override — a generous negotiated ceiling should not survive a soft limit.
- **The run pool's exit path** now closes the run's span and records the run's outcome as a metric,
  in the same place its sandbox seconds are metered.

### Fixed

- **A workspace deletion swept every other workspace's checkpoints.** `FileCheckpointStore.runsHeld`
  ignores the context it is given — correctly, for the single-user path it was written for — so
  asking it "what does this workspace hold" answered with the whole directory. Run ids now come
  from the scoped rows; `runsHeld` is consulted only on the store that filters by workspace.

---

## v0.2.12 : Connector OAuth and the Credential Vault

Session 7 of the hosted migration. Connecting Gmail used to mean obtaining a refresh token out of
band and pasting three variables into `runtime/.env`. Jaroku now owns the OAuth app and a user
grants it access by clicking a button — which is a different security posture rather than a nicer
form, because the credential is now a grant *somebody else's system* made to us, against a real
mailbox, revocable from the far end.

### Added

- **`oauth_connections` + `oauth_states`** (migration 026, both dialects). Neither has a token
  column: the connection records the NAMES its credentials live under in `SecretStore`, the same
  shape `mcp_servers.auth_env_key` has. The state row is hashed at rest, single-use, ten minutes
  old at most, and consumed by a `DELETE` whose row count is the decision.
- **A provider-agnostic OAuth service**, with Google and Slack as data. Authorize-URL
  construction, callback handling, token exchange, and a failure classification that decides
  behaviour rather than wording: `denied` is not an error, `invalid_grant` is terminal, a 503 is
  worth retrying, `invalid_client` is our app being wrong.
- **PKCE, always `S256`**, alongside `state` — they defend different things and a flow needs both:
  `state` defends the callback against a login-CSRF that would connect an attacker's mailbox to a
  victim's workspace; `code_verifier` defends the authorization code against whoever intercepts it.
- **`TokenRefresher`**, with one refresh in flight per connection. Twelve concurrent runs
  refreshing one rotating token would have the provider treat the reuse as theft and revoke the
  entire grant — so an eval fan-out would disconnect the integration. `test:oauth-refresh` fires
  twelve callers and asserts the token endpoint is called once.
- **`ConnectionRevoker`** — Disconnect hands the grant back at the provider before forgetting it
  here, and forgets it anyway when the provider cannot be told, recording which of the two
  happened. `endAllGrants` is the provider-side half of the workspace deletion Session 8 owns.
- **A Connections tab** on a channel of its own, with consent shown in sentences before the button
  and the exact granted scopes after it. `connector:read` is a member capability;
  `connector:manage` is an admin one.
- **`mcpUrl.ts`** — the second SSRF vector the migration spec names, closed at discovery time (where
  the control plane fetches, with no sandbox around it) and again at call time (a pinned egress
  rule), and re-checked before every re-discovery rather than trusted from registration.
- Eleven suites: `test:oauth-state`, `test:oauth-service`, `test:oauth-google`, `test:oauth-slack`,
  `test:oauth-refresh`, `test:oauth-injection`, `test:oauth-revoke`, `test:connector-auth`,
  `test:connector-secrets`, `test:mcp-tenancy`, `test:mcp-url`, `test:mcp-discovery-queue`.

### Changed

- **An MCP token stops being one value for the whole server.** A server id is a slug, so two
  workspaces connecting `mcp.linear.app` both derived `JAROKU_MCP_MCP_LINEAR_APP_TOKEN` — and
  `process.env` has no workspace in it, so the second to save a token overwrote the first's and
  both then authenticated as whoever wrote last. Credentials go through `SecretStore` now, and
  `configured` reads the workspace's own listing rather than the environment.
- **`mcp.discover` is a queued job class**, the only registered one that is a round trip to a third
  party rather than to a provider we have a contract with. Collapsed by `(workspace, server)`, so
  six presses of Re-discover are one round trip. Not retryable: discovery classifies its own
  failures and returns rather than throwing.
- **`catalog.json` gains `auth`** per connector — `oauth`, `user_secret` or `none` — and
  `.env.example` stops presenting a key a connection fills in as a blank to paste into. The names
  stay in the file, because an exported project has no Jaroku to ask.
- **`gmail.py` prefers `GMAIL_ACCESS_TOKEN`** when present, falling back to the refresh-token
  triple. The migration spec said the connector Python should not need to change; for Gmail that
  was not quite true, and keeping it literally unchanged would have meant injecting a permanent
  grant into model-written Python.
- **`DATABASE_URL` goes through the vault**, validated at save to produce a sentence and
  re-resolved and pinned at run time to close DNS rebinding.
- `SandboxSpec` and the run pool carry an `egress` policy, computed per run from the provider, the
  connectors, the control plane, the workspace's own `DATABASE_URL` and the MCP servers the agent
  was granted.

### Fixed

- **`upsert` stamped `last_refreshed_at` on a connection that had never been refreshed.** Caught by
  the tenancy suite, which asserted that a cross-tenant `recordRefresh` could not set the field and
  found it already set. "Last refreshed" now means what it says rather than "last touched".
- `check_failures_raise()` strips a connector's `OPTIONAL_ENV` as well as its `REQUIRED_ENV`. A
  second route to being configured that the check did not know about would have left it passing on
  the one machine it is least able to be trusted on.

### Migrations

- `026_oauth` — `oauth_connections`, `oauth_states`, RLS on the first and deliberately not on the
  second (consuming a state is the operation that *produces* a workspace scope, the same exemption
  `ws_tickets` has).

---

## v0.2.11 : Cost Metering, Budgets, and Billing

Session 6 of the hosted migration. The cost arithmetic is untouched — `runtime/pricing.json` is
still the one table both runtimes read, cost is still summed from `steps` and never from
`runs.cost`, and an unpriced model still costs `null` rather than `$0`. What is new is where those
numbers are written down, what may be started against them, and whose money is being spent.

### Added

- **`usage_events`** — one row per metered thing, with `kind` (what was bought), `payer` (whose
  money bought it), `cost_usd` and `cost_known`. Fed from the ingest chain, one row per `llm_call`
  step, keyed by the step's own id so a redelivered batch cannot bill twice. Eight kinds:
  `llm.provider`, `llm.judge`, `llm.generation`, `llm.plan`, `llm.edit`, `llm.explain`,
  `sandbox.seconds`, `storage.bytes`.
- **`workspace_balances` + `billing_holds`** — credit, what is reserved against it, and the rows
  that make a reservation releasable. Taking a hold is one atomic `UPDATE` whose `WHERE` is the
  check, so ten simultaneous runs against a balance that covers three admit exactly three.
- **`plans` + `subscriptions` + `billing_webhook_events`**, and `server/src/billing/plans.ts`,
  which is where every plan LIMIT lives. The table holds only what varies per deployment (a price
  id, whether a plan is purchasable) and the two are checked against each other at boot.
- **`BudgetGate`** — the pre-dispatch gate for interactive runs and evals. The ceiling bounds what
  is STARTED, never what is spent; a fan-out is re-checked on every pump; every refusal names the
  figure, the limit, the plan that set it, the window and the two things that would clear it.
- **`PlatformKeyGate`** — the platform's own key, lent to a workspace that has none, behind a
  global kill switch (`JAROKU_PLATFORM_KEY=off`, read per call), the plan's own feature flag, and
  a per-workspace ceiling that is deliberately a *different number* from the budget ceiling.
- **`WorkspaceProviderKeys`** — a workspace's own provider keys, through `SecretStore`, proved
  with a models-list probe before they are stored, injected into a run's environment for the
  provider that run named and no other.
- **Stripe, by hand** — checkout, and a webhook whose signature is its authentication: verified
  over the raw bytes, inside a five-minute replay window, tolerating a multi-secret rotation.
  Plus a subscription state machine in which a failed renewal does **not** downgrade.
- **A Usage tab**, with the period total against its ceiling, what the platform paid against its
  own, credit and holds, and a breakdown by agent, by run and by kind — plus a CSV export that
  carries every caveat the screen does.
- Nine suites: `test:plans`, `test:metering`, `test:balances`, `test:gate`, `test:eval-budget`,
  `test:estimate`, `test:byok`, `test:platform-key`, `test:stripe`.

### Changed

- `estimateEval` gains an `affordability` block, computed from the same `BudgetGate.status` the
  gate itself decides with — so the dialog before the button and the refusal after it are one
  computation. Three states, kept distinct: refused, may-not-finish, and unknown-because-unpriced.
- `providerStatus` takes the configured NAMES rather than reading `process.env`, and
  `listProviders` takes the asking socket's context. Hosted, the process environment holds the
  PLATFORM's key, and reading it would have told every workspace it has a provider connected
  because the server does.
- `SecretStore` gains `getForPlatformCall`, its second and last plaintext exit, for the workspaces
  that opt their own key in to platform-side calls. Covered by the conformance suite on both
  stores.
- `RunPool`'s `exit` event carries `elapsedMs`. The pool launches the sandbox and hears it go, so
  it is the only thing that knows how long the machine actually existed.
- `workspaces.plan` gains its only writer, which appends an audit row in the same transaction.
- `billing:read` is a MEMBER capability. A member whose run is refused for budget has to be able
  to see the number it was refused against.

### Fixed

- **A per-cell cost that was a floor rendered, and exported, as a clean measurement.** The
  per-leg rollup has flagged `costIncomplete` since the eval dashboard was written; the per-CELL
  shape never carried it, though `eval_jobs.cost_complete` was in the table the whole time. The
  drill-down now shows `≥` against the figure and the CSV gains a `cost_complete` column — three
  states, not two: `cost_known: no` is "we could not price it at all", `cost_complete: no` is "we
  priced some of it and this is a floor".
- The four env-shaped rate and switch readers (`JAROKU_SANDBOX_USD_PER_SECOND`,
  `JAROKU_STORAGE_USD_PER_GIB_MONTH`, `JAROKU_PLATFORM_KEY`) are read per call rather than at
  import, so a rate change or a kill switch takes effect without a restart — the same trap
  `queue/jobs.ts` was fixed for in the previous release.

### Migrations

`020` billing tables · `021` `usage_events.total_tokens` (the frozen event schema gives a Step one
combined figure and no split, so a split-only usage table could record no tokens at all for the
largest kind) · `022` `quantity` + `unit` (sandbox seconds and stored bytes are not measured in
tokens) · `023` `own_key_for_platform` · `024` `usage_events.payer` · `025`
`billing_webhook_events`.

### Verification

- The full suite is green except for the failures that reproduce identically at the pre-existing
  base commit and are properties of this machine rather than the code: Windows `symlink` EPERM
  (`test:object-keys`, `test:generation`, `test:edit-versions`, `test:read-only`,
  `test:store-reads`), Windows `chmod` semantics (`test:env-writer`), Python extras not installed
  (`test:pricing`, `test:mcp-isolation`, `test:checkpoint-threads`), and no Postgres
  (`test:shape-parity`, `test:rls`, and the Postgres half of `test:tenancy`).
- `npm run typecheck` clean on `server/` and `client/` at every commit.

---

## v0.2.10 : Bug Fixes on Queue, Sandbox, and Distributed Execution Hardening

A hardening pass across the sandbox session and the queueing session, looking specifically for
what breaks under load, under failure, and under a second tenant. No new capability: every entry
here is either something that was already meant to be true and was not, or coverage for a surface
that had none.

### Added

- `fixtures/redis/mockRedis.ts` — an in-process Redis for the sixteen commands `redisBackend.ts`
  issues, running the **real Lua source** out of that module in a real Lua VM (fengari; pure
  JavaScript, no native build). Not a transliteration: a JavaScript paraphrase would only have
  proved that two things written from one idea agree. The queue conformance suite, the semaphore
  conformance suite, the chaos suite and the event bridge's cross-replica assertions now all run
  against `RedisQueueBackend` on a machine with nothing installed. A real Redis is still the
  authority and still preferred when `JAROKU_REDIS_URL` points at one.
- `npm run test:eval-stress` — 500 queued jobs against 2 slots, a backend that throws mid-drain,
  a store that refuses writes between reserving and starting, a cancel racing a live run, and two
  evals started in the same instant.
- `npm run test:interactive-slot` — the per-workspace interactive reservation, extracted from
  `index.ts` into `interactiveSlot.ts` so the rule about it can be tested at all.
- Conformance now asserts `ringOrder` is the order actually served, and that a workspace pending
  first is served first — the assertion that would have caught the ring bug below.

### Fixed

**the sandbox boundary**

- `isDeniedAddress` matched the **text** of an IPv6 address rather than the address.
  `::ffff:169.254.169.254` was denied and `::ffff:a9fe:a9fe` — the same address, the cloud
  metadata endpoint, in hex — was admitted, along with the IPv4-compatible form, NAT64, 6to4, and
  every link-local address above `fe80:` (`fe80::/10` is a ten-bit prefix, not four characters).
  Since `resolveAndPin` **pins what it admits**, a hostname answering AAAA with any of those got
  the metadata endpoint written into a run's egress allowlist as permitted. Normalised to sixteen
  bytes; every rule is now a prefix comparison.
- A host that is already an address no longer goes to DNS. `dns.resolve4` refuses a literal, which
  surfaced as "did not resolve to any address" — so a control-plane URL, object-store endpoint or
  `DATABASE_URL` written as a bare public IP could not be granted to a sandbox at all.
- The lines-per-second cap was enforced on a local run's stdout and on nothing at all on the
  hosted trace push, despite `backpressure.ts` documenting the same limiter for both. A run
  pushing small events as fast as it could open connections was bounded only by the 64 MB per-run
  ceiling, roughly a million events later.
- `CodeCheckSandbox` accumulated untrusted output into a string with no ceiling. A candidate agent
  containing `print("x" * 10**10)` — a file being *validated*, before anything is saved — took the
  control plane's memory rather than being rejected by it. Both streams share a 4 MB budget,
  checked per chunk, and the check is killed and reports `truncated`.
- A long-poll a client had stopped reading still held a waiter, and `signal()` hands its action to
  exactly one — so a hostile run parking a hundred abandoned polls made a real pause a
  one-in-a-hundred shot. A new poll supersedes the run's earlier ones, which fixes the delivery
  bug and bounds the run at one waiter and one timer in the same move. The queued-action list is
  bounded too, and pause/resume collapse to the latest intent.
- A Fly machine reclaimed by `auto_destroy` — the ordinary end of a run — 404s on `getMachine`,
  and the exit poll caught every error alike and tried again forever. `RunPool` frees a slot in
  its `exit` handler and nowhere else, so that was a slot lost for the process's lifetime. A 404
  is now terminal, and a machine still running past its wall clock plus a grace window is given
  up on as a timeout. `FlyError` carries the HTTP status rather than leaving callers to parse it
  out of a message.

**Fixing the queue**

- The Redis ring rotated with `RPOPLPUSH` while `enqueue` appended to the tail, so the most
  recently pending workspace was served first and the longest-waiting one last — the reverse of
  `ringOrder`'s documented meaning and of what the in-memory backend does for the same queue.
  Round-robin survived, which is why every fairness scenario passed.
- `drainAvailable` could wedge the event loop permanently. `providerLimit` is 2 for a real
  provider and the eval pool defaults to 4 slots, so any eval with a backlog reaches "a free slot,
  no provider slot" — and a job admitted there goes straight back on the queue, so the queue never
  empties and `freeSlots > 0` stays true. Every step of it resolves as a microtask, so the loop
  never yields: no timer fires, no socket is read. The reproduction ran 740,000 iterations without
  reaching a `setTimeout` scheduled for 50 ms.
- Every promise `evalRunner.ts` starts and does not await now goes through one handler. They are
  floating by construction — an EventEmitter listener cannot be awaited and neither can a timer —
  and a floating rejection is an `unhandledRejection`, which Node has ended the process for since
  v15. One SQLITE_BUSY under exactly this session's concurrency took the gateway down.
- `executeAdmitted` holds a dispatcher lease and a provider slot before it starts anything, and
  there is no exit event coming for a run that never started; a throw in between left both held
  until their TTLs lapsed. `onRunExit` also releases them **before** asking whether the eval is
  still live, since an eval can stop being live while a run it started is winding down.
- A `pool.tryStart` returning false left a per-workspace interactive reservation with nothing
  coming to release it — the cap is one per workspace on an hour-long lease, so one refused start
  locked that workspace out for the rest of it. The same two discarded statements appeared at all
  three call sites; reserving and starting are one call now.
- Two `startEval` commands could both pass the "one eval at a time" check: `wsRelay` dispatches
  concurrently and the guard was followed by five awaits. Two live evals is a **cross-tenant
  write**, not merely slot contention — `contextForEval(activeEvalIds()[0])` attributes the second
  eval's reads and writes to the first one's workspace.
- `WorkerLoop.shutdown` re-enqueued work that finished during the hand-back, manufacturing a
  duplicate in the one method whose purpose is losing nothing and duplicating nothing. Its
  `drained` count reported how many *classes* the worker was configured for.
- `InMemoryQueueBackend` never released anything it stopped needing — an expired semaphore holder
  stayed for the process's lifetime, and a lease id is minted per admission. It is the real queue
  for any deployment without `JAROKU_REDIS_URL`, not only a test double.
- The in-flight and semaphore counts used ZCOUNT's inclusive minimum where the in-memory backend
  uses a strict `expiresAtMs > now`, so a lease expiring on that exact millisecond both held
  capacity and was reapable.
- Three env overrides (`JAROKU_JUDGE_CONCURRENCY`, `JAROKU_JOB_TIMEOUT_MS`,
  `JAROKU_MCP_DISCOVERY_MS`) were read into a table at import, in a file whose comment says
  overrides are resolved lazily so tests can vary them.

### Verification

- The full suite is green except for failures that reproduce identically at the pre-existing base
  commit and are properties of this machine rather than the code: Windows `symlink` EPERM
  (`test:object-keys`, `test:generation`, `test:edit-versions`, `test:read-only`,
  `test:store-reads`), Windows `chmod` semantics (`test:env-writer`), Python extras not installed
  (`test:pricing`, `test:mcp-isolation`, `test:checkpoint-threads`), and no Postgres
  (`test:shape-parity`, `test:rls`).
- `npm run typecheck` clean on `server/` and `client/` at every commit.

---

## v0.2.9 : Queueing, Fairness, and Per-Workspace Limits

Session 5 of the hosted migration. "Who runs next" stops being an index into one pool and becomes
a fair dispatcher: work enqueued per workspace, admitted round-robin, capped by named leases. The
single-user version of this — one pool with slot 0 reserved for the interactive run — was correct
with one workspace and a way for one tenant to occupy every slot with six thousand. The local
path is unchanged and still needs nothing installed: with no `JAROKU_REDIS_URL` the dispatcher
runs in-memory and no cross-replica bridge is created at all.

### Added

- `Dispatcher`, and the `QueueBackend` interface behind it — `InMemoryQueueBackend` (the default,
  nothing installed) and `RedisQueueBackend`, selected by `JAROKU_REDIS_URL` being set. Both pass
  the same conformance suite: starvation, thundering herds, global caps, orphaned leases.
- A fair admit that is genuinely **one** step — rotate the ring, check capacity, pop, reserve —
  as a Lua script on Redis and as a synchronous block in memory. Split across four calls it
  reopens the exact race the dispatcher exists to close: two workers both see room, both admit,
  and the cap was never real.
- Leases rather than pops: an admitted job is *reserved*, so a worker that dies mid-job doesn't
  take the job with it. `reapExpired` reclaims it; two reapers racing the same expired lease still
  only claim it once.
- `queue/jobs.ts`: every job class as data — concurrency, timeout, retryability — with
  `JAROKU_WORKSPACE_CONCURRENCY_<CLASS>` and `JAROKU_JOB_TIMEOUT_MS_<CLASS>` overrides.
- Named leased semaphores (`queue/semaphores.ts`): per-workspace and per-provider caps, the
  descendants of the reserved slot and `JAROKU_LIMIT_<PROVIDER>`. Checked *after* a fair admit
  rather than fused into it — a workspace is known before enqueue, so there is no race to close.
- `worker.ts` (`npm run worker`): a second entrypoint that requires Redis, drains configured
  classes, and hands its in-flight work back on SIGTERM rather than waiting out a TTL.
- `queue/eventBridge.ts`: cross-replica broadcast fan-out over Redis pub/sub, hooked into the one
  function every WebSocket channel already funnelled through. Each bridge tags its own publishes
  and drops them on receipt; a received message is never re-published, so two replicas cannot
  ping-pong one forever.
- `cancelRun`: a hard stop, distinct from `pauseRun`'s resumable halt — kills the process,
  releases its reservation, and writes a terminal status rather than leaving a row reading
  `running` forever.
- `npm run loadtest:queue`: N workspaces × M jobs through the real dispatcher, reporting admit
  p50/p95/p99, the fairness ratio, and the worst first-serve position.

### Changed

- `RunPool` has no reserved slot and no `startInteractive` — every slot is interchangeable. The
  protection it provided is now structural: `interactivePool` and `evalPool` are separate
  instances with separate capacity, so an eval fan-out cannot occupy a slot an interactive run
  needed.
- `evalRunner.ts` enqueues a `run.eval` job on the dispatcher instead of calling `pool.tryStart`
  directly; `drainAvailable()` admits and `executeAdmitted()` runs it, releasing the lease and the
  provider semaphore on exit either way.
- The per-provider cap is now **global** across every eval rather than per-eval-instance — two
  concurrent evals used to each get their own budget against the same provider.
- `cancelEval` purges its still-unadmitted jobs out of the dispatcher by idempotency key, not just
  the ones already running.
- The judge's own model call carries a deadline (`jobClassConfig("judge").timeoutMs`); a verdict
  call that never returned used to hold a concurrency slot indefinitely.
- `test:retry` now runs the whole retry cycle through the real dispatcher, asserting attempts
  exhaust at exactly `JAROKU_JOB_ATTEMPTS` and that the backoff between them actually grows.

### Fixed

- Every test helper that built a migrations path from a raw `file://` URL's `.pathname` kept the
  leading slash in front of a Windows drive letter, which `path.join` then mangled into a
  directory that does not exist — so `migrate()` silently found nothing and each affected suite
  ran against an unmigrated database. Fourteen files now go through `fileURLToPath`.
- `test:db-boundary` compared a joined Windows path against a hardcoded `/`, so every file inside
  `src/db/` read as outside it and the rule flagged its own drivers as violations.

### Verification

- The dispatcher's fairness is measured, not asserted: at 6,000 workspaces × 5 jobs the fairness
  ratio is 1.000, admit latency is p50 491µs / p95 1.10ms / p99 1.90ms, and the worst first-serve
  position is 5,999 of 30,000 — bounded by the number of workspaces (round-robin) rather than by
  the backlog (FIFO starvation).
- "Eval runs stay off the live trace channel" is re-proven at the new seam, with a control case
  that disables the gate and shows all twenty crossing — so the assertion cannot pass vacuously.
- The event bridge's envelope logic runs everywhere against an in-process broker; the genuinely
  two-process assertions skip loudly without `JAROKU_REDIS_URL` rather than passing on a fake.
- Three limits are recorded rather than papered over: the worker process drains nothing yet
  (`run.eval` and `judge` are drained in-process, because moving execution needs index.ts's
  trace-ingestion and debug-control surface exported first); `generate`/`plan`/`edit`/`explain`/
  `mcp.discover` are registered classes that stay synchronous by design; and one live interactive
  run per gateway is still enforced process-wide, so `JAROKU_INTERACTIVE_CONCURRENCY` above 1
  does nothing yet.
- `npm run typecheck` clean on both `server/` and `client/` at every commit in this session.

---

## v0.2.8 : Sandboxed Execution

Session 4 of the hosted migration. Every place model-written code used to execute directly on
this process — a run, the import check, graph introspection — now goes through `RunSandbox` or
`CodeCheckSandbox`, an interface rather than a raw `child_process.spawn`. The local
implementation is behaviour-identical to what came before it: `npm run dev` still spawns exactly
the subprocess it always has, with nothing installed and nothing running. The hosted
implementation runs a run inside its own Fly Machine, reachable only by the egress it was
declared to need, authenticated by a token scoped to that run alone.

### Added

- `RunSandbox`, the interface a run's execution goes through — `LocalSubprocessSandbox` (the
  renamed, unchanged `ProcessManager`) and `FlyMachinesSandbox`, selected by
  `JAROKU_RUN_SANDBOX=local|fly` and defaulting to `local`.
- `CodeCheckSandbox`, the narrower interface for a short-lived check with no run identity and no
  trace — the import check and graph introspection both move onto it, off a direct spawn.
- `buildEgressPolicy`: the one provider host, each connector's fixed hosts, the control plane and
  the object store, each resolved and pinned before a sandbox starts. Every private, link-local
  and reserved IPv4/IPv6 range is refused unconditionally, including the IPv4-mapped form of the
  cloud metadata endpoint, and a host is refused whole if *any* of its resolved answers is one of
  them — the DNS-rebinding case a naive re-check would miss.
- `validateDatabaseUrl`: a workspace's own DATABASE_URL is parsed, constrained to a small port
  allowlist, and resolved through the identical private-range refusal every other egress host
  goes through, closing the SSRF vector a Postgres connector's user-supplied URL would otherwise
  be.
- `runtime/sandbox/Dockerfile` and `boot.py`: one sandbox image, built once and referenced only by
  digest — never a tag — ships Jaroku's own reviewed code and none of an agent's. `boot.py`
  fetches the run's project archive fresh at boot and extracts it with the same traversal/symlink
  refusal `projectFs` already enforces on local disk.
- Run tokens: a self-contained, HMAC-signed credential scoped to exactly one run id, the same
  shape a presigned object URL already is and for the same reason — the control-plane long-poll
  is a hot path, and a database round trip on every poll is a cost worth skipping.
- A control-plane HTTP surface for a hosted run with no local pipe or shared control file to use:
  batched trace push, a control-line push, a bounded long-poll for pause/resume, and a blocking
  MCP confirmation that denies on its own timeout — never allows.
- `jaroku_runner/controlplane_http.py`: the runner's client for that surface, batching trace
  events (50 or 100ms, whichever comes first) rather than one HTTP round trip per step.
  `mcp_bridge.py` gets its own, deliberately separate copy — it is copied into every generated
  project and must never import anything named `jaroku`.
- `BackpressureTracker`: bytes-per-run, a single-line ceiling, and a lines-per-second rate, the
  same tracker behind a local run's raw stdout chunks and a hosted run's trace-push batches. A run
  that crosses any cap stays refused for the rest of its life, not merely for one call.
- `TraceIngestMetrics`: a dropped trace event is counted, not merely logged and forgotten.
- Migration 019: `agent_versions.graph_cache`. A version's topology cannot change without the
  version itself changing, so `introspectGraphCached` introspects a given version at most once,
  ever, across every replica and every restart — and deliberately never caches a failure.
- A fixture Fly Machines API (`fixtures/fly/mockFlyApi.ts`), so `FlyMachinesSandbox` is built and
  verified with no Fly account, the same way the fixture S3 and MCP server already let this
  codebase test its other hosted paths for free.
- A sandbox escape suite naming each attack by what it is — IMDS, a workspace's own Postgres, a
  Redis-shaped port, another run's token, a host-filesystem escape via a crafted archive, a
  repointed image, resource exhaustion, DNS rebinding — proven against the real code that refuses
  it, with two gaps recorded rather than assumed closed (see Verification).
- `sandbox/tenancyIsolation.test.ts`, extending the isolation suite onto a surface with no
  database rows: two workspaces, two run tokens, neither able to reach the other's run through
  any of the four control-plane routes.

### Changed

- `ProcessManager` is now `LocalSubprocessSandbox`, implementing `RunSandbox`; `RunPool` takes a
  sandbox factory rather than constructing one directly, so a hosted sandbox is a constructor
  argument, never a rewrite of the pool.
- A run token and a bus entry are minted only when a launch carries both a `workspaceId` and a
  configured control-plane URL — the local path has neither and mints nothing.
- `validator.ts`'s static analysis and import check, and `graphIntrospect.ts`, no longer spawn a
  subprocess directly; both go through `CodeCheckSandbox`, local behaviour unchanged.
- The MCP confirmation gate gets a third path in `mcp_bridge.py`, checked before the file-based
  one: a hosted run has no shared control directory, so it blocks on `POST /mcp-confirm` instead.
- A hosted MCP confirmation raises the identical modal a local one does, through the same
  `pendingConfirms` registration; answering one now resolves both the approval file and the event
  bus, so `resolveMcpConfirm` never has to know which kind of run it is answering.

### Fixed

- Nothing in this session was a bug fix to existing behaviour — Session 4 is additive
  infrastructure, and the local path it sits beside is unchanged by construction, not merely by
  intent (see Verification).

### Verification

- Every module above ships with its own suite, run against real subprocesses, a real fixture Fly
  API, and the real Python control-plane client — not mocked substitutes standing in for them.
- The escape suite records two gaps rather than closing over them: no pid/process-count ceiling
  is enforced inside a hosted machine yet (today's actual backstop is Fly's own memory ceiling),
  and no network-layer egress enforcement is wired to stop a compromised process from opening a
  socket the policy never admitted — the policy is computed and validated, but nothing yet
  refuses the packet. Both are the natural next hardening step, not a claim this session makes.
- A hosted `RunSandbox` implementation running the import check and graph introspection inside
  the sandbox image (rather than `CodeCheckSandbox`'s local implementation) is a documented
  follow-up: the interface exists and the image already carries everything it would need, but the
  concrete Fly-backed executor was not built this session.
- `npm run typecheck` clean on both `server/` and `client/` at every commit in this session.

---

## v0.2.7 : Storage Isolation

Session 3 of the hosted migration. Every assumption that the server, an agent's code and its
checkpoints share one disk is gone, and each of the three now has two implementations selected by
config  a local one that needs nothing installed and nothing running, and a hosted one. The local
path is the default and is unchanged.

### Added

- An `ObjectStore` interface with `FsObjectStore` (rooted under `runtime/.objects/`) and `S3ObjectStore` (R2, S3 or MinIO), selected by `JAROKU_OBJECT_STORE` and defaulting to `fs`.
- SigV4 request signing in `node:crypto` rather than the AWS SDK, checked against AWS's own published test vectors.
- A fixture S3 that verifies signatures, so the hosted storage path is exercisable with no cloud account.
- An object key layout rooted at `ws/<workspace_id>/`, so whose object a key names is answerable from the key alone.
- Presigned object URLs, and a route that redeems them — checking the signature, re-checking the key, and refusing a URL for one workspace presented by a request scoped to another.
- Migration 014: an `agent_versions` row records what made a version, the instruction, the summary, the per-file diff stat and whether it has been undone.
- A `SecretStore` interface with deliberately no method that returns a plaintext value to a request handler.
- Migration 015: envelope encryption for the hosted secret store — a per-workspace data key, wrapped by a master key that is never in the database, with each value bound to `<workspace_id>:<name>`.
- Migration 016: `secret_refs`, the store-agnostic record of what a workspace has configured, with no column a value would fit in.
- Migration 017: a `langgraph` schema for LangGraph's checkpoint tables, kept away from Jaroku's forward-only migration runner.
- `JAROKU_CHECKPOINTER=postgres`, so pause, resume and branch survive landing on a different worker.
- Eleven new suites, including a storage conformance suite both object stores must pass, and one that deletes an agent's local copy before asking the graph view and validator to work.

### Changed

- Generation stages into the object store under a staging id, validates what it would publish, and commits as a version row plus a pointer move rather than a directory rename.
- Applying an edit publishes the next version; undoing one moves the pointer back and marks what it left behind. Neither copies a project.
- The agent file list, the graph view and the validator all read the current version out of the store, so a replica that has never run an agent answers identically to the one that generated it.
- A deploy records the artifacts it wrote as a version, so they are visible in the file list and survive onto another replica.
- Branching copies checkpoint rows bounded at the fork point instead of copying a database file, with the columns read from `information_schema` because the tables are LangGraph's.
- The checkpoint sweep deletes by thread rather than unlinking files, with the run ids still coming from the eval's own job rows.
- A run resolves its declared credentials by name through the secret store rather than taking what is ambient in the environment.
- Slug uniqueness is checked against the workspace's own agents, not against a global directory.

### Fixed

- The read-only block list spelled `tools/mcp_bridge.py` with the platform separator, so on Windows it matched nothing in the object store — silently dropping the one file that scopes an agent's entire MCP access.

#### From the bug hunt across sessions 1 to 3

Storage:

- `FsObjectStore` followed a symlink out of its own root, and `list()` walked one into a cycle. Object stores have no symlinks; it now refuses a key whose path passes through one.
- A symlink in a project directory reached the file list and was copied, contents and all, into a published version.
- The file list and the graph view fell back to `runtime/agents/<slug>` for a workspace whose own version was empty — handing it another tenant's generated source, through a lookup that had correctly found the caller's own row.
- A publish that lost a race moved `current_version` onto a version whose objects the winner's cleanup had deleted. Publishing now reserves the number, writes the objects, then promotes.
- Applying an edit whose base version had moved — a deploy publishing in between — silently dropped whatever landed in between. It is refused, naming both versions.
- A file named `__proto__` was swallowed by the manifest object, so the version was published without it while the object sat in the store.
- Both object stores now normalise a presign TTL the same way. A fractional one floored to zero locally and minted a URL that had already expired.

Tenancy:

- `secret_refs` accepted an `agent_id` from another workspace: the foreign key was to `agents(id)`, which any tenant's agent satisfies. Migration 018 makes it a key on the pair.
- Boot soft-deleted every agent whose directory was absent — which on a second replica, or after the runtime directory was cleaned, was all of them, while their versions sat intact in the store.
- Boot also adopted every directory under `runtime/agents/` into the local workspace, including the ones other workspaces had materialised.
- `applyEdit`, `discardEdit`, `discardPlan`, `generate --planId`, `pauseRun`, `cancelEval`, `cancelDeploy` and `resolveMcpConfirm` acted on an id without asking whose it was. Each is now answered in the caller's workspace, and an id belonging to somebody else reads as absent rather than as forbidden.
- A control line printed by an agent's own subprocess was attributed to the run id IN the line rather than to the slot that produced it, so one run could pause another workspace's run, re-stamp the checkpoint boundary its branching depends on, or raise a tool-confirmation modal in it.
- Starting an eval read its dataset as the server rather than as the asking workspace, so no other workspace could start one at all.

Row-level security — all three worked locally, on SQLite, and as the database owner every test connects as, and did nothing as the application role a deployment actually connects with:

- The whole invite flow ran unscoped, so creating one failed the policy outright and listing, revoking and accepting saw nothing.
- The eval job aggregates read `steps` unscoped, zeroing every job's cost, tokens and latency — and the budget ceiling they feed.
- The eval cost estimate read `runs` unscoped, so it always fell back to "no history".

A new structural rule in `test:db-boundary` reads the policied tables out of the migrations and fails when one is reached without a scope, which is what found the last two.

Elsewhere:

- The WebSocket server accepted `ws`'s default 100 MiB message while the HTTP router beside it stopped at 64 KiB; it now caps at 1 MiB, enforced before a byte is buffered.

---

## v0.2.6 : Authentication and Workspace Access

**Released:** August 7, 2026

### Added

- Provider agnostic OIDC verification: tokens are checked against cached JWKS, and the provider's `sub` claim maps to a Jaroku user.
- `POST /v1/auth/session`, which verifies a token and provisions the user on first sight.
- `POST /v1/ws-ticket`, which validates workspace membership and issues a single use ticket.
- A WebSocket handshake that validates the ticket and checks the request `Origin` before the socket opens.
- A real RS256 development issuer, so `npm run dev` exercises the production verification path instead of a local bypass that can silently drift.
- Replica safe ticket storage backed by Postgres, kept behind an interface so Redis can drop in later.
- A role matrix written as data and checked in one place, alongside a documented auth model and threat model.

### Changed

- Sockets open with an immutable workspace context, and no message can change that workspace once connected.
- `/v1/auth/session` and `/v1/ws-ticket` now share a single workspace selection function instead of applying different rules.
- Legacy `Local` workspaces are converted from `personal` to `team` when they are adopted.
- Commands resolve the live workspace context rather than the role captured at connection time.
- Open sockets are rechecked, so a connection cannot outlive the membership that opened it.
- Migration 011 was introduced rather than editing the already shipped migration 010, keeping the runner forward only and checksummed.
- The client gained a session and a token of its own, and every store empties when the workspace changes.

### Fixed

- User provisioning race: simultaneous first sign ins could both insert the same user on Postgres, a problem SQLite masked through single connection serialization.
- Workspace adoption mismatch between the session endpoint and the ticket endpoint, which could hand a user two different default workspaces.
- Role changes were not enforced, so a demoted member could still execute commands.
- Provider broadcasts were workspace unscoped and could reach every connected client.
- Every push now carries the workspace it belongs to, after an audit of all WebSocket channels rather than only the ones somebody happened to notice.
- The remembered test input leaked across workspaces, and is now scoped to the one it belongs to.
- Onboarding asked whether the browser had onboarded rather than whether the user had, and the server now refuses to start on SQLite when `NODE_ENV` is production.

### Verification

- The tenancy suite covers 84 scoped repository methods across 227 assertions, on both database drivers.
- Forged, unsigned, tampered, and expired tokens are all rejected.
- WebSocket ticket replay and cross workspace tickets are refused.
- Forged workspace IDs are refused, and membership revocation is enforced while a socket is already open.
- `test:auth` and `test:reset` cover retry versus stop handling and store reset.
- A scratch Postgres instance was used, so Postgres paths that had previously been skipped in silence were actually exercised, and the full flow was smoke tested against a live server.
- One gap is recorded rather than glossed over: the Chrome extension is typechecked and production built but not visually verified, since it is not yet connected to the backend.

---

## v0.2.5 : Jaroku's Tenancy

**Released:** August 7, 2026

### Added

- Postgres support behind a shared database interface, selected with `JAROKU_DB_DRIVER=sqlite|postgres`, with SQLite remaining the default.
- A forward only migration runner that applies numbered SQL migrations transactionally and records checksums in `schema_migrations`.
- The tenancy tables: `users`, `workspaces`, `workspace_members`, `audit_log`, `agents`, and `agent_versions`.
- Postgres Row Level Security, enabled and forced across tenant tables, with a dedicated application role that is neither the table owner nor a superuser.
- An agent registry, so agents are database records and the filesystem becomes a cache that is reconciled on generate, apply, and undo.
- A SQLite to Postgres importer, `npm run import -- --from <sqlite.db> --workspace <name>`, batched, idempotent, and supporting `--dry-run`.
- Two boundary suites, `npm run test:tenancy` and `npm run test:db-boundary`, which gate every later session.

### Changed

- Every repository operation now requires an explicit `TenantContext`.
- Runs, steps, datasets, evaluations, MCP resources, deployments, and logs are all workspace scoped.
- Agent slugs are unique per workspace instead of globally unique, the one intentional behavioural change in this release.
- Each transaction sets its workspace with `SET LOCAL`, so isolation holds under transaction pooling infrastructure such as PgBouncer.
- A missing workspace context fails closed and returns no tenant data, rather than risking another workspace's rows.
- All four stores moved onto the `Db` interface and await everything they touch.
- Schema v1 and the emitted events are unchanged, and `workspace_id` exists only at the storage layer.

### Fixed

- Paused runs could silently lose their resume state.
- Workspace context could be lost between socket handlers and long lived commands.
- Broadcasts could reach clients belonging to other workspaces.
- Disk backed agent reads could cross workspace boundaries.
- Interrupted runs could stay permanently stuck, and a restart now closes them out.
- Postgres dropped any step containing a NUL character, losing the whole step.
- SQLite MCP rebuilds failed against populated databases, `close()` threw when called twice, and an unreadable `--from` database produced a raw stack trace.

### Verification

- 31 server suites and 7 client suites pass against both database drivers.
- Full end to end execution on Postgres with RLS enabled, using neither a superuser nor `BYPASSRLS`.
- Concurrent migration testing with five simultaneous attempts, protected by a Postgres advisory lock.
- Idempotent import testing across 106 runs and 1,218 steps.
- A concurrent Postgres evaluation completed 180 steps with zero failures.
- Hostile payload testing with deeply nested data, large payloads, ANSI escapes, NUL characters, and hostile workspace IDs.
- A real 3 MB SQLite database was upgraded in place, and the suite was confirmed to leave behind neither production rows nor scratch databases.

---

## v0.2.4 : Testing and Reliability Improvements

**Released:** August 5, 2026

### Added

- A raw socket HTTP probe driven directly against `serve.py`.
- A stub Railway API paired with a fake CLI, so the whole deployment path can be exercised without a provider.
- A WebSocket command fuzzer.
- A suite of hostile input probes.
- Slow loris protection, bounding how long one client may hold a connection.
- Written documentation of the deploy layer, now that it has been tested rather than only built.
- A frame for the first run screens, and the real Jaroku mark everywhere the app signs its name.

### Changed

- Redeploys target the existing Railway service instead of creating a new project each time.
- The action reads Redeploy, and the behaviour is stated clearly before confirmation.
- Log streaming follows Railway's sliding window rather than treating the cursor as a page offset.
- Secret detection was narrowed so only genuine sensitive values are redacted.
- The deploy log re renders on its own instead of redrawing the entire deploy panel.
- State serialization handles cyclic structures safely.
- A credential the user unticked is now refused the same way a missing one is.

### Fixed

- HTTP request desynchronization: rejecting a request without consuming its body left unread data in the socket, corrupting the next request and even preventing `413 Payload Too Large` from reaching clients over persistent connections.
- Cyclic agent state triggered a `RecursionError`, causing the server to discard an otherwise valid agent response.
- Every redeploy created an entirely new Railway project, leaving older services running, continuing to cost money, and exposing several live URLs for what looked like one deployment.
- Long builds duplicated hundreds of log lines and then appeared to freeze, making healthy deployments look stuck.
- The log scrubber treated common host values such as `anthropic` and `claude-haiku-4-5` as secrets, producing unreadable output like `langchain-••••••••>=0.3.0`.
- `isSafeAgentId` accepted `undefined`, `null`, and arrays through JavaScript type coercion, and that validation is shared across run, edit, eval, graph, and file operations.
- A mistyped timeout calculation evaluated to `NaN`, making every deployment appear interrupted moments after it started, and a malformed deploy command leaked internal plumbing in its reply.

### Verification

- Four dedicated harnesses drove the deployment pipeline adversarially rather than along the happy path.
- Thirteen production bugs were uncovered, each fixed in its own commit with supporting evidence.
- The deployment server was probed at the raw socket level, below any client library.
- Persistent connection behaviour was checked, so refusal responses reach the client instead of being lost to desync.
- Thread exhaustion under a partially transmitted request line was reproduced and then bounded.
- Redeploy was confirmed to reuse the existing service instead of provisioning duplicate infrastructure.
- Build log output was compared end to end for both duplication and over redaction.

---

## v0.2.3 : Introducing Agent Deployments

**Released:** August 5, 2026

### Added

- Production deployments for every existing agent, making all 15 deployable retroactively.
- A reviewed deployment template built on Python's standard library `ThreadingHTTPServer`, adding zero dependencies and importing nothing from Jaroku.
- Synthesised `Dockerfile`, `.dockerignore`, and `pyproject` files per agent, host owned so nothing else can write one.
- A Railway API client and a CLI upload path that never echoes a secret back.
- A dedicated deploy channel carrying deploy state, mirrored on the client.
- Seven live deployment stages with a running timer and real time build log streaming.
- A Deployed sidebar filter listing deployed agents alongside their live URLs.

### Changed

- The agent contract is untouched: `agent.py`, `contract.py`, `prompt.ts`, `validator.ts`, and `schema/events.md` all stay exactly as they were.
- Only environment variable names travel across the socket, and values are fetched only when the `variableCollectionUpsert` mutation executes.
- `deployments.env_keys` stores key names alone, never secret values.
- Build logs redact sensitive values even when a build script tries to print them.
- Each connector now records what it needs installed, per connector.
- Deploy artifacts either land in a project completely or leave it untouched.
- Restart reconciliation was added, so an interrupted deploy is resolved rather than left dangling.

### Fixed

- A standard `pip install .` inside the Dockerfile failed because `runtime/pyproject.toml` did not package agent files into the wheel, so the image now places the project directly on `sys.path`.
- Container deployments shared MCP approval state because `_run_grants` was a module level global, so `JAROKU_MCP_CONFIRM=require` is now enforced per deployment.
- Uploads could stall for roughly 60 seconds when terminating the CLI shell left a child holding `stdout` open, and correct exit detection cut that to around 705 ms.
- Deployment bearer tokens appeared in `deployment_logs`, and are now delivered exactly once through their callback and never persisted.
- Selecting the latest deployment relied on `created_at` alone, making two deployments in the same millisecond nondeterministic, so `rowid` is now the tie breaker.
- A dependency that would break out of the Dockerfile is now refused outright.
- A patch could rewrite the very row it was patching, and a self referencing state could exhaust the stack.

### Verification

- The complete pipeline was exercised in the browser against a stub Railway API and a fake CLI.
- Validation and deployment refusals were confirmed to stop a bad deploy before it starts.
- Tests confirm that no secret reaches an image and that no failure damages a project.
- Tests confirm that a credential cannot reach anywhere it must not.
- The deploy record was tested for honesty, and the ordering tie that made it lie was fixed as part of that test.
- One time bearer token delivery was checked against both the logs and the database.
- A live URL was produced end to end, with the Deployed filter populated from real records rather than a placeholder.

---

## v0.2.2 : Client Design Pass, One Visual System Applied Everywhere

**Released:** August 4, 2026

### Added

- `lib/tokens.ts`, defining `RADIUS`, `ELEVATION`, `MOTION`, `TYPE`, and `STEP_TYPE`.
- `lib/actionIcons.tsx`, giving one icon, verb, and accent per action kind across 11 kinds in two tenses each.
- `components/Chip.tsx` for every tag like label: file references, model ids, tool names, connectors, and status.
- `components/ActionRow.tsx`, the shared narrative line of icon, verb, object, and trailing figures.
- `components/DiffStat.tsx`, `components/EmptyState.tsx`, and `components/Truncate.tsx` for change figures, idle panels, and gradient fades at the cut.
- `components/ChoiceRow.tsx`, surfacing the forks a session is already at as option cards.
- `lib/useStreamedText.ts` and `lib/composerMoment.ts`, for backlog proportional reveal and for deriving what the composer should say.

### Changed

- The trace narrates itself: a row that read `#3 [tool_call] get_time 1,204 tok · $0.0031 · 820 ms` now reads `#3 Called get_time`, with the figures as tabular columns.
- The plan card, generation progress, and edit progress share four slots and one vocabulary, so a plan says "Calls get_time" and the trace later says "Called get_time".
- Eleven hand rolled pills at six heights became one chip, and eighteen font characters standing in for icons became real SVGs at one stroke weight.
- Nine corner radii became four, chosen by the size of the box rather than the name of the component.
- The app is a panel on a surface with an 8px inset, a hairline, and a four level elevation scale where every level is a border plus a shadow.
- Structure is drawn in hairlines instead of background fills, and content nests three levels deep as card, section, and well.
- The prose and code type split moved from one panel to the body, with three sizes replacing seven and hierarchy carried on weight.

### Fixed

- Latent React crash in `PlanCard`, where `useMcpStore` sat below the early returns, so the same component instance grew a hook once a plan settled.
- The wordmark read as a warning sign, since an outlined amber triangle in an app where amber means running looks like a road sign, so it became two solid tones with no edge.
- The connector picker's off state vanished because `selected={false}` forced a bare chip, so an explicit variant now wins.
- The composer described a context it was about to ignore, offering to explain a step that stayed selected across an agent change.
- The streaming file list stalled after the first file instead of streaming file by file as promised.
- `animate-pulse` faded live elements to 50% and read as disabled, so `stream-pulse` replaced it on all nine live elements.
- Text that ran out of room was cut rather than faded, and `prefers-reduced-motion` was honoured nowhere.

### Verification

- `npm run typecheck` on every commit.
- `npm run build` at every milestone.
- The six lib and store tests green at every milestone.
- A full end to end pass against the live fixture run.
- Trace, step detail, graph, evals, and MCP panels all checked by hand.
- Both composer modes exercised.
- Two exclusions were recorded deliberately: no addition and deletion figures on the generation summary, since `GenTurn` carries paths and no line counts, and brand logos stay exempt from the stroke rule.

---

## v0.2.1 : MCP Hardening

**Released:** July 31, 2026

### Added

- A dedicated adversarial suite that drives the real registry and the real Python bridge instead of mocking around them.
- Validation of every tool name against what it actually has to satisfy, before it reaches storage, the interface, or the model API.
- Size limits on all server provided text, including server names and descriptions.
- A refusal, raised before the model is called, when two connected servers expose the same tool name, naming both servers.
- A backstop check on the runtime side for anything generated before that refusal existed.
- Written documentation of what an MCP advertisement has to satisfy.
- A fixture server built to misbehave, exercising oversized results, malformed schemas, hostile names, and a tool that never answers.

### Changed

- Selected MCP tools are now actually carried through into the generation request.
- Server provided text is bounded and stripped of raw newlines before it can reach the prompt.
- A credential embedded in a server URL is refused before anything is sent.
- Error messages no longer echo the offending URL back.
- Confirmation cleanup checks which specific confirmation it is closing.
- Duplicate tool names resolve in one place rather than differently in the bridge and the validator.
- Tool names outside the accepted character set are rejected rather than left to break every call the agent makes.

### Fixed

- Generation was silently dead on arrival for every MCP scoped agent, because a hand written type omitted the field carrying the selected tools and nothing caught the gap, so every such generation failed after a full generation call had already been paid for.
- Two servers exposing the same tool name resolved differently in the bridge and the validator, and in the worst case the surviving entry was the low impact one, meaning the confirmation gate could silently never fire.
- A tool named `__proto__` overwrote the object prototype instead of adding an entry, making that tool disappear from the wiring check meant to catch exactly that gap.
- Names containing spaces, dots, unicode, or embedded control characters could break every tool call an agent made, not only their own, since the API accepts a narrow character set.
- An oversized description or server name flowed unbounded into storage, into every connected client's live update, into a generated project's manifest, and into the prompt.
- A credential in a server URL leaked into the database, into every connected client, and into the logs, because the error message quoted the full URL back.
- A single timed out confirmation silently closed every other pending confirmation in that run.

### Verification

- The adversarial suite carries 34 assertions.
- 17 of those failed against the code as it stood before this pass.
- All 34 pass now.
- Every existing MCP suite still passes.
- The rest of the server's tests still pass.
- The project type checks clean.
- One gap is noted rather than quietly patched: generated agent code can set an environment variable that disables the confirmation gate, which needs a new validation rule rather than a bug fix.

---

## v0.2.0 : MCP Server Support

**Released:** July 31, 2026

### Added

- Connection to any remote MCP server, performing the standard handshake and showing exactly what it advertises before anything is granted.
- An MCP server registry on its own WebSocket channel, with a panel in the client.
- Impact classification at the moment a tool is discovered, with the reason stored alongside it.
- A first use confirmation gate that stops before a high impact tool runs and shows the exact arguments the model produced.
- A host written manifest in every generated project, plus a reviewed bridge file that is the only thing allowed to act on it.
- Credential entry in the interface, written to the same environment file every other credential already lives in.
- A fixture MCP server, exercised by the free dry run model with no live server and no cost.

### Changed

- Access is granted per tool and never per server, so connecting a server grants an agent nothing on its own.
- The plan gained a third provenance, so an agent can be scoped to specific MCP tools while it is being planned.
- MCP sourced tools are marked everywhere they appear, so a reviewed connector and an unread server tool never look alike.
- Only Streamable HTTP endpoints are supported, since stdio would mean running a third party's binary locally.
- Connection failures are classified rather than swallowed, and a network blip never wipes a server's previously discovered tools.
- A tool's result is capped in size with truncation announced, and labelled as external data from a named server.
- The manifest and the bridge are off limits to the conversational edit loop, the same protection reviewed connectors already had.

### Fixed

- A server's claim that its own tool is read only is ignored, since trusting it would make the safety gate optional by four characters of JSON.
- A tool nothing legible can be said about defaults to high impact rather than low, matching the rule the eval engine already uses for unrecognised failures.
- Denying a confirmation and letting the window time out both count as a refusal the model is told about, so nothing proceeds silently.
- Generation refuses to guess when two connected servers expose a tool with the same name.
- A server reporting its own call as failed is recorded as a failure in the trace, not as a quietly successful step containing an error message.
- Tool results are stripped of anything that could corrupt how they render, before they reach either the model or the trace.
- A server that requires OAuth says so plainly instead of failing as a generic unauthorized error.

### Verification

- The fixture server was built to misbehave deliberately, not to pass.
- Oversized results were driven through the real client.
- Malformed schemas were driven through the real client.
- Hostile tool names were driven through the real client.
- One fixture tool never answers at all, so the timeout path is exercised rather than assumed.
- The free dry run model synthesises arguments from each tool's real declared schema, so every tool actually gets called.
- The whole feature runs with no live server, no credential, and no cost.

---

## v0.1.12 : Trust and Stability Fixes

**Released:** July 30, 2026

### Added

- Read only protection extended to `tools/__init__.py`, so the reviewed tool guarantee covers the wiring and not only the source file.
- A check that catches a reviewed tool dropped from `TOOLS`.
- A check that catches a reviewed tool shadowed by name.
- Surfacing of a reviewed connector's own failures, which previously had no route to the user at all.
- A locked state on the name field, applied once a plan exists.
- Chip rendering for identifiers inside explain answers, matching how the same term already looks in a structured row.
- Column width handling for model ids in the comparison table.

### Changed

- Staleness now resolves in both directions instead of latching one way.
- Unticking a connector clicked by mistake no longer costs a fresh plan.
- The name field locks after planning instead of silently doing nothing.
- Graph layout gives the model circle and the tool row enough room at three tools and above.
- Connector chips keep their width when ticked, so the row no longer shifts.
- Explain answers route through the prose renderer instead of emitting raw markdown.
- The streaming file list updates continuously rather than only at the start and the end.

### Fixed

- A reviewed connector's failures were swallowed instead of surfaced, the most serious defect in this release, since trust in reviewed code depends on failures being loud.
- A reviewed tool could be silently unwired through `tools/__init__.py`, either dropped from `TOOLS` or shadowed by name, with no warning raised.
- Staleness was a one way latch, so an accidental untick left the plan permanently dead with re planning as the only escape.
- Typing in the name field incorrectly marked the plan stale and blamed it on connectors.
- The streaming file list stalled after the first file, so generation did not visibly stream file by file as promised.
- Graph view collided the model circle and the tool row at three or more tools, overlapping labels on adjacent nodes.
- The eval table's column layout broke midway through scoring on `claude-haiku-4-5`, because of the hyphen in the model name.

### Verification

- Nine fixes landed across the composer, the graph view, the eval table, and the reviewed connector trust boundary.
- The unwiring gap was reproduced by dropping a tool from `TOOLS` before the protection was extended.
- The shadowing case was reproduced by name before the protection was extended.
- Staleness was exercised in both directions, ticking and unticking.
- The eval table was rechecked mid scoring against the exact model name that broke it.
- The streaming file list was watched through a full generation rather than sampled at the ends.
- The connector chip row was checked for cursor displacement while ticking.

---

## v0.1.11 : Generation Panel Polish

**Released:** July 29, 2026

### Added

- Grouping of tools into reviewed connectors versus bespoke ones.
- A brief thinking indicator while the plan is being assembled, consistent with the app's existing no spinner philosophy.
- Per file status in the streaming file tree as generation proceeds.
- Independent collapse for each major section of the plan, which matters once a plan gets long.
- File type specific icons, a badge for newly created files, and a small bar showing the size of each change.
- A distinct marker separating hard constraints from general informational notes.
- Code chips for technical terms mentioned inline, matching how the same term looks in a structured row.

### Changed

- State fields and graph structure read as scannable blocks instead of prose.
- The graph section reads as an ordered numbered sequence rather than a generic bullet list.
- Confirm and revise controls got deliberate labels and styling instead of default buttons.
- Revising opens an inline input in the same card and visibly replaces the same turn, rather than opening a modal or piling on a new turn.
- Confirming a plan and starting generation read as one continuous flow in a single conversation turn.
- Cost and token counts for both the plan and the generation are muted and tucked into the corner.
- Once generation finishes, a compact one line summary replaces the loudly expanded file list by default.

### Fixed

- A long agent title truncated mid word.
- The undo control was plain text and carried no visual weight for an action that reverses work.
- User turns and Jaroku turns were distinguishable only by indentation.
- Notes all carried equal weight, so a hard constraint looked like a passing remark.
- Spacing came from eleven separate guesses rather than one scale.
- Prose line height was set in several places rather than once.
- Cost was reported as a sentence rather than as figures.

### Verification

- No interaction logic was touched in either round of this pass.
- No approval or apply state was touched.
- No data flow was touched.
- Everything was built on the design tokens already established, rather than introducing a new visual language.
- The plan card was reviewed against a real plan rather than a mock.
- Both rounds were checked in the same panel, so the first round's structure held while the second filled the remaining flat areas.
- Long titles, long plans, and collapsed sections were checked as the awkward cases the panel has to survive.

---

## v0.1.10 : Plan Before Generate

**Released:** July 28, 2026

### Added

- A plan gate, so describing an agent produces a plan before any file exists.
- Tool intent in the plan, split clearly into reviewed connector templates versus new bespoke ones.
- The rough shape of the agent's state and its graph structure, stated in plain language.
- A plan card that shows the plan inside the conversation.
- In place revision, so typing a change revises the plan rather than forcing a restart.
- Cost reporting and recording for the plan step itself.
- A substantial new test suite around the plan's parsing and its lifecycle.

### Changed

- Nothing generates until the plan is confirmed.
- The composer flips to the plan gate instead of sending straight to generation.
- The plan reuses the existing generation model and prompt infrastructure, as an earlier phase of the same call rather than a second pathway.
- Plan cost is shown alongside generation cost once both exist, instead of being hidden inside one combined number.
- Discarding a plan hands the original request back to the composer, unchanged.
- Changing connector selection marks a plan stale locally rather than discarding it server side, a deliberate deviation from the original design.
- Asking to add a connector or rethink an approach continues the same conversation instead of throwing away what was already proposed.

### Fixed

- A plan mentioning the reviewed connector template in plain prose was parsed as if it named an actual connector called reviewed, fixed at the parsing layer.
- A refused confirmation permanently marked the plan unavailable, leaving no way to retry, so a refusal no longer consumes the plan.
- The plan could run into the generation, so its output is now bounded.
- Catalog drift between what a plan named and what the catalog offers is handled rather than assumed away.
- Redirection during planning is treated as a revision instead of a restart.
- Throwing a plan away to protect a slot that costs nothing to keep was not worth the friction, so the plan is kept.
- Known and left open deliberately: the generation model used for cost accounting is fixed in one place regardless of what is configured, and the plan step inherits the same issue.

### Verification

- The full path was checked end to end over the real server: the plan streams in, parses, is confirmed, generates, validates, and replaces the previous project.
- Confirming the wrong plan is correctly refused, and costs nothing.
- Skipping straight to generation still behaves exactly as it did before.
- Plan parsing is covered by the new test suite.
- The plan lifecycle is covered by the same suite.
- Both edge cases surfaced during testing were fixed before shipping rather than documented and left.
- Plan cost and generation cost were compared as two separate figures rather than one.

---

## v0.1.9 : Eval Engine, Multi Provider Comparison

**Released:** July 28, 2026

### Added

- Dataset building for an agent, including promoting a Test mode input straight into the dataset.
- An orchestrator that expands a dataset into jobs and fans them out across providers.
- An in process run pool with concurrency limits, per provider rate limits, bounded retries, and per run timeouts.
- An independent judge with an editable rubric, prompt construction, and verdict parsing.
- A comparison dashboard laid out as provider by metric, with per example drill down into the full trace.
- Pre run cost estimates, a hard budget ceiling, and export to CSV and JSON.
- Checkpoint artifact sweeping, so an eval cleans up after itself.

### Changed

- A single shared pricing file now feeds both the Python side and the server side.
- Cost is summed from what each step actually spent, rather than read from a run level field.
- Cached tokens are billed at the cached rate rather than the full input rate.
- A model with no pricing entry shows as cost unknown and is excluded from cost rankings.
- Comparison cost counts only successful runs, while true spend is reported separately and includes retries and the cost of judging.
- One slot is permanently reserved for interactive use, so a background eval never interferes with pausing, resuming, or branching.
- Eval runs stream on their own channel, so watching one never yanks focus away from the trace view.

### Fixed

- A model with no pricing entry rendered silently as free, reporting a false $0.
- A run that crashed partway reported spending nothing, despite its completed steps holding real cost.
- Cached tokens were billed at the full input rate, overstating cost by as much as ten times whenever caching engaged.
- Python and server cost math could diverge, so a test now asserts both compute byte identical numbers for the same inputs.
- A provider that hit a transient rate limit was penalised as expensive in the comparison.
- Jobs are persisted before they are dispatched, so a server restart leaves a recoverable eval rather than a stranded one.
- Failures are isolated per job, so one bad example no longer takes an entire eval down with it.

### Verification

- A real two provider eval was checked directly against the Anthropic billing console.
- The estimate before running, the actual cost after, and the internally recorded cost all agreed.
- The exact published per token rate was reconstructed from the recorded numbers alone.
- The judge was checked for real discrimination: a correct answer, a hallucinated one, and an empty one scored distinctly apart.
- Documented limit: the budget ceiling bounds what gets started, not what is already running, so a few in flight jobs can finish after it is crossed.
- Documented limit: a run killed for taking too long can still be billed by the provider for the call in progress, even though that spend never appears in the trace.
- Documented limit: pre run estimates assume a fixed ratio of input to output tokens, since only a combined count is available beforehand.

---

## v0.1.8 : Unified Composer with Chat and Test Modes, and Voice Input

**Released:** July 24, 2026

### Added

- A Chat and Test toggle inside a single composer.
- Built in voice input using the Web Speech API, with live transcription.
- Listening feedback while voice input is active.
- A graceful fallback wherever the Web Speech API is unsupported.
- An auto growing editor.
- An integrated model selector, context chip, and route hints in the composer itself.
- A redesigned send button matching Jaroku's visual language.

### Changed

- Chatting with Jaroku and testing an agent now happen from the same input.
- The separate run bar was removed entirely.
- Chat and Test keep separate drafts that survive switching between modes.
- Placeholders are context aware per mode.
- Runtime input handling was centralised in one place.
- Persisted test inputs are shared across re runs and keyboard shortcuts.
- Chat mode keeps intent aware routing across generate, edit, explain, fix, and re run, while Test mode sends input straight to the agent.

### Fixed

- Test input had to be retyped for every re run, and the previous input is now restored.
- A draft typed in one mode was lost on switching to the other.
- Keyboard shortcuts and the composer could read different input state before handling was centralised.
- Running an agent had two entry points that could drift apart, and the legacy run bar was removed to leave one.
- The editor did not grow with its content.
- An unsupported Web Speech API surfaced as a broken control rather than a hidden one.

### Verification

- The redesigned composer matches the intended interface.
- Separate Chat and Test drafts are preserved across mode switches.
- Previous test inputs are restored correctly.
- Real test runs start from the composer.
- Chat routing is unchanged from the previous release.
- The composer runs without console errors.

---

## v0.1.7 : Unified Chat Composer and Context Aware Routing

**Released:** July 24, 2026

### Added

- One unified composer, replacing scattered entry points for fixes, explanations, retries, and generation.
- Automatic intent detection using lightweight heuristics, with no per message LLM classification.
- Selection aware routing that knows whether a trace step or a graph node is selected.
- Live context indicators: a selection chip, a route preview, and an intent aware send button.
- A new Explain action for grounded debugging assistance.
- A dedicated explain endpoint, with responses streaming on a separate chat reply channel.
- A contextual fallback, so explanations still work when no AI API key is configured.

### Changed

- Natural language routes itself: "Why did this step fail?" goes to Explain, "Fix this" to Fix, and "Re-run from here" to Branch and Re-run.
- Step Details lost its dedicated Fix button in favour of the unified composer.
- Routing logic was centralised rather than duplicated per entry point.
- Explanations use only the selected step's execution context, or the selected node's prompt and tools.
- Existing edit, fix, and branch execution paths are reused rather than reimplemented.
- Chat replies stream on their own channel, separate from the execution trace.
- The trace protocol and the execution schema were left untouched.

### Fixed

- Fixes, explanations, retries, and generation each had their own entry point, so the same intent behaved differently depending on where it was typed.
- A selected step did not scope what the composer would do with a typed message.
- Explanations could reach for context beyond the selection, and are now grounded strictly in it.
- Requesting an explanation without an API key configured previously left the feature unavailable.
- Classifying intent through the model would have added cost and latency to every message, which deterministic heuristics avoid.
- Re run requests did not branch from the selected point.

### Verification

- In browser testing confirmed that selecting a step automatically scopes the composer.
- Explanation requests stream grounded responses using the actual execution context.
- Re run requests branch correctly from the selected point.
- Existing edit flows continue to work through the unified interface.
- Existing fix flows continue to work through the unified interface.
- Routing decisions were checked against both trace step and graph node selections.
- The trace protocol was confirmed unchanged by the addition of the explain endpoint.

---

## v0.1.6 : Interactive State Branching and Branch History

**Released:** July 24, 2026

### Added

- State inspection directly in Step Details, showing the state captured at any node boundary.
- Branch with edits, forking a new run after applying validated domain field changes.
- Re run from here, branching and replaying execution without modifying state.
- A `branchRun` client command wired to the runner for one click branching.
- Automatic branch focus after creation, with the copied execution prefix loaded immediately.
- Visual branch history with indentation, branch markers, and `branch @<seq>` labels.
- Lineage metadata on run summaries through `parent_run_id` and `branch_from_seq`.

### Changed

- Debugging workflows are fully reachable from the interface rather than only from the backend.
- All domain state fields are editable as JSON.
- `messages` stays read only in v1, to prevent invalid resumes.
- The original checkpoint and the original run are never modified.
- Run history shows lineage rather than a flat list.
- Creating a branch is a single action rather than a manual fork.
- The copied prefix loads straight away instead of waiting for the branch to produce new steps.

### Fixed

- Editing state and forking a run previously required backend access.
- A branch's relationship to its parent was invisible in run history.
- Editing `messages` could produce an invalid resume, so it is now refused.
- State edits went unvalidated before being applied at the fork point.
- After branching, the new run had to be located manually in history.
- A run's execution prefix was not visible until the branch produced new steps.

### Verification

- End to end browser testing pauses a live run.
- State is inspected at the paused boundary.
- Both edited and unchanged branches are created.
- The new run is watched streaming from the copied prefix into a divergent execution.
- The resulting branch hierarchy is viewed in run history.
- The original run is confirmed untouched throughout.

---

## v0.1.5 : Run Branching for Deep Debugging

**Released:** July 24, 2026

### Added

- Forking a new execution from any completed node boundary.
- Optional state editing before resuming, validated as part of the fork.
- Independent branch execution with its own checkpoint database, run history, and lineage.
- Automatic prefix copying, preserving every step up to the fork point with remapped step relationships.
- Checkpoint aware branching in the runner, so execution can resume from any valid checkpoint.
- Server side boundary resolution, prefix cloning, and checkpoint database duplication.
- Debug events and history updates emitted at branch creation, for immediate visibility in the interface.

### Changed

- Parent runs are immutable, and the original checkpoint database is only ever read.
- Branch lineage is recorded through `parent_run_id` and `branch_from_seq` for full traceability.
- A branch is a first class run rather than a variant of its parent.
- State edits apply only after the fork point.
- Step relationships are remapped on copy rather than duplicated verbatim.
- Every branch gets its own checkpoint database instead of sharing one.
- The frozen event schema is untouched by branching.

### Fixed

- Experimenting with a run previously meant modifying that run.
- Step relationships broke when a prefix was copied without being remapped.
- A branch sharing its parent's checkpoint database would have corrupted the parent.
- Branch lineage was untraceable without explicit parent metadata.
- State edits could apply before the fork point rather than after it.
- A newly created branch was invisible in the interface until the next refresh.

### Verification

- Branched runs leave the parent run completely untouched.
- Branched runs produce independent execution histories.
- All pre fork steps are preserved exactly.
- Edits apply only after the fork point.
- Step sequencing stays contiguous through the fork.
- Parent step relationships stay correct after remapping.

---

## v0.1.4 : Pause and Resume Mid Execution

**Released:** July 24, 2026

### Added

- Pausing a run at its next node boundary, and resuming later from its durable checkpoint.
- A boundary signal emitted after every node, carrying the current sequence position, the checkpoint just written, and which nodes could run next.
- A small per run control file the runner checks at every boundary.
- Two new commands, one to pause a run and one to resume it.
- A new communication channel carrying pause, resume, and boundary updates to the client.
- Pause and resume controls shown directly on a running trace, with the new paused state understood end to end.
- Additive database columns tracking which checkpoint each step corresponds to, plus groundwork for run branching later.

### Changed

- The server assigns a run its identity before the run starts, so a live run can be addressed and paused while still in progress.
- The process manager separates the boundary signal from ordinary log output into its own typed event.
- Resuming reopens the paused run's checkpoint and continues under the same run identity rather than starting a new run.
- No new run started event is emitted on resume.
- Step numbering picks up exactly where the paused segment left off.
- Pausing exits cleanly without marking the run finished, since it is not actually over.
- The existing rule that data is always saved before it is broadcast to the client is unchanged.

### Fixed

- A long run could only be abandoned, never paused.
- Boundary signals mixed into ordinary log output would have polluted the event stream.
- A run could only be addressed after it finished, so it could not be paused mid flight.
- Resuming as a new run would have split one execution across two traces.
- Ordinary logging is left completely untouched by the new typed boundary event.
- Documented quirk: a paused and resumed run against the offline test model can come out slightly longer, because that model's scripted responses reset position when the process restarts, while a real model resumes exactly and trace causality holds either way.

### Verification

- Checked against a live run over the real server, not only in isolation.
- Pausing partway through and resuming produced a single completed run.
- The step sequence was fully contiguous and unique, with no gaps and no duplicates.
- A checkpoint was recorded at every step.
- Exactly one start marker and one finish marker were emitted for the run.
- No step was ever re executed after resuming.
- The event schema stayed byte frozen throughout the feature.

---

## v0.1.3 : Checkpointed Run Path

**Released:** July 24, 2026

### Added

- The official `SqliteSaver` as a runtime dependency, storing one checkpoint database per run.
- A checkpointed driver in the runner that recompiles a checkpointed twin from the same graph builder.
- A streaming loop replacing the single blocking call, writing a durable checkpoint after every node boundary.
- A fallback path for agents without a compatible graph builder.
- An additive starting sequence parameter on the tracer, so a future resume can continue a run's step numbering exactly where it left off.
- Gitignored checkpoint storage that lives entirely outside the trace stream.

### Changed

- Generated agents still compile a bare graph with no checkpointer, so the generated contract is unchanged.
- The runner drives the checkpointed twin instead of calling invoke once and blocking.
- Nothing changes from a user's perspective, since this release is purely foundational.
- The frozen event schema is untouched.
- Checkpoints are stored per run rather than shared across runs.
- The shape of what the tracer records is unchanged by the new sequence parameter.

### Fixed

- A plain invoke left nothing to resume from once the process exited.
- There was no node boundary at which state could be durably captured.
- Agents without a compatible graph builder would have failed on the checkpointed path.
- Checkpoint data mixed into the trace stream would have compromised the frozen schema.
- Step numbering had no way to continue across a process restart.
- Checkpoint databases committed into the repository would have been noise, so they are gitignored.

### Verification

- Checkpointed and non checkpointed runs of the same test agent produce byte identical traces.
- Both produce the same step count.
- Both produce the same ordering.
- Both produce the same step types and names.
- Both sort the same way.
- No node was re executed on the checkpointed path.
- The emitted event stream was compared step for step against the previous run path.

---

## v0.1.2 : Graph View Visual Redesign

**Released:** July 24, 2026

### Added

- A new graph icon set covering both flow node types and connector brand logos.
- Circular resource nodes for an agent's model and tools, carrying full colour brand logos where available.
- Left to right flow nodes with an icon, a bold title, and a muted subtitle.
- Dashed drooping connections labelled Model and Tool, with small diamond connection points.
- A decorative add affordance matching the reference design language.
- A node click micro interaction that briefly highlights the node's connected edges.
- A traversed edges resolver added to the existing trace to graph mapping layer.

### Changed

- Graph View was rebuilt as a flat n8n style workflow canvas, matching the polish of the rest of the interface.
- Cards are solid and panel coloured, with JetBrains Mono labels throughout.
- The canvas gained a faint dot grid and wider layout spacing for real breathing room.
- Selection and active state read through a subtle fill change and a thin left accent bar rather than a glow.
- Trace status dots on nodes are unchanged.
- The traversed edges resolver reuses the step and edge resolution already verified for the live sync feature, rather than introducing a second mapping.
- A particle pulses along the edges in the real direction data flowed, for nodes that actually executed in the current trace.

### Fixed

- A node that has never run gets the static highlight only, never a fabricated animation implying execution that did not happen.
- The graph did not match the polish of the rest of the interface.
- Glow based selection clashed with the visual language used everywhere else in the app.
- A second mapping layer would have drifted from the verified one.
- Layout spacing was too tight for node labels to breathe.
- Flow node and connector iconography was inconsistent before the shared set existed.

### Verification

- Checked by hand against multiple agents.
- Checked against agents with prior runs.
- Checked against agents without prior runs.
- Confirmed that the click interaction never implies data flow that never happened.
- Confirmed that edge direction matches the recorded trace.
- Confirmed that trace status dots behave exactly as they did before the redesign.

---

## v0.1.1 : Graph View, Command Palette, and One Click Fix

**Released:** July 23, 2026

### Added

- Graph View, rendering every agent's structure as an interactive auto laid out graph with pan, zoom, and click to inspect a node's prompt, model, or tool schema.
- Trace to graph sync, so the active node glows in real time during a run.
- Bidirectional selection, where clicking a trace step highlights its node and clicking a node selects its step.
- A Cmd+K command palette for running an agent, switching providers, or jumping between views.
- Keyboard navigation, with J and K moving through trace steps, Enter expanding one, Cmd+P opening any file as an overlay, and Cmd+/ jumping to chat.
- One click fix, routing a failed trace step into the existing conversational fix loop, pre filled with the error and the relevant code.
- Sidebar filtering of agents by status.

### Changed

- Topology is introspected directly from the compiled LangGraph object through an isolated read only entrypoint.
- Graph introspection is kept completely separate from the trace event stream, so the frozen schema and transport are untouched.
- The step to node mapping was built deliberately rather than by name matching, resolving tool and model call steps to their enclosing node by walking the step hierarchy.
- Router steps resolve to the specific edge they took.
- The right panel settled on Graph, Trace, and Evals, with Evals shown as a clearly marked upcoming placeholder.
- Full code access moved from a permanent tab to an on demand overlay.
- Step detail opens as a slide in panel rather than an inline block.

### Fixed

- A timing gap between a run's completion event and its process actually exiting could, in a narrow window, cause an edit to be incorrectly refused right after a run finished.
- Run state is now tracked directly rather than inferred from process liveness.
- Diagnosing a failed step required manual copying and pasting into chat.
- Name matching between steps and nodes would have mismapped any steps whose names collide.
- Router steps had no edge to resolve to before the mapping walked the hierarchy.
- A permanent code tab took space away from the panels that actually change during a run.

### Verification

- The graph render was checked by hand against a live running agent.
- Trace to graph sync was checked in both directions.
- Palette shortcuts were checked individually.
- The one click fix path was checked end to end.
- The build is clean.
- The prior trace pipeline was re verified with no regressions.
- The prior generation and edit pipelines were re verified with no regressions.

---

## v0.1.0 : Conversational Agent Editing

**Released:** July 22, 2026

### Added

- Conversational editing, so asking for a change to an existing agent returns a proposal grounded in its actual current files.
- Full file rewrites instead of patches, so nothing applies incorrectly against a misplaced line reference.
- An expandable diff card for every proposed change.
- Apply and Undo, where Apply snapshots the project first so Undo restores it exactly.
- A conversation first interface, where generation and edits both appear as turns in one persistent thread with diff cards inline.
- Sandboxed import checking in the validator, which now actually imports each project in a subprocess.

### Changed

- Nothing touches disk until Apply.
- Every proposal passes the same validation as generation: it parses, it imports, required symbols are present, and there are no unsafe writes.
- Reviewed connectors stay protected, so the edit model can never rewrite the Gmail, Slack, or Postgres templates.
- The guard blocking edits during an active run now tracks run state directly instead of process liveness.
- Diff cards render inline in the conversation rather than on a separate review surface.
- Undo restores the exact snapshot rather than attempting to reverse a diff.

### Fixed

- A generated project containing dead unreachable code was syntactically valid but crashed on import, and the validator previously only parsed files.
- The validator now imports each project in a sandboxed subprocess, catching that entire class of failure going forward.
- The edit guard was keyed to process liveness and could briefly misfire right as a run finished.
- Patch based edits could apply against the wrong lines, which is why edits became full file rewrites.
- A real request to loosen a read only guard on a reviewed connector was refused cleanly instead of rewriting the template.
- Undo previously carried no guarantee of exactness, so it is now verified byte identical across repeated cycles.

### Verification

- Generate, run, propose an edit, review, apply, re run, and undo were all confirmed end to end by hand.
- The whole path was checked against a real Anthropic model.
- Undo was verified byte identical across repeated cycles.
- Reviewed connector protection was confirmed with a real request to loosen a read only guard.
- Prior trace behaviour was re verified with no regressions.
- Prior generation behaviour was re verified with no regressions.

---

## v0.0.3 : Jaroku's Generation Layer

**Released:** July 21, 2026

### Added

- Prompt to project generation, so describing an agent and picking connectors streams a full project of `agent.py`, tools, prompts, and config in file by file.
- A free dry run replay mode that exercises the full experience at zero API cost.
- Staged writes, where generated files land in staging and are promoted only after passing checks.
- Reviewed connector templates for Gmail, Slack, and Postgres, hand written once and copied verbatim into every project.
- A read only guard on Postgres, enforced through real AST analysis rather than string matching.
- Router step capture and a reducer aware state diff view.
- Real provider verification of the trace pipeline against Anthropic.

### Changed

- Generated code is pure LangGraph with zero platform imports.
- A single hand written runner injects the model and the tracer from outside, so generated projects stay portable.
- The tracing guarantee is enforced in one place rather than once per generation.
- Connector templates are never re authored by the model.
- Promotion requires valid syntax, the required contract, no tracing imports, no stdout writes, and a path safe target.
- A bad generation can never overwrite a working project.

### Fixed

- A live generation call produced a tool invocation bug, fixed at the system level rather than by prompt instruction alone.
- The same call produced a SQL injection widening bug, also fixed at the system level.
- Both defects were preserved as permanent free regression tests.
- stdout was hardened against `print()`, `sys.stdout.write()`, and raw file descriptor writes from generated code.
- The event stream can no longer be corrupted by anything a generated project writes.
- Known follow up: optional connector clients for Gmail, Slack, and Postgres are not installed by default, and are installed when live connector testing is needed.
- Known follow up: prompt caching is not yet active, because the prompt sits just under the cacheable threshold.

### Verification

- Generated projects were run end to end through the existing trace pipeline.
- The trace pipeline was verified against a real Anthropic provider.
- stdout hardening was verified against three separate write paths.
- The Postgres read only guard was verified through AST analysis rather than pattern matching.
- Two real defects found in a live generation became permanent regression tests.
- The dry run replay mode reproduces the full flow at zero cost, so this path stays testable for free.

---

## v0.0.2 : Trace Layer UI

**Released:** July 19, 2026

### Added

- A new React client under `client/`, built on Vite, React, TypeScript, and Tailwind, with a dark theme and JetBrains Mono.
- A live trace timeline where steps stream in as the agent runs.
- A run history sidebar listing past runs from SQLite, with click to load and replay.
- Step detail, expanding any step to show its input, output, state, and error.
- A status bar showing connection, provider, total cost, tokens, duration, and current step.
- A `loadRun` WebSocket command that loads a past run's steps on demand.
- `step_count` included in `listRuns`.

### Changed

- `traceStore` keys steps by id, making re delivery idempotent.
- Steps are always rendered sorted by `seq`, never by arrival order.
- The timeline is borderless, using a connector line instead of boxes.
- Steps slide in over 120ms rather than appearing abruptly.
- Live tickers show working seconds, tokens, and cost while a run is in flight.
- The visual system is restraint based rather than decorative.

### Fixed

- A corrupted or reordered trace is a lying product, so render order is now guaranteed to equal causal order.
- Duplicate re delivery is deduped rather than appended.
- Reconnecting mid run no longer duplicates steps.
- Reconnecting mid run no longer reorders steps.
- Past runs previously had no way to be loaded back into the timeline.
- Run listings gave no indication of a run's size before loading it.

### Verification

- Scrambled arrival order such as `[1,2,0,4,3...]` renders as contiguous `0..N`.
- Duplicate re delivery is deduped.
- Reconnecting mid run neither duplicates nor reorders steps.
- The server contract passes nine checks.
- The store logic passes eight checks.
- `tsc --noEmit` is clean.
- `vite build` is clean.

---

## v0.0.1 : Foundation, the Core Trace Pipeline

**Released:** July 16, 2026

### Added

- A frozen Run and Step event schema in `schema/events.md`, mirrored in both Python and TypeScript.
- `JarokuTracer`, the Python interceptor that turns LangChain and LangGraph callbacks into trace events.
- Token and cost accounting, with correct causal ordering.
- A two tool test agent, weather and calculator, that runs offline with no API key or against Claude or OpenAI through one environment variable.
- A Node server with a crash safe process manager and a `node:sqlite` trace store.
- A WebSocket relay and a minimal live trace debug client.
- Live streaming with no spinners, so steps land in the browser the instant they complete.

### Changed

- This is the first release, so everything here establishes the baseline the rest of the product is built on.
- The event schema is frozen at `schema_version: 1` from the start, rather than evolved into later.
- stdout carries events only, and all logging goes to stderr, so the stream is never polluted.
- Events are newline delimited JSON, exactly one object per line.
- Ordering within a run is `run_start`, then steps in ascending `seq`, then `run_end`.
- The system is single process, local, and SQLite backed by design at this stage.

### Fixed

- Malformed and partial lines never crash the parser.
- Killing a run mid execution leaves no zombie process.
- Steps persist contiguously and in causal order rather than in arrival order.
- Logging cannot pollute the event stream, because it is routed to stderr.
- Cost and token figures are accounted per step rather than estimated at the end.
- Stated plainly rather than implied: the trace timeline UI, agent generation, eval, and deploy are not included yet.

### Verification

- End to end live delivery confirmed.
- SQLite persistence confirmed, with contiguous and correctly ordered steps.
- Malformed and partial line resilience confirmed.
- Killing a run mid execution confirmed to leave no zombie process.
- `tsc --noEmit` clean under strict.
- The agent runs standalone with `uv run python -m test_agent.agent`.
- The full pipeline runs with `npm run dev` on port 4317.
