# Changelog

All notable changes to Jaroku are recorded here, newest release first.

The format follows [Keep a Changelog](https://keepachangelog.com/) conventions, and versions
follow [Semantic Versioning](https://semver.org/). Every entry is drawn from the published
release notes and the commits in that release's range.

---

## v0.3.12 : One Mark Per Verb — The Icon System, Wired

The client had three icon paths. `panelIcons.tsx` drew Lucide geometry at `ICON.strokeWidth`;
`components/icons.ts` drew HugeIcons through `@hugeicons/react` at a second weight of 1.5; and a
handful of controls drew their own inline `<svg>` or set a mark as a literal character in the text
font. Nothing was broken, and that is the point — a screenshot of any one bar looked right. What
they could not do was **move together**, so the composer's seven controls sat a different weight
from the panel they live in, and one mark in the sidebar rail shipped at stroke 2 because that is
what the package happened to send.

This release replaces all three with one: **117 committed inline-SVG marks**, generated from
`@hugeicons/core-free-icons@4.3.0` at authoring time, drawn through the one factory, at the one
token. Client-only — no schema change, no migration, no server route.

### Added

- **`client/src/lib/icons/manifest.ts`** — 150 registry keys mapped to HugeIcons export names, as
  strings. The one file anybody edits when a mark changes, and the reason changing what "fork" looks
  like is a one-line edit rather than a hunt through nine call sites.
- **`client/scripts/gen-icons.mjs`** — reads the package, strips `stroke` and `strokeWidth` from
  every path so a mark *physically cannot* carry its own weight, and emits components that delegate
  to `panelIcons.tsx`'s `svg()`. Deterministic: attributes sorted, element order preserved because
  order is paint order. A manifest name the package does not export exits non-zero with the name
  printed, rather than shipping a blank square.
- **`client/src/lib/icons/registry.ts`** — the one import surface. `Icon.agents.fork`, never
  `GitForkIcon`, typed so an unknown key is a compile error rather than an undefined render.
- **`client/src/components/IconButton.tsx`** — `label` is required and becomes both `aria-label`
  and the tooltip, from one string, so the two cannot disagree. 32×32 minimum hit target whatever
  the mark's size; a disabled control carries the reason in the tooltip and keeps its name.
- **Six suites, in their own CI step**: `test:icon-manifest`, `test:icon-stroke`, `test:icon-deps`,
  `test:icon-registry`, `test:icon-a11y`, `test:icon-generated` — plus a `gen:icons` re-run whose
  diff must be empty, which catches a manifest edit committed without regenerating.

### Changed

- **`@hugeicons/react` is uninstalled and `@hugeicons/core-free-icons` is a devDependency.** The
  renderer walked path tuples on every render, which made the icon set a runtime dependency of the
  composer's control bar — the one row that has to be on screen before anything else is.
- **One stroke weight, `ICON.strokeWidth`.** `GLYPH.strokeWidth` is gone. The size ladder stayed:
  sizes are not weights, and a toolbar control is 20 for reasons that survive the merge.
- **Two controls that were text are now icon-only where §6 is binding**, and the labels moved to
  `aria-label` plus tooltip rather than being deleted.

### The seven decisions

The specification is internally inconsistent in seven places. Each was resolved deliberately, and
**three of them contradict the source document** — flagged here because a silent correction is
indistinguishable from a mistake.

- **D1 · Optical stroke at small sizes.** Match the existing factory, which puts a constant
  `ICON.strokeWidth` on the `<svg>` and lets the 24-unit viewBox scale it down — so at 14px a mark
  draws 1.02 device pixels and accepts the thinning. The alternative the spec offers,
  `strokeWidth * 24 / size`, was **not** taken: it would be a third behaviour in a codebase that
  already has one, and every Lucide mark would then sit lighter than the HugeIcons mark beside it.
- **D2 · `x` versus `cancel-01`.** `XIcon` closes a surface; `Cancel01Icon` aborts an operation.
  **Contradicts the document twice**: `inbox.dismiss` moves from `cancel-01` to `XIcon`, because
  the document put `cancel-01` on a lane six inches from an `x` doing the identical job on a card;
  and `evals.cancel` moves from `x` to `Cancel01Icon`, because cancelling an eval aborts something
  in flight rather than closing a panel.
- **D3 · Three refresh marks, kept, with the split written into the registry.** `Refresh03Icon`
  re-fetches a list you are looking at; `ReloadIcon` retries an operation that failed;
  `RefreshCwIcon` syncs with an external system, which is why GitHub gets its own.
- **D4 · `plus` versus `plus-sign-square`.** The mark follows the **object**, not the surface: a
  square-plus creates an agent, a bare plus creates everything else. **Contradicts the document** —
  `agents.newThread` becomes `PlusIcon`, because the thing being created there is a thread.
- **D5 · `loader-circle` in a filter chip.** Kept, drawn **static**, and nothing animates it. In a
  row of five filters a spinning chip says the filter is loading; the amber dot on the rows below
  is what actually reports liveness.
- **D6 · The Workspace tab strip.** All six tabs get icon **and** label. The document marked four
  icon-only and left two labelled, which reads as unfinished — and these are settings destinations
  opened twice a month, which is exactly where a bare glyph fails.
- **D7 · The command palette is one affordance, not 21.** All 21 rows carry the same trailing
  "this navigates" mark, which is a property of the row component. One key, `palette.jump`.
- **D8 · 117 marks, not 104** — an eighth decision this work had to make. Acceptance asks for 104,
  but I2 requires `@hugeicons/react` uninstalled, and the composer's control bar, its ⊕ menu and the
  turn rows drew through it. Thirteen of those marks are outside the appendix, so they joined the
  manifest. The count moved and the invariant held, which is the right way round.

### Notes

- **The specification calls `lib/actionIcons.tsx` the factory; it is not.** That file is a semantic
  table mapping action kinds to descriptors. The SVG factory is `components/panelIcons.tsx`'s
  `svg()`, and the generated marks draw through it — §0's rule is that where the spec and the files
  disagree, the files win.
- **134 registry keys are named by §5 and §6, not the 135 the header claims.** The two tables say
  86 and 48; `agents.new` is printed twice, shared between the sidebar and the Agents grid.
- **The Inbox's `team` lane has no registry entry, deliberately.** §5 names five lanes and this is a
  sixth — it does not exist in a Personal workspace, so the capture the specification was drawn from
  could not have seen it. It keeps its existing mark, through the same factory at the same weight.
- **`test:icon-a11y` found three icon-only controls with a tooltip and no accessible name** — the
  sidebar's rename, the Threads notice dismiss, and the Workspace panel's close. All three now
  carry both.

---

## v0.3.11 : Talking To An Agent — The Per-Agent Conversation, On The Record

The Cockpit gives you a list, and a list is not how a person asks *"did that email go out?"* This
release makes a thread a conversation about an agent's **work** rather than about its code — and it
does so by adding one column and one item kind to the table that already held conversations, not by
building a second one.

The rule underneath it is the reason it is worth anything. **A deployed agent remembers nothing** —
`build_initial_state(user_input) -> dict`, every run from nothing — so the agent never answers a
question about itself. Jaroku does, from `work_items`, and where the record is silent the answer is
that it is silent. Asking the container instead would return a confident invention, which is the
single worst thing this product could ship.

### Added

- **`threads.mode`** — `build` or `operate` — and `thread_items.kind` gains `work`. Which kinds may
  be written into which mode is enforced in `ThreadStore.addItem` rather than requested in a
  comment: an operate thread cannot hold a `proposal`, so it cannot render Apply, so nobody running
  real work is one mis-click from rewriting the agent's code.
- **A fact pack, assembled by code before anything is asked to write prose.** Recent jobs with
  status, timing and outcome; what is waiting; what failed and whether the trace was opened; cost
  summed from `steps` and never `runs.cost`. Bounded by count *and* by bytes — thirty jobs whose
  agent answers with a document are under the item cap and over the budget — and three statements
  whether it is asked about one agent or forty.
- **A fourth prompt in `prompt.ts`**, and no second answering engine: `streamExplain` takes different
  rules rather than being rewritten. With no key it streams the facts as facts, which here is a
  feature rather than a fallback and is what makes the whole path testable for free.
- **Citations that resolve only against the pack the model was handed.** `[work:<id>]` becomes a chip
  that opens the Part 2 work detail. Another workspace's *real* job id fails exactly as an invented
  one does — there is no cross-tenant check in the path to forget — and an invented one stays on
  screen as bare text rather than being quietly stripped.
- **A second classifier, deliberately not an extension of `lib/intent`.** Question or command, by
  keyword and pattern, with the destination label always visible before sending: *"This will run
  Tracey"* versus *"This reads the record"*. A question mistaken for a command spends real money and
  the reverse costs a rephrase, so a question mark outranks a bare imperative and nothing undecided
  reaches a container. `test:thread-classify` prints the number: 105/105 on its corpus.
- **A command in an operate thread is an ordinary `dispatchWork`** — same store, same run token, same
  trace, same work item, same pre-flight gate, which both composers now render from one component.
  There is no third way to execute an agent.
- **`threadStatus.ts` gains no rung.** A `waiting` job is `needs_you`, a running one is `running`, a
  failure nothing came after is `errored` — the ladder that existed, with three more facts fed into
  it, so `archived` still wins over all of them.
- **What asking costs is attributed to `usage_events.thread_id` and shown**, counted apart from the
  agent's own provider spend: it is the same model on every question, and folding it in would add a
  constant to each and make a cheap agent look expensive.
- **Nine suites, all in CI**: `test:thread-mode`, `test:thread-status-work`, `test:convo-facts`,
  `test:convo-citations`, `test:convo-honesty`, `test:convo-spend`, `test:convo-tenancy`,
  `test:convo-replay` and `test:thread-classify`.

### Fixed

- **Dropping `thread_items` to widen its CHECK would have deleted every note, pin, rating,
  attachment and variant in the database.** Five tables reference it `ON DELETE CASCADE`, and
  SQLite's `DROP TABLE` performs an implicit delete that fires foreign-key actions — so the obvious
  rebuild leaves a schema that is correct in every respect a test would check and a database missing
  a feature's data. The children's rows step aside first. `test:migrate` runs the migration against
  a populated database and asserts all five survived.
- **A `work` item is bound to its conversation, and the per-thread cost join could not see it.** An
  operate thread's job is a `work` item, not a `run` one, so `spendByThread` reported what asking
  cost and not what doing cost — fourpence on a conversation that had spent eleven pounds.
- **`thread_items.thread_id` references `threads(id)` — the id alone**, so a foreign key could not
  stop one workspace writing into another's conversation, and the mode check above it was skipped
  for exactly that case. The store refuses it now, with the same sentence for "gone" and "not
  yours".

### Not in this release, deliberately

Talking to more than one agent at once — *"who can do X?"* is a dispatcher that has to choose, and
choosing wrong spends money on the wrong container. Voice and calls, which sit on it. Any memory
beyond the record: no summarisation into durable "facts about this agent", no vector store, nothing
that can outlive what a row says. And editing an agent from an operate thread, ever.

---

## v0.3.10 : The Production Bridge and the Cockpit — Post-Ship Control of Live Agents

A deployed agent used to be a black box. It emitted no trace, reported no cost, could not be paused
or cancelled, and could not stop and ask a human before a high-impact tool ran. Every one of those
looked like a missing feature and none of them was: the machinery existed and the deploy path had
never joined it. **`serve.py` now starts `python -m jaroku_runner` as a subprocess and answers
`202`**, so a deployed run is an ordinary traced run — the same runner, the same schema-v1 events,
the same control-plane ingest, the same cost aggregation. There is no second way to execute an
agent any more.

That made a screen worth building. **The Cockpit is the fifth sidebar destination** — Threads,
Agents, Cockpit, Inbox, Activity — and it answers five questions: what is live, give this agent a
real job, what is happening to the jobs I gave it, what does it need from me right now, and what did
it cost. None of it is approximate, because all of it reads what the bridge already records.

### Added

- **A deployed run is a traced run.** Traces, cost, pause, resume, cancel and MCP confirmation all
  work in production without one new mechanism — `deployRuns.ts` emits what a `RunPool` emits, so
  everything downstream reaches it unchanged. A container that goes quiet past a fifteen-minute
  ceiling is closed out as errored with a reason that says what is known and what is not, rather
  than leaving a row claiming to be in flight for ever.
- **Jaroku keeps the serve token**, envelope-encrypted and keyed by Railway *service* id so a
  redeploy overwrites one variable instead of accumulating a dead secret per deploy. The old
  property was "Jaroku does not keep a copy"; it ended because a token shown once cannot dispatch a
  run. **Reconnect** mints a fresh one for every agent deployed before this.
- **The Cockpit**: a fleet strip over a work list, with a detail panel sliding in from the right. A
  fleet card's one line is its own state — *2 running · 1 waiting on you*, *idle · 11 jobs today ·
  $0.42*, *not connected* — never a status word, because a status word is what the Railway dashboard
  already gives.
- **`work_items`**, with `created_by` NOT NULL. That is the column `runs` never had, and "who gave
  this agent a job" is the question the whole tab exists to answer. There is deliberately **no cost
  column**: cost is summed from `steps`, so a run that crashed mid-graph reports what it really
  spent instead of the zero its own row carries.
- **A dispatch composer that does not route through `lib/intent`.** The build composer routes one
  input by phrasing into plan / revise / edit; here there is one destination, so reusing it would
  let *"refund order 4471"* be read as an instruction to change the agent meant to do it. A
  pre-flight gate names the agent, the version and the model before the button — money asks first,
  and there is no dry-run path out here.
- **Health, runtime logs and kill**, which were the three things people still opened Railway for.
  Health asks the agent's own `/health`, because Railway reports a crash-looping service as
  deployed; logs are followed as the sliding window Railway's query actually is; and kill reports
  what *happened* rather than what was asked for, because "stopped" and "detached from Jaroku, still
  running and still costing money" are different facts about somebody's bill.
- **Nine suites**, all in CI: `test:work-store`, `-dispatch`, `-lifecycle`, `-cost`, `-redaction`,
  `-tenancy`, `-channel`, `test:work-badge` and `test:fleet-line`.

### Fixed

- **A confirmation was broadcast once and could be missed.** A tab opened after the ask went out had
  a run stopped on a timer and no dialog to answer it in — survivable while every ask arrived
  seconds after somebody pressed Run in the tab they pressed it in, and not survivable for a job
  that was dispatched and left. The relay now replays what is blocked to a connecting socket, with
  the countdown showing what is *left* rather than what it started at.
- **`test:deploy-reconcile` passed for two hours and then failed for ever.** Its injected clock was
  pinned to the afternoon it was written, and run tokens are minted from that clock while
  `verifyRunToken` checks the real one — so past the two-hour TTL the stub container's pushes were
  refused as expired and nine assertions reported `undefined` for a row nothing ever wrote.
- **`_run_grants` in `mcp_bridge.py` was keyed by tool alone**, so the first approval of a refund
  approved every refund that container served afterwards. It is keyed by `(run_id, tool)`.

### Not in this release, deliberately

Schedules and triggers, rollback and environment variables, per-agent spend ceilings, and delivering
a result outward. All four sit directly on machinery this release creates, and the constraints they
put on it are honoured now: `work_items.created_by` stays NOT NULL so a scheduled item can be
attributed to whoever created the schedule, and `work_items.id` is stable and citable because Part
3's answers will cite it.

Two limits are worth knowing. A container's checkpoints do not survive a restart, and setting a
Railway variable restarts it — so a resume whose checkpoint is gone is a `409` rather than a silent
re-run of a graph that already spent money. And the fleet strip's health figure is whatever the last
probe found; nothing polls on a timer, so a card that has never been probed says nothing rather than
guessing.

---

## v0.3.9 : Bug Fixes and Product Audit — The Last Link, Sixteen Times

Every release since v0.3.0 connected an entry point and a persistence layer, and this one is about
what a forensic audit of the whole product found sitting between them. The finding is a single
shape, repeated: **the value is stored, the value is displayed, and the value is not read by the
thing it was supposed to change.** Reasoning effort, composer attachments, connector scoping,
response variants, memory decisions, forked objects and restored versions are seven instances of
it, and in every one the expensive part — schema, store, route, component, empty state, suite —
was finished and the missing piece was between five and fifty lines.

The audit produced sixteen confirmed findings, each traced along one chain from backend capability
to user action and back, with the break recorded. All sixteen are closed here, one commit each,
each left with CI green before the next was started. Two more were discovered while closing them
and are written up below rather than absorbed quietly.

**The one to fix first was the one that made the rest visible.** `WsRelay.answer()` — the shared
path for every point-to-point read on the socket — had three outcomes and expressed two: a success
was a message, a refusal was a message, and a **failure was a line on a server console the person
who asked cannot see.** That is not a quieter error. Every empty state in this product is designed
to mean "there is nothing here", so a swallowed failure spends that meaning on a lie: one
unreadable object made the Code view, the ⊕ attachment picker and the version browser all agree
that an agent with two published versions had never been generated. Closing it first is what turned
the next two findings from theory into a reproduction.

### Fixed

- **A read that failed answered nothing at all.** `answer()` takes a required `onError` returning
  the channel's own error member, and all thirteen call sites supply one. Required rather than
  optional is the structural half: a read command added next year cannot be written without
  deciding what its failure looks like, and `test:channels` reads every call site out of the source
  to say so. `loadHistory` and `loadRun` answer on the diagnostics rail instead of their own
  channels, deliberately — a full-snapshot channel with no error member would mean every consumer
  learning a second shape for a read that has never failed in production.
- **`forkAgent` published a version whose objects were never written.** An object's key is per
  agent — `ws/<workspace>/agents/<agentId>/v<n>/<path>` — so a manifest copied across an agent
  boundary names a prefix nobody wrote. The row was correct, the version list was correct, the byte
  total was correct, and every read of the content threw. `addVersion` is right for a *restore*,
  where the objects live under the same id; copying that call into fork was the whole defect. It
  publishes the source's **files** now, reading them before any row is written so an unreadable
  source refuses with a sentence instead of producing a second broken agent.
- **A restore was broken in the object store as well as on disk, and the audit had it as working.**
  The same defect one axis over: a key carries the version it was written under, so a manifest
  handed to `addVersion` reserves v5 and names paths that exist only under v3. It read as correct
  because the read threw, the throw was swallowed, and the panel not changing looked exactly like a
  refresh that had. It publishes the old version's files now — which also strengthens the property
  the forward publish exists for, since a version that owns its objects cannot be broken by a
  retention sweep collecting the one it pointed at — and materialises them where a run spawns from.
- **Composer attachments were picked, priced by the server, rendered with their token cost, and
  dropped on the floor.** A complete backend and a complete front end with no line between them:
  `turn_attachments` held zero rows, and an over-budget rail **blocked the send of a message** whose
  attachments were never going to leave the browser. The refs ride the command now — at Send the
  turn has no id yet, which is why `github.attachments` already worked that way — and
  `attachTurn` is one implementation of the cap, the server-side re-measurement, the budget check
  and the all-or-none write, called by both the route and the dispatch. They reach the prompt too:
  a persisted ref nothing reads is a record, not a feature.
- **Reasoning effort was persisted, resolved, rendered — and never applied.** `planEffort`, the one
  adapter §3.2 required, was written, tested, and reached from nothing, so somebody setting High on
  a hard generation got the provider's default. It is called at all four model calls the composer
  can start, and the run path carries the level to `models.py` on the same seam `JAROKU_PROVIDER`
  already uses. The adapter gained a **per-request** ceiling: every builder sends its own
  `max_tokens` — 600 for a plan, 700 for an explain — and a thinking block is spent out of *that*.
  The inference that this was enforced was entirely reasonable, which is what made it a bad failure
  rather than a small one: `permission_mode`, the column beside it on the same row, is enforced.
- **Connector scoping was enforced for MCP servers only.** The composer's deck lists reviewed
  connectors, user-secret connectors and MCP servers in one list and lets you disable any of them;
  the dispatch applied those decisions to one of the three kinds. Switching Gmail off dimmed a tile,
  persisted a row, and left its tools bound, its token minted and `googleapis.com` on the egress
  allowlist. One narrowed list now feeds the credentials, the egress and the runtime, and the
  connector templates — host-owned and copied byte-for-byte into every project, **including ones
  already generated** — refuse by name rather than reporting a credential problem that does not
  exist.
- **`runnable` was derived from the local filesystem, never from the version manifest.** The comment
  above it already said the manifest answers for a published agent; the code asked the disk twice.
  So a fork, a restore on another replica, a restored backup or any hosted deployment with an
  ephemeral disk reported an agent as unrunnable and blamed a missing `agent.py` on a filesystem the
  user cannot see. One query for the whole workspace answers it now, and `ensureProjectDir` is the
  only way the run, the plan and the deploy obtain a project directory — which makes the local run
  path correct on a second gateway replica for the first time.
- **Eight of twenty-nine Inbox actions rendered controls that did nothing**, two of them a card's
  **primary** control, on a surface whose stated goal is that a board can be cleared without leaving
  it. Six had a working command one import away. `runAction`'s switch is exhaustive now — a new
  action name fails the client typecheck rather than shipping as a dead glyph — and its return value
  is read at both call sites, where it used to be discarded so a closing menu was the only feedback
  either way.
- **The upsell card named a plan that does not unlock what was refused.** `nextTier` was a
  two-branch heuristic — Free's next step is Pro, a paid tier's is Team — standing in for a lookup,
  and it is false for the three kinds a Free workspace is most likely to hit: GitHub sync and
  per-agent access are Team-only, and **Pro's seat count is 1, the same as Free**. Somebody
  inviting a colleague was told "Pro raises this limit", paid $20 a month, and found out when the
  invite refused again. It is a lookup now, over the same projection the refusal was made with, and
  a kind no plan grants renders as "No plan currently includes this" with no button at all.
- **Response variants had a table, a store, a suite, a slot in the metadata row and a switcher with
  both arrows disabled over a prop nothing passed.** Regenerate put the sentence back in the
  composer and stopped. It dispatches now, attaching a second answer to the turn it is re-running
  rather than appending a second question.
- **An agent's MCP grants were fixed at generation.** The Capabilities tab detected and explained a
  grant whose server had left the workspace and offered no way to remove it, and `forkAgent`'s own
  notice told people their fork's grants start empty — advice that is only sensible if grants can
  be filled. `setAgentTools` is the first writer of that column that is not a creation.
- **`memory_proposal` could not be answered.** Its primary control did nothing *and* prevented the
  card expansion that would have shown the evidence, its two verbs closed a menu and changed
  nothing, and its resolve predicate read a `decision` field nothing wrote. `noteMemoryDecision` had
  existed since the type shipped, reachable only from a test.
- **The pricing page sold three capabilities the product does not have.** Batch approvals, the
  policy engine and evals as a CI gate name flags that gate nothing — which
  `entitlementGate.ts` records openly, in the right order: declare the flag, wire it when the
  surface lands. What went wrong is that the marketing shipped *ahead* of the flag rather than
  behind it, and it was the only commercial claim in this repository the code contradicted.
- **Every external pull request was told a collaborator could approve real providers, and the state
  that sentence described was unreachable by construction.** `approvedForSha` needed a paid check
  row, a paid row needed a paid run, and a paid run needed `approvedForSha`. The maintainer it was
  addressed to went looking and found nothing.
- **The Graph tab's error was truncated to a bare filename.** The one error path in this product
  wired end to end delivered *less* than a raw string dump: a 120-character diagnosis went through
  a truncator built to keep the last path segment, so `could not read this agent's files: no such
  object: ws/…/v2/.env.example` rendered as `.env.example`, under a heading it had no visible
  relationship to, with the real sentence one hover away.
- **Share was a permanently enabled no-op** in the one strip present on every surface of the
  application — focusable, in tab order, with a tooltip you had to hover a dead control to read.

### Added

- **`answerMemoryProposal`**, `setAgentTools` and a GitHub Check Run **requested action** — three
  commands for three states that had a UI and no way in. The last is a real round trip: the button
  is declared on the check gated on `offersApproval` (the caller that function was written for and
  never had), `check_run.requested_action` parses into its own event, and the handler asks GitHub
  whether the sender has write access before writing anything.
- **`test:dead-controls`**, a new client suite: no `<button>` renders enabled with nothing behind
  it. It reads every `.tsx` under `client/src`, strips prose first — four files argue at length
  about what a `<button>` should be, and the first run reported all four as dead controls — and was
  **watched refusing a reinstated Share** before being kept. A check nobody has seen refuse anything
  might be stuck at true.
- **A structural gate on the pricing page.** `test:checkout-surfaces` reads the Features table and
  requires every row to map to an `EntitlementKind` — a *check somebody can be refused by* rather
  than a flag somebody declared, which is the difference between a claim and a delivery.
- **`features` on the in-app plan list.** The upsell card's whole job is "Team turns this on", and
  until now the only surface that could corroborate it was the public pricing page, which a paying
  customer does not open.
- **A collaborator-permission route on the GitHub fixture.** Without it `hasWriteAccess` swallowed a
  404 and answered false for every login, so the approval's success path was unreachable in the
  suite exactly as the circular `approvedForSha` made it unreachable in production.

### Changed

- **`noteUserMessage` and `threadStore.addItem` return the turn id.** Four tables hang off that row
  and nothing could reach it without reading the thread back — which is why composer attachments had
  no turn to attach to at the moment they were sent.
- **`linksForRepo`'s branch is optional.** A `check_run` delivery carries no branch to narrow by, and
  guessing one would be inventing a fact. Both existing callers are byte-identical.
- **`view_all_failures` is removed from the Inbox registry.** There is no filtered run list in the
  product to send anybody to, so it rendered in an overflow, closed the menu, and did nothing. A
  menu that closes reads as confirmation, which makes a silent no-op worse here than an absent
  entry. It comes back when a destination does.
- **`enable_gate` is relabelled and repointed.** It promised something no command could do: the
  confirmation gate is off because a line in the agent's *own generated source* turned it off, so
  only an edit can put it back. It navigates to the code now, labelled "Open the code that turns it
  off" — the old label is why it read as a broken button instead of as a link.
- **`DraftAttachment.error` and the send-block that read it are gone.** No code path could set that
  field, so it blocked Send on a state that could never exist, over a payload that was never going
  to leave the browser. A refusal now arrives in the conversation, beside the message it is about.

### Migrations

None. Every table this release writes to already existed — `turn_attachments`, `turn_variants`,
`agent_grants`, `check_runs`, `conversation_settings` and `agents.mcp_tools` were all in the schema
and all of them had fewer writers than readers. `schema/events.md` is untouched.

### Verified

- **Sixteen commits for sixteen findings**, each pushed to `origin/main` on its own and each left
  with CI green before the next was started, plus one repair when a suite added to CI turned out
  unable to run there.
- **Nine suites gained a reachability audit, and each is a source audit deliberately.** The pattern
  this release is about defeats arithmetic assertions: every check already in `test:attachments`,
  `test:effort` and `test:turn-variants` was *true* of code that never ran on a real turn. So those
  suites now read the dispatch, the wire and the client for the links themselves — four dispatch
  sites, three payload sites, four commands carrying a field, both `sendPlanAgent` call sites.
- **Two assertions were written from the broken end first**, because one that only exercised the
  fixed path would have passed on the shipped code too: a manifest copied across an agent boundary
  still throws `ObjectNotFound`, and one copied onto a new version number still resolves to nothing.
- **`test:entitlements` holds the four kinds the old heuristic got right as well as the three it got
  wrong**, since a lookup that special-cased the failures would pass the wrong three alone.
- **The exhaustiveness check proved itself while being written**, failing the build naming
  `set_secret | set_mcp_credential | raise_ceiling | view_all_failures` — exactly the class of
  omission that shipped.
- **One defect was found by the implementation rather than by the audit**, and it would have shipped
  as a silent success: migration 045 allows one live check per commit, so opening the approval's
  paid row while the dry-run check was still running **read that row back and wrote nothing** —
  `approvedForSha` stayed false and the re-run went out on the fake provider having reported
  success.

### Still owed

- **Forty-five server suites are registered in `package.json` and absent from `ci.yml`** — found by
  this pass rather than reported by it: two of the four suites this work needed for
  verification turned out not to run. Three were added. The rest need triage per suite rather
  than a bulk addition, and `test:edit-versions` is the proof: it validates a generated
  project by importing it with Python, and the server job has node and nothing else, so it fails
  there for a reason that says nothing about the code under test. It is recorded in the workflow as
  deliberately absent, with the reason, rather than left looking forgotten.
- **Forks created before this release still have no objects.** They report an honest read failure
  now instead of an empty file list, which is the recoverable state; re-forking from the source
  produces a working copy.
- **The variant switcher's bodies live in memory.** That is migration 044's own decision about
  Jaroku's prose applied consistently — replies are not stored and a reloaded thread is rebuilt from
  stubs — so `turn_variants` records what each answer *cost* forever and the text lives as long as
  the tab does. Storing the bodies would be a transcript table §7 deliberately does not have.
- **Everything v0.3.8 left owed is still owed**, unchanged by this pass: the personal-workspace
  Exposure sentence, per-agent narrowing on indirect ids, and cross-replica live sessions.
- **`approvalBatchApprove`, `policyEngine` and `evalCiGate` still gate nothing**, which remains the
  correct order. They are simply no longer sold ahead of the surfaces they will gate.

---

## v0.3.8 : The Access Tab — Per-Agent Access, and the One Section That Says What This Does Not Cover

A workspace role has always been the whole answer to "what may this person do", and it is the same
answer for every agent in the tenant. That is fine for a workspace of three and wrong for the case
this release is about: a contractor brought in to fix one agent held the same authority over every
other one, and there was no row anybody could write to say otherwise.

So access becomes per-agent. What that could easily have been is a second permission system beside
the first, and the whole of the design is about it not being one. There is **one resolver**, in the
file the role matrix already lives in, and the grant is data that flows through the same check
every command already passes. A grant may narrow somebody below their role's default or widen them
within it, and can never exceed it — enforced when it is written *and* again on every command, which
sounds redundant and is the only thing that makes a demotion bite without anybody rewriting rows.

The section that matters most is the one that is not about Jaroku at all. Every grant here governs
access *through* this product; a deployed agent answers HTTP directly, on a template with no auth
layer of any kind. An access panel that implied otherwise would be worse than no panel, because it
converts an unknown risk into a false certainty — so Exposure states the posture as a sentence and
renders when nothing is deployed too, since a section that disappeared would have its absence read
as safety.

### Added

- **Seven agent-level capabilities** — `view`, `run`, `edit`, `eval`, `deploy`, `secrets`, `admin` —
  extending `auth/capabilities.ts` rather than sitting beside it. The implication rules are data:
  `view` is implied by everything, `edit` implies `run`, and `secrets`, `edit` and `admin` imply
  none of each other, because a contractor who writes an agent's code and a person who holds its
  production credentials are genuinely different roles. The grant dialog applies the same table the
  server applies, so the set on screen and the set that gets stored cannot disagree.
- **`resolveCapabilities(ctx, agentId)`**, the one resolver: workspace role → the role's default set
  → the grant → **the intersection with the ceiling, always** → the implication closure. Expiry is
  evaluated here and nowhere else, because a control that is correct only as often as a cron fires
  fails silently in the generous direction.
- **`agent_grants`** (migration 060), keyed on `(workspace_id, agent_id, user_id)` with a composite
  foreign key to `agents (workspace_id, id)`. A bare `agents(id)` reference is satisfied by *any*
  tenant's agent — that is the hole migration 018 closed on `secret_refs`, and repeating it on an
  access-control table would be considerably worse.
- **The `access` channel** — `loadAccess`, `loadExposure`, `loadSessions`, `loadAccessHistory`,
  `grantAccess`, `modifyGrant`, `revokeGrant`, `endSession`. WebSocket commands rather than the
  HTTP routes the original design called for, because a socket is already scoped to a workspace and
  agent access happens inside one. Every read answers the socket that asked.
- **The Access tab**, sixth in the agent detail view, with five collapsible regions. It is
  **read-only without the `admin` capability rather than hidden**: "who can deploy this?" is a
  question a member should be able to answer without asking an admin, and hiding the answer produces
  exactly the Slack thread the tab exists to eliminate.
- **A provenance line on every person row** — "from workspace role", "granted here by Priya · 3 days
  ago · expires in 6 hours", or "their member role caps this at view, run". This is the whole point
  of the panel rather than a nicety: a list of names with permission badges is a report, and an
  admin who cannot tell an inherited capability from a granted one will revoke a grant that was
  never the reason.
- **Time-boxed grants as a first-class control**, and a **required note** for `deploy`, `secrets`
  and `admin`. Six months later "why does this contractor have deploy" needs an answer that is not
  archaeology, and the only moment anybody can write it is the moment they know.
- **Live revocation.** Any grant change emits a workspace-scoped recheck carrying **nothing at all**
  — not who, not which agent, not what — because it reaches every socket in the workspace and the
  detail belongs to whoever may read the History section. It is emitted from `setMemberRole`,
  `removeMember` and `leaveWorkspace` as well, since a role *is* the ceiling.
- **Exposure**, which names the live URL, states in a sentence that the endpoint is unauthenticated,
  and says who deployed it — for which `deployments` gained a `created_by` column (migration 061),
  nullable and never backfilled, because a name beside a public URL that nobody chose to publish is
  worse than an honest gap.
- **Live sessions**, with a name, two words about the browser and a duration. **No IP addresses**,
  no tickets, no raw User-Agent. End session closes one socket and revokes nothing, and the
  confirmation says so, because an administrator who believes they removed somebody's access and
  removed their tab is the failure that button invites.
- **Pending invites and History.** History reads `audit_log` and marks a *workspace* change apart
  from an *agent* one, because the commonest reason somebody's access to an agent changed is a role
  change two panels away. `[Export CSV]` carries the scope as a column, since an icon is nothing in
  a spreadsheet.
- **`access.denied`**, written whenever a real command is refused for insufficient per-agent
  capability. It is the highest-signal row in the feature and the only evidence a grant is wrong:
  nobody files a ticket saying their capability is misconfigured — they try, fail, and eventually
  ask a colleague to do it for them.
- **Pre-staged grants on invitations** (migration 062). The grant travels with the invitation and is
  written **in the same transaction as the membership**, so a partially-accepted invite with a
  missing grant is impossible. The dialog's confirming sentence names the workspace twice, because
  an admin must never think they granted narrow agent access when they widened the tenancy.
- **Three new suites**, all wired into `ci.yml`: `test:access-resolver` and `test:access-denied`
  (server), `test:access-tab` (client).

### Changed

- **`useCapability` and `useCanRun` take an optional `agentId`** rather than gaining a sibling. A
  `useAgentCapability` would have been the two-resolver drift this whole feature exists to prevent,
  one layer out from the server where the same rule is written. Without the argument every existing
  call site means exactly what it meant.
- **Every agent-scoped guard now passes its agent** — Deploy in the title bar and the panel, and the
  six GitHub writes. A guard left at the workspace scope is not a broken button: it renders exactly
  as it always did and the narrowing somebody deliberately applied is silently not there.
  `test:permission-ui` reads the components and fails on one that forgot, which is how the last two
  were found.
- **The GitHub writes are agent-level `deploy` rather than `edit`**, which is the least obvious
  decision in the matrix. What they do to the source is nothing; what they do is put it outside this
  product where people with no membership here can read it. A contractor granted `edit` to fix one
  agent has not been granted the right to publish it to the company's organisation.
- **`perAgentAccessGrants` is wired.** The flag has been in `TierEntitlements` and in the plan table
  since v0.3.4 — off on Free and Pro, on for Team — declared with nothing to check because the
  surface did not exist. It gates `grantAccess` and `modifyGrant`. The **reads are deliberately not
  gated**: what Team buys is the ability to narrow somebody, and what every workspace gets is the
  ability to see who can reach what. The Exposure warning behind a paywall would be indefensible.
  Revoking is not gated either, by the rule a downgrade gates features off and never destroys data.
- **A third close code, `4003`**, for a session an administrator ended. Distinct from `CLOSE_RECONNECT`
  because a tab that came straight back would make the button appear not to work.

### Fixed

- **`describeClient` reported "Safari on macOS" for every iPhone.** An iOS User-Agent contains the
  literal string "like Mac OS X" and an Android's contains "Linux", so a scan that asked the general
  question first was confidently wrong on every phone — on the one row whose entire job is helping
  somebody recognise their own session. Both lists are now most-specific-first, with an assertion
  per case.
- **The agent-scoped command audit was too generous.** It looked for `agentId` anywhere in a
  command's type literal, so `inviteMember` — which gained a nested `agentGrant.agentId` — was
  reported as needing an agent-level capability. The relay reads `msg.agentId` and nothing deeper,
  and an invitation is an act on the *workspace*; the rule now matches only a top-level field, which
  is exactly what the gate reads.
- **`deployments.created_by` did not exist**, so §13's "who deployed it" was unanswerable — there is
  no audit row for a deploy either. The column is written from the socket's own context, which is
  the person the server already decided was allowed to do it.
- **Every expiry rendered as "expires just now".** `relTime` floors its delta at zero, which is
  correct for the fifty call sites it was written for — all of them describing something that has
  already finished, none of which should read "in 1s" because a clock was a second fast. A grant's
  `expires_at` is the first future instant this client has ever had to draw, and it went through
  that function: a grant with eight hours left announced itself as one that had just run out, which
  is not a smaller answer than the right one but a confident wrong one about the single fact a
  time-boxed grant exists to communicate. `relUntil` is a sibling rather than a sign flip inside
  `relTime`, so the clamp the other fifty depend on stays where it is.
- **The History line spelled the person as a uuid.** `metadata.user` on an access audit row is an
  id — deliberately, since a stored display name is a record of what somebody was called that day —
  and the sentence read it as though it were already a name: "granted
  5935135b-c901-4861-ad62-cb6b199a276a view", on the one line whose whole job is letting an
  administrator recognise a change they did not make. It resolves through the same membership
  lookup the actor's name already used, and capabilities now read in the panel's order rather than
  the closure's, so a line does not list the same set differently from the chips above it. The
  sentence moved to `auth/accessHistory.ts` in the process: inside `index.ts` it could only be
  asserted with a regular expression over the source, which is how it passed every check for a
  release while being wrong.
- **A tier refusal on the access channel had no card.** `perAgentAccessGrants` gated nothing until
  this release wired it, so Grant is the first control in this panel a Free workspace can press and
  be refused by — and the refusal arrived as the panel's red sentence alone, while every other
  tier-gated surface in the app answers with the inline upsell naming what would change it. The
  card is scoped to the `access` channel, so a refused generation puts nothing here and a refused
  grant puts nothing on the composer.

### Migrations

Three, all expand-only and safe against the version currently serving:

- **`060_agent_grants`** — the table, with RLS enabled and forced and a `WITH CHECK` half, because a
  write here is somebody else's permission. Registered with export, retention and the deleter so the
  three audits that read the schema cover it from its first migration.
- **`061_deployment_actor`** — `deployments.created_by`, nullable, never backfilled.
- **`062_invite_agent_grant`** — the pre-staged grant, as `json` on the invitation row. Deliberately
  no foreign key to `agents`: §16 requires that an invitation accepted after its agent was deleted
  still create the membership and discard the grant silently, which a key would turn into an error.

`schema/events.md` is untouched — nothing here is a run event.

### Verified

- **Fifteen commits for the specification's own plan**, each pushed to `origin/main` on its own and
  each left with CI green before the next was started.
- **`test:access-resolver` drives every gated command with the client bypassed entirely** — a real
  relay on a real port, raw WebSocket frames, no store and no component that could be politely
  refusing on the server's behalf. Its two load-bearing assertions both look redundant: a grant
  exceeding a role is refused at write time *and* a row written straight to the database is
  intersected down at read time, and a cross-workspace agent id answers "there is no such agent"
  rather than refusing, on every command, because a refusal confirms the id exists.
- **The composite foreign key was proved by the database rather than by a comment** — a grant naming
  another tenant's agent is rejected on both drivers, and `test:tenancy` aims the reads, the write
  and the revoke at workspace B's real ids from workspace A.
- **`test:access-denied` asserts the row is written per refusal rather than deduplicated**, because
  the pattern is the signal — and that a cross-tenant id writes nothing at all, since that branch is
  reachable by anybody who can open a socket at whatever rate they choose.
- **The render assertions are about absence.** A non-admin gets the full panel with every mutation
  control absent rather than disabled, and the suite fails on `disabled` too, because §8 rules out
  both shapes.
- **The panel was driven in the running desktop app, and that is where the last three defects came
  from.** None of them was reachable from a suite: a formatter is correct against a fixture and
  wrong against a clock, a history line reads perfectly until real ids are in it, and a paywall on
  a control nobody had pressed yet is invisible until somebody presses it. The access channel was
  also exercised over a raw socket against the same process the window was talking to — sign-in,
  ticket, `loadSessions`, `loadAccessHistory`, a grant refused for exceeding a member's ceiling,
  and a grant accepted, with its recheck arriving on the workspace channel.

### Still owed

- **A personal workspace loses the Exposure sentence along with the tab.** §16 puts the Access tab
  out of personal workspaces because they have no members, and that is right for four of the five
  sections — a People list of one, an invite section offering to widen a tenancy that is not
  shareable, a History of things one person did to themselves. It is not right for the fifth: a
  personal workspace can deploy, and "anyone with the URL can invoke this agent" is exactly as true
  there. The Deploy tab still shows the URL; what a solo person loses is the sentence about what it
  means. Recorded rather than quietly decided otherwise.
- **The per-agent narrowing does not reach commands that name an agent only indirectly.** `pauseRun`
  carries a run id, `applyEdit` a proposal id, `cancelDeploy` a deployment id, `addExample` a dataset
  id — each belongs to an agent and none says which. So a person who may not `run` an agent may
  still pause a run of it that somebody else started. Every command that *creates* those ids is
  gated, so the narrowing holds at the door and leaks at the follow-up; closing it means the id
  carrying its agent, which is a change to four message shapes and their clients.
  `test:capabilities` asserts this rather than leaving it implied.
- **Live sessions are the sockets this process holds.** Tickets are in Postgres so the question is
  answerable across replicas, and the answer is not assembled across them yet: behind two gateways
  each reports its own, and `endSession` can only close one it holds. The count is honest about what
  it counted.
- **The per-socket agent context is advisory.** A tab left open on an agent last Tuesday still
  reports that agent. What it answers well is "who is in here right now".
- **No group or team grants, no custom roles, no approval workflow for grant requests**, all
  explicitly out of scope — per-user until there is evidence of teams large enough to need
  otherwise.
- **Authentication on deployed agent endpoints is still the largest real gap**, and it belongs to the
  deploy layer rather than here. The Exposure section is what makes it visible enough to prioritise.

---

## v0.3.7 : Teams & Workspaces — The Surface That Reaches a Backend That Was Already There

Almost nothing in this release is a new capability. The tables landed in v0.2.5, the socket has
been scoped to one immutable workspace since v0.2.6, every store has emptied on a workspace change
since then, and the commands to invite, remove and re-role somebody have all been checked against
the capability matrix since the day they were written. What was missing was the way in: there was
no switcher, so `POST /v1/ws-ticket` only ever asked for the default workspace; no client called
`POST /v1/workspaces`, so the only way to make a team was an environment variable; and an
invitation could be minted but not pasted.

So this is a wiring release, and the two places wiring goes wrong are both about *ordering*.
Switching workspace is a teardown and a rebuild, and the difference between doing it right and
leaking one tenant's rows into another tenant's panel is which of six steps happens first. And an
affordance a role cannot use has to be **absent** rather than disabled — which means the client
needs the server's capability matrix, which means the two can drift, which means something has to
fail when they do.

### Added

- **The workspace switcher, in the sidebar header.** The workspace name was a label; it is now the
  control. Collapsed it carries the kind icon, the plan chip from the session, and a chevron.
  Expanded it lists the personal workspace first and teams alphabetically by `localeCompare` — the
  ordering rules are where the wrong answers are, and every one of them looks right on the
  four-workspace account somebody develops against: byte order puts `Zebra` above `acme co`, and a
  personal workspace sorted among the teams moves the one fixed point in the menu every time
  anybody renames anything. Arrow keys, Enter, Escape, outside click.
- **The switch transition.** Lock, close the old socket, empty every store, fetch a ticket, open a
  new socket, unlock. Closing before opening and emptying before refilling are the two orderings
  that matter, and both are cross-tenant leaks in the UI when they are wrong. A failure at any step
  **reverts to the workspace it came from** and says why, rather than leaving somebody behind a
  scrim or on a sign-in screen.
- **Create workspace**, from the switcher rather than an environment variable. Name, kind, trimmed
  before sending, auto-selected on success.
- **Join workspace by pasted code**, beside the deep link that already worked. It takes a whole URL
  or a bare token and refuses what cannot be one before anything is sent — the truncated paste is
  the case the refusals exist for, because it is the one that otherwise reaches the server looking
  like a valid secret.
- **The members and invitations surface**, wired to the four commands that were already there:
  role changes with an owner-transfer confirmation, removal, an invitation shown once and copyable
  for thirty seconds, and a pending list with revoke. An owner cannot leave; everybody else can.
- **`useCapability`, `useCanRun`, `useCanReach`, `useCanTake`, and `<Capable>`.** A guard should
  name the *command* rather than the capability: `useCanRun("deploy")` asks the table, where
  `useCapability("agent:write")` asks whoever wrote the component to remember a mapping — and a
  wrong answer there looks exactly as plausible in review as a right one.
- **Workspace identity in the chrome.** The Tauri window title is now `Jaroku — <workspace>`,
  because nothing the page wrote to `document.title` reached the native window and alt-tabbing
  between two workspaces showed two windows called Jaroku.
- **Five new suites**, all wired into `ci.yml`: `test:workspace-switcher`, `test:workspace-switch`,
  `test:join-flow`, `test:permission-ui` (client) and `test:invite-flow` (server).

### Changed

- **The audit sweep replaced four disabled-with-a-reason controls with absent ones** — export,
  delete, the BYOK toggle and the plan buttons. A greyed control with "only an owner can do this"
  beside it has decided somebody should keep looking at it, and §8 of the specification rules out
  both that and hiding with CSS. The BYOK *state* still renders for everybody, because whose keys
  the agents run on is a fact a member needs in order to read a bill; what is absent is the switch.
- **Two places where the specification and the server disagreed were resolved toward the server**,
  which is what the specification itself asks for in bold. Its checklist files Deploy under
  `agent:write` — a member capability, so following it would have put a Deploy button in the title
  bar of every member's window — and lists members, export, delete and billing as "Owner, Admin"
  where `COMMAND_CAPABILITY` puts all of them in `OWNER` alone. And it asks for three distinct
  invite-failure messages where the server deliberately collapses expired, revoked and used into
  one, so that a stolen link learns nothing about which it is.

### Fixed

- **Being refused entry to one workspace ended the session in the one you were already in.**
  `fetchTicket` answers 403 for a workspace you are not a member of, `AuthFailure` marks a 403
  not-retryable, and the connect path's handling of not-retryable is `signOut` — correct for the
  workspace a tab is already in, and badly wrong for one it is trying to enter. Somebody removed
  from a team while their tab was open would click it in the switcher and land on the sign-in
  screen. A switch in flight now reverts instead.
- **A `member` link invitation silently demoted an owner who opened it.** `insertMemberIn` upserts
  the role, so an owner clicking their own shareable link wrote `member` over `owner` — on the one
  account that cannot be restored by anybody else, since only an owner can change a role.
- **An invitation stored with an empty address competed for the one row the partial unique index
  gives it**, so minting a second link revoked the first. An absent address now reaches the
  repository as absent and the column stores `NULL`.
- **The invite form returned early on a blank address**, which made the link-for-anybody the one
  credential no screen in the product could produce.
- **`POST /v1/workspaces` created a second personal workspace for anybody who asked.** The rule
  was only ever on the button: the switcher absents the Personal option once you have one, and the
  route accepted `kind: "personal"` from any request behind it. Every account is provisioned with
  one, an owner cannot leave the one workspace they cannot be removed from, and several things
  read as though there is exactly one — the landing after leaving a team picks
  `find(kind === "personal")`, and the switcher pins *the* personal workspace to the top. Found by
  walking §12.3 against a running server; `test:session` asserted the opposite and now asserts the
  refusal.
- **Two of the three routes that provision an account let an identity conflict escape as a 500.**
  `provisionUser` refuses to hand one verified address to a second `sub` — a person whose provider
  changed under them — as a typed error rather than a unique violation, precisely so that somebody
  gets a sentence instead of "your sign-in is broken". Only `/v1/auth/session` was converting it,
  so `/v1/invites/accept` and `POST /v1/workspaces` answered 500 — and the invite route is the one
  an invitee reaches first, because §12.2 has them redeem before they have ever signed in.
- **Six capability guards named a capability in the comment above them and then compared against a
  role literal.** Billing, the spend ceiling, the checkout, members, the audit log and the data
  section all read `role === "owner"`, and all six were *right*, because `billing:manage`,
  `member:manage` and `workspace:manage` are the owner's today. That is what makes it worth a rule
  rather than a fix: nothing was broken, so the day one of those moves to admin, six surfaces would
  go on quietly meaning the old thing. `test:permission-ui` now reads the components and allows
  two, both rules about ownership rather than capabilities — §10.2's rename, which mirrors the
  route's own two-role check, and §6.5's "an owner may not leave".
- **Every capability refusal an admin has ever seen began "a admin".** `a ${ctx.role}` is right for
  two of the three roles and wrong for the one that reads it — an owner is refused nothing, so the
  sentence reaches admins and members alone.

### Migrations

**None.** Every table this release touches has existed since v0.2.5, and the one column it leans
on — a partial unique index that permits many `NULL` addresses and one row per real address —
arrived with `059_link_invites`. `schema/events.md` is untouched: nothing here is a run event.

### Verified

- Fifteen commits for the specification's own plan, each pushed to `origin/main` on its own and
  each left with CI green before the next; then three more for what a bug sweep found afterwards.
- **§6 was walked against a running server as well as §12.3** — an admin refused every membership
  command, an owner promoting and demoting, a member leaving and losing their ticket, an owner
  refused the same departure, and a removal closing the removed member's *already open* socket
  (code 4001) rather than leaving it until they next reconnect.
- **`test:permission-ui` reads `server/src/auth/capabilities.ts` as text** rather than importing
  it, and fails in both directions. The direction that matters is the one nobody watches: a
  capability the client grants and the server does not is a button that 403s and gets reported the
  same day, while a capability the server grants and the client does not is a feature that
  silently is not there for the role that has it — nobody files that, they assume the product does
  not do it. It also renders six real panels at member, admin and owner and asserts the affordance
  is absent from the markup rather than merely disabled.
- **`test:workspace-switch` asserts a transcript, not a result.** The socket and the network are
  fakes that record, because "closed then opened" and "opened then closed" produce the same screen
  and only one of them is correct. Its last assertion in every block is that nothing from workspace
  A survived into workspace B.
- **§12.3's golden path was walked end to end against a running server** — sign in, create a team,
  ticket, socket, mint a link over the socket, redeem it as an account that had never been seen
  before, redeem an addressed one as an account that already existed, revoke a third and be
  refused by it — along with every redemption that must fail.

### Still owed

- **The golden path was walked over HTTP and the socket, not in a browser.** §14.3 asks for a
  browser against the running server; the click-through half is covered structurally by the client
  suites, which render the real components, and not by anything that drives a real DOM.
- **No unread count on the switcher's rows**, which §2.2 offers "only if you've implemented an
  unread-count-per-workspace endpoint" and asks to be noted rather than faked if not. There is no
  such endpoint: the Inbox badge is computed for the one workspace this socket is in, and a socket
  is scoped to one workspace for its whole life. Counting the others means either a second socket
  per workspace or an HTTP route that runs the derivation per membership on every hydration.
- **No per-member spend attribution**, which §11.3 names and v0.3.3 already recorded: runs carry a
  workspace and not an actor, so "who spent this" is not a question the data can answer yet.
- **Seats are Team-plan only.** Free and Pro are solo by design, so §12.1's "open the Members panel
  and create an invite link" is a step that begins with a checkout. What a Free owner gets is the
  upgrade card rather than a button that fails.
- **No live presence, no edit locks, no thread assignment**, all explicitly out of scope in §16 and
  all of them things a team of two to six will ask for before a team of fifty does.

---

## v0.3.6 : Three New Connectors — Google Calendar, Stripe (Read-Only), HTTP/Webhook

Six connectors instead of three. Calendar pairs with Gmail and unlocks the scheduling agent;
Stripe pairs with Postgres for the support agent the README already describes; HTTP is not really
a connector at all but an escape hatch for the long tail of APIs nobody will write a connector for.

One rule governs all three, and it is ADR-014's: **a connector's safety posture has to be a
property of the file, not a promise about it.** Every posture in this release is therefore
something a suite can fail on. Stripe is read-only because `test:connector-stripe` walks the
template's syntax tree and refuses any SDK call that is not `retrieve`, `list` or `search` — the
way that guarantee stops being true is a seventh tool, which does not exist to be called until
somebody has written it. The HTTP connector's refusals are counted rather than read, because a
message saying "refused" while a socket was opened passes a text check. And Calendar cannot delete
anything because there is no delete call in the file and no scope that would permit one.

### Added

- **Google Calendar, as a second Google connection rather than a wider Gmail one.**
  `gcal_list_events`, `gcal_get_event`, `gcal_create_event`, `gcal_update_event`. Merging the two
  behind one grant would have saved a click and cost the thing people actually want: one grant is
  one revocation, so somebody stopping an agent from reading their mail would lose their
  scheduling assistant with it. Two connections, two `GCAL_` names, independent revocation. The
  scope asked for is `calendar.events` and not `calendar` — the wide one grants creating, deleting
  and sharing *calendars*, which no tool here does, and it is what the consent screen would say.
- **No `gcal_delete_event`, and that is the posture rather than an omission.** Gmail drafts and
  never sends; Calendar creates and updates and never deletes. Writes are already irreversible in
  the sense that matters — an invitation cannot be unsent — so the tool docstrings say so where
  the model reads them, and the update tool reports the guest list it is about to replace, because
  passing `attendees` replaces the whole list and everybody omitted is uninvited.
- **Stripe, read-only, enforced twice and proven from the file.** Six tools, all `retrieve`, `list`
  or `search`. Returned fields are an **allowlist** rather than a denylist — a rule that only knows
  what to remove admits whatever the API grows next — and nothing is `expand`ed, so a card number
  is not something to be careful with here but something the template cannot ask for. Amounts are
  reported as the integer Stripe means: dividing by a hundred is right for most of the world and
  wrong by a factor of a hundred for Japan, in a number an agent is about to quote to a customer.
- **"Use a restricted key" became enforcement instead of advice.** The second layer of the
  read-only posture is Stripe's to enforce and ours to insist on, and until now it was a sentence
  in a catalog description, which is not a layer. A full-access `sk_live_` key is now refused at
  save — on every write path, including a pasted `.env`, because the rule hangs off the vault's
  `store` rather than off a form — with a message naming the `rk_` key to create instead.
- **The HTTP connector, whose allowlist *is* the connector.** HTTPS only; exact hostnames with no
  wildcards, because the domain anybody would want one on is a shared platform and a wildcard
  there grants every tenant of it; credential-in-URL refused before anything is sent and never
  quoted back into a stored trace; response capped at 256 KB; `Set-Cookie` and `Authorization`
  stripped on the way back, after filtering rather than before capping, so a server cannot push
  them out of view behind forty of its own.
- **Addresses are pinned, which is the rule the others depend on.** Checking a hostname and then
  handing that hostname to urllib is a check that proves nothing: a name can answer publicly for
  the millisecond the check looks and `169.254.169.254` for the millisecond the socket connects.
  The name is resolved once, **every** answer is checked — not the first, because a round-robin
  resolver could hand out the dangerous one next — and the socket is dialled at a literal address
  while TLS still validates the certificate against the name.
- **A redirect is reported and never followed**, even to another allowed host. It is the one thing
  a server at an approved address controls completely, and following it hands the choice of
  destination to whoever answered, which is how an allowlist becomes advisory. The report says
  whether the target would pass, so an agent can ask for it directly and go through every check
  again.
- **`HTTP_ALLOWED_DOMAINS` became per-run egress**, the way `DATABASE_URL` already was: parsed and
  normalised at save, resolved fresh and **pinned** at policy-build time, and refused **per domain
  rather than per run** — one entry since repointed at a private address contributes no rule and is
  logged while the other three still work, which is the judgement `mcpEgressRules` already makes.
- **Postgres, Stripe and HTTP now appear in the Connections tab.** Three of six connectors were
  missing from the one screen named for connections, and the answer was to open the Secrets tab and
  type a variable name from memory. They are the same rows, ending in fields instead of a Connect
  button. The value still goes over the elevation-gated `POST /v1/secrets` and never the socket,
  because a WebSocket frame cannot carry an elevation header — and the allowlist, which is a policy
  rather than a credential, can be read back through the existing reveal route, because a list
  retyped from memory is how a domain silently drops off it.
- **Marks for Calendar and Stripe, and a suite for the table that assigns them.** That mapper runs
  on every tool path including the bespoke ones a model names, so its real inputs are
  `mail_to_calendar.py` and `stripe_api_client.py` — and a wrong order there is not a crash or a
  blank square but a Gmail envelope on the calendar tool of the one workspace that has both.

### Fixed

- **The connector catalog's own two verifications had never been run by anything.** The README,
  ADR-014 and CONTRIBUTING all tell a contributor to run `check_catalog()`, and between them no
  workflow, script or npm target invoked it — so a catalog entry naming a file that is not there, a
  `required_env` disagreeing with its module, or a `pip_requires` outside the `connectors` extra
  could each have merged on the word of whoever last typed it into a REPL. A third CI job now runs
  both it and `check_failures_raise()`.
- **The Python private-range refusal had a hole where the standard library used to be.** Delegating
  to `ipaddress`'s own predicates was tried first: `100.64.0.0/10` — carrier-grade NAT, where a
  mobile network or a cloud NAT gateway puts real infrastructure — is **not** `is_private` in
  Python 3.12, having been in that table in earlier versions. The blocks are now named, entry for
  entry with `egressPolicy.ts`, with the predicates kept as a supplement.

### Migrations

**None.** These connectors are files and a catalog entry, not tables: `oauth_connections` already
handles Calendar, and Stripe and HTTP use the existing `SecretStore` under their own names.
`schema/events.md` stays at `schema_version: 1` — an HTTP call is an ordinary `tool_call` step.

### Verified

- Fifteen commits, each pushed to `origin/main` on its own and each left with CI green before the
  next. Five new suites, all wired into `ci.yml` rather than left in `package.json` alone:
  `test:connector-catalog`, `test:connector-gcal`, `test:connector-stripe`, `test:connector-http`,
  `test:egress-connectors`, `test:graph-icons`.
- **A third CI job**, because the connector templates are Python and this workflow had only ever
  run TypeScript. It needs no services and no `--extra connectors`: every suite fakes its SDK into
  `sys.modules` before the template's lazy import, which is both why it is fast and why it can
  assert what a template *sends* rather than only that it did not crash.
- **The two private-range block lists are held to each other by reading the other language's
  source.** The rule is written twice on purpose — the control plane cannot check a request the
  sandbox originates and the sandbox cannot call TypeScript — so drift is the only way it fails,
  and drift is what `test:egress-connectors` tests, in both directions.
- Every scanner in `test:connector-stripe` is re-run against snippets that violate it, because a
  check nobody has watched refuse anything might be stuck at true.

### Still owed

- **No wildcard domains** on the HTTP connector. `*.example.com` is refused and will stay refused
  until there is a model that does not amount to granting a whole shared platform. A future version
  could add path prefixes, which is the narrowing people actually want.
- **No `http_webhook_listen`.** A hosted run's sandbox is outbound-only and its egress policy has
  no concept of accepting a connection, so the tool would work on a laptop and raise everywhere the
  product actually runs — present in the prompt, selected by a model, failing at the point of use.
  Shipped as one tool rather than one-and-a-half.
- **No incremental OAuth scope consent.** Gmail and Calendar are separate Google connections, which
  is the safer arrangement and is documented as the decision rather than the shortcut.

---

## v0.3.5 : The Composer & Generation Panel — Telling the Model More, and Saying What Happened

The right panel inspects; the middle panel acts, and this release is the middle panel. Everything
here serves one of three jobs: tell the model more (attachments, connectors, reasoning effort),
tell the user what happened (the response metadata row), and let the user respond to what happened
(copy, note, pin, regenerate, feedback).

One rule governs every decision in it, and it is the reason several obvious shortcuts were not
taken: **the composer gathers intent; it never performs privileged actions.** Attaching a GitHub
commit is context. Pushing to GitHub is a confirmed, audit-logged action that lives in the GitHub
panel. The same line separates the permission shield — a *policy* control — from tool execution,
which is a gated action. Blurring it is how a trust-first product quietly stops being one.

### Added

- **One bottom control bar, seven controls, in a fixed order.** ⊕, fullscreen, effort, shield and
  the connector deck pack left; the model selector, the Chat/Test toggle, mic and send pack right;
  one spacer absorbs the difference. Deliberately **not** `justify-content: space-between` — the
  deck is absent with zero connectors and the effort control is hidden on a non-reasoning model,
  and spreading the row would move every button each time one of them disappeared. The layout
  rules live in `lib/composerBar.ts` with their own suite, because "hiding a control moves nothing
  else" and "the bar never wraps" are acceptance criteria that otherwise get checked by resizing a
  window and looking.
- **The fullscreen editor is the same composer, re-parented.** Draft text, attachments and every
  toolbar setting are held above both, so there is nothing to synchronise and no direction for a
  sync to fail in. The thread behind it stays mounted at reduced opacity — unmounting it would
  kill streaming turns.
- **An icon registry, and nothing outside it imports the icon package.** Hugeicons numbers some
  glyph families and the numbers move between releases; a renamed export arrives as `undefined`
  rather than throwing, so the control bar would lose a button to a dependency bump with nothing
  reporting it. `test:icons` asserts all twenty tokens still resolve to real path data.
- **Reasoning effort, translated per provider in one adapter.** Four Jaroku levels; extended-
  thinking providers get a budget, `reasoning_effort` providers get a named level, and a model
  with no reasoning control renders the chip **disabled with the model named** rather than showing
  a meaningless "Low". Budgets live in `runtime/pricing.json` beside the prices — the same file
  both the Node estimator and the Python interceptor already read — and every one is validated
  against the model's max output tokens before dispatch. A clamp is **reported**: the turn stores
  what was requested *and* what was applied, so §6.2's marker is derivable after the fact rather
  than only knowable to the provider.
- **The permission shield, enforced server-side with the client bypassed.** Strict, Smart, Fast,
  and there is no fourth. The control writes a row; the gate reads it at the moment a run stops to
  ask, so a modified client, a replayed frame and a runner built from a fork all arrive at the same
  decision. Two invariants hold in **every** mode including Fast: a write or a tool nothing could
  classify always confirms, and a protected path is never writable. Paths are compared as
  normalised POSIX keys, so the Windows separator that silently emptied that block list once
  cannot empty it again through a new code path. Mode changes write to `audit_log` with the actor
  and **both** values — "set to Fast" does not distinguish somebody relaxing Strict from somebody
  re-saving.
- **⊕ Add — five sources, one picker, searched server-side.** File, run, dataset case, tool schema
  and GitHub, all on the command-palette infrastructure rather than five bespoke modals. A source
  with nothing behind it is hidden rather than disabled: an empty menu item that always fails is
  worse than no item.
- **Attachments are snapshotted at send, not at attach.** A file ref stores its `version_id`, so a
  turn stays reconstructible after the file changes. Token cost is measured **server-side** — a
  client-supplied estimate would make the budget advisory — with an inline warning at 70% of the
  model's context window and a hard block at 100% that **names what to remove**. Silent truncation
  is the failure this exists to prevent: it produces a confident answer grounded in half a file,
  with no error attached to it.
- **The connector deck scopes a conversation, and the scoping reaches the dispatch.** Toggling a
  connector off removes its tools from that conversation's run and leaves the workspace connection
  intact. A disabled connector stays in the deck greyed rather than vanishing — its absence would
  read as a workspace disconnection, which is precisely what the toggle does not do.
- **The response metadata row: model → effort → build → duration → variants, always in that
  order.** Absent items collapse and the rest hold position. The natural implementation — map over
  what exists — passes every hand-written case and moves the duration on any turn that produced
  code, so the ordering is a pure module with a suite that checks every combination of absences.
- **Regenerate writes a new variant beside the old one.** Variant 1 keeps its own model, effort,
  duration and version, and the metadata row reports the response actually on screen. Switching
  variants stays a view change: the variant store has no publish path to reach, so reading a
  response can never become deploying one.
- **Notes are shared; pins are personal.** Both failures are silent, which is why both are checked:
  a note that turned out to be private is a warning a teammate never sees, and a pin that turned
  out to be shared is a rail full of somebody else's anchors. The user is in the pin's primary key
  rather than in a `WHERE` somebody has to remember. Notes hang off the turn and never off a
  variant, so a regeneration cannot take them.
- **Thumbs are exclusive and toggleable, and a thumbs-down on a code-producing turn offers the
  eval case it should have been** — which is the highest-value thing a negative signal can become
  in this product.
- **`STATUS.warn`, a fourth status colour.** Fast mode needed a caution tone and there was no
  warning token to reuse: amber means IN-FLIGHT everywhere in this app and always moves, and red
  means something went wrong. Painting a supported setting as a failure teaches people to ignore
  red; one static amber teaches them it no longer means "happening now".

### Fixed

- **`thread_items` had no defined order for rows written in the same millisecond.** `created_at`
  was their only ordering and neither driver promises a stable result for equal values, so the
  preview a thread shows — "the last user message" — could flip to an older sentence with no write
  in between. Latent since the column existed; adding an index changed the plan Postgres chose and
  surfaced it. The store now issues monotonic timestamps and every ordered read carries a
  tiebreaker.

### Migrations

`054` `conversation_settings` + workspace defaults and the admin pin · `055` `turn_attachments` ·
`056` `conversation_connectors`, `mcp_servers.logo_url` · `057` `turn_variants`, existing turns
backfilled as ordinal 1 with unmeasured fields left null rather than guessed · `058` `turn_notes`,
`turn_pins`, `turn_feedback`. Every foreign key that reaches a turn or a conversation is on the
composite `(workspace_id, id)` pair — a bare id FK is satisfiable by any tenant's row, which is
the class of bug the earlier tenancy hunt turned up.

### Verified

- Eight commits, each with its own suite wired into `ci.yml` rather than left in `package.json`
  alone: `test:icons`, `test:composer-bar`, `test:effort`, `test:conversation-settings`,
  `test:conversation-routes`, `test:permission-shield`, `test:attachments`, `test:connector-deck`,
  `test:turn-metadata`, `test:turn-variants`, `test:turn-interaction`.
- Checked against the running Tauri shell rather than only the browser: all five migrations applied
  to the desktop database on launch, every new route driven against the live backend with real
  data, a real plan generated end to end, and the `audit_log` row for a permission-mode change
  confirmed to carry the actor and both values.

---

## v0.3.4 : Subscriptions — What Each Tier Allows, Checked Where Every Command Already Passes

Free, Pro and Team, and one function that says what each is allowed: `resolveEntitlements`,
which extends the `FREE`/`PRO`/`TEAM` objects `billing/plans.ts` already held rather than
forking a second table of numbers beside them. The harder question this release answers is not
what the tiers get but where that gets enforced. This product has almost no HTTP routes — nearly
everything goes down the WebSocket as a command — so the gate that would ordinarily sit in front
of an Express handler sits instead at the one dispatch point `COMMAND_CAPABILITY` already sits
behind, checking what the tier allows beside the existing check for who may.

### Added

- **`resolveEntitlements`**, the one function tier limits and features come from. An admin
  session gets `ADMIN_ENTITLEMENTS`, a checked-in constant rather than a computed bypass.
- **`requireEntitlement`**, a second gate orthogonal to the capability check it sits beside:
  capability says who may, entitlement says what the tier allows, and a command failing either
  is refused the same way. `test:entitlements` enumerates every command in `wsRelay.ts` the way
  `test:capabilities` already does, and fails on one left unclassified.
- **The 402 renders as an inline `UpsellCard`, never a modal** — `{ error, kind, current, limit,
  tier, upgradeUrl }`. Until the Stripe wiring below went live, resolution ran Team-equivalent so
  the rollout itself never locked anyone out.
- **Checkout, handed to the system browser and back through a deep link.** `openExternal` is a
  Rust command (`deeplink.rs`) that validates `https` and an allowlisted host before it will
  spawn anything, so nothing a web page says reaches a process spawn. `jaroku://billing/success`
  and `/canceled` both open the same Billing screen — the honest thing to show someone who backed
  out of a payment form is their plan, unchanged. Nothing is believed from the link itself: the
  tier moves only when `GET /v1/billing/subscription` agrees with the webhook.
- **`workspace_usage_periods`, one row per workspace/period/metric** — a new metered dimension
  later is a new string, not a migration. Runs increment at the moment `status` first becomes
  `running`, not on receipt or completion; eval cases increment one per dispatch.
- **The Billing section, a fourth `WorkspaceSection`** — plan, status, renewal date, seats, the
  BYOK toggle, change-plan, cancel. A downgrade that would leave the workspace over the target
  tier's limits is blocked with a resolve-first screen rather than left to silently overflow.
- **BYOK, instant and workspace-level.** `subscriptions.byok_enabled` decides routing at
  inference-call time, no proration, because the moment anyone reaches for this is the moment
  they just noticed a bill. Absent from Free entirely rather than present and disabled — Free
  already runs on the workspace's own key by construction, and a disabled switch would have
  implied a paywall behind it that isn't there.
- **The platform key pool, round-robin behind a 429** — `system_provider_key` secrets,
  `Retry-After` on exhaustion rather than a silent queue, usage batched to Stripe every five
  minutes or a hundred calls, whichever comes first. Free never touches the pool.
- **Retention, extended to move on a tier change** — the daily sweep already existed; this adds
  the re-run within the hour a plan moves, an `audit_log` summary with a per-table row count, and
  the three windows themselves: 7 days, 90, a year.
- **Abuse control's specific numbers** — a $50/7-day cap for a new account, a hard ceiling at
  twice the plan's included credit, a hundred requests a minute per user, and a freeze (plus an
  internal alert) at ten times a trailing 24 hours.
- **Admin mode.** `JAROKU_ADMIN_USER_IDS`, read once, at session hydration, nowhere else — adding
  an admin costs a restart, on purpose. `adminMode` itself is in-memory and defaults to off on
  every session *and every relaunch*, which matters because the session token survives for weeks
  in the OS keychain. A non-admin sending `adminMode: true` gets a logged 403. The toggle is
  absent from the DOM for anyone who isn't an admin — not hidden, absent — and the banner it
  turns on is not dismissible.

### Migrations

`052` `workspace_usage_periods`, `seat_count`/`byok_enabled`/`current_period_start` on
`subscriptions`, `scale` repointed to `team` · `053` RLS on the new table.

### Verified

- Ten commits, each its own suite (`test:entitlements`, `test:billing-view`,
  `test:usage-periods`, `test:platform-key`, `test:byok`, `test:admin-mode` among them), each
  wired into `ci.yml` rather than left in `package.json` alone.
- Checked against the actual packaged Tauri shell, not only the browser: the `jaroku://billing`
  deep link, which previously only logged, now opens the Billing screen the way the checkout
  handoff always specified; admin mode confirmed to reset when the spawned backend process is
  killed and relaunched while the session token itself survives, because that is the exact case
  the design exists for.

---

## v0.3.3 : The Activity Tab — What This Workspace Is Doing

The fourth and last of the sidebar's destinations, and the only one that writes nothing. Threads is
the conversation, Agents is the artifact, the Inbox is what is waiting on you, and this is the
workspace itself: cross-agent, aggregate, historical, read-only.

It inherits the leftover axis rather than defining its own, and that inheritance is the whole design.
Everything per-agent already exists in the Agents detail pane. Everything actionable already exists in
the Inbox. So Activity gets exactly what is left — and the hard consequence is enforced by what is
absent rather than by a rule anybody has to remember: **the channel has no mutating command**. Every
other tab's relay code carries a set of them; this one carries none, so the next person who wants a
button that changes state has to add a command first and will find nothing to put it beside.

Four tabs, four genuinely different layouts. Threads is rows, Agents is a card grid, the Inbox is a
severity board, and this is a grid of cards each led by one large figure with the chart as texture
behind it. Nothing here is a fifth list.

### Added

- **One window, resolved once, handed to every module.** There is no per-card range: 24h / 7d / 30d,
  chosen in the header and remembered per workspace, and every card states its own window in its
  context line so a screenshot is never ambiguous. That is not tidiness — cross-highlighting is only
  coherent because all four participating modules are looking at the same seconds, and six aggregates
  that each resolved their own window would be four lenses onto four moments.
- **Ten aggregates, one grouped query per module, none of them moving with the number of agents.**
  The leaderboard's statement count is asserted equal for one agent and for forty, the way the Agents
  grid's is — a leaderboard is the most natural place in the product to write an N+1, because every
  row wants a per-agent figure.
- **Cost is summed from what each step actually spent, and there is still exactly one calculator.**
  Every dollar on this tab is a SUM over the usage ledger that `pricing.costFor` wrote, over the same
  `runtime/pricing.json` the Python interceptor reads. A crashed run still contributed cost, because
  the row is written per step as the step arrives; the fixture leaves `runs.cost` at zero on purpose,
  so a query that read the run-level field fails the suite rather than production. Cached tokens bill
  at the cached rate. An unpriced model is *cost unknown*, is named and counted beside the floor, and
  is excluded from every ranking — never a $0.
- **Definitional care on the numbers that will be quoted.** A paused-and-resumed run is one run. A
  branch is a first-class run that does **not** inherit its copied prefix's seconds — the join takes
  only `seq > branch_from_seq`, which is exactly the boundary the copy was made at, or two runs carry
  the same work into the same p95. Latency is summed step time, not wall clock, and the card says
  which. Runs a restart or a cancellation closed out are their own slice: folding them into the
  failure rate would report a deploy bouncing the server as the workspace's agents breaking.
- **A unified feed that is a union, not a table.** Nine sources — runs, branches, publishes, edits and
  their undos, deploys, evals, high-impact MCP calls, member events — derived every time from the rows
  that are already the truth. An `activity_events` table would be a second copy of six tables, and the
  second copy is the one that goes stale: a run cancelled or a version undone after the fact would
  leave a feed row describing a world that had moved on.
- **Keyset pagination, tested by inserting rows above the cursor mid-scroll.** That is what an offset
  gets wrong and gets wrong silently — repeating rows it has shown and skipping ones it never will —
  and this feed is written to on every run, every step and every deploy.
- **§5's "MCP confirmations resolved" needed no new recording anywhere.** The confirmation gate raises
  *inside* the tool, so a refusal is already on the step in the runtime's own sentence. Reading it
  there rather than adding a write means the numbers reach history as well as today. `schema/events.md`
  is untouched, no table gained a column, and no code path gained a write.
- **The release timeline includes failed deploys**, because a release log that only shows successes is
  a marketing page — and it is the view that makes "three agents went out on Tuesday and two of them
  failed" visible at all, which the per-agent Deploy panel structurally cannot.
- **Four numbers nothing else in the product reports**: the confirmation approve / deny / timeout split
  on high-impact tools, the high-impact call count, the result-truncation rate, and reviewed connector
  failures — v0.1.12's bug in aggregate, and a number that should be zero in a place somebody will
  notice it is not.
- **Polarity as data, next to each metric.** There is no global "up is bad": spend up is bad, tokens up
  is neither, latency down is good, success down is bad. The badge renders from `goodWhen` rather than
  from the arrow, and a delta with no comparable previous window renders `--` — never `0%`, never
  `100%`. A workspace four days old has no previous thirty.
- **Empty is not zero, per card.** A range with nothing in it renders `--` and a short line of context;
  a range whose rows summed to nothing renders the real figure. That is why every aggregate carries an
  event count beside its total — `usd === 0` is two different sentences and a card cannot tell them
  apart from the number alone.
- **Cross-highlighting through one hover subject in one small store.** Hovering a leaderboard row dims
  everything that is not that agent, across the mix, the feed and the timeline; hovering a model
  segment dims every row that did not run it. Nothing is clicked, nothing changes and nothing is
  fetched — the payload already carries what the highlight needs, which is why those fields exist. The
  highlight is a de-emphasis of everything else rather than a colour change on the target, so it works
  in a palette this restrained; the transition drops under `prefers-reduced-motion` and the highlight
  does not.
- **A virtualised feed with no dependency**, driven by a suite at ten thousand rows rather than at
  fifty. Overscan on both sides, a clamp at the end, and a fetch threshold in rows rather than pixels
  so the same feed behaves the same on a laptop and a phone.
- **Twelve icons from the HugeIcons free set**, read out of `@hugeicons/core-free-icons` and committed
  as inline SVG at this app's one stroke weight. No runtime icon font, no hotlinking. `actionIcons.tsx`
  is extended rather than duplicated: nine feed kinds map onto the eleven kinds that already exist, so
  a confirmation row and the trace row that produced it read identically — same icon, same verb, same
  accent. Two icons are simplified for legibility at 14px and both say so at their definition.
- **A cache that is honest about being one.** Per (workspace, range), sixty-second life, the freshness
  travelling with the value so a cached figure never presents as live, invalidated on the events that
  move the numbers rather than on the timer alone, and the 24h range never cached at all. It also
  single-flights: ten sockets connecting at once against a cold cache is ten identical thirty-day
  scans, and a cache of *results* cannot prevent that, because by the time the first finishes the
  other nine are already running. No materialised rollup table — that gets designed deliberately, with
  measurements, or not at all.
- **Amber appears nowhere on this tab.** Amber means running, and nothing on a historical dashboard is.

### Verified

- **Two workspaces, seeded with different data, and every module's figures asserted in both
  directions.** Not one module — every module. Row-level security has bitten this project repeatedly
  and *every single instance was an aggregate*; this tab is nothing but aggregates over exactly those
  tables. Both workspaces deliberately share agent slugs, so a `GROUP BY` that lost its scope would
  visibly merge rather than merely add.
- **Nine suites**, wired into CI in a step of their own: the window, the four honesty rules, run health,
  the pulse, the leaderboard's constant statement count, the model mix's two denominators, the feed's
  keyset, the releases, the tool rollup, the team pulse, the cache, the payload, the icon join and the
  feed virtualiser.
- **The known-secret test, by the pattern `test:log-redaction` uses.** One credential, every route into
  a payload tried against it — and the opposite direction too, because a suite that only proved secrets
  leave would pass on a scrubber that redacted everything, and a redacted *model name* on the one tab
  whose job is naming models deletes the answer.
- **The cross-language markers are asserted against the runtime file.** The confirmation refusal and
  the truncation marker are sentences `mcp_bridge.py` writes; if either changes there, a rate silently
  becomes zero, so the suite reads the Python rather than a copy of the string.
- **Opened in a browser against the running server.** The dashboard renders all nine modules with no
  console errors; every empty card shows `--` and a line of context rather than a zero; the range
  control drives every context line together; and a real generation appeared in the Releases timeline
  and in the spend figure within a second of finishing.

### Still owed

- **Postgres with RLS, as the application role.** §6 calls this the single most important line in its
  verification section, and it has not run here: there is no Postgres on this machine, so every suite
  ran on SQLite only. The isolation harness is invoked from `test:tenancy`, which CI runs against a
  real Postgres with the RLS suite beside it — so it will run on the next push, and it has not run
  yet. Recorded plainly rather than implied, for the reason v0.2.6 recorded the Chrome extension gap.
- **Two of §10's five columns are not attributable, and the card says so.** `runs`, `deployments` and
  `eval_runs` carry no actor, and spend is attributed *through* runs, so nothing anywhere records who
  started a run or who pressed deploy. The Team pulse shows the three that are recorded and states the
  absence. A zero beside somebody's name would be a claim about that person; an absent column is a
  claim about the schema, which is the true one. Fixing it means a column on `runs`, which is part of
  the frozen event schema this tab does not touch.
- **§5's member filter narrows to the sources that can answer it**, for the same reason. Filtering the
  feed by a person returns publishes, edits and member events, and cannot return runs or deploys —
  they are omitted rather than included unattributed, because a short list is better than one that
  looks like an answer.
- **A custom date range has no picker.** The range vocabulary, the storage, the clamping and the server
  path all handle `custom`; the header offers it only when one is already remembered, because a
  control that puts itself into a state whose own value is missing is worse than one that is absent.
- **The by-hand pass is partial.** The dashboard, the range control, the empty states and a real
  generation flowing into Releases were opened and looked at. What was not: the narrow-width fallback
  at a phone size, the cross-highlight walked across all four modules with a pointer, and the
  virtualiser scrolled through ten thousand real rows in a browser — the last of those is asserted by
  a suite at that size, which is not the same thing as having watched it.

---

## v0.3.2 : The Inbox Tab — What Is Waiting On You, and What Dies On Its Own

The third of the four sidebar destinations, and the one that replaces Memory. v0.3.0 recorded Memory
as a shell and nothing was ever built behind it; what ships instead is the surface the idea was
actually for. A memory Jaroku proposes from a `failure → fix → pass` triple is an **item on this
board**, answered where it is raised, rather than a tab somebody has to remember to go and read.

The four tabs now divide cleanly: Threads is the conversation, Agents is the artifact, Activity is
what happened, and the Inbox is what is waiting on you. Activity is passive, chronological and
complete; this is active, prioritised, actionable, and it **shrinks as you work**.

Three laws hold it up, and each is enforced by something other than a comment. **Every item has
exactly one owner-action** — "run failed" is Activity, "run failed and nobody has opened the trace"
is Inbox. **Every item dies on its own**: a resolve condition the server evaluates independently of
any user action, so setting a missing credential from the Agents tab, from a thread or from a script
clears the card with nobody dismissing anything. **Items collapse**: forty failed runs is one item
with a count of forty, deduplicated at write time on a key in the database.

### Added

- **Sixteen item types as one typed registry.** Each entry declares its severity, its subject, how it
  is produced, its icon, its action set, the sentence its card reads — and, load-bearing, the
  predicate that says whether it is still true. The trigger that creates an item and the condition
  that removes it sit three lines apart on purpose: a file apart they drift, and the type quietly
  becomes one that can be raised and never cleared. Adding a seventeenth is one entry and no line in
  the sweep, the store, the channel or the board.
- **Two generators, because two kinds of item exist.** Event-driven ones hang off moments the control
  plane already emits — a run failing, a deploy failing, an eval finishing, an MCP server changing
  status, an applied edit. Derived ones have no event to hang off, because each is a *comparison*
  between two states that are both simply true: a name in `required_env` with no configured secret, a
  deployed version behind a current one, a server that last answered a day ago, spend three times its
  own average, a high-impact grant with the confirmation gate off. **Nothing was added to the frozen
  event schema.**
- **A reconciler that is what makes Law 2 real.** Idempotent by its own `WHERE`, workspace-scoped one
  at a time through the repository layer, safe against concurrent replicas on an advisory lock that
  *tries and gives up* rather than queueing, and constant in the number of agents — one aggregate pass
  plus two statements, asserted by counting them for two items and for forty. Every predicate lives in
  the registry and the sweep is a generic loop over it.
- **Three verbs, and they stay three.** Resolve is shared, because the problem is. Snooze is personal
  and *returns*, evaluated at read time so there is no job that can fail to run and leave work away
  forever. Dismiss is personal and does not return. Snoozed items live in a visible tray, because a
  snooze somebody cannot see is a slower dismissal — which is exactly how an Inbox starts hiding real
  problems.
- **Undo instead of confirmation dialogs.** Every destructive action offers a five-second toast and a
  `⌘Z`, and undo restores the **prior value** rather than clearing the column: an item dismissed last
  week and dismissed again by a bulk action has two dismissals and one column, and clearing it would
  put the card back on a board somebody had deliberately cleared. Tokens are single-use and scoped on
  redemption, because unguessable is not a tenancy boundary. Bulk is the same path as single, so one
  press takes back all forty.
- **A severity board that does not behave like Kanban.** Columns are buckets, not lanes: severity is
  assigned by the system and a card never moves between them, cards do not progress left to right, and
  there are no WIP limits, no manual reordering and no swimlanes. Card **size** carries severity —
  blocking large with its inline form visible, attention medium, proposals compact — so priority is
  read from the shape before a word of it. Rose appears exactly once, on the left edge of a blocking
  card. **Amber is not available**, because amber means running.
- **In-place resolution that reuses the commands that already exist.** Setting a credential from a
  card posts to the same guarded route the Secrets tab does; a redeploy is the same `deploy` command
  through the same plan gate, with the provider and model the last deploy used carried on the payload
  so nothing has to be invented. A card that cannot name them falls back to the Deploy panel rather
  than guessing — a second way to put something on the internet is a second thing to get wrong.
- **Keyboard triage.** `J`/`K` across column boundaries in visual order, `E` resolve, `S` then 1/2/3
  snooze, `X` dismiss, `Enter` expand, `⌘Z` undo, 1–6 for the rail. It extends the binding layer from
  v0.1.1 rather than adding a second one, and the cursor steps off a card *before* the action that
  removes it — afterwards there is no neighbour left to find.
- **Drag to snooze, with no dependency.** One destination and a pointer-event handler: a drag must not
  swallow a click, pointer capture keeps the events coming when the pointer leaves the card, and
  letting go over the board does nothing at all. Dragging toward another column dims the columns, so
  "this is not a lane" needs no explanation.
- **Fifteen icons from the HugeIcons free set, committed as inline SVG** and redrawn at this app's one
  stroke weight. No runtime icon font, no hotlinking. `lib/actionIcons.tsx` is extended rather than
  duplicated — resolve, retry, view logs, deploy and rediscover already had marks and keep them.
- **The sidebar badge counts blocking plus proposals only.** Attention is deliberately excluded and
  there is now a test that fails if somebody "fixes" it: a badge that counts everything never reaches
  zero, and a badge that is never zero is one people train themselves to ignore.
- **A pointer strip on Agent detail** — "2 items need you", the count and nothing else, clicking
  through to the board filtered to that agent. A list there would be a second place an item can be
  dealt with.
- **The zero state, and the per-column empties.** "Nothing needs you" with one line of real statistic
  beneath it, counted from resolutions and never from dismissals — somebody who cleared their board by
  hiding things is not congratulated for it. Each empty column says its own thing, because three empty
  columns mean three different things and `Blocking 0` should feel like an achievement.
- **Two seeded items for a new workspace**, `setup_api_key` and `setup_first_agent`, which resolve the
  moment the thing is actually done and never return. Real items with real resolve conditions, seeded
  on the board read as well as on the sweep so §2.5 is true on frame one rather than a minute late.

### Changed

- **Memory is no longer a sidebar destination.** `NavDestination` names `inbox` where it named
  `memory`; nothing persisted a destination, so there is no stored value to migrate and no alias with
  anything to spell.
- **`inbox_items` is swept by retention**, on `resolved_at` and never on `first_seen_at` — an item
  that has been blocking somebody for six months is an unsolved problem, not old data. It is also
  exported, because "when did this start going wrong" is the workspace's own operational record; the
  per-user dismissals are not, because in a Team workspace they are a record of what each individual
  chose not to look at.
- **`Db` grew `withAdvisoryLock`**, distinct from the migration runner's and on a different key.
  Advisory locks are one flat namespace: a sweep sharing the migration key would block behind a deploy
  applying migrations, and — worse — a deploy would block behind a sweep.
- **The relay's `loadRun` reports that a trace was opened.** That one call site is the whole of Law 2
  for `unreviewed_failures`: the sidebar's run list, the Agents tab's health sparkline, the command
  palette and a deep link all go through it, so the card leaves because the trace was read rather than
  because the card was pressed.

### Fixed

- **A payload could have carried a credential, and now cannot.** Every string on its way into one goes
  through the same redactor that protects the log sinks, *before* it is cut rather than after —
  cutting first leaves a key truncated mid-value, unmatched by the redactor and therefore half
  visible, which §6.5 rules out in as many words. Lists are capped, keys are capped, control
  characters and ANSI escapes become spaces, and only five value shapes are allowed at all: a nested
  object is where a future generator would put an entire response body without noticing.
- **A derived condition observed every minute counted as 1,440 occurrences.** `count` means
  occurrences — forty runs failed, so the card reads `×40` — and a condition is not an occurrence. The
  store reads the registry's `origin` to know the difference.
- **Opening a trace reported a tenth failure.** Stamping the review through `record` moved
  `last_seen_at` and incremented the count, so reading nine failures made the badge say ×10.
  `setPayload` exists for exactly the difference between "this happened again" and "here is something
  more we know about it".
- **The boot sweep died on every restart.** It called into the relay during module initialisation and
  hit its temporal dead zone, so the first pass after every deploy was lost and logged an error for
  it — leaving a board up to a minute stale at exactly the moment a boot sweep exists to prevent.
- **A resolution re-sent the whole board.** §5.6 asks for the affected card only, so a resolution is a
  delta now; a snapshot is reserved for a derived item, which is the case where what belongs on a
  board genuinely depends on whose board it is.

### Verification

- `npm run typecheck` clean on server and client at every commit; `npm run build` clean.
- `npm run test:tenancy` and `npm run test:db-boundary` green, both extended: the inbox store is in
  `SCOPED_MODULES` and its ten methods are in `SCOPED_API`, and the suite now asserts §6.3 in the
  direction that matters — a pass for workspace A cannot resolve, rewrite, snooze or undo anything in
  B, and the two workspaces share a dedupe key while doing it.
- Seven new suites, all in CI: the registry (every type's resolve condition, tested by resolving it
  externally, plus the assertion that no predicate is a constant), the store (forty `record` calls
  producing one row with `count = 40`), the generators, the derived rules and their round trip against
  their own predicates, the reconciler's four §6.2 properties, the three verbs and the badge rule,
  undo and the seeds, and the payload's known-secret test.
- All existing server and client suites green — threads, agents, channels, relay, capabilities,
  acceptance, retention, export, boolean literals, migrations and the store reset.
- **A real socket, against the running server.** A brand-new workspace's board arrived on frame one
  carrying both seeded items with the right severities, icons and actions and a badge of 2; a drift
  card inserted underneath appeared without moving the badge, which is Attention doing what it is
  supposed to; dismiss offered a token and rebuilt the board 3 → 2; undo put it back; a second undo
  was refused with "that can no longer be undone"; a snooze moved a card to the tray with its return
  time; a duration nobody offers and an item id from nowhere were both refused in the words a person
  would read. Every field of every payload was inspected for anything value-shaped — there is nothing
  but names.

### Still owed

- **The by-hand visual pass.** §9 asks that every card size, the zero state, the per-column empties,
  the snooze tray and the narrow-width fallback are "all opened by hand and looked at", and that the
  keyboard is walked end to end without a mouse. Every one of those is built, every rule behind them
  is under a suite, and the channel that feeds them has been walked over a real socket — but nobody
  has opened the board in a browser. Recorded here rather than claimed above, for the reason the
  Agents tab recorded the same gap in v0.3.1: a verification section listing a check nobody ran is
  worse than one that is short.
- **The catalog names sixteen item types; §2 and §9 say eighteen.** Four blocking, five attention, two
  proposals, three team and two onboarding is sixteen, and nothing was dropped — the arithmetic in the
  specification does not match its own list. The sixteen that are specified are implemented, and
  `INBOX_TYPES` is what anything asserting a count should read.
- **The confirmation-gate detector is a pattern, not a proof.** v0.2.1 recorded that generated agent
  code can set the environment variable that disables the bridge's high-impact gate, and said a
  validation rule was needed. This is not that rule. It finds the obvious spellings and a miss
  produces no card rather than a reassuring one — nothing in this feature ever claims a gate is *on*.

---

## v0.3.1 : The Agents Tab — Threads Is the Conversation, Agents Is the Artifact

v0.3.0 gave every built capability a door and recorded three that stayed shells: Agents, Memory and
Activity. This is the first of the three, and it is the second of Jaroku's four sidebar destinations.

It answers four questions and nothing else. What agents exist in this workspace. What can each one
touch. What version is live, and is it drifting from what is deployed. Is it healthy. The live trace,
the plan card, the diff card and the MCP registry itself are deliberately out of it — the first three
live where they already live, one tab away, and the registry is workspace configuration rather than an
agent-level fact, so an agent shows its grants and not the servers.

### Added

- **The grid, and the card that is a glance rather than a dashboard.** Search over display name and
  slug, filters for status, connector, deployed, creator and archived, four sort orders, and two
  densities that are real layouts rather than a scale transform — compact drops the current-work line
  and shrinks the thumbnail, and the type ladder stays three sizes. Archived agents are hidden behind
  their filter and appear greyed with a restore action and no `+ New thread`, because an agent that has
  been put away should not be offering work. Two empty states, which mean different things: "no agents
  here" is an entry point that opens a thread with the composer focused, and "nothing matches these
  filters" names what is on and offers to clear it.
- **The tag row, as a pure function with its own suite.** At most three tags render, then a `+n` chip;
  precedence when trimming is Attention > Runtime > Deploy > Health > Lifecycle, so an agent that is
  both failing and new shows `Failing` — the problem outranks the novelty. One tag per family, resolved
  before the row is assembled, so `Idle` and `Running` can never appear together. Runtime and Health
  stay separate axes and never collapse: "Idle · Failing" is a real state and a card that hid it would
  be lying about the agent. **A warning is never amber** — v0.2.2 redrew the wordmark because an amber
  outline read as a warning sign in an app where amber already means running, and `test:agent-tags`
  asserts the colour law rather than trusting the comment above it.
- **Health from the validator AND the record, because either alone lies.** The validator alone would
  call an agent healthy while every one of its last ten runs failed; a rolling error rate alone would
  call a hand-dropped project healthy for never having been run. The validator's verdict costs nothing
  to read and needed no column: it is the gate on publishing, so a version whose `source` is
  `generation`, `edit` or `deploy` passed it by construction, and `import` — the backfill and the
  hand-dropped directory — is exactly what `Unverified` means.
- **A gradient per agent that is stable forever.** FNV-1a over `agents.id` into an explicitly sorted
  list built at build time, so the same agent shows the same image on every replica, for every member,
  for the life of the agent. Everything convenient was ruled out: a render-order index moves when
  somebody archives the card above it, a random pick changes on reload, and a stored column would hold
  a fact the id already implies. The sort is not a detail — the order *is* the mapping, directory
  iteration order is not stable across platforms, and this project has been bitten once already by a
  platform-dependent path.
- **A clickable health sparkline.** The last ~20 outcomes are individually clickable buttons rather
  than a drawn path, because a path cannot be tabbed to, cannot carry a tooltip per segment, and cannot
  be reached by a screen reader. A failed bar opens its trace **on the failing step** — the first one,
  because a failure cascades and what somebody wants is where it went wrong — and the step-to-trace
  mapping that already existed is reused rather than re-derived by name.
- **Copy agent context**, as one markdown block for pasting into an issue: slug, version, connectors,
  granted MCP tools, credential status by name, health summary, last error. Names only, and that is a
  property of the shape rather than a discipline — there is no field on `AgentCardView` a value could
  travel in, and `test:agent-context` asserts it by the same pattern that keeps a known secret out of a
  log sink.
- **The keyboard, extending the binding layer rather than adding a second one.** `/` focuses search,
  `J`/`K` move between cards, `Enter` opens one, `⌘Enter` starts a thread on it, and `⌘K` fuzzy-jumps
  to any agent by name from the palette. Focus is visible, is scrolled to, and survives a filter change
  by falling back to the first card rather than to nothing.
- **The detail view: the agent as an artifact.** Overview with inline rename, version history with a
  comparison between any two versions, and a file browser that reads out of the object store rather
  than off disk — so a replica that has never run this agent answers byte-identically to the one that
  generated it. Beside them five tabs: Capabilities, Health, Deploy, Evals, and Threads & runs, which
  is the only link from the artifact back to the conversation. Read-only files now show **why**: three
  different things are protected — the deploy artifacts that answer a public URL, the MCP grant and the
  reviewed bridge that honours it, and the audited connector templates — and one lock icon cannot say
  which.
- **Fork, and restore-to-a-version.** A fork copies the connectors and the current manifest and resets
  MCP grants to zero, because copying them would silently re-grant high-impact third-party tools to a
  brand-new agent without anybody ticking a box. No file is copied: objects are content-addressed and
  immutable, so the fork's first version names the same ones. A restore publishes a NEW version
  pointing at an old manifest and never moves `current_version` backwards, which would rewrite the
  history the request was made from and leave the pointer on objects a retention sweep is entitled to
  consider superseded.

### Fixed

An adversarial pass over the tab found fourteen defects in the code above, every one of them
invisible from a screenshot. They are listed here rather than folded quietly into the entries they
correct, because the failure mode most of them share is worth naming once: **a control that appears
to work and does not**, and **code that claims a feature and can never run**.

- **`Forked` was a tag family member no card could ever wear.** `agentTags` read `forked_from`, the
  family listed it, and the wire shape had no such field — so the branch typechecked and was
  unreachable. A fork's provenance is genuinely not derivable: the only trace was its version
  summary's prose, and parsing a display string as an API is how a rewording silently breaks a tag.
  Migration 049 adds the column, which is the one place this release adds one.
- **An unapplied diff was painted as the machine's turn.** `buildingAgents` read `openProposals` —
  diffs that have ARRIVED and are waiting on a person — and called it `Generating`, so work that had
  STOPPED wore amber, which the colour law reserves for runtime activity, while an edit genuinely
  streaming files wore `Idle`. The editor now names the agent it is writing to, set with `busy` and
  cleared in the same `finally`.
- **A deploy that failed still carried the version it meant to build, and drift believed it.**
  `currentByAgent` answers with an agent's most recent deployment whatever became of it, so a build
  that never got off the ground put `v2 → v9` on a card with nothing serving. The card guarded on
  `live` and the tag row did not.
- **The Evals tab rendered a chip for a winning provider hardcoded to `null`.** `bestByQuality` is the
  ranking rule now, beside the aggregate the eval dashboard is already drawn from: unscored legs
  cannot win or lose, an unpriced model is not disqualified from a QUALITY ranking (§6 excludes it
  from a COST one), and ties are broken stably so two reads never disagree.
- **A cast invented an `id` on `Member`.** The store's real type is keyed by `user_id`, so every
  option in §4's Team-only creator filter came out `undefined` — it narrowed to nothing whatever was
  picked, and §5.2's creator avatar never rendered on a single card. Both features were dead and both
  typechecked. The cast is gone, which is what makes the type catch it.
- **"Export current version" fetched the files into a store and saved nothing.** The download lived
  only inside the detail's file browser, where a card cannot reach it. The builder moved to a shared
  module, and the card sets a one-shot intent the grid consumes when the payload lands — matched on
  the agent, so a version somebody is browsing is never saved by accident.
- **The `Files` button on a version row fetched into a collapsed region**, so clicking it did nothing
  anybody could see. A version arriving is somebody asking to look at files, so the region opens
  itself — and only ever opens, because folding it away while one is showing is a decision a later
  broadcast must not undo.
- **Escape cancelled a rename and the blur it caused sent it anyway.** Taking the field down fires
  `onBlur`, and that handler had closed over the render where the draft was still what somebody typed.
  A ref is read at call time, so the blur sees the cancellation that caused it.
- **A refused `loadAgentDetail` showed three grey bars and hid the sentence the server sent.** The
  comment claimed the grid's error strip had it covered; opening a card collapses the full-screen
  view, so that strip is not mounted. The pane that asked is the pane that says.
- **A hovered card lost its glow whenever an unrelated agent emitted a step.** The hover was written
  imperatively onto `element.style` on an element whose `style` prop React also owned, so React won on
  the next render — and the grid re-renders on every broadcast by design.
- **A fork asked whether a slug was free of the one list that hides swept rows.** `list` excludes
  soft-deleted agents and a swept row keeps its slug, so the fork was told a name was available, hit
  UNIQUE on INSERT, and answered "that did not work". `takenSlugs` asks what the constraint holds.
- **Four tabs on one workspace paid for four identical grids on every transition.** `perClient`
  rebuilds per recipient, which is what makes it safe — and this snapshot is ten statements over the
  whole workspace. Memoised per call, keyed by workspace, thrown away when the broadcast ends.
- **A fork's notice outlived the visit it belonged to**, greeting whoever next opened the tab.
- **§4 asks the header for the workspace name** and it only ever said "Agents".

Two suites were wrong rather than the code they guard:

- **The browser-key audit read a comment.** It scans raw source for a quoted `jaroku.` prefix, and
  that prefix is not exclusive to browser storage — an agent project's own metadata is `jaroku.json`.
  A suite that fails over prose is one somebody switches off.
- **The query counter handed repositories a `Queryable` with no `dialect`**, so a hydrator reading it
  to choose a JSON branch would have taken the wrong one and the counter would have been measuring a
  differently behaved query.

- **Migration 041 added the version a deploy built from, and nothing ever wrote it.** The column has
  been NULL on every deployment row this product has created, so a card could say a deploy is live and
  never that it is behind. Recorded at creation now, from the version the artifacts are about to be
  built from — reading it at the end cannot tell a publish that happened mid-deploy from one that did
  not, which is the case 041 exists for. Never backfilled, because a guess there is a confident lie
  about somebody's production, and `driftOf` draws no badge for a null.
- **`agents.created_by` has existed since migration 008 and nothing ever selected it.** The Team-only
  creator filter and the card's creator avatar are the first things to ask for it.
- **The agent lifecycle answered on the wrong channel.** `archiveAgent`, `restoreAgent` and
  `renameAgent` were classified `log`, so a refusal about one person's click went to every socket in
  the workspace as a status-bar line — while the surface that asked sat waiting for an answer that had
  already gone somewhere else. All five agent commands answer on `agents` now, and a refusal goes to
  the socket that earned it.
- **The sidebar item went dark at the moment §2 forbids it.** "The sidebar item stays visually active
  the entire time, in both the full-width and the 3-pane state" — and one nullable field cannot say
  that, because collapsing the view and leaving the section are two facts that move apart on the way
  down. Descending into a row keeps the section; picking an agent out of the sidebar's own list clears
  it. The Threads tab gets the fix for free, having had the same gap.

### Changed

- **`scheduleThreadBroadcast` became `scheduleListRefresh` and refreshes both lists.** Every one of its
  eighteen call sites is a moment both changed: a run starting turns a thread row ● and a card amber, a
  run ending grows a sparkline and settles a status, a deploy settling moves a drift badge. Two
  schedulers over one set of transitions would be two chances to add a call site to only one of them,
  which is how a surface goes quietly stale — and the grid's whole promise is that it updates without a
  refresh. `test:channels` was widened to match, and its window for the run-ending handler went from
  6,000 characters to 8,000: the refresh sat 5,975 in, which is a coincidence rather than a rule.

### Migrations

- `048_agents_grid` — one index, `threads (workspace_id, agent_id, last_activity_at DESC)`, and **no
  column**. Every fact the card needs is already in this schema, and a column you can derive is a
  second copy that goes stale. What was genuinely missing is one access path: the card's current-work
  line and the grid's default sort are the same question — which of this agent's threads was active
  last — and neither of 043's two indexes answers it. Deliberately not on `runs` or `usage_events`:
  `migrate:check` refuses an unqualified `CREATE INDEX` on either, because building one takes a write
  lock for the whole build on the hottest write path in the system.

### Not in this release

- **Memory and Activity stay shells.** Two of v0.3.0's three placeholders are still working as
  specified; each has its own document.
- **A multi-agent side-by-side compare, a per-card version scrubber, and a hover-to-flip graph on the
  thumbnail.** Recorded so nobody adds them later by accident: the eval engine already answers the
  first, version history already answers the second in full and the targets would be too small to hit,
  and the third would cost a graph introspection per card on every grid load and is unreachable on
  touch. The graph stays in the detail view.
- **A delete for an agent.** The specification lists one in the overflow menu; this product has none,
  deliberately, and v0.3.0 argued why — an agent's versions, runs, traces and costs are the record
  every past comparison points at. So the confirmation the specification asks for, naming the creator
  as the collaborative-workspace safety net, sits on **Archive**, which is the destructive-looking act
  that actually exists.
- **HugeIcons.** The specification names it as the source; §8's own first rule is "one stroke weight
  everywhere… do not undo that", and every icon in this product is Lucide geometry drawn through one
  factory at `ICON.strokeWidth`. A second family would give a filter bar two optical weights side by
  side. The ten new marks go through that factory, and everything else §8 asks for holds: inline SVG
  components committed to the repo, no runtime icon font, no hotlinks, and an accessible label plus a
  tooltip on every icon-only control.

### Verification

- Both packages typecheck clean; `npm run build` clean; `migrate:check` passes with no contract step.
- New suites, all in CI: `test:agent-health` and `test:agent-grid` on the server, `test:agent-art`,
  `test:agent-tags`, `test:agent-filter` and `test:agent-context` in the client.
- `test:agent-grid` is the one that matters: it instruments the driver and asserts the statement count
  for one agent equals the count for forty, which is the only version of "this is not an N+1" worth
  having. Beside it, cross-workspace reads returning absent rather than forbidden.
- The existing server and client suites green — threads, tenancy, the db boundary, channels, relay,
  acceptance, capabilities, boolean literals, migrations, read-only and the store reset.
- The server boots against a real database, applies 048 and 049, and answers a real socket: the grid
  came back with nine cards, `drifted_agent` carrying `v5 → v9` while `deployed_agent` — up to date —
  carried none, the credential-missing card naming `STRIPE_SECRET_KEY` and nothing else, and an agent
  id this workspace does not have reading as "no such agent in this workspace" rather than as a
  refusal. Every field on a card was inspected for anything value-shaped; there is nothing but names.
- `test:agent-adversarial`, which pins each defect above as a claim rather than a memory.

### Still owed

- **The by-hand pass over every card state.** §5.3 asks for never-run, working, failing, deployed,
  drifted, credential-missing and archived to be built AND looked at — "a state you have not looked at
  is a state that is broken" — and §10 adds both densities at desktop and narrow widths plus the three
  awkward cases: a long display name, a long thread title, and an agent with fifteen connectors. Every
  one of those is built and every rule behind them is under a suite; what has not happened is somebody
  opening them. Recorded here rather than claimed above, because a verification section that lists a
  check nobody ran is worse than one that is short.

---

## v0.3.0 : Every Built Capability Gets a Door

v0.2.17 fixed thirty-one defects and, in the same passes, counted nineteen findings that were not
defects at all: whole subsystems that were built, tested, documented — and unreachable. A user
could not stop a run, create a workspace, invite anybody, see who was in one, change a plan, set a
ceiling, edit the judge's rubric, switch on pull-request checks, export or delete a workspace,
answer an enforcement, read the audit log, page past the fiftieth row, or delete, archive or rename
an agent. Every one of those had a repository method, most had a command, several had their own
migrations and passing suites, and none had an entry point.

This release is the entry points. Nothing here is a new capability; the capabilities were already
there. What is new is that the product's own surface reaches them.

### Added

- **Stop, beside Pause and Resume.** `cancelRun` was implemented, routed, typed and
  capability-checked on the server, and was the one command in the matrix the client could never
  send. The interactive slot is process-wide, so a wedged run blocked every other run, branch,
  resume and apply until it timed out — while two of the server's own refusals instructed the user
  to stop it first. Confirmed in place rather than in a modal: it destroys nothing that was
  written, and it cannot be undone.
- **Workspaces, members and invitations — the whole half of the product that had no surface.**
  `IdentityRepository` implemented workspace creation, membership, roles, invitations and their
  audit rows; five commands were wired end to end; `acceptInvite` existed with its own test. None of
  it was reachable: a user had exactly one workspace, made for them on first sign-in, always
  `personal`. Now there is `POST /v1/workspaces` (HTTP, not a command — a socket is scoped to a
  workspace by its ticket, and this is the request that creates one), a **Members and invitations**
  panel behind the workspace switcher, and an invitation round trip that ends in a membership: the
  client assembles `<origin>/?invite=<token>` from the one-shot secret, the sign-in screen says an
  invitation is waiting, and it is redeemed as soon as there is a session — then removed from the
  URL, because a spent single-use token in an address bar is a link whose reload fails in a way
  that reads like forgery. `kind` is required on creation and cannot be defaulted: it decides
  whether the workspace has a members list, roles and a Threads author column at all.

- **Export and delete, in the product rather than in `curl`.** Three routes existed —
  capability-checked, audited, with a table-completeness suite behind the exporter and a receipt
  naming what could not be revoked behind the deleter — and no client code called any of them. They
  are the workspace panel's **Data** section now: the export is polled from the browser (there is
  nothing to push, and whether the archive exists is a HEAD on one key), and the delete asks for the
  workspace's id because that is what the route requires, with the id shown beside the box. The two
  are in one section deliberately — offering deletion without export makes leaving cost you your
  history.
