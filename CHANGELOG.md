# Changelog

All notable changes to Jaroku are recorded here, newest release first.

The format follows [Keep a Changelog](https://keepachangelog.com/) conventions, and versions
follow [Semantic Versioning](https://semver.org/). Every entry is drawn from the published
release notes and the commits in that release's range.

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