- **A plan can be bought.** `POST /v1/billing/checkout` validated the plan against the `plans`
  table, reused the Stripe customer, passed an idempotency key, and had the whole subscription
  webhook state machine behind it — including the dunning notice that tells a user about a payment
  problem on a subscription they had no way to start. Nothing called it. The Usage tab now carries
  the catalogue under the ceiling meter it is about, with each plan's real limits beside it: the
  list is the server's (`purchasable` and the price id are columns; the limits come from the code
  that enforces them), a deployment with no Stripe keys shows nothing rather than a refusing
  control, and choosing is `billing:manage` while reading spend stays a member's.
- **Gemini is documented, named and marked.** It has been a complete provider for a release —
  priced in `pricing.json`, built by `models.py`, offered in `RUN_PROVIDERS`, with a working key-entry
  path — and `GOOGLE_API_KEY` appeared **zero times** in the README, whose only documented Google
  credential was the Gmail connector's OAuth app: a user searching the docs for "Google" found a
  credential that will not run a model. It is in the Quick start template and the Models table now,
  each cross-referencing the other so the two cannot be confused, the repository layout stops
  describing `models.py` as `fake / anthropic / openai`, the provider has its brand colour and mark
  instead of a hollow dot between two branded rows, and the client's `ProviderId` can finally express
  a provider the product ships.
- **The selectable model catalogue comes from `pricing.json`.** It was a hardcoded array in the
  client and it had drifted four models behind the price sheet that calls itself the single source of
  truth — so `claude-opus-5`, the newest priced entry, could not be chosen for a run, added as an
  eval leg, or deployed with, and a model added to the priced table silently changed nothing a user
  could do. The catalogue now rides the providers snapshot, grouped by provider in the file's own
  order, with each provider's display name resolved server-side — which also removed the two
  disagreeing copies of that mapping in the browser, the reason one provider was "Gemini" where you
  picked it and `google` where you configured it. `test:pricing` asserts what keeps it safe.
- **Abandoned OAuth flows are swept.** `sweepStates` existed and nothing called it on a timer, so a
  row per started-and-closed consent screen accumulated forever — each holding a code verifier and a
  return path long past the ten minutes either means anything for. Hourly, beside the hold sweep and
  the ticket sweep, unref'd. Housekeeping and explicitly not a boundary: an expired state is already
  refused at redemption, which is where the check that matters lives.
- **A manual refresh, and the operator queue can be read.** `sendListAgents`, `sendListProviders`
  and `sendListThreads` were exported and called by nothing, so a snapshot that went stale had no
  remedy but reloading the page: there is a palette entry that asks for all three, and a quiet
  refresh on the Threads header, which is the surface a missed transition bites hardest.
  `npm run billing:stuck` reads the webhook events that arrived and never finished — the queue
  `http/billing.ts` deliberately leaves rows in and whose reader had no caller anywhere. It cannot
  replay an event and says so: the table stores no payload on purpose, so the operator resends by id
  from the provider and marks the row resolved here, which is what keeps the queue drainable.
- **Two written-and-unreadable histories became readable.** Every credential rotation has been
  recorded since the vault landed — with its reason, its masked hint and a millisecond-safe tie-break
  ordering — and `rotations()` had no caller: the Secrets panel could rotate a credential and could
  not show that it ever had, so "when did we last replace this, and was it because it leaked" was a
  SQL question during an incident. It is a **History** control on the row now, carrying no value, like
  everything else that surface answers. And `secret_scan_findings` stores every finding with whether
  it was **overridden** and by whom — the record `auditGithubOverride` exists to make answerable —
  with nothing able to read it; `listScanFindings` is a **Secret scan** region in the GitHub panel,
  asked for on open because the answer is empty for almost every agent.
- **Lists can be paged.** Every list read is `ORDER BY <time> DESC LIMIT 50` and nothing could ask
  past it, so the 51st-newest run was unreachable — `loadRun` needs an id, and the only source of ids
  was that list — while retention keeps traces for up to a year. The eval strip was worse: two
  ceilings on top of each other, a fifty-row read and then a six-chip render, so the seventh-newest
  comparison could not be selected in the panel whose whole job is comparing. Both grow a WINDOW
  rather than walking a cursor, which keeps every channel a full-snapshot channel — `applyHistory`
  merges by run id — capped at 500 a request, with `complete` (a window that came back short) as the
  only end-of-list signal. The sidebar's search box now says it is searching what has been loaded,
  which was the silent half of the same problem: looking for last month's run said there was no such
  run.
- **An agent has a lifecycle.** The product's central object had no removal, no archive and no rename
  in any layer — no command, no route, no repository method, no affordance — while datasets, examples,
  MCP servers, threads, deployments, links, secrets, invitations and members all had one. The only way
  an agent left was the disk sweep, which refuses a row with a published version: every agent the
  product builds has one, so none could be removed short of SQL. Meanwhile the Threads specification
  had a section about what happens when an agent is deleted, and declined to build a thread-delete
  confirmation on the grounds that "that confirmation applies to Agents only" — a safety net that did
  not exist.
  Now: `archiveAgent` / `restoreAgent` / `renameAgent` at `agent:write`, migration 047, an **Archived**
  tab in the sidebar, and rename in place on the row. Archived rather than deleted, because the
  versions, runs and costs hanging off an agent are the record; archiving removes it from the lists
  that offer work and from nothing else, its threads stay attached, and a deployed agent is refused
  because it is still serving. The rename changes `display_name` and never the slug — and sets
  `display_name_is_custom`, so the next disk sync cannot overwrite it, which is the trap
  `threads.title` was in and the same fix.
- **Pull-request checks can be switched on.** Four modules, two migrations, a webhook branch and
  four passing suites sat behind one row in `agent_ci_config` that nothing in the product could
  write: `setConfig` had no caller, so `ci_dataset_id` was always null and every delivery logged "no
  dataset is linked for CI on this agent". `setAgentCiConfig` is on the github channel at
  `github:manage` — it decides whether a stranger's pull request may spend this workspace's provider
  balance — and the panel has a **Checks** region with the dataset picker and §B.1.3's three-position
  policy. The dataset is the switch; the two fields patch independently, so clearing one keeps the
  other.
- **The judge's rubric can be edited.** ADR-012 is titled *LLM-as-judge with a data-driven rubric*
  and the data was not user-supplied anywhere: the table, both commands, the store fields and both
  senders existed, `EvalDrillDown` already rendered per-criterion breakdowns, and no component read
  or wrote any of it — so every eval scored against the built-in rubric and the server validated two
  refusals no user could produce. The dataset builder now has a **Judge rubric** block beside the
  examples: it opens with whatever the dataset is actually scored against (the built-in one, when it
  has none of its own), edits as a draft and saves in one command, because a half-saved rubric is a
  scoring standard nobody chose. A criterion's id is fixed once it exists — it is what stored
  verdicts are keyed by.
- **The sidebar footer names the person signed in and the plan they are on.** It was three
  literals — the avatar letter `J`, the name `jaroku`, and a `Free` chip — shown to every user
  whatever their account and whatever their plan, while the product held a correct copy of both
  facts two panels away. That is the anti-pattern the Threads spec argues against for the nav badge,
  in its worst form: a paid workspace reading `Free` in the sidebar and `Pro` in the Usage panel.
  The session now carries each workspace's plan with its LABEL resolved by `planFor` — the same
  function the budget gate resolves limits through — so nothing is mapped in the browser, and the
  chip is absent rather than invented when the session has not landed.
- **An enforcement can be appealed.** The ladder is one-sided by construction — a score rises, a
  rung is applied, work is refused — and `appeal_note` is the column that makes it two-sided.
  `EnforcementRepository.appeal` was written, audited, and had no caller, so the note could only be
  written with SQL: the one hand that does not need an appeal mechanism. A workspace under a rung now
  gets a strip under the top bar with the rung's own sentence (the same one a refusal carries), when
  it lapses, what it has been under before, and one text field. `watch` gets no strip because it
  changes nothing; the two rungs that refuse work outright cannot be dismissed. `enforcement:appeal`
  is a **member's** capability, for the reason the repository gives.
- **The audit log stopped being write-only.** Five subsystems write `audit_log` rows — membership,
  GitHub safety overrides, secret reveals and rotations, enforcement appeals, export and deletion —
  and `auditGithubOverride`'s own comment says the record has to be readable "by somebody who does
  not know this feature exists". `listAudit` had no caller at all, so the rows were kept for a
  question nobody could ask. It is a channel of its own (the log is not a footnote on membership),
  answered to the asking socket and never broadcast, at `workspace:manage` — and the metadata is
  printed as stored, because a trail read during an incident must not have summarised away the field
  the question turned on.
- **A workspace can set its own spend ceiling.** `BudgetGate.status` has always preferred the
  workspace's own ceiling over its plan's, and the Usage panel has always rendered the result — so
  the number was visible, was what runs are refused against, and could only be changed with SQL. A
  budget you can see and cannot set is a dashboard. `setSpendCeiling` is on the billing channel at
  `billing:manage`, and all three states the column has are reachable: a number, `0` for "start
  nothing", and clearing it back to the plan's. `limit_overrides` stays SQL on purpose — seats,
  concurrency, retention and the platform-key ceiling are a negotiated exception, and a workspace
  raising its own platform-key ceiling would be editing what we pay for.
- **`lib/http.ts`**, one place where a non-socket request gets the bearer token and this tab's
  `?workspace=`. It was inside the Secrets module, which is where it had to be while the Secrets
  group was the only such surface; forgetting the scoping on an EXPORT would mean handing somebody
  an archive of whichever workspace the server picked as their default.

### Fixed

- **Creating a thread threw on Postgres, and always had.** `ThreadStore.create` wrote
  `title_is_custom` as an inline SQL `0` into a column that is `INTEGER` on SQLite and `boolean` on
  Postgres — and a literal is typed before the column is consulted, so the production driver refused
  it: *column "title_is_custom" is of type boolean but expression is of type integer*. That is not
  one broken row; it is `create`, and therefore `ensureForAgent`, and therefore every run, generation
  and edit that resolves a session through it. Bound as a parameter now, which is how every other
  boolean in this codebase is written and what lets Postgres resolve it against the column.
  It survived a release because **every thread suite opens SQLite** — the same blind spot, and the
  same shape, as migration 044's COALESCE. `test:agent-lifecycle` runs on both drivers and creates a
  thread on each, which is what surfaced it; the assertion is now stated in that suite rather than
  left as a side effect of it.
- **Renaming and auto-titling a thread threw on Postgres too.** The same mistake as `create`, twice
  more in the same file: `rename` set `title_is_custom = 1` and `autoTitle` guarded on
  `title_is_custom = 0` in a WHERE. The second is the one that reads least like a type problem —
  Postgres reports it as *operator does not exist: boolean = integer*, which looks like a missing
  operator rather than the wrong value — and it meant the first user message in any thread failed on
  the production driver, after `create` had already failed. Both bound.
- **`test:boolean-literals`**, so this class cannot come back quietly. It reads the Postgres
  migrations for which columns are boolean and the production SQL for what is written into and
  compared against them, and fails on a literal where a parameter is needed — in a VALUES, in a SET,
  and in a WHERE, which is the position that hid the third occurrence from a hand search. It is a
  linter and says so, it excludes tests and CLIs because a SQLite-only suite may legitimately spell a
  boolean `0`, and it carries the original broken statement as a fixture: a lint with no proof that
  it catches anything is decoration. It needs no database, so it fails on the laptop where that SQL
  gets written rather than in CI.
- **A CI check would have failed every job it dispatched.** `checkRunner` passed the agent's **uuid**
  to `startEval`, where the eval engine takes the **slug** — which becomes the eval row's `agent_id`
  and then `runtime/agents/<agentId>`, the working directory of every job's subprocess. It could not
  be observed while the feature was unreachable: with no way to write `agent_ci_config`, the line was
  never executed in a running product. `test:check-runner` asserts the slug now, and the two ids are
  documented where they meet — the config is keyed by uuid because it is a row, the run by slug
  because it is a directory.

### Changed

- **`JAROKU_DEV_WORKSPACE` says what it does.** The README described it as naming which workspace
  the server acts in on its own behalf, and did not mention that setting it to an unused name
  *creates* that workspace — as a `team` one, which for a long time made this the only reachable
  route to the collaboration half of the product. The boot line now names the kind it made and what
  follows from it, and both README entries say so. The variable is a development convenience again
  rather than a door.


### Migrations

- `047_agent_lifecycle` — `agents.archived_at` and `agents.display_name_is_custom`, plus an index on
  `(workspace_id, archived_at)`. Both are additive and defaulted, so the version currently serving
  ignores them; `migrate:check` passes with no contract step. `archived_at` is deliberately not
  `deleted_at`: that column is the disk sweep's mark and `upsertFromDisk` clears it, so an archive
  stored there would be undone by the next boot that materialised the project.

### Not in this release

Recorded so the next reader does not go looking for them:

- **The Agents, Memory and Activity destinations stay shells.** The Threads specification is explicit
  — "build the shell so they can slot in; do not build their contents" — so the three placeholders
  are working as specified. The audit trail that would naturally live under Activity is in the
  workspace panel instead, beside the membership it mostly records.
- **Tearing down a deployment from Jaroku.** `forgetDeployment` detaches a record and touches
  nothing in your hosting account, which the README states as a boundary rather than a limitation:
  the same posture as never deleting a user's GitHub repository.
- **Re-running a finished eval.** Retry exists inside `evalRunner` as automatic, bounded recovery
  for retryable failures; it is deliberately not a user action, and nothing asks for one.
- **GitHub's own history is not paged.** What the panel renders is versions and remote commits read
  thirty at a time from GitHub's API. Widening that means paging somebody else's API for a surface
  nobody scrolls, which is a different feature from the paging above.

### Verification

- Both packages typecheck clean; the three gates that are not tests pass (`migrate:check`,
  `edge:render --check`, `obs:render --check`).
- Every suite this release touches is green: the twenty-one server suites covering capabilities,
  channels, relay, membership, session, identity, threads, the new agent lifecycle, pricing, the
  check runner, Stripe, plans, enforcement, tenancy, acceptance and migrations — and all nineteen
  client suites, including the new `test:invite`.
- Two structural audits did their job during the work rather than after it: `test:channels` refused
  the two new channels until they were classified as tenant data and actually exercised, and
  `test:reset` refused the two new stores until they were wired into the workspace reset.
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
