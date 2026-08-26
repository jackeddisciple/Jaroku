# Jaroku Product Gap Audit

**Date:** 2026-08-26 · **Revision audited:** `04e6583` (v0.3.8) · **Method:** static trace + live drive

## What was audited

Every capability was traced along one chain and the audit records where the chain breaks:

```text
backend capability → command/route → client sender → UI entry → user action
    → backend execution → result/state → UI feedback → persistence → next action
```

**Static.** All 116 WebSocket commands in `server/src/wsRelay.ts` were extracted and matched
against `client/src/lib/socket.ts` senders and their component callers; all 45 HTTP route paths
were matched against client callers; exported server and client symbols were swept for callers
excluding their own file and test files; every `TierEntitlements` flag was traced to its gate;
the `runtime/pricing.json` → `effort.ts` → provider-request chain, the object-store key scheme,
and the `conversation_connectors` → run-dispatch path were each read end to end.

**Live.** The running server (`:4317`, sqlite `server/jaroku.db`, 16 workspaces / 15 agents) and
the running Vite client (`:5173`) were driven through Chrome DevTools Protocol: signed in as
`adarshhchoudhary20@gmail.com`, walked the four nav destinations, all nine right-panel tabs, the
agent grid, an agent detail view, the composer's ⊕ picker and ⋯ controls, and a Test run — with
every WebSocket frame and HTTP request captured. Three findings below (**GAP-001**, **GAP-003**,
**GAP-015**) were found by driving rather than by reading, and one suspected finding (two
popovers open at once) was **discarded** after checking `Popover.tsx` — it closes on `mousedown`,
which a synthetic `.click()` does not dispatch. It was a measurement artifact, not a defect.

**Corroborated by data.** `server/jaroku.db` was queried directly to confirm claims empirically —
`turn_variants` holds 8 rows, all `ordinal: 1` with every metadata column null (migration 057's
backfill and nothing else); `turn_attachments` holds 0; the two forked agents hold a 961-byte
manifest naming 9 files and have no directory in the object store at all.

## What is deliberately not here

`ui-audit/` was excluded — it is not current with the code. Items already recorded in
CHANGELOG's *Still owed* / *Not in this release* sections (the personal-workspace Exposure
sentence, per-agent narrowing on indirect ids, cross-replica live sessions, deployed-endpoint
auth, no group grants) are acknowledged as known and are **not** re-reported as findings.
`approvalBatchApprove` / `policyEngine` / `evalCiGate` gating nothing is documented in
`entitlementGate.ts` — only the half that reaches a **customer** (the pricing page) is reported.

---

# Executive Summary

| | |
|---|---:|
| **Total findings** | **16** |
| P0 — critical | 3 |
| P1 — high | 7 |
| P2 — medium | 5 |
| P3 — low | 1 |

### The most important overall pattern

**Jaroku has two sources of truth for an agent's source code, and only one of them is
maintained.** ADR-031/ADR-032 make the object store authoritative, and every *read* surface
honours that — the Code view, the Graph, the file picker, Export, the workspace export. But
**runs, deploys, and the `runnable` flag all read `runtime/agents/<slug>` on the local
filesystem**, and only two write paths ever update that directory (`generator.ts:365`,
`editor.ts:636`). Three writers do not: `forkAgent`, `restoreAgentVersion`, and any other
gateway replica. Everything downstream of that divergence is a P0.

### The biggest hidden capability

**Composer attachments.** A complete backend — `GET /v1/agents/:id/attachables`,
`POST/GET/DELETE /v1/turns/:id/attachments`, a token-budget check, a 10-item cap, an all-or-none
transaction, `turn_attachments` with retention/export/deletion registrations — and a complete
front end: a five-source picker, a rail, a live budget meter, a send-blocking over-budget check.
The one line that posts them does not exist. The picker's rows are priced by the server and then
dropped on the floor, and an over-budget rail **blocks the send** of a message whose attachments
were never going to be sent.

### The biggest broken workflow

**Fork an agent.** `forkAgent` copies the source agent's *manifest* onto a new agent id but
copies none of its *objects*. The fork is born with a published v2 pointing at content that was
never written. Proven live and empirically: the fork cannot run ("*it has no agent.py*"), its
**Files** button is a dead control, its ⊕ menu says "Nothing to attach yet", and its Graph tab
renders an error message truncated down to a bare filename. Fork is offered in the grid overflow
with no warning; every press makes another one.

### The biggest missing integration

**Per-conversation connector scoping is enforced for MCP servers only.** The composer's deck
lists reviewed connectors, user-secret connectors and MCP servers in one list and lets you
disable any of them. The run dispatch (`index.ts:10137-10146`) applies those decisions to MCP
servers alone; connector credentials and the sandbox egress allowlist are both built from
`agent.connectors` — the generation-time list — with the conversation's decisions never read.
Switching Gmail off for a conversation dims a tile, persists a row, and changes nothing about
what the agent can reach. `conversationConnectors.ts`'s own header names this exact failure as
the reason the feature was built.

---

# Top 10 Highest-Value Gaps

Ranked by **Opportunity Score** = (impact + coverage + workflow + discoverability + confidence) − effort.

| # | Gap | Score | Priority | Effort |
|---:|---|---:|:--|---:|
| 1 | **GAP-003** — Server read failures are swallowed; the client is never answered | 40 | P0 | 2 |
| 2 | **GAP-001** — `forkAgent` publishes a version whose objects were never written | 39 | P0 | 3 |
| 3 | **GAP-004** — Composer attachments are picked, priced, and discarded | 38 | P1 | 3 |
| 4 | **GAP-009** — The upsell card names a plan that does not unlock the refusal | 38 | P1 | 2 |
| 5 | **GAP-002** — Restore and deploy read a filesystem that restore never updates | 37 | P0 | 4 |
| 6 | **GAP-008** — Eight Inbox actions render controls that do nothing | 35 | P1 | 3 |
| 7 | **GAP-005** — Reasoning effort is persisted, rendered, and never applied | 34 | P1 | 4 |
| 8 | **GAP-007** — `runnable` is derived from the local filesystem only | 34 | P1 | 3 |
| 9 | **GAP-006** — Connector scoping is enforced for MCP servers only | 33 | P1 | 5 |
| 10 | **GAP-010** — Response variants: table, store, suite, switcher — no writer | 31 | P1 | 5 |

`GAP-015` (score 31, effort 1) and `GAP-014` (score 30, effort 1) are the two cheapest fixes in
the report and belong in the same first pass.

---

# Findings

## GAP-001 — `forkAgent` publishes a version whose objects were never written

**Priority:** P0
**Category:** PARTIAL_WORKFLOW · LIFECYCLE_GAP · MISSING_FEEDBACK
**Opportunity Score:** 39
**Confidence:** 10/10
**Tags:** `[BACKEND_EXISTS]` `[UI_EXISTS]` `[PARTIAL_WORKFLOW]` `[MISSING_FEEDBACK]` `[MISSING_RECOVERY]`

### What Already Exists

Fork is a shipped, documented capability: `sendForkAgent` on the agents channel, an overflow
entry on every card in the grid, `nextForkSlug` for naming, migration 049's `forked_from`
column, a `FORKED` tag in `agentTags`, and a README section explaining what fork copies and why
(README:951). It creates an `agents` row and an `agent_versions` row correctly.

The object store is keyed `ws/<workspaceId>/agents/<agentId>/v<n>/<path>` — **per agent id**
(`storage/keys.ts:151`). A version's manifest names paths; `ProjectStore.readVersion`
(`storage/projectStore.ts:134-143`) fetches each path under the calling agent's own key.

### Evidence

- `server/src/index.ts:5484` — `forkAgent()`
- `server/src/index.ts:5532` — `await agentRepo.addVersion(ctx, id, version.manifest, { source: "import", … })` — **the source agent's manifest, onto the fork's id, with no object copy**
- `server/src/storage/keys.ts:151` — `agentVersionKey(workspaceId, agentId, version, path)`
- `server/src/storage/projectStore.ts:134-143` — `readVersion()` → `objects.get(agentVersionKey(ctx.workspaceId, agentId, version, path))`
- `client/src/components/AgentsView.tsx:309` + overflow — the Fork entry
- **Empirical, this database:** `agent_versions` for `af7a6948-…` (`…_copy`) and `63ae8f83-…` (`…_copy2`) each hold a 961-byte manifest naming 9 files. `runtime/.objects/ws/febc43c9-…/agents/` contains **only** `a938356b-…` — neither fork has a directory.
- **Reproduced directly against the running object store:**
  ```
  base: OK     ws/febc43c9-…/agents/a938356b-…/v2/agent.py (1849 bytes)
  fork: THROWS ws/febc43c9-…/agents/af7a6948-…/v2/agent.py
           -> no such object: ws/febc43c9-…/agents/af7a6948-…/v2/agent.py
  ```

### Current User Path

Open the Agents grid → overflow on a card → **Fork**. A notice says *"Forked to
`…_copy2`. Its MCP grants start empty."* A new card appears, tagged `IDLE · UNVERIFIED ·
FORKED`, with a v2 in its version history reading *"forked from … v2 · 5.0 KB"*. Nothing
indicates a problem.

### Missing Connection

The version row and the objects it names are written by two different mechanisms.
`ProjectStore.publish` writes both together; `agentRepo.addVersion` writes only the row.
`restoreAgentVersion` may legitimately call `addVersion` with an existing manifest because the
objects live under the **same agent id**. `forkAgent` copied that pattern across an agent
boundary, where it does not hold. **No object copy step exists anywhere in the fork path.**

### Complete Workflow

```text
Fork an agent
    ↓
agents row created (forked_from set)              ← exists
    ↓
agent_versions row created (manifest copied)      ← exists
    ↓
[MISSING CONNECTION: copy objects to the fork's key prefix]
    ↓
ProjectStore.readVersion resolves                 ← exists
    ↓
Code view, ⊕ picker, Graph, Export, run, deploy   ← exist and all fail
```

### Why This Is A Real Gap

Every symptom was observed live, on this machine, in this build:

| Surface | What the user sees |
|---|---|
| Composer | *"an agent that takes a list of numbers and returns their mean copy **can't run — it has no agent.py**"*, Send permanently disabled |
| Version history → **Files** | `loadAgentVersion` sent; **zero frames back**; the panel does not change at all |
| ⊕ Attach menu | *"Nothing to attach yet — Generate an agent, run it, or link it to GitHub"* on an agent with two published versions |
| Graph tab | *"No graph for this version yet"* with the detail rendered as the single word `.env.example` (see GAP-015) |
| Deploy tab | *"`…_copy2` has no agent.py — there is nothing to serve"* |
| Agents grid | `IDLE · UNVERIFIED · FORKED` — no failure signal at all |

`lifecycle/export.ts:877-885` walks every agent calling `agentProjectFiles`; one fork therefore
throws inside the **workspace export**, which is the archive a customer takes when they leave.

### Minimal Fix

In `forkAgent`, between `agentRepo.create` and `addVersion`, read the source version's files and
publish them under the fork's id:

```ts
const files = await projects.readVersion(ctx, source.id, version.version);
await projects.publish(ctx, id, files, { source: "import", summary: `forked from ${source.slug} v${version.version}` });
```

That replaces the bare `addVersion` and writes the row and the objects together, which is the
invariant `publish` exists to hold. Then materialise to `runtime/agents/<forkSlug>` for the local
run path (see GAP-002/GAP-007), and add an assertion to `test:agent-lifecycle` that a forked
agent's files are readable — the fork suite currently asserts the row and never the content.

### Related Existing Capabilities

Code view, ⊕ file attachment, Graph introspection, Export current version, run, deploy, workspace
export, the Agents grid's health derivation — all become correct for a fork.

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 9/10 |
| Existing Implementation Coverage | 9/10 |
| Workflow Importance | 8/10 |
| Discoverability Impact | 6/10 |
| Implementation Effort | 3/10 |
| Confidence | 10/10 |

### Resolution

**Status: RESOLVED**

**Implemented:**

`forkAgent` now reads the source version's files and **publishes** them under the fork's own id,
replacing the bare `agentRepo.addVersion(ctx, id, version.manifest, …)`:

```ts
const sourceFiles = await projects.readVersion(ctx, source.id, version.version);   // before any row
…
const { version: published } = await projects.publish(ctx, id, sourceFiles, { … });
await projects.materialise(ctx, id, published, join(agentsDir(RUNTIME_DIR), forkSlug));
```

Three deliberate details:

1. **The read comes before `agentRepo.create`.** A source whose own objects are missing — a fork
   made before this change — now refuses with a sentence rather than producing a second broken
   agent. The old order would have created the row first and failed after.
2. **`publish` rather than `addVersion`,** because `publish` writes the row and the objects
   together, which is the invariant it exists to hold. `restoreAgentVersion` may keep calling
   `addVersion` with an existing manifest — its objects live under the *same* agent id. Fork
   copied that call across the one boundary where the premise does not hold.
3. **A materialise to `runtime/agents/<forkSlug>`,** so the local run path — which reads the disk
   — can see the fork at all. GAP-007 makes that derivation honest for every agent; this makes it
   correct for the one that was provably broken.

**Files Changed:**

- `server/src/index.ts` — `forkAgent`, and the `agentsDir` import
- `server/src/storage/projectStore.test.ts` — the fork invariant, both drivers
- `server/src/agentAdversarial.test.ts` — the structural assertion on the call

**Verification:**

`test:project-store` proves the property from both ends, which an assertion on the working path
alone would not: a manifest copied onto another agent's id with `addVersion` **still throws**
`ObjectNotFound`, and the same manifest published as *files* reads back byte for byte, under the
fork's own key prefix, with the bare-row fork's prefix holding nothing at all — exactly what the
audit found in `runtime/.objects`. Independence is asserted too: publishing over the fork leaves
the source's bytes where they were. `test:agent-adversarial` reads `forkAgent` out of `index.ts`
and fails if it goes back to `addVersion`, if it stops reading the source first, or if it stops
materialising — the function is not exported, and the distinction is one identifier wide.

**Regression Coverage:**

Both suites pass on SQLite and Postgres. The fork's *other* deliberate decisions are untouched and
still asserted: `mcp_tools: []` (§7.5's least-privilege rule), `creation_cost: null`, `forkedFrom`
as a column rather than parsed prose, and `nextForkSlug` reading `takenSlugs` rather than the
visible list. The version's `source` stays `"import"`, which is what migration 014 defines it to
mean and is honest about a project this agent's name never validated.

**Known limitation:** forks created *before* this change still have no objects. They now report
an honest read failure (GAP-003) instead of an empty file list, which is the recoverable state;
re-forking from the source produces a working copy.

**Resolved On:** 2026-08-26

---

## GAP-002 — Restore and deploy read a filesystem that restore never updates

**Priority:** P0
**Category:** PARTIAL_WORKFLOW · INTEGRATION_GAP · DUPLICATE_PATH
**Opportunity Score:** 37
**Confidence:** 9/10
**Tags:** `[BACKEND_EXISTS]` `[UI_EXISTS]` `[MISSING_CONNECTION]` `[DUPLICATE_PATH]`

### What Already Exists

Version history with **Restore** (`restoreAgentVersion`, `AgentVersions.tsx`), which correctly
publishes a *forward* version pointing at the old manifest rather than moving the pointer
backwards — the reasoning is written out at `index.ts:5545-5552` and is right.

Deploy reads and uploads a project directory, and records the deployed version number for §5.2's
drift badge (migration 041).

### Evidence

- `server/src/index.ts:5553-5586` — `restoreAgentVersion()`: `addVersion` → `broadcastAgents` → `broadcastAgentFiles` → `broadcastAgentGraph` → `broadcastAgentGrid`. **No `projects.materialise`.**
- `server/src/generator.ts:365` — generation materialises to `agents/<slug>`
- `server/src/editor.ts:636` — apply-edit **and** undo materialise to `agents/<slug>`
- `server/src/processManager.ts:68-84` — a local run spawns `uv run -m jaroku_runner <slug>` with cwd `runtime/`, importing `agents.<slug>` **from disk**
- `server/src/deployManager.ts:149` — `planDeploy` checks `join(runtimeDir, "agents", agentId)/agent.py`
- `server/src/deployManager.ts:422` — the upload's `projectDir` is that same directory
- `server/src/deployManager.ts:576-590` — `recordArtifacts()` reads that directory and calls `projects.publish(… source: "deploy")`
- `server/src/deployManager.ts:295,303` — the deployment row records `agent.current_version` (a **number from the database**) while the bytes came from disk

### Current User Path

Open an agent → Version history → **Restore** on v3. A notice says *"v3 is live again, published
as v5."* The Code view refreshes and shows v3's files (it reads the object store). The grid says
v5. Everything on screen agrees.

### Missing Connection

`runtime/agents/<slug>` still holds v4's bytes. Nothing in the restore path writes it.
Consequences, in order of severity:

1. **The next local run executes v4**, while the UI, the version list and the trace all say v5.
2. **Deploying afterwards ships v4** to Railway and records the deployment as version 5, so the
   drift badge reads "up to date" over a URL serving the code the user just replaced.
3. **`recordArtifacts` then publishes v4's bytes as v6** — the restore is silently undone in the
   version history as well.

Undo (`editor.ts:599`) materialises. Apply materialises. Generate materialises. Restore is the
one publish path that does not, which makes this an inconsistency rather than a design decision.

### Complete Workflow

```text
Restore v3
    ↓
new version row published, pointing at v3's objects   ← exists
    ↓
object store now serves v3                            ← exists (Code view is correct)
    ↓
[MISSING CONNECTION: materialise to runtime/agents/<slug>]
    ↓
run / deploy read that directory                      ← exists
    ↓
The agent that runs is the agent the history says was replaced
```

### Why This Is A Real Gap

The product's stated first principle is *"the trace never lies."* Here the trace is honest about
a run of code the user believes they retired. Worse, the failure is **silent and
self-propagating**: nothing errors, the drift badge actively reassures, and a redeploy writes the
stale bytes back into the version history as the newest version. There is no surface anywhere that
would let a user notice.

### Minimal Fix

One line in `restoreAgentVersion`, matching what `editor.undoEdit` already does:

```ts
await projects.materialise(ctx, agent.id, published, join(agentsDir(RUNTIME_DIR), slug));
```

The durable fix is GAP-007's: make one function the only way anything obtains a project
directory, materialising from the object store on demand, and let run, deploy and `runnable` all
call it. `test:edit-versions` should gain a restore-then-read-the-directory assertion — no suite
currently reads the disk after a restore.

### Related Existing Capabilities

Version history, Restore, Deploy, the drift badge, `recordArtifacts`, the local run path, and
GAP-007's `runnable` derivation.

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 9/10 |
| Existing Implementation Coverage | 8/10 |
| Workflow Importance | 8/10 |
| Discoverability Impact | 4/10 |
| Implementation Effort | 4/10 |
| Confidence | 9/10 |

### Resolution

**Status: RESOLVED — and the finding understated it**

**Correction to the original finding.** This audit recorded *"The Code view refreshes and shows
v3's files (it reads the object store)"* and scoped the defect to the filesystem. That is wrong,
and the implementation proved it: **a restore was broken in the object store as well.**

An object's key carries the version it was written under — `…/agents/<id>/v<n>/<path>` — so
`addVersion(ctx, agent.id, row.manifest, …)` reserves v5 and names paths that exist only under v3.
Every read of the restored version asks for `v5/agent.py` and gets nothing. Reproduced in
`test:edit-versions`:

```
ObjectNotFound: no such object: ws/…/agents/…/v5/.env.example
```

This is **GAP-001's defect one axis over**: there a manifest crossed an *agent* boundary, here one
crosses a *version* boundary. Same root cause, same mechanism, same reason it shipped — the row,
the version list and the byte total are all correct while the content is unreachable.

It read as correct during the audit because the failure had no symptom. The read threw, `answer()`
swallowed the throw (GAP-003), and the panel simply did not change — which, on the screen where
somebody has just pressed Restore, is indistinguishable from a refresh that worked. Closing
GAP-003 first is what made this visible, which is the reason the audit put it at the front of the
fix order.

**Implemented:**

```ts
const restoredFiles = await projects.readVersion(ctx, agent.id, wanted);
const { version: published } = await projects.publish(ctx, agent.id, restoredFiles, {
  source: "import", summary: `restored v${wanted}`,
});
await projects.materialise(ctx, agent.id, published, join(agentsDir(RUNTIME_DIR), slug));
```

The forward-publish design is unchanged and still right — `current_version` never moves backwards,
so the version list keeps describing what happened. `publish` also *strengthens* the property that
reasoning was written for: a forward version that owns its own objects can no longer be broken by a
retention sweep collecting the older version it was pointing at.

The materialise is the half the audit did find, and it closes the self-propagating chain: the run
executing retired code, the deploy shipping it while recording the new number (the drift badge
reading "up to date" over a URL serving the replaced version), and `recordArtifacts` republishing
the stale directory as a newer version — which undid the restore in the history as well.

**Files Changed:**

- `server/src/index.ts` — `restoreAgentVersion`
- `server/src/storage/projectStore.test.ts` — the property, both drivers
- `server/src/agentAdversarial.test.ts` — the structural check on the call
- `server/src/editVersions.test.ts` — section 3b, which drives the same thing through the real editor

**Verification:**

`test:project-store` asserts **from the broken end first** — a bare `addVersion` of the old manifest
still throws `ObjectNotFound`, because a key carries its version as well as its agent — and then the
fixed path: the restored version reads back as the old bytes, the version it restored *from* keeps
its own objects, and materialising moves a directory that was sitting on the replaced version.
`test:agent-adversarial` reads `restoreAgentVersion` out of `index.ts` and requires both halves: it
must publish files rather than copy a manifest, and it must materialise.

**Both of those suites already run in CI.** `test:edit-versions` drives the same properties through
the real editor and is the better local proof, but it **cannot run in the server CI job**: an apply
validates the generated project by importing it with Python, and that job has node and nothing else.
It fails there at its first apply with *"the generated project failed validation and was
discarded"*, which says nothing about the code under test — so the properties live where they
actually execute, and the workflow records why the suite is absent rather than leaving it looking
forgotten.

**Regression Coverage:**

`test:project-store` passes on SQLite and Postgres; `test:agent-adversarial` and `test:edit-versions`
pass locally in full — apply, undo, the failed-validation path, the cross-workspace refusals and the
read-only enforcement are unchanged. GAP-001 and this share a mechanism, and both suites cover both.
The drift badge needs no change: it compares a recorded version number against `current_version`,
and both are now true.

**Resolved On:** 2026-08-26

---

## GAP-003 — A failed read is swallowed; the client is never answered at all

**Priority:** P0
**Category:** MISSING_FEEDBACK · STATE_MACHINE_GAP
**Opportunity Score:** 40
**Confidence:** 10/10
**Tags:** `[BACKEND_EXISTS]` `[UI_EXISTS]` `[MISSING_FEEDBACK]` `[MISSING_STATE]` `[DEAD_END]`

### What Already Exists

`WsRelay.answer()` is the shared read path for the socket's point-to-point reads. Every one of
them has a well-designed empty state on the client — `EMPTY_GRID`, `EMPTY_THREADS`,
`EMPTY_INBOX` all exist *specifically* so a client can distinguish "nothing" from "not answered
yet" (`wsRelay.ts:2609-2615` states this in as many words).

### Evidence

- `server/src/wsRelay.ts:3989-3999`:
  ```ts
  private async answer(ws, build, pending): Promise<void> {
    try { this.sendTo(ws, await build(await pending)); }
    catch (err) { console.error("[relay] read failed:", (err as Error).message); }
  }
  ```
- Commands routed through it: `loadAgentFiles` (3594), `loadAgentVersion` (3625), `listMcpServers` (3624), `listThreads` (3630), `loadThread` (3636), `listInbox` (3651), `listAgentGrid`, `loadAgentDetail`
- Contrast — `agentGraph` (`index.ts:2201-2205`) **catches** and returns `{ error }`, and the Graph tab renders it. Two read paths for the same underlying failure, one honest and one silent.

### Current User Path — observed live

Selecting a forked agent, captured over the socket:

```
OUT: {"cmd":"loadAgentFiles","agentId":"an_agent_that_takes_a_list_of_numbers_an_copy2"}
IN : connected · history · agents · mcp:servers · providers · deploy
     · threads · inbox · enforcement        ← no agentFiles frame, ever
```

Clicking **Files** on a version, captured over the socket:

```
OUT: {"cmd":"loadAgentVersion","agentId":"…_copy","version":2}
IN : []                                     ← nothing; the panel does not change
```

The client's store never receives a message, so it renders its *initial* state forever: no
spinner, no error, no empty state that says anything true. The ⊕ menu concludes there are no
files and prints *"Nothing to attach yet — Generate an agent…"* about an agent with two
published versions.

### Missing Connection

`answer()` has three outcomes and expresses two. A refusal is a message; a success is a message;
**a failure is a log line on a server the user cannot see.** The channel shapes already have an
error member for exactly this (`AgentEvent` has `{ type: "error"; message; agentId? }`), and
`loadThread` proves the pattern by answering `{ type: "error", message: "no such thread…" }` for
its own not-found case.

### Complete Workflow

```text
Client sends a read command
    ↓
Server builds the answer                     ← exists
    ↓
Build throws
    ↓
[MISSING CONNECTION: answer the socket with the channel's own error member]
    ↓
Store applies the error                      ← exists on every channel
    ↓
Panel shows what went wrong and what to do   ← exists (GraphView does exactly this)
```

### Why This Is A Real Gap

This is the amplifier under GAP-001 and under every future read failure. One missing object turns
into a Code view, an attachment picker and a version browser that are indistinguishable from
"this agent has nothing" — an empty state that is a **confident wrong answer** rather than a
missing one, which is the failure mode this codebase argues against everywhere else. It is also
the reason GAP-001 was invisible to every suite: nothing observable changes.

### Minimal Fix

Give `answer` an error shape per call site — a third argument returning the channel's own error
member:

```ts
private async answer(ws, build, pending, onError?: (m: string) => unknown) {
  try { this.sendTo(ws, await build(await pending)); }
  catch (err) {
    const m = (err as Error).message;
    console.error("[relay] read failed:", m);
    if (onError) this.sendTo(ws, onError(m));
  }
}
```

`loadAgentFiles` and `loadAgentVersion` pass `(m) => ({ channel: "agents", type: "error", agentId, message: m })`.
`test:channels` — which already refuses a channel that is not exercised — is the right place to
assert that every `answer()` call site supplies one.

### Related Existing Capabilities

Every point-to-point read: agent files, agent versions, agent detail, the grid, threads, the
inbox, the MCP registry. Also the entitlement/role refusal plumbing in `socket.ts:82-108`, which
already routes structured errors correctly once one is sent.

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 8/10 |
| Existing Implementation Coverage | 9/10 |
| Workflow Importance | 8/10 |
| Discoverability Impact | 7/10 |
| Implementation Effort | 2/10 |
| Confidence | 10/10 |

### Resolution

**Status: RESOLVED**

**Implemented:**

`answer()` takes a fourth parameter, `onError: (message: string) => unknown`, and its catch now
sends that shape to the asking socket as well as logging. The parameter is **required**, not
optional — that is the structural half of the fix. A read command added later cannot be written
without deciding what its failure looks like, and the typecheck refuses one that tries.

All thirteen call sites supply an error member on their own channel, using the shape that
channel's store already renders:

| Command | Answers with |
|---|---|
| `loadAgentFiles` | `{ channel: "agentFiles", agentId, error }` — a new member on that channel |
| `loadAgentVersion`, `loadAgentDetail`, `listAgents`, `listAgentGrid` | `{ channel: "agents", type: "error", … }` |
| `listThreads`, `loadThread` | `{ channel: "threads", type: "error", … }` |
| `listInbox` | `{ channel: "inbox", type: "error", message }` |
| `listMcpServers` | `{ channel: "mcp", type: "error", message }` |
| `listDeployments` | `{ channel: "deploy", type: "error", message }` |
| `getActivityFeed` | `{ channel: "activity", type: "error", message }` |
| `loadHistory`, `loadRun` | `{ channel: "log", level: "stderr", text }` |

The last two are on the diagnostics rail rather than their own channel, deliberately: `history`
is a full-snapshot channel and `runSteps` carries one run's steps, and neither has an error member
to reuse. Giving them one would mean every consumer learning a second shape for a read that has
never failed in production; the stderr rail is already visible, already the place a diagnostic
goes, and is the difference between a scroll-back that silently stops and one that says why.

Client side, `agentFiles` became a two-member union (`files` xor `error`) so the two outcomes
cannot be confused, `buildStore.setAgentFilesError` empties the tree and records why, and the ⊕
menu now distinguishes *"Nothing to attach yet — generate an agent…"* from *"Nothing to attach
right now — this agent's files could not be read"*. That sentence was the audit's own example of
a confident wrong answer.

**Files Changed:**

- `server/src/wsRelay.ts` — `answer()`'s signature and catch; thirteen call sites
- `server/src/channels.test.ts` — section 2b, the structural audit
- `server/src/wsRelay.test.ts` — a stub that throws, and the live assertion over it
- `client/src/types.ts` — the `agentFiles` union
- `client/src/store/buildStore.ts` — `setAgentFilesError`
- `client/src/lib/socket.ts` — the `agentFiles` error branch
- `client/src/components/composer/AddMenu.tsx` — the `unavailable` reason
- `client/src/components/BuildPane.tsx` — passes it

**Verification:**

`test:channels` gained five assertions that read `wsRelay.ts` as text: `answer()` takes the
parameter, its catch sends it, all thirteen call sites supply a fourth argument that is a
*function of the message* (a constant string would be the same silence wearing a sentence), and
every channel named is one the suite has already classified. `test:relay` drives it live — a
`listAgentFiles` stub that throws now produces an `agentFiles` frame carrying the store's own
`no such object:` message, asserted by waiting for the frame, since "no frame ever arrives" is
exactly the old behaviour and only a timeout distinguishes it from a slow one.

**Regression Coverage:**

Both suites pass whole; server and client typecheck. `test:relay`'s existing tenancy assertions
are unchanged, including the one that matters here — an agent id belonging to another workspace
still answers `files: []` rather than an error, because a refusal that says "that read failed"
confirms the id exists and turns the socket into an enumeration oracle. The two outcomes are
deliberately different shapes for that reason.

**Resolved On:** 2026-08-26

---

## GAP-004 — Composer attachments are picked, priced, budget-checked, and discarded

**Priority:** P1
**Category:** UI_DEAD_END · BACKEND_NO_UI · NO_PERSISTENCE
**Opportunity Score:** 38
**Confidence:** 10/10
**Tags:** `[BACKEND_EXISTS]` `[API_EXISTS]` `[UI_EXISTS]` `[NO_CALLER]` `[DEAD_END]` `[MISSING_PERSISTENCE]`

### What Already Exists

**A complete backend.** `POST /v1/turns/:id/attachments` validates the kind and ref, **re-measures
every token estimate server-side** ("a client-supplied estimate would let any request through by
claiming to be small"), enforces `MAX_ATTACHMENTS` against existing + arriving, checks the model's
context budget before writing, and stores all-or-none in a transaction. `GET` and `DELETE` exist.
`GET /v1/agents/:id/attachables` populates all five pickers from one route. `turn_attachments` is
registered with retention, export and the workspace deleter.

**A complete front end.** `AttachPicker` (one component, five sources, server-side search,
per-kind multi-select), `AttachmentRail` (two rows then `+N`), a live budget meter with a warn
threshold, an 11th-item cap, Backspace-to-remove-last, and a send-blocking over-budget state.

### Evidence

- `server/src/http/turns.ts:229-310` — `POST /v1/turns/:id/attachments`
- `server/src/http/turns.ts:194-228, 313-352` — `GET` and `DELETE`
- `server/src/http/turns.ts:397+` — `GET /v1/agents/:id/attachables`
- `server/src/attachmentStore.ts:67-95` — `attach()`, all-or-none
- `server/src/attachments.ts` — `MAX_ATTACHMENTS`, `checkBudget`, `checkCount`, `validateRef`
- `client/src/components/composer/AttachPicker.tsx:99` — the **only** attachment route the client calls
- `client/src/components/BuildPane.tsx:1074` — `const [attachments, setAttachments] = useState<DraftAttachment[]>([])`
- `client/src/components/BuildPane.tsx:1220-1275` — `submit()`: routes to `sendPlanAgent` / `sendEdit` / `sendBranchRun` / `sendExplain`. **`attachments` is not read in any branch.** Only `github.attachments` rides (line 1269).
- `client/src/components/BuildPane.tsx:1144-1149, 2190` — `overBudget` and `unresolved` **disable the Send button**
- **Empirical:** `turn_attachments` — 0 rows. `grep` for `/v1/turns/.*attachments` across `client/src` — no match.
- **Observed live:** opening the picker fires `GET …/attachables?kind=file&q=&limit=50` and lists real files with token counts (`agent.py | 555 tok`). **Selecting a row fires zero requests.**

### Current User Path

⊕ → File → search → pick `agent.py` and `tools/statistics.py` → two chips appear on the rail with
their token cost → a meter warns as the context fills → press Send. The message is sent. The
chips vanish with the draft. The model never saw either file.

### Missing Connection

The turn's durable id (`turn.itemId`) exists — `AssistantTurn` already loads notes, pins and
feedback against it (`BuildPane.tsx:311-313`). Nothing posts the rail's refs to
`POST /v1/turns/<itemId>/attachments`, and no command carries them either.

### Complete Workflow

```text
⊕ → picker (server-searched, server-priced)     ← exists
    ↓
Rail holds refs + live budget                    ← exists
    ↓
Send
    ↓
[MISSING CONNECTION: POST /v1/turns/:id/attachments with the refs]
    ↓
Server re-measures, budget-checks, stores        ← exists
    ↓
[MISSING CONNECTION: resolved content into the prompt]
    ↓
The model answers about the thing you attached
```

### Why This Is A Real Gap

The feature's own justification (`AddMenu.tsx:1-10`) is that Jaroku's context is otherwise
passive and selection-based — "there is no way to reference a file you have not clicked, a run
from yesterday, or a failing eval case without leaving the conversation." That is still true.

It is worse than inert: **the client-side budget check blocks Send.** A user who attaches a large
file cannot send their *message* — "Remove `agent.py` or `README.md` to send it" — over a payload
that would never have left the browser. `AttachmentRail.tsx:36,71-77` renders an error tone and a
retry for a resolution failure that no code path can produce, because there is no round trip that
could fail.

### Minimal Fix

Two steps, in order:

1. **Send them.** After the send resolves the turn's durable id, `POST /v1/turns/<id>/attachments`
   with `{ attachments: [{ kind, ref, agent_id }] }` and surface a 409/413 on the rail — which is
   what `DraftAttachment.error` was written for.
2. **Consume them.** `deps.attachments.forTurn` already returns resolved rows; the prompt builders
   in `planner.ts` / `editor.ts` / `explainer.ts` need a block for them. Until step 2 lands, step 1
   alone at least makes the persisted record honest.

If neither is imminent, the correct interim is to **hide ⊕** rather than let it block Send.

### Related Existing Capabilities

Turn notes / pins / feedback (same resource, same scoping, already wired), the Cmd+K palette the
picker is built on, the model catalogue's `context_window`, GitHub attachments (which *do* ride
`sendExplain` and are the working proof of the pattern).

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 8/10 |
| Existing Implementation Coverage | 10/10 |
| Workflow Importance | 8/10 |
| Discoverability Impact | 5/10 |
| Implementation Effort | 3/10 |
| Confidence | 10/10 |

### Resolution

**Status: RESOLVED — both links, not only the first**

**The refs ride the command, not a second round trip.** The finding proposed
`POST /v1/turns/<id>/attachments` after the send resolves the turn's id. That id does not exist at
send time: the server writes the `thread_items` row, so there is nothing to address. `github`
attachments on `sendExplain` already work exactly this way and are the pattern named in the
finding as the working proof — so `attachments` joins `generate`, `planAgent`, `edit` and `explain`
as references, never content.

**One implementation of the rules, not two.** `attachTurn` was extracted from the route's body and
is now called by both the route and the dispatch. The cap counted against existing *plus* arriving,
the estimate **re-measured server-side**, the budget checked *before* the write, and the write
all-or-none are each a rule somebody could re-derive slightly differently — and the second version
is the one that forgets to re-measure, at which point any request gets through by claiming to be
small. That is the route's own stated reason for measuring, and it is why the dispatch does not
have its own copy.

**And they reach the model, which is the half that makes it a feature.** `resolveAttachmentBlock`
reads the stored rows back and resolves each from the store that already owns that kind of thing —
the agent's pinned version for a file, the trace store for a run, the eval store for a case, the
MCP registry for a schema, and `githubService.resolveAttachments` for a commit or PR, which is the
same resolver §7's own attachments use so one thing does not read two ways in a prompt. The block
is appended to the brief, the instruction or the explain context, which is the shape §7 already
established: the subject first, the attached material as evidence about it.

Resolution is at **send** time, except a file, whose ref pins a `version_id` — §4.4's snapshot. The
two are not in tension: the ref decides what "now" means, and a file's ref names a version.

**`noteUserMessage` returns the turn id.** It was fire-and-forget; `turn_attachments`,
`turn_notes`, `turn_pins` and `turn_feedback` all hang off that row, and nothing could reach it
without reading the thread back. `threadStore.addItem` returns its id too — a widening, since every
existing caller ignores it.

**The dead send-block is gone.** `DraftAttachment.error` and the `unresolved` check that read it are
removed. No code path could set that field — there was no round trip to fail — so it blocked Send
on a state that could never exist, over a payload that was never going to leave the browser. A
refusal now arrives as an error in the *conversation*, beside the message it is about, which is
where every other failure of that send already lands. The budget check stays and is now a genuine
early warning: the server re-measures and answers 413.

**Files Changed:**

- `server/src/http/turns.ts` — `attachTurn`, `RequestedAttachment`, `AttachDeps`; the route now calls it
- `server/src/index.ts` — `turnDeps` extracted, `requestedAttachments`, `attachToTurn`, `resolveAttachmentBlock`, `attachmentBody`, four dispatch sites
- `server/src/wsRelay.ts` — `CommandAttachment` on the four commands
- `server/src/threadStore.ts` — `addItem` returns the id
- `server/src/attachments.test.ts` — the reachability audit
- `client/src/lib/socket.ts` — `CommandAttachment`, four senders
- `client/src/components/BuildPane.tsx` — `attachRefs`, cleared with the draft, `unresolved` removed
- `client/src/components/composer/AttachmentRail.tsx` — the unreachable error state removed

**Verification:**

`test:attachments` gained a reachability audit, and it is a source audit deliberately: **every
arithmetic assertion in that suite was already true of the shipped code and none of it ran on a real
turn.** It holds fifteen claims — `attachTurn` exported and called by the route, the re-measurement
still there, the budget still checked before the write, four commands carrying the field, both
`sendPlanAgent` calls plus `sendEdit` and `sendExplain` passing the refs, the draft cleared with
them, the block resolved from the store rather than from the request, **all four** dispatch sites
appending it, and a refusal caught rather than thrown. Two of those could be true with the feature
still inert, which is why all of them are checked.

**Regression Coverage:**

`test:attachments`, `test:threads`, `test:thread-channel`, `test:thread-binding`,
`test:thread-status`, `test:turn-interaction`, `test:http`, `test:acceptance`, `test:channels`,
`test:relay` and `test:conversation-routes` all pass; both sides typecheck. `addItem`'s change is
additive — the auto-title race it guards is untouched, and the title work stays floated inside
`noteUserMessage` so a message that failed to title is still a message that arrived.

**Resolved On:** 2026-08-26

---

## GAP-005 — Reasoning effort is persisted, resolved, rendered — and never applied

**Priority:** P1
**Category:** NO_PERSISTENCE · INTEGRATION_GAP · ORPHANED_BACKEND
**Opportunity Score:** 34
**Confidence:** 9/10
**Tags:** `[BACKEND_EXISTS]` `[UI_EXISTS]` `[ORPHANED]` `[MISSING_INTEGRATION]`

### What Already Exists

A four-level effort abstraction with a per-provider adapter: `planEffort()` translates a level
into a `thinking` token budget or a named `reasoning_effort`, clamps XHigh on three-level
providers, validates every budget against the model's `max_output_tokens`, and returns
`{ requested, applied, supported, clamped }` so a clamp can be shown honestly.

Storage: `conversation_settings.reasoning_effort` and `workspaces.default_reasoning_effort`
(migration 054), resolved through a conversation → workspace → default chain.
Route: `GET`/`PATCH /v1/conversations/:id/settings`.
Capability: `runtime/pricing.json` carries `reasoning: "thinking" | "effort" | null` and a budget
table per level; `index.ts:4822` puts it on the providers snapshot.
UI: `EffortControl.tsx` renders the picker, disables it with an explanation when the model has no
reasoning control, and `TurnMetadata.tsx:83-88` renders the clamp marker.

### Evidence

- `server/src/effort.ts:83` — `planEffort(...)` · **no production caller**
- `server/src/effort.ts:103` — `planForCapability(...)` · **no production caller**
- `server/src/effort.ts:199` — `relativeCost(...)` · **no production caller** (mirrored in the client instead, `EffortControl.tsx:45`)
- `server/src/pricing.ts:198` — `reasoningBudgets()` · called **only** from `effort.ts:144,210`
- `server/src/claude.ts` — the shared Anthropic client: **no `thinking`, no `budget_tokens`**
- `server/src/generator.ts:391`, `planner.ts:322`, `editor.ts:690`, `explainer.ts:70`, `judge/score.ts:226` — every request builder passes `max_tokens` and nothing else
- `runtime/jaroku_runner/models.py:33-60` — `build_model()` constructs `ChatAnthropic(model=…)` / `ChatOpenAI(model=…)` / `ChatGoogleGenerativeAI(…)` with **no reasoning parameter**
- **Contrast:** `permission_mode`, the *other* column on the same row, **is** enforced — `index.ts:3374-3388` (`permissionModeForRun`), `9415-9417` (`mustConfirm`), `10114` (`JAROKU_PERMISSION_MODE` into the run env)

### Current User Path

⋯ → **Reasoning effort** → High. `PATCH /v1/conversations/:id/settings` returns the server's
resolved value; the store replaces local state with it; the chip reads High; a reload still reads
High. Every subsequent plan, generation, edit, explain and judge call is sent at the provider's
default.

### Missing Connection

`planEffort` is the adapter §3.2 required — *"translated per provider at request time, in one
adapter module — never inline at the call site."* The module was written, tested (`test:effort`),
and never called. Nothing reads `conversation_settings.reasoning_effort` outside the route that
writes it.

### Complete Workflow

```text
Pick an effort level                                    ← exists
    ↓
PATCH persists it, resolved through the workspace       ← exists
    ↓
[MISSING CONNECTION: read it when dispatching]
    ↓
planEffort(model, level) → { applied, supported }        ← exists, uncalled
    ↓
[MISSING CONNECTION: put the budget on the request]
    ↓
The model actually thinks harder, and the metadata row
reports what was spent rather than what was asked for
```

### Why This Is A Real Gap

Two of the codebase's own rules are broken by the same absence. §3.2: *"Never report an effort
that wasn't used."* The metadata row currently reports the level from `usage.effort` — a field
nothing sets — so the chip is either absent or reporting a setting that did nothing. And §6.2's
clamp marker (`isClamped`, `TurnMetadata.tsx:83`) can never fire, because `effort_requested` and
`effort_applied` are only ever equal or both null.

For a user, the harm is quiet and expensive in the other direction: they set High on a hard
generation, believe they bought more reasoning, and get the default. The paired control next to
it (Permission mode) *is* enforced, which makes the inference that this one is too entirely
reasonable.

### Minimal Fix

At each of the five dispatch sites, resolve the level and hand it to the adapter that already
exists:

```ts
const { effort } = await conversationSettings.effective(ctx, threadId);
const plan = planEffort(modelId, effort);
// Anthropic: plan.supported && plan.applied !== "low"
//   → thinking: { type: "enabled", budget_tokens: plan.budgetTokens }
```

and pass `plan.requested` / `plan.applied` onto the usage payload the turn already carries, which
is what makes the clamp marker real. For agent runs, forward the resolved level as an env var
alongside `JAROKU_PERMISSION_MODE` and have `models.py` apply it — that is the same seam
`JAROKU_PROVIDER` / `JAROKU_MODEL` already use.

### Related Existing Capabilities

The composer's effort control, the metadata row's effort chip and clamp marker, `test:effort`,
the providers snapshot's `reasoning` capability, per-turn override, the workspace default, and
`turn_variants.effort_requested`/`effort_applied` (GAP-010).

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 7/10 |
| Existing Implementation Coverage | 9/10 |
| Workflow Importance | 7/10 |
| Discoverability Impact | 6/10 |
| Implementation Effort | 4/10 |
| Confidence | 9/10 |

### Resolution

**Status: RESOLVED**

**Implemented:** `effortForThread(ctx, threadId, modelId, maxOutputTokens)` in `index.ts` resolves
the level through the conversation → workspace → default chain and hands it to `planEffort` — the
adapter §3.2 required and which had no production caller. It is called at **all four** model calls
the composer can start (plan, generate, edit, explain), and each builder spreads the resulting
thinking block onto its request. A call with no plan is byte-identical to the one that shipped.

**`planEffort` gained a per-request ceiling, and it is a real fix rather than plumbing.** Every
builder sends its own `max_tokens` — 600 for a plan, 700 for an explain, 16,000 for a generation —
and a thinking block is spent out of *that* allowance. A budget validated only against the model's
theoretical maximum is a 400 on the plan call and a truncated answer on the explain one, neither
with an error naming the cause. The adapter now clamps per request and reports the level it
stepped down to, which is what makes the clamp marker able to fire at all.

**§6.2's two fields are on the payload.** `effortFields` puts `effort` (spent) and
`effort_requested` (asked) on the plan, generation and edit usage payloads — **both or neither**,
because the clamp marker is exactly their inequality, so one without the other makes a clamp either
invisible or imaginary. `isClamped` can fire for the first time.

**And the run path, on the seam `JAROKU_PROVIDER` already uses.** `env.JAROKU_REASONING_EFFORT`
carries the level, and `models.py` translates it beside the constructor: a thinking budget with
`max_tokens` raised to match for Anthropic, `reasoning_effort` for OpenAI with XHigh clamped to
High. The **word** travels rather than a number, deliberately — a budget computed in TypeScript
would be a second implementation of the adapter, in a second language, wrong the first time either
table moved.

Without the run half, a conversation set to High would have planned and edited at High and *run*
at the default — which is worse than the setting doing nothing at all, because the parts that work
make the third look like it works too. That is the same inference that made this gap invisible:
`permission_mode`, the column beside it on the same row, is enforced.

**Files Changed:**

- `server/src/effort.ts` — the per-request ceiling
- `server/src/index.ts` — `effortForThread`, `effortFields`, four dispatch sites, the run env
- `server/src/planner.ts`, `generator.ts`, `editor.ts`, `explainer.ts` — the option and the spread; `MAX_TOKENS` exported
- `runtime/jaroku_runner/models.py` — the level applied per provider
- `server/src/effort.test.ts` — the ceiling assertions and the reachability audit

**Verification:**

`test:effort` gained two sections. The first drives the new ceiling against a real
catalogue model: High is High at the model's own ceiling, steps down on a 600-token request while
still reporting `requested: "high"` and marking the clamp, and a ceiling *above* the model's own
changes nothing. The second is a source audit, and it is the assertion this module waited for —
**every arithmetic assertion above it was already true of code with no production caller.** It
holds that `effortForThread` exists and calls the one adapter, that it is called at all four
dispatch sites, that all four builders put the block on the request, that both usage fields travel
together at three payload sites, and that the run env and `models.py` agree on the variable name
and on the XHigh clamp.

**Regression Coverage:**

`test:effort`, `test:conversation-settings`, `test:conversation-routes`, `test:generation`,
`test:edit-versions`, `test:plan` and `test:desktop-contract` all pass; both sides typecheck. The
`desktop-contract` pass matters: it greps every environment variable the shell sets against the
server's own source, and a new run variable that only one side knew about would fail there.

**Resolved On:** 2026-08-26

---

## GAP-006 — Per-conversation connector scoping is enforced for MCP servers only

**Priority:** P1
**Category:** INTEGRATION_GAP · PERMISSION_GAP · UI_DEAD_END
**Opportunity Score:** 33
**Confidence:** 9/10
**Tags:** `[BACKEND_EXISTS]` `[UI_EXISTS]` `[MISSING_INTEGRATION]` `[MISSING_PERMISSION]`

### What Already Exists

`ConversationConnectorStore` with the absent-row-means-yes rule, `GET`/`PUT
/v1/conversations/:id/connectors`, the `conversation_connectors` table, a client store that
treats the response as truth rather than the request, and `ConnectorDeck` — three tiles then a
`+N`, disabled ones kept in place and greyed.

And the enforcement half **does exist** — for MCP servers.

### Evidence

- `server/src/conversationConnectors.ts:14-19` — the module's own statement of intent: *"A toggle that only dimmed a logo would leave the tool in the dispatch, the model would call it anyway, and the user would conclude the control does nothing."*
- `server/src/index.ts:3265-3324` — `workspaceConnectors()` returns **three kinds of row in one list**: OAuth connectors (`gmail`, `gcal`, `slack`), user-secret connectors (`stripe`, `postgres`, `http`), and MCP servers
- `server/src/http/conversations.ts:145-158` — `connectorView` joins the decisions over **all three kinds**; the `PUT` accepts any id from that list
- `server/src/index.ts:10134-10146` — the **only** consumer of `decisionsFor`:
  ```ts
  const servers = await mcpStore.listServers(ctx);
  const allowed = servers.map((sv) => sv.id).filter((id) => decisions.get(id) ?? true);
  env.JAROKU_MCP_SERVERS = allowed.length > 0 ? allowed.join(",") : "-";
  ```
- `server/src/index.ts:10178-10203` — connector **credentials** are resolved from `agent?.connectors ?? []` — the generation-time list — with no reference to `decisions`
- `server/src/index.ts:10234+` — the sandbox **egress allowlist** is built "from the same declarations the credentials came from"
- `runtime/agents/*/agent.py:7,13,27` — `from .tools import TOOLS` … `llm.bind_tools(TOOLS)` … `ToolNode(TOOLS)` — the reviewed-connector tool list is **static in the generated project**
- `runtime/tool_templates/slack.py:54` — reads `SLACK_BOT_TOKEN` from the environment; no per-conversation gate exists in any template
- `grep decisionsFor server/src` → exactly one production call site

### Current User Path

⋯ → Connectors → click the Gmail tile off. The tile goes grayscale and stays in the deck. A
`PUT` persists `gmail: false` and the server answers with the whole joined list, which is what
the deck re-renders. Reloading keeps it off. Running the agent in that conversation: Gmail's
tools are still bound, `GMAIL_ACCESS_TOKEN` is still minted and injected, and
`googleapis.com` is still on the egress allowlist.

### Missing Connection

The dispatch reads the decisions and applies them to one of the three kinds of row the UI offers.
For the other six connectors there is no runtime allowlist to apply them to.

### Complete Workflow

```text
Deck lists connectors + MCP servers                     ← exists
    ↓
Toggle persists a decision                              ← exists
    ↓
Run resolves the decisions                              ← exists
    ↓
MCP servers filtered via JAROKU_MCP_SERVERS             ← exists
    ↓
[MISSING CONNECTION: the same filter for reviewed and user-secret connectors]
    ↓
Their tools are not bound / their credentials not injected / their hosts not on the egress list
```

### Why This Is A Real Gap

This is a **safety** control that reads as enforced and is not. "Switch Gmail off for this
conversation" is the exact gesture a user makes before pasting something they do not want an
agent's mail tools near. The deck's design is careful — a disabled connector *stays* in the deck
so its absence cannot be misread — which makes the dimming an unusually strong signal that the
capability is gone.

The MCP half being genuinely enforced is what makes the inference reasonable and the gap sharp:
one list, one gesture, two different meanings depending on which row you clicked, with nothing on
screen distinguishing them.

Note a second-order effect: disabling *any* connector makes `decisions.size > 0`, which switches
the MCP allowlist on. In a workspace with no MCP servers this sets `JAROKU_MCP_SERVERS="-"`,
which is harmless today and is a latent surprise the moment one is connected.

### Minimal Fix

Mirror the MCP mechanism. The run env already carries a sentinel-based allowlist; add
`JAROKU_CONNECTORS` built the same way from `agent.connectors ∩ enabled`, and:

1. Filter the credential resolution at `index.ts:10178-10203` by that set — a template with no
   credential already reports "not configured" cleanly at the point of use, which is the honest
   failure.
2. Filter the egress allowlist by the same set, so a disabled connector's host is off the list.
3. Have `tools/__init__.py` read `JAROKU_CONNECTORS` and omit the unlisted templates from `TOOLS`,
   so the tool is not merely credential-less but absent from the model's tool list.

Step 1 alone closes the security half. Until all three land, the deck should visually separate
"scoped" rows from "workspace only" ones rather than presenting one uniform list.

### Related Existing Capabilities

The connector catalogue, OAuth token minting and refresh, the credential vault, the sandbox
egress policy, the MCP allowlist (the working half), and the permission shield.

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 9/10 |
| Existing Implementation Coverage | 9/10 |
| Workflow Importance | 7/10 |
| Discoverability Impact | 4/10 |
| Implementation Effort | 5/10 |
| Confidence | 9/10 |

### Resolution

**Status: RESOLVED — all three steps**

**Implemented:** the run dispatch resolves `conversationConnectorIds` — `agent.connectors ∩
enabled`, honouring the store's absent-row-means-yes rule — and that **one narrowed list** is the
input to every place a connector reaches a run:

| Consumer | Was | Is |
|---|---|---|
| Credentials (`connectorRunEnv`) | `agent.connectors` | `activeConnectors` |
| Optional env names (`optionalEnv`) | `agent.connectors` | `activeConnectors` |
| Egress allowlist (`buildRunEgress`) | `agent.connectors` | `activeConnectors` |
| The runtime's tools | — | `JAROKU_CONNECTORS`, the same sentinel scheme as `JAROKU_MCP_SERVERS` |

One list feeding all four, and not four reads of `agent.connectors`, because four reads are four
chances to forget one — which is exactly how this shipped: the decisions *were* read, and applied
to one of the three kinds of row the deck offers.

**Step 3 landed in the templates rather than in `tools/__init__.py`,** and that is a better answer
than the finding's. `tools/__init__.py` is written by the model per agent, so filtering there would
reach only agents generated after this release and would leave every existing one enforcing
nothing. The connector templates are **host-owned, reviewed, and copied byte-for-byte into every
project** — including projects already generated — so `require_enabled(id, label)` in
`tool_templates/__init__.py`, consulted by all six templates, enforces on agents that exist today.

Its value is the *sentence*. The host already declines to mint the credential, so a disabled
connector's tool would fail regardless — with *"Gmail is not configured"*, which sends somebody to
the Connections panel to repair a credential that is perfectly fine. *"Switched off for this
conversation"* is a different problem with a different fix, one tile away. It **raises** rather
than returning, which is the rule `check_failures_raise` exists to hold: LangChain records a
returned string as a *successful* tool call, so returning would draw a green step whose content
happened to be a refusal.

**Files Changed:**

- `server/src/index.ts` — `conversationConnectorIds`, `activeConnectors`, `JAROKU_CONNECTORS`
- `runtime/tool_templates/__init__.py` — `require_enabled`
- `runtime/tool_templates/{gmail,google_calendar,slack,postgres,http_connector,stripe_connector}.py`
- `server/src/connectorLoop.test.ts` — section 9

**Verification:**

`test:connector-loop` is the right home and its header says why: every other connector suite tests
one seam and passes with the seam either side of it broken, which is exactly how `HTTP_AUTH_HEADER`
survived three green suites over a value that did nothing. Section 9 holds all three consumers at
once — the disabled connector's host is off the egress allowlist while the others keep theirs, its
credential names are not among those the run resolves, and the guard exists, raises, treats an
absent variable as no restriction and `-` as nothing-allowed. All six templates are asserted to
import and consult it, and the dispatch is read as text: one narrowed list, used by the credentials,
the egress and the runtime variable.

`test:connector-catalog`'s `check_failures_raise()` passes with the guard in place, which is the
assertion that matters most on the Python side.

**Regression Coverage:**

`test:connector-loop`, `test:connector-catalog`, `test:connector-gcal`, `test:connector-stripe`,
`test:connector-http`, `test:connector-secrets`, `test:connector-auth`, `test:egress-connectors`
and `test:egress-policy` all pass; the server typechecks. The MCP half is untouched and still
works: `JAROKU_MCP_SERVERS` is built exactly as it was, and the new variable sits beside it under
the same `decisions.size > 0` guard, so a conversation nobody has scoped runs precisely as it did.

**Known, and unchanged:** the second-order effect the finding notes — disabling *any* connector
makes `decisions.size > 0` and switches the MCP allowlist on — still holds, and is still harmless.
It is now symmetric rather than surprising: both allowlists arm together.

**Resolved On:** 2026-08-26

---

## GAP-007 — `runnable` is derived from the local filesystem, never from the version manifest

**Priority:** P1
**Category:** INTEGRATION_GAP · STATE_MACHINE_GAP
**Opportunity Score:** 34
**Confidence:** 9/10
**Tags:** `[BACKEND_EXISTS]` `[MISSING_INTEGRATION]` `[MISSING_STATE]`

### What Already Exists

The object store is authoritative for an agent's source (ADR-031, ADR-032), and `agentFiles.ts`
is explicit that the shared directory is *not* a valid fallback for a workspace's own agent. A
one-way boot bridge imports disk → objects (`index.ts:1868-1892`).

`AgentSummary.runnable` gates the composer's Run/Test control and produces the message a user
sees when they cannot run.

### Evidence

- `server/src/index.ts:3574-3577` — the comment: *"`runnable` is still 'does this project have an agent.py', **which the version manifest answers for a published agent** and the disk answers for one somebody dropped in by hand."*
- `server/src/index.ts:3579,3596` — the code:
  ```ts
  const onDisk = new Map(scanAgentDirectory(RUNTIME_DIR).map((a) => [a.agent_id, a]));
  …
  runnable: onDisk.get(a.slug)?.runnable ?? false,
  ```
  **The manifest is never consulted.**
- `server/src/agents.ts:66` — `runnable: existsSync(join(dir, "agent.py"))`
- `server/src/index.ts:1868-1892` — `importAgentFiles()` is **disk → objects only**; there is no objects → disk direction at boot
- The only two writers of `runtime/agents/<slug>`: `generator.ts:365`, `editor.ts:636`
- **Empirical:** `runtime/agents/` holds 4 agent directories. The database holds **15 agents across 16 workspaces**. Every agent without a directory reports `runnable: false`.
- **Observed live:** *"an agent that takes a list of numbers and returns their mean copy can't run — it has no agent.py"*, with Send disabled

### Current User Path

Select an agent whose project exists in the object store but not on this box's disk — a fork, a
restore on another replica, a restored backup, any hosted deployment with an ephemeral
filesystem. The agent renders normally in the grid with its version history and file counts. The
composer refuses to run it, blaming a missing `agent.py` the user has no way to supply.

### Missing Connection

Three surfaces disagree about where an agent's code lives:

| Surface | Source |
|---|---|
| Code view, Graph, ⊕ picker, Export, workspace export | object store ✅ |
| `runnable`, local run, deploy | local filesystem ❌ |
| Boot import | disk → objects, one way |

Nothing materialises from the object store on demand.

### Complete Workflow

```text
Agent published to the object store              ← exists
    ↓
[MISSING CONNECTION: runnable = manifest contains agent.py]
    ↓
Composer offers Run/Test                          ← exists
    ↓
[MISSING CONNECTION: materialise on demand before spawning]
    ↓
Run executes the version the product says is live
```

### Why This Is A Real Gap

`agentFiles.ts` spends twenty lines arguing that the shared directory is not a valid source of
truth — and `runnable`, one of the highest-traffic booleans in the product, is derived from
exactly that directory. The comment above it describes the correct behaviour, so this is a
mismatch between intent and code rather than a design choice.

The message it produces is the worst kind: *"it has no `agent.py`"* is a statement about a
filesystem the user cannot see, on a product whose entire model is that the agent is a versioned
artifact in a store. There is no recovery action anywhere.

### Minimal Fix

Two independent halves:

1. **Derive the flag honestly.** `runnable` becomes `"agent.py" in version.manifest || onDisk?.runnable`. This is one line and fixes the *reporting* half immediately.
2. **Materialise on demand.** One helper — `ensureProjectDir(ctx, agent)` — that returns a
   directory, materialising from the object store when it is absent or when its version does not
   match `current_version`. Call it from the run dispatch, `planDeploy`, and the deploy upload.
   That also closes GAP-002 and the run half of GAP-001, and makes the local run path correct
   on a second gateway replica for the first time.

`test:agent-files` already runs both drivers and is the right home for "an agent published to the
object store with no directory is runnable".

### Related Existing Capabilities

The composer's Run/Test, `agentGraph` (which already materialises to a tmpdir on demand and is
the working proof of the pattern), deploy, `ProjectStore.materialise`, the Agents grid's
`runtime` tag.

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 8/10 |
| Existing Implementation Coverage | 8/10 |
| Workflow Importance | 8/10 |
| Discoverability Impact | 4/10 |
| Implementation Effort | 3/10 |
| Confidence | 9/10 |

### Resolution

**Status: RESOLVED — both halves**

**1. The flag is derived honestly.** `runnable` is now
`published.has(a.slug) || onDisk.get(a.slug)?.runnable`, where `published` comes from
`agentRepo.currentVersionHas(ctx, "agent.py")` — **one query for the whole workspace**, joining
`agents` to the row at `current_version` and testing the manifest's keys. The comment above the old
derivation already said this was the right answer; the code asked the disk both times.

A join and not a loop, and that constraint decided the shape: `test:agent-grid`'s load-bearing
assertion is that the statement count for one agent equals the count for forty, and a per-agent
manifest read would be an N+1 that is invisible in review and instantly visible in a real
workspace. The containment test is done in TypeScript over one result set rather than in
dialect-specific JSON SQL, since `manifest` is JSON on both drivers and the key set differs per row.

**The disk half stays**, and that is not caution — a hand-dropped project has no row and no version,
so the manifest cannot see it. Dropping the disk half would make *that* agent unrunnable, which is
a different regression wearing this fix's clothes.

**2. `ensureProjectDir` is the only way anything obtains a project directory.** Three surfaces read
`runtime/agents/<slug>` — the local spawn, `planDeploy`'s `agent.py` check, and the deploy upload —
and only `generator.ts:365` and `editor.ts:636` ever wrote it. It is now called before the run and
before **both** deploy commands: `planDeploy` and `deploy` are separate commands, and a deploy is
reachable without a plan (the Inbox's `retry_deploy`, the top bar, a second tab), so a directory the
plan brought up to date is not one the deploy may assume.

Three details:

- **A stamp, not a rewrite.** `.jaroku-version` holds the version the directory was last
  materialised at, so the common case is one short `readFileSync`. Re-materialising unconditionally
  would empty and rewrite the project on every run. The stamp is written *after* the files, so a
  crash mid-materialise leaves a mismatch and the next call redoes it — the same order
  `promoteVersion` uses. It is dot-prefixed, so `listProjectFiles` skips it and it cannot reach a
  deploy or a republish.
- **A hand-dropped project is left alone.** Nothing published means nothing to write, and
  materialising over it would delete the only copy.
- **Never fatal.** It returns the directory either way; a run's own "no agent.py" is a better
  answer than a dispatch refused for a reason nobody can see.

**This subsumes the durable half of GAP-002 and the run half of GAP-001**, and makes the local run
path correct on a second gateway replica for the first time.

**Files Changed:**

- `server/src/db/repositories/agents.ts` — `currentVersionHas`
- `server/src/index.ts` — the derivation, `ensureProjectDir`, three call sites
- `server/src/agentFiles.test.ts` — the assertions
- `.github/workflows/ci.yml` — `test:agent-files` added

**Verification:**

`test:agent-files` is the right home because it is the module that argues, at length, that the
shared directory is not a valid source of truth for a workspace's own agent — and `runnable` was
derived from exactly that directory. It holds: a published agent is runnable with **no local
directory**; a workspace with a row and no version is not, *even though the directory exists*
because another workspace materialised it there — which is precisely the case a disk-derived answer
gets wrong; a published version with no `agent.py` is not runnable; and the whole workspace costs
**one statement**, asserted by proxying the driver and counting. Plus the structural half: the
derivation reads the manifest first, `ensureProjectDir` exists, all three call sites use it, and it
compares a stamp.

**Regression Coverage:**

`test:agent-files`, `test:agent-grid`, `test:agent-health`, `test:agent-adversarial`,
`test:project-store`, `test:db` and `test:driver` all pass; the server typechecks. The tenancy
assertions in `test:agent-files` are unchanged — B still cannot read A's materialised directory,
and the new manifest read is scoped through `agents.workspace_id` like every other statement in
that repository.

**Resolved On:** 2026-08-26

---

## GAP-008 — Eight Inbox actions render controls that do nothing

**Priority:** P1
**Category:** UI_DEAD_END · ACTIONABILITY_GAP
**Opportunity Score:** 35
**Confidence:** 10/10
**Tags:** `[UI_EXISTS]` `[BACKEND_EXISTS]` `[DEAD_END]` `[NO_CALLER]`

### What Already Exists

The Inbox registry declares each item type's actions in priority order; the client renders the
first as the card's primary icon button and the rest in the overflow, filtered by capability
through `ACTION_COMMAND`. `runAction` is the single dispatcher. Eighteen of the twenty-nine
action names have a case; three more (`set_secret`, `set_mcp_credential`, `raise_ceiling`) are
handled by `InlineForm`; `dismiss` is the `×`.

### Evidence

- `client/src/components/InboxActions.tsx:161-270` — `runAction()`; the `default:` branch returns `false`
- `client/src/components/InboxCardActions.tsx:266` — `onClick={() => runAction(primary, item)}` — **the return value is discarded**
- `client/src/components/InboxCardActions.tsx:208-209` — overflow: `runAction(action, item); onClose();` — the menu closes either way, so a no-op looks like a success
- `client/src/types.ts:2154-2162` — the 29-name `InboxActionName` union

**The eight with no case, and the card types that offer them** (`server/src/inbox/registry.ts`):

| Action | Offered by | Position | Command that exists and is not called |
|---|---|---|---|
| `enable_gate` | `ungated_high_impact` (578) | **primary** | `setMcpToolImpact` |
| `view_evidence` | `memory_proposal` (558) | **primary** | — (expansion) |
| `save_memory` | `memory_proposal` (558) | overflow | `noteMemoryDecision` |
| `reject_memory` | `memory_proposal` (558) | overflow | `noteMemoryDecision` |
| `cancel_deploy` | `deploy_failed` (407) | overflow | `sendCancelDeploy` |
| `remove_server` | `mcp_auth_required` (389), `mcp_unreachable` (517) | overflow | `sendRemoveMcpServer` |
| `view_all_failures` | `unreviewed_failures` (455) | overflow | — |
| `dismiss_all` | `unreviewed_failures` (455) | overflow | `sendBulkInboxAction` |

### Current User Path

A card appears with an icon button whose tooltip reads *"Turn the confirmation gate on"* or
*"View the evidence"*. Pressing it does nothing at all — no state change, no toast, no error.
Opening the kebab and choosing *"Save this"* or *"Remove the grant"* closes the menu, which reads
as confirmation.

### Missing Connection

Six of the eight have a working command one import away — `sendCancelDeploy` and
`sendRemoveMcpServer` are called by the Deploy and MCP panels; `sendBulkInboxAction` is called by
`useInboxKeys`. `runAction` simply has no case for them.

`view_evidence` is the sharpest instance: the card already expands its evidence on click
(`InboxCard.tsx:219`), but `IconButton` calls `e.stopPropagation()` — so pressing the button that
says "View the evidence" **prevents** the expansion that would have shown it. Clicking anywhere
else on the card works better than clicking its primary control.

### Complete Workflow

```text
Registry declares the card's actions              ← exists
    ↓
Client filters by capability, renders primary     ← exists
    ↓
User presses it
    ↓
[MISSING CONNECTION: a case in runAction]
    ↓
The existing command runs                         ← exists for 6 of the 8
    ↓
The sweep resolves the card                       ← exists
```

### Why This Is A Real Gap

The Inbox's stated design goal is *"a user should be able to clear an entire Inbox without
leaving the Inbox."* Two card types — `memory_proposal` and `ungated_high_impact` — have a **dead
primary action**, so the most prominent control on the card is the one that does nothing. A
silent no-op is the worst failure shape here, because the surrounding design (a menu that closes,
a sweep that resolves cards on its own schedule) makes "nothing visible happened" indistinguishable
from "it worked and the board will catch up."

The comment above `ACTION_COMMAND` argues that an unmapped name should fail loudly — *"an unmapped
name answers `undefined`, which `canRun` refuses, so the affordance is absent until somebody
decides who may use it."* That reasoning is sound but guards the wrong table: `ACTION_COMMAND` is
the *capability* map, and an action absent from it is treated as ungated-and-allowed. The
**dispatch** table has no such backstop.

### Minimal Fix

Add the six cases that have commands, and make the missing-case branch impossible to ship:

```ts
case "cancel_deploy":  sendCancelDeploy(item.subject_id ?? ""); return true;
case "remove_server":  sendRemoveMcpServer(item.subject_id ?? ""); return true;
case "dismiss_all":    sendBulkInboxAction("dismiss", item.type); return true;
case "enable_gate":    /* setMcpToolImpact over the card's tools */ return true;
case "view_evidence":  /* expand rather than stopPropagation */ return true;
case "save_memory":
case "reject_memory":  /* GAP-012 */ return true;
```

Then type the switch exhaustively (`const _never: never = action`) so a new `InboxActionName`
fails the client typecheck rather than shipping as a dead glyph — which is the same structural
audit `test:channels` and `test:reset` already apply on the server side. `view_all_failures`
needs a destination decision (a filtered run list) and can stay absent from the registry until it
has one.

### Related Existing Capabilities

`cancelDeploy`, `removeMcpServer`, `bulkInboxAction`, `setMcpToolImpact`, the inbox undo toast,
the derived-resolution sweep.

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 7/10 |
| Existing Implementation Coverage | 8/10 |
| Workflow Importance | 7/10 |
| Discoverability Impact | 6/10 |
| Implementation Effort | 3/10 |
| Confidence | 10/10 |

### Resolution

**Status: RESOLVED**

**Implemented:** each of the eight was traced to whether a command exists, whether the action is
implementable as declared, and whether it is stale — which is what the brief's §3 asks for, and the
eight do not have one answer between them.

| Action | Answer |
|---|---|
| `cancel_deploy` | `sendCancelDeploy` — the Deploy panel's own command |
| `remove_server` | `sendRemoveMcpServer` — the MCP panel's own command |
| `dismiss_all` | `sendBulkInboxAction("dismiss", ids)` over every card of that type |
| `view_evidence` | expands the card, which is what it always said it did |
| `enable_gate` | **relabelled and repointed** — no command can do what it claimed |
| `view_all_failures` | **removed from the registry** — it had no destination |
| `save_memory`, `reject_memory` | **declared unimplemented and not rendered** — GAP-012 |

Three of those need their reasoning kept:

**`enable_gate` was a promise no command could keep.** The gate is off because a line in the
agent's *own generated source* turned it off — `os.environ["JAROKU_MCP_CONFIRM"] = "skip"`, which is
what `disablesConfirmGate` detects — so nothing on a card can put it back; only an edit to that file
can. It now navigates to the agent, labelled *"Open the code that turns it off"*. Renaming it is the
fix rather than a retreat from one: the old label is why it read as a broken button instead of as a
link, and §4.5 is explicit that navigation is a legitimate fallback — what it must not do is look
like an inline one. It left `INLINE_ACTIONS` and `ACTION_COMMAND` accordingly.

**`view_all_failures` is gone from both unions.** There is no filtered run list in the product to
send anybody to. `open_latest_failure` opens the trace (which is what resolves the card) and
`dismiss_all` clears the type; the entry comes back when a failure list does.

**`save_memory` / `reject_memory` are declared, not silently absent.** `UNIMPLEMENTED_ACTIONS` is
read by `useAllowedActions`, so they are *not rendered* — the card falls through to its next-best
action exactly as it does for a capability the role lacks. An unfinished action is now invisible
rather than dead.

**And two structural fixes underneath, which are the actual root cause:**

1. **The switch is exhaustive** — `const _never: never = action`. A new `InboxActionName` fails the
   client typecheck rather than shipping as a dead glyph. `ACTION_COMMAND`'s own comment argues an
   unmapped name should fail loudly and is right, but it guards the *capability* table; the
   **dispatch** table had no backstop at all.
2. **The return value is read.** `InboxCardActions` discarded it at both call sites, so a menu that
   closed was the only feedback either way. `false` now leaves the overflow open and puts a message
   on the board's error strip — a card missing what a command needs is a different thing from a
   command that failed, and neither should look like success.

Two entries were also missing from `ACTION_COMMAND`, which was the more dangerous half: a name
absent from that map is treated as **ungated-and-allowed**, so cancelling a deployment and removing
an MCP server were offered to every member and happened to be harmless only because they did
nothing. Both are now gated as their own panels are.

**Files Changed:**

- `client/src/components/InboxActions.tsx` — five new cases, the exhaustiveness check, `UNIMPLEMENTED_ACTIONS`, two `ACTION_COMMAND` entries, the `enable_gate` relabel
- `client/src/components/InboxCardActions.tsx` — both call sites read the answer
- `client/src/store/inboxStore.ts` — `expandedId` / `setExpanded`
- `client/src/components/InboxView.tsx` — reads the expansion from the store
- `client/src/lib/inboxBoard.test.ts` — the cross-language audit
- `server/src/inbox/registry.ts`, `client/src/types.ts`, `client/src/components/inboxActionIcons.tsx` — `view_all_failures` removed

**Verification:**

`test:inbox-board` reads `registry.ts` as text — the same shape `test:permission-ui` uses against
`capabilities.ts` — and holds four claims a typecheck cannot: every action the server can offer has
a client entry, the client names none the server cannot, **every name has a case in `runAction`**,
and `view_all_failures` is offered by nothing. It read 29 names and cleared all of them. The
exhaustiveness check proved itself during implementation: it failed the build naming
`set_secret | set_mcp_credential | raise_ceiling | view_all_failures`, which is exactly the class of
omission that shipped.

**Regression Coverage:**

All eight server inbox suites pass, plus `test:inbox-board`, `test:reset` and `test:dead-controls`;
both sides typecheck. The `expandedId` move keeps its one-at-a-time rule and the keyboard's
`toggleExpand`; it is inside `inboxStore`, which `test:reset` already requires to be cleared on a
workspace switch — an expanded id naming a row from another workspace is exactly the leak that suite
exists for.

**Resolved On:** 2026-08-26

---

## GAP-009 — The upsell card names a plan that does not unlock what was refused

**Priority:** P1
**Category:** BILLING_GAP · PERMISSION_GAP
**Opportunity Score:** 38
**Confidence:** 10/10
**Tags:** `[BACKEND_EXISTS]` `[UI_EXISTS]` `[MISSING_ENTITLEMENT]` `[MISSING_CONNECTION]`

### What Already Exists

The entitlement loop is otherwise complete and unusually careful: the server refuses with a
structured payload carrying `tier`, `kind`, `current`, `limit`; `socket.ts:82-99` lifts it off
any channel; `UpsellCard` shows a meter for a quota and no meter for a feature gate ("a bar
sitting at 0/0 reads as something that fills up again next month"); the card is inline rather than
modal; the promise that nothing is destroyed is stated at the moment of refusal.

### Evidence

- `client/src/components/UpsellCard.tsx:58-60`:
  ```ts
  /** Free's next step is Pro, and a paid tier's is Team — the same rule the server's URL carries. */
  function nextTier(tier: string): string { return tier === "free" ? "Pro" : "Team"; }
  ```
- `client/src/components/UpsellCard.tsx:98-101, 107` — `nextTier` drives **both** the sentence and the button label, for **both** refusal kinds
- `server/src/billing/plans.ts:235` — **Pro** `features: { ...FREE.features, githubPhase1: true, approvalBatchApprove: true }`
- `server/src/billing/plans.ts:270-273` — **Team** adds `githubPhase2`, `perAgentAccessGrants`, `policyEngine`, `evalCiGate`
- `server/src/billing/plans.ts:222` + `entitlements.ts:119` — **Pro `seats: 1`**, and `maxMembers = p.seats ?? 20` → Free 1, **Pro 1**, Team 20. `plans.ts:216-221` names this openly: *"the only place in this file where a paid plan does not beat the one below it on an axis."*

### Current User Path — three wrong answers on Free

| Refusal on Free | Card says | Truth |
|---|---|---|
| `githubPhase2` (GitHub sync) | "GitHub sync is not part of this plan · **Pro** turns this on" · `[ See Pro ]` | Team-only |
| `perAgentAccessGrants` (Access grants) | "Per-agent access is not part of this plan · **Pro** turns this on" · `[ See Pro ]` | Team-only |
| `members` (invite a second person) | "This plan is single-user · **Pro** raises this limit" · `[ See Pro ]` | Pro is also single-user |

### Missing Connection

`nextTier` is a two-branch heuristic standing in for a lookup the client already has the data
for. `LIMIT_LABEL` in the same file maps every gate kind to a readable name, so the file knows
which kinds exist; it does not know which plan grants each. The server's `PLANS` table does, and
`usage.plans` — already delivered to `UsagePanel` — is the client's copy of it.

### Complete Workflow

```text
Capability → entitlement → refusal payload            ← exists
    ↓
Card explains what was refused, with a meter or not   ← exists
    ↓
[MISSING CONNECTION: which plan actually grants this kind]
    ↓
"Team turns this on"  ·  [ See Team ]
    ↓
Checkout for the right plan                            ← exists
    ↓
Capability unlocked
```

### Why This Is A Real Gap

This is the one card in the product whose entire job is *"here is how to unlock this,"* and for
three of its refusal kinds it names a plan that leaves the user refused identically — after
taking their money. The `members` case is the most likely to be hit (inviting a colleague is the
first thing a Free workspace tries) and the most damaging, because the user pays $20/month and
discovers Pro is single-user only when the invite refuses again.

The card's own copy makes the promise explicit — *"Pro turns this on"* — so this is a false
statement rather than a vague one.

### Minimal Fix

Add the minimum tier to the refusal payload server-side (the `PLANS` table already answers it),
or resolve it client-side from `billingStore`'s plan catalogue:

```ts
function unlockingTier(kind: string, plans: PlanView[]): string | null {
  return plans.find((p) => grants(p, kind))?.label ?? null;
}
```

and render `null` as "No plan currently includes this" rather than guessing. While there, drop
the three unbuilt flags from the pricing page (GAP-014) so no `kind` can resolve to a tier that
would not actually deliver it.

Worth pairing: the in-app plan list (`UsagePanel.tsx:356-390`) shows credits, ceiling, retention,
seats and deploys — and **no feature differences at all**, so a user who follows `[ See Pro ]`
cannot check the card's claim against anything.

### Related Existing Capabilities

`entitlementGate`, the plans table, Stripe checkout, the Usage panel's plan catalogue, every
tier-gated command.

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 8/10 |
| Existing Implementation Coverage | 9/10 |
| Workflow Importance | 6/10 |
| Discoverability Impact | 7/10 |
| Implementation Effort | 2/10 |
| Confidence | 10/10 |

### Resolution

**Status: RESOLVED**

**Implemented:**

`unlockingTier(field, from)` in `billing/entitlements.ts` — the cheapest plan above the current one
that would actually lift a refusal, resolved over `fromLimits(PLANS[id])`, which is the **same
projection `requireEntitlement` reads**. Asking each plan the question in the currency the refusal
was made in is what makes `members` come out as Team: Pro and Free differ there by a seat count
rather than by a flag, so a comparison over feature flags alone would have kept getting it wrong.

The comparison is `>` and never `>=`, which is the whole of the `members` case — Pro's seat count
*equals* Free's, and `>=` recommends it.

The refusal payload now carries `unlocks` and `unlocksLabel`, and three consumers read them
instead of guessing:

| Consumer | Was | Is |
|---|---|---|
| `upgradeUrl` | `tier === "free" ? "pro" : "team"` | the plan that works; no `to=` at all when none does |
| `UpsellCard` sentence + button | `nextTier(tier)` | `refusal.unlocksLabel`, absent button when null |
| `refusalMessage` | "upgrading turns it on" | names the plan, or says no plan includes it |

`nextTier` is deleted. A `null` renders as *"No plan currently includes this"* with **no upgrade
button at all** — absent rather than disabled, the same rule the Access tab is held to.

**Paired, as the finding suggested:** the in-app plan list showed credits, ceiling, retention,
seats and deploys and **no feature differences at all**, so the card's claim could not be checked
anywhere inside the product. Plans now carry `features` — a `FEATURE_LABELS` table of the flags
that actually gate something *and* actually differ between plans. `approvalBatchApprove`,
`policyEngine` and `evalCiGate` are deliberately absent from it: listing them on a billing panel
would repeat, for a paying customer, the exact mistake the pricing page made (GAP-014).

**Files Changed:**

- `server/src/billing/entitlements.ts` — `unlockingTier`, `grants`
- `server/src/billing/entitlementGate.ts` — `Unlocking` on both refusal shapes, `upgradeUrl`, `refusalMessage`
- `server/src/billing/plans.ts` — `FEATURE_LABELS`
- `server/src/index.ts` — `features` on the plan catalogue
- `server/src/billing/entitlements.test.ts` — the resolution assertions
- `client/src/store/entitlementStore.ts` — the fields, and `isRefusal`'s normalisation
- `client/src/components/UpsellCard.tsx` — reads the payload; `nextTier` deleted
- `client/src/components/UsagePanel.tsx`, `client/src/types.ts`, `client/src/lib/evalExport.test.ts`

**Verification:**

`test:entitlements` asserts the four kinds the old heuristic got **right** as well as the three it
got wrong — a lookup that fixed the failures by special-casing them would pass the wrong three
alone. Then: Free + `members` → Team, Free + `githubPhase2` → Team, Free + `perAgentAccessGrants`
→ Team, Team at twenty seats → `null` with a sentence that names no tier, and the URL following
the same answer in every case. `unlockingTier` is exercised directly against a flag, a strict
number, a becomes-unlimited, an already-unlimited, an ungated flag and an unrecognised tier.
`test:entitlement-store` holds the client guard: `unlocks` may be a string or `null`, never
anything else, and a refusal from a server that predates the fields is **admitted with them
normalised to null** rather than refused — its figures are still true and its meter is still the
answer.

**Regression Coverage:**

`test:plans`, `test:gate`, `test:entitlement-store` and `test:export` all pass; both typecheck.
The refusal's existing shape is unchanged — the asymmetry `test:entitlement-store` guards (a quota
refusal without figures is refused, a feature refusal without them is correct) still holds, and the
meter still renders only for a quota.

**Resolved On:** 2026-08-26

---

## GAP-010 — Response variants: a table, a store, a suite, a switcher — and no writer

**Priority:** P1
**Category:** ORPHANED_BACKEND · ORPHANED_UI · UI_DEAD_END
**Opportunity Score:** 31
**Confidence:** 10/10
**Tags:** `[BACKEND_EXISTS]` `[UI_EXISTS]` `[ORPHANED]` `[NO_CALLER]` `[DEAD_END]`

### What Already Exists

**Server:** migration 057 (`turn_variants`, both drivers, a unique `(workspace, turn, ordinal)`
index, a backfill), `TurnVariantStore` with `begin` / `finish` / `forTurn` / `forTurns`, a passing
suite (`test:turn-variants`), registration in export and retention with a written rationale.

**Client:** `TurnMeta.ordinal` / `.total`, `presentSlots` giving `variants` a fixed position in
§6.5's slot order, and a rendered `‹ n/m ›` switcher with prev/next controls.

**Regenerate** is on every assistant turn (`TurnActions` → `onRegenerate` / `onRegenerateWith`),
including a "regenerate with a different model" menu built from the three newest models.

### Evidence

- `server/src/turnVariants.ts:73` — `TurnVariantStore`. Instantiated in **`turnVariants.test.ts:40`** and **`turnInteraction.test.ts:69`** and nowhere else.
- `grep "variant_ordinal\|variant_total" server/src` → **no match**. The server never sends either field.
- `client/src/lib/turnSource.ts:110-111` — `ordinal: usage?.variant_ordinal ?? 1, total: usage?.variant_total ?? 1` — so `total` is always 1
- `client/src/lib/turnMetadata.ts:63` — `if (meta.total > 1) slots.add("variants")` — the slot can never be present
- `client/src/components/composer/TurnMetadata.tsx:40,47,150-162` — `onSwitchVariant` is an optional prop **never passed by any caller**; both arrows carry `disabled={… || !onSwitchVariant}`
- `client/src/components/BuildPane.tsx:354-366` — `rerunTurn()` calls `ui.setModel(...)` and `ui.prefillChat(prompt)` and **nothing else**
- `client/src/components/BuildPane.tsx:349-351` — the comment: *"The server writes a new `turn_variants` row beside the old one, so 'which model wrote this?' stays answerable for both."* No code does this.
- **Empirical:** `turn_variants` holds 8 rows. Every one has `ordinal: 1` and `model_id`, `provider`, `effort_requested`, `effort_applied`, `duration_ms`, `tokens_in`, `tokens_out`, `cost_usd`, `agent_version_id` all **null** — the signature of migration 057's backfill, which writes only `(id, workspace_id, turn_id, ordinal, created_at)`.

### Current User Path

Hover a Jaroku turn → the action row appears → **Regenerate** (or *Regenerate with Claude Opus 5*).
The old prompt is placed back in the composer and the model selector changes. Nothing is sent —
the user must find and press Send themselves. What arrives is an ordinary new turn appended to the
thread, not a variant of the old one. The `‹ n/m ›` switcher never appears, and would have both
arrows disabled if it did.

### Missing Connection

Three links, in order:

1. **Regenerate does not re-run** — it prefills. §5.4 says *"Re-runs the same user input with the
   current toolbar settings."*
2. **The dispatch never opens a variant** — `variants.begin(ctx, turnId, { modelId, provider, effortRequested, effortApplied })` has no production caller.
3. **The wire never carries the counts** — no payload sets `variant_ordinal` / `variant_total`, so the switcher is unreachable and `onSwitchVariant` has nobody to pass it.

### Complete Workflow

```text
Regenerate a turn
    ↓
[MISSING CONNECTION: dispatch instead of prefilling]
    ↓
variants.begin() opens ordinal 2                    ← exists, uncalled
    ↓
variants.finish() records model, effort, cost       ← exists, uncalled
    ↓
[MISSING CONNECTION: variant_ordinal/total on the usage payload]
    ↓
‹ 2/2 › switcher renders                            ← exists, unreachable
    ↓
[MISSING CONNECTION: onSwitchVariant]
    ↓
Compare two answers to the same prompt, each honestly labelled
```

### Why This Is A Real Gap

`turnVariants.ts`'s header states the invariant the feature exists for: *"Never overwrite variant
1's metadata with variant 2's… A store that updated a turn in place would answer that question
with whichever model ran LAST."* Today the product answers it by appending a second turn, so
"which model wrote this?" stays answerable — but the promised comparison affordance does not
exist, and the metadata row's slot for it is unreachable code.

`turn_notes`'s foreign key was deliberately placed on `thread_items` rather than `turn_variants`
so that "notes survive regeneration" — a property that currently has nothing to survive.

The severity is bounded by the fact that Regenerate is not *broken* so much as reduced to a
prefill: the user still gets a second answer, just as a separate turn with no way to switch
between them.

### Minimal Fix

Smallest honest step, in two parts:

1. **Make Regenerate re-run.** `rerunTurn` should dispatch the same command the original turn
   dispatched, rather than prefilling — the prompt and the intent are both already resolved
   (`promptForRegenerate`, `turnSource`).
2. **Open and close a variant around it.** Instantiate `TurnVariantStore` in `index.ts`, call
   `begin` at dispatch and `finish` at completion, and add `variant_ordinal` / `variant_total` to
   the usage payload from `forTurns`. The switcher and `onSwitchVariant` then have data and a
   caller.

If neither is imminent, the honest interim is to relabel the control — *"Send this again"* — and
delete the switcher, because a metadata slot that can never render is a promise in the type
system that the product does not keep. Either way, fix `BuildPane.tsx:349-351`, which currently
asserts behaviour that does not exist.

### Related Existing Capabilities

Turn metadata (model, effort, build, duration), turn notes and pins (which hang off the turn
specifically so a regeneration cannot take them), the model catalogue, `effort_requested` /
`effort_applied` (GAP-005 — the two features share a column and neither writes it).

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 6/10 |
| Existing Implementation Coverage | 9/10 |
| Workflow Importance | 6/10 |
| Discoverability Impact | 5/10 |
| Implementation Effort | 5/10 |
| Confidence | 10/10 |

---

## GAP-011 — An agent's MCP grants are fixed at generation and can never be changed

**Priority:** P2
**Category:** LIFECYCLE_GAP · ACTIONABILITY_GAP · BACKEND_NO_UI
**Opportunity Score:** 29
**Confidence:** 9/10
**Tags:** `[BACKEND_EXISTS]` `[UI_EXISTS]` `[NO_UI_ENTRY]` `[MISSING_RECOVERY]`

### What Already Exists

A full per-tool MCP grant model: `mcp_tools.json` is the manifest the bridge honours, tools are
granted per tool rather than per server, impact is classified with a ratchet, high-impact tools
stop for confirmation, and the agent detail's **Capabilities** tab renders every granted tool with
its impact, its stored reason, and an `unresolved` chip when its server has left the workspace.

The MCP panel can add, remove, re-discover and re-authenticate *servers*, and reclassify a tool's
impact workspace-wide.

### Evidence

- `server/src/wsRelay.ts:69-86, 90-99` — `mcpTools?: string[]` on `GenerateCommand` and `PlanAgentCommand` — the **only** inputs
- `server/src/generator.ts:352,470` — `mcp_tools: manifestRefs(manifest)` at creation
- `server/src/db/repositories/agents.ts:362-372` (`create`), `:399-423` (`upsertFromDisk`) — the only two writers of the column
- `server/src/projectFs.ts:78-81,143` — `mcp_tools.json` is `HOST_OWNED`, so the edit loop refuses to touch it
- `server/src/index.ts:10126-10128` — *"`mcp_tools.json` is a protected path precisely so that cannot happen"*
- `client/src/components/AgentTabs.tsx:118-150` — the Capabilities tab is **read-only**: no add, no remove
- No command in the 116-command surface changes an existing agent's `mcp_tools`

### Current User Path

Generate an agent with two MCP tools ticked. Later, remove that server from the MCP panel. The
agent's Capabilities tab now shows both refs with a red `unresolved` chip and the tooltip *"This
server is no longer in the workspace"* — a correctly surfaced broken state with no repair
anywhere. Wanting to *add* a tool means regenerating the agent from scratch.

### Missing Connection

There is no `setAgentTools` command, no repository method that updates `mcp_tools` on an existing
row, and the manifest file that would express it is protected from the one mechanism that edits an
agent's files.

### Complete Workflow

```text
Connect an MCP server, discover its tools           ← exists
    ↓
Grant specific tools at generation                  ← exists
    ↓
Capabilities tab shows what is granted              ← exists
    ↓
[MISSING CONNECTION: grant / revoke on an existing agent]
    ↓
mcpManifest rewrites mcp_tools.json                 ← exists
    ↓
The next run sees the new grant                     ← exists
```

### Why This Is A Real Gap

The strongest evidence is `forkAgent`'s own notice, which the user reads immediately after
forking: **"Forked to `…_copy`. Its MCP grants start empty."** That sentence is only sensible
advice if there is a way to fill them. There is not — so the notice tells a user to do something
the product cannot do, and the deliberate least-privilege decision behind it (README:951: *"the
whole MCP design rests on access being granted per tool"*) has no counterpart control.

The `unresolved` chip is the second: the product goes to the trouble of detecting and explaining a
grant that can no longer resolve, on a surface with no way to remove it.

This is P2 rather than P1 because a regeneration is a real, if expensive, workaround, and because
the immutability is *safe* in the direction that matters — no grant can widen without a
generation.

### Minimal Fix

One command, at `agent:write` with an MCP-server-scoped check, writing the column and re-emitting
the manifest through `mcpManifest.ts` (which already builds it), plus add/remove controls on the
Capabilities tab's existing list. `mcp_tools.json` stays host-owned — it is written by Jaroku, not
by a model, which is exactly what the block list is for.

Revocation alone would close the two concrete broken states (the `unresolved` chip and the fork's
empty grant) at roughly half the work.

### Related Existing Capabilities

The MCP registry, impact classification, the confirmation gate, the fork notice, the Capabilities
tab, `mcpManifest.ts`, the `ungated_high_impact` inbox card (whose `remove_grant` action
explicitly defers to "the agent's own capability list" — a surface that does not exist).

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 7/10 |
| Existing Implementation Coverage | 7/10 |
| Workflow Importance | 7/10 |
| Discoverability Impact | 5/10 |
| Implementation Effort | 6/10 |
| Confidence | 9/10 |

---

## GAP-012 — `memory_proposal` is generated, cannot be answered, and would be consumed by nothing

**Priority:** P2
**Category:** UI_DEAD_END · ORPHANED_BACKEND · PARTIAL_WORKFLOW
**Opportunity Score:** 25
**Confidence:** 9/10
**Tags:** `[BACKEND_EXISTS]` `[UI_EXISTS]` `[NO_CALLER]` `[DEAD_END]` `[ORPHANED]`

### What Already Exists

A three-legged derivation (a failure, an edit, a subsequent pass) that produces a proposal card
carrying all three evidence ids; a registry entry with `severity: "proposal"`, an icon, a subject
line, and a resolve predicate; `InboxEvidence.tsx:146` renders its evidence block; icons exist for
it. `noteMemoryDecision` writes the decision that resolves it.

### Evidence

- `server/src/inbox/generators.ts:307-338` — `noteMemoryProposal()` · **called** at `index.ts:9302`
- `server/src/inbox/generators.ts:353-370` — `noteMemoryDecision()` · called **only** in `generators.test.ts:317`
- `server/src/inbox/registry.ts:549-568` — `actions: ["view_evidence", "save_memory", "reject_memory"]`, `resolved: (item) => decision === "saved" || decision === "rejected"`
- `client/src/components/InboxActions.tsx:161-270` — **no case for any of the three** (see GAP-008)
- No inbox command carries a decision: `resolveInboxItem`, `dismissInboxItem`, `snoozeInboxItem`, `undoInboxAction`, `bulkInboxAction`
- `server/src/inbox/generators.ts:302-305` claims *"the injection into planner, generator and editor prompts is attributable back to this item."* `grep -i memory server/src/{planner,generator,editor,prompt}.ts` → **no such injection exists**
- There is no memory table in the schema (65 tables enumerated)

### Current User Path

A card appears under **Proposals**: *"Jaroku learned something about API Gateway."* Its primary
control is an icon labelled *"View the evidence"* — which does nothing, and, because `IconButton`
stops propagation, also prevents the card expansion that *would* have shown the evidence. The
overflow offers *"Save this"* and *"Reject this"*; both close the menu and change nothing. The
card's resolve predicate requires a `decision` field nothing writes, so it can only ever be
cleared by the generic *"Mark as done"* or by snoozing it.

### Missing Connection

Three, stacked: no client case → no command → no consumer for a saved memory even if one were
recorded. The type has `origin: "event"` and is deliberately excluded from derived resolution —
*"there is no external world in which a proposal becomes answered"* — which makes the missing
action the **only** way it can ever settle.

### Complete Workflow

```text
Failure → edit → pass detected                    ← exists
    ↓
Proposal card recorded and rendered               ← exists
    ↓
[MISSING CONNECTION: an action that carries a decision]
    ↓
noteMemoryDecision writes payload.decision        ← exists, uncalled
    ↓
Predicate resolves the card                       ← exists
    ↓
[MISSING CONNECTION: a store for saved memories]
    ↓
[MISSING CONNECTION: injection into planner / generator / editor prompts]
    ↓
The next edit does not repeat the mistake
```

### Why This Is A Real Gap

This is the one card type in the Inbox whose **primary** control is dead **and** whose resolve
condition is unreachable — a card the surface's own promise ("clear the board without leaving it")
cannot clear. It is also the only place in the product where a comment describes a consumer that
does not exist, which is worth correcting on its own: a future reader will go looking for the
prompt injection.

P2 rather than P1 because the card is derived and rare (it needs a failure, an edit, and a pass in
sequence), and because "Mark as done" does clear it.

### Minimal Fix

Two honest options, and the second is defensible:

1. **Complete the answer half.** Add `resolveInboxItem`-style commands carrying `decision:
   "saved" | "rejected"` reaching `noteMemoryDecision`, wire the two actions in `runAction`, and
   fix `view_evidence` to expand rather than swallow the click. This makes the card clearable and
   the record honest, without building a memory store.
2. **Withdraw it.** Stop generating the type until there is something that consumes a saved
   memory, and correct `generators.ts:302-305`. A proposal whose acceptance changes nothing is a
   question the product cannot act on.

Either is better than the current state. Option 1 is roughly a day and keeps the evidence trail,
which is the genuinely valuable part.

### Related Existing Capabilities

The Inbox board, `InboxEvidence`, the failure/edit/pass correlation, the undo toast,
`unreviewed_failures` (the neighbouring derived card, which works).

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 5/10 |
| Existing Implementation Coverage | 7/10 |
| Workflow Importance | 5/10 |
| Discoverability Impact | 5/10 |
| Implementation Effort | 6/10 |
| Confidence | 9/10 |

---

## GAP-013 — External pull requests are told a collaborator can approve real providers; nothing can

**Priority:** P2
**Category:** BACKEND_NO_UI · STATE_MACHINE_GAP · ORPHANED_BACKEND
**Opportunity Score:** 29
**Confidence:** 9/10
**Tags:** `[BACKEND_EXISTS]` `[NO_UI_ENTRY]` `[NO_CALLER]` `[MISSING_STATE]` `[ORPHANED]`

### What Already Exists

Eval-as-CI: `agent_ci_config` (writable since v0.3.0), `checkRunner`, `check_runs`,
`checkPolicy` with a three-position policy, a GitHub Check Run posted at queue time carrying its
own mode explanation, and a fork-PR safety default of the free dry-run provider.

### Evidence

- `server/src/checkPolicy.ts:69-87` — `providerModeFor(facts)`: `if (facts.approvedForThisSha) return "paid"`
- `server/src/checkPolicy.ts:98-100` — `offersApproval(facts)` · **no caller anywhere outside `checkPolicy.test.ts`**
- `server/src/db/repositories/checks.ts:398-406` — `approvedForSha()` is true **only** if a `check_runs` row with `provider_mode = 'paid'` already exists for that sha
- `server/src/checkPolicy.ts:115` — the sentence: *"this pull request is from outside the repository, so it runs on the free dry-run provider — **a collaborator can approve real providers for this commit**"*
- `server/src/checkRunner.ts:157` — `summary: modeReason(facts)` — posted to GitHub on **every** external PR
- No command, route, webhook branch or UI control sets the approval

### Current User Path

A contributor opens a pull request from a fork. Jaroku posts a Check Run whose summary tells
whoever reads it that a collaborator can approve real providers for this commit. No such control
exists — not in the GitHub panel, not on the check, not as a slash command, not as a webhook
branch. The maintainer goes looking for it and finds nothing.

### Missing Connection

The state is **unreachable by construction**, not merely un-surfaced:

```text
approvedForSha(sha) == true
    ⇐ a paid check_runs row exists for sha
    ⇐ providerModeFor returned "paid"
    ⇐ approvedForSha(sha) == true
```

`offersApproval` exists precisely to decide when the control should appear — it is the missing
control's own precondition, written and never called.

### Complete Workflow

```text
Fork PR opens → check queued on the dry-run provider    ← exists
    ↓
Summary says a collaborator can approve                  ← exists (and is false)
    ↓
[MISSING CONNECTION: offersApproval gates a rendered control]
    ↓
[MISSING CONNECTION: a write that records the approval for this sha]
    ↓
Re-run → providerModeFor returns "paid"                  ← exists
    ↓
Real-provider legs run, spending the workspace's balance ← exists
```

### Why This Is A Real Gap

The whole point of the mode explanation is that *"the person reading a pass rate on a pull request
is usually not the person who configured the agent."* That person is now told to do something
impossible, on a surface outside the product where they cannot ask anyone. The comment above
`offersApproval` names the exact hazard this creates — *"a button that does nothing… teaches people
that the control is decorative"* — and the sentence achieves the same effect without a button.

Bounded severity: the safe default holds, and no money is spent by accident. What is lost is the
capability itself and the credibility of the message.

### Minimal Fix

Cheapest correct step: **stop promising it.** `modeReason`'s last branch becomes *"this pull
request is from outside the repository, so it runs on the free dry-run provider"* — one line, and
`test:check-policy` already covers that function.

To deliver it instead: a GitHub Check Run **requested action** (`actions: [{ label: "Run with real
providers", identifier: "approve_sha" }]`) gated on `offersApproval`, plus a
`check_run.requested_action` branch in the webhook that verifies the actor's write permission and
re-runs with `providerMode: "paid"`. That is the smallest design that keeps the approval where the
person already is and keeps `approvedForSha`'s derived-from-the-rows discipline intact.

### Related Existing Capabilities

`agent_ci_config`, the Checks region in the GitHub panel, the eval engine, the budget gate,
`check_runs`, `shadow_runs`.

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 5/10 |
| Existing Implementation Coverage | 8/10 |
| Workflow Importance | 5/10 |
| Discoverability Impact | 6/10 |
| Implementation Effort | 4/10 |
| Confidence | 9/10 |

---

## GAP-014 — The pricing page sells three capabilities the product does not have

**Priority:** P2
**Category:** BILLING_GAP
**Opportunity Score:** 30
**Confidence:** 10/10
**Tags:** `[MISSING_ENTITLEMENT]` `[ORPHANED]`

### What Already Exists

Three flags on `TierEntitlements`, present in the plan table, sold on the public pricing page —
and gating nothing. `entitlementGate.ts` records this openly and gives the right reason for the
order of work.

### Evidence

- `web/pricing.html:179-181`:
  ```html
  <tr><th scope="row">Batch approvals</th>   <td>—</td><td>Yes</td><td>Yes</td></tr>
  <tr><th scope="row">Policy engine</th>     <td>—</td><td>—</td><td>Yes</td></tr>
  <tr><th scope="row">Evals as a CI gate</th><td>—</td><td>—</td><td>Yes</td></tr>
  ```
- `server/src/billing/entitlementGate.ts:36-44` — *"`approvalBatchApprove`, `policyEngine` and `evalCiGate` are tier flags… they appear in no row of the table below because the surfaces they gate — the Approval System, the Policy Engine, an eval that can fail a pull request — are other specifications and **are not built**."*
- `EntitlementKind` (`entitlementGate.ts:50-60`) contains no member for any of the three
- `grep` across `server/src` and `client/src`: the three names appear **only** in `plans.ts`, `entitlements.ts` and that comment

### Current User Path

A prospective customer reads the comparison table, sees three named features on Pro/Team, and
pays. Nothing in the product mentions them again — the in-app plan list
(`UsagePanel.tsx:356-390`) shows only credits, ceiling, retention, seats and deploys, so there is
no second surface where the absence would be noticed either.

### Missing Connection

The engineering decision (declare the flag, wire it when the surface lands) is correct and is the
same order `perAgentAccessGrants` followed successfully through v0.3.4 → v0.3.8. The gap is that
the **marketing** surface shipped ahead of the flag rather than behind it.

### Complete Workflow

```text
Feature flag declared in the plan table          ← exists
    ↓
[MISSING: the surface it gates]
    ↓
[MISSING: an EntitlementKind and a gate]
    ↓
Pricing page advertises it                       ← EXISTS, AHEAD OF BOTH
```

### Why This Is A Real Gap

It is the only commercial claim in the repository that the code contradicts, the codebase already
knows it, and the fix is three deleted lines. It also compounds GAP-009: `nextTier` could
plausibly be "corrected" to resolve a tier from the flag table, and would then confidently sell
Team for a Policy Engine that does not exist.

### Minimal Fix

Remove the three rows from `web/pricing.html`, or mark them explicitly as planned with a date.
Keep the flags — the declaration order is right. Consider a small gate in `test:plans` asserting
that every feature row named in `pricing.html` has a corresponding `EntitlementKind`, which is the
kind of structural audit this codebase already applies to channels and stores.

### Related Existing Capabilities

`TierEntitlements`, `entitlementGate`, the plans table, Stripe checkout, the upsell card (GAP-009).

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 7/10 |
| Existing Implementation Coverage | 3/10 |
| Workflow Importance | 4/10 |
| Discoverability Impact | 7/10 |
| Implementation Effort | 1/10 |
| Confidence | 10/10 |

### Resolution

**Status: RESOLVED**

**Implemented:**

The three rows are gone from `web/pricing.html`. The flags stay on `TierEntitlements` and in the
plan table — the declaration order is right, and `perAgentAccessGrants` is the proof it works:
declared in v0.3.4, sold, wired in v0.3.8 when the Access tab landed, at which point its row here
became true. What was wrong was that the marketing shipped *ahead* of the flag rather than behind
it, and a prospective customer has no way to tell which side of that a row is on.

The deleted rows are replaced by a comment saying why, so the next reader does not restore them.

**And a gate, so it cannot happen again.** `test:checkout-surfaces` now reads the Features group
out of `pricing.html` and requires every row to map to a member of `EntitlementKind`. The gate is
against `EntitlementKind` and deliberately **not** against `PlanFeatures`: a flag on `PlanFeatures`
is a *declaration*, while a member of `EntitlementKind` is a check somebody can actually be refused
by — which is what makes a row on that page a thing the customer receives. The three removed names
are also asserted absent individually, because their absence is the fix and a regression would
restore them one at a time.

**Files Changed:**

- `web/pricing.html` — three rows removed, with the reason left in place
- `server/src/billing/checkoutSurfaces.test.ts` — the structural gate

**Verification:**

`test:checkout-surfaces` passes: it reads ten entitlement kinds out of `entitlementGate.ts`, finds
the three features the page still sells, and confirms each maps to a check. It caught its own bug
while being written — a `[A-Za-z]` character class dropped `githubPhase1` and `githubPhase2`,
which are the two rows the audit is most about, so the check would have passed over exactly what it
exists to verify. Fixed to `[A-Za-z0-9]` with the reason recorded beside it.

**Regression Coverage:**

The suite's existing rules are untouched and still pass: no script, no form, no Stripe, every CTA a
download or a mailto, all three tier cards present. This also removes GAP-009's compounding risk —
`unlockingTier` resolves from the flag table, so had `policyEngine` stayed on the page it would now
confidently recommend Team for a capability that does not exist.

**Resolved On:** 2026-08-26

---

## GAP-015 — The Graph tab's error detail is truncated down to a bare filename

**Priority:** P2
**Category:** MISSING_FEEDBACK
**Opportunity Score:** 31
**Confidence:** 10/10
**Tags:** `[UI_EXISTS]` `[MISSING_FEEDBACK]`

### What Already Exists

`agentGraph` is the one read path that handles a missing object **correctly** — it catches and
returns `{ agent_id, error: "could not read this agent's files: …" }` (contrast GAP-003), and
`GraphView` renders it in a dedicated empty state.

`Truncate variant="path"` is a genuinely good component: it collapses a path's middle, keeps the
filename whole, preserves the extension, and puts the full string in `title`.

### Evidence

- `client/src/components/GraphView.tsx:890-895`:
  ```tsx
  // THE PATH IS NOT PROSE. This branch rendered the server's raw message as centred sans text —
  // which for the common failure is a 120-character object-store key… One muted sentence, and the
  // key itself set in mono and middle-truncated…
  if (graph?.error) return <Empty title="No graph for this version yet" detail={graph.error} />;
  ```
- `client/src/components/GraphView.tsx:965-983` — `Empty` passes the **whole message** through `<Truncate variant="path">`
- `client/src/lib/truncatePath.ts:10-32` — the path truncator keeps the **last segment** and collapses everything before it
- **Captured live from the DOM:**
  ```
  title: "could not read this agent's files: no such object:
          ws/febc43c9-…/agents/63ae8f83-…/v2/.env.example"
  shown: ".env.example"
  ```

### Current User Path

Open the Graph tab on a forked agent. It reads:

> **No graph for this version yet**
> `.env.example`

The user is looking at a filename with no verb, no cause, and no relationship to the heading —
which reads as though `.env.example` is somehow responsible for the graph. The real sentence
exists and is one hover away, which is unreachable on touch and undiscoverable anywhere.

### Missing Connection

The comment describes exactly the right design — *"One muted sentence, and the key itself set in
mono and middle-truncated"* — two elements, a sentence and a key. The implementation has one
element and feeds the sentence to the path truncator, which is built to throw away everything
before the last `/`.

### Complete Workflow

```text
Server catches the read failure and explains it    ← exists (and is the good example)
    ↓
Client receives { error }                          ← exists
    ↓
[MISSING CONNECTION: split the sentence from the key]
    ↓
Sentence rendered as prose · key middle-truncated in mono
    ↓
The user can tell what went wrong
```

### Why This Is A Real Gap

The one error path in this product that is fully wired end to end delivers **less** information
than a raw string dump would. It is also the first place a user meets GAP-001, so it is the
diagnosis that fails at the moment it is needed most. The fix is small and the intent is already
written down.

### Minimal Fix

Give `Empty` two props and split at the last `": "`:

```tsx
const at = detail.lastIndexOf(": ");
const sentence = at > 0 ? detail.slice(0, at + 1) : detail;
const key      = at > 0 ? detail.slice(at + 2)  : null;
```

Render `sentence` as prose and `key` through `Truncate variant="path"` — which is what the comment
above the branch already specifies. Better still, have the server return `{ message, key }` as two
fields so no client is parsing prose.

### Related Existing Capabilities

`agentGraph`'s error handling, `Truncate`, `EmptyState`, and every future read error once GAP-003
is closed — this rendering is the template they would follow.

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 4/10 |
| Existing Implementation Coverage | 8/10 |
| Workflow Importance | 4/10 |
| Discoverability Impact | 6/10 |
| Implementation Effort | 1/10 |
| Confidence | 10/10 |

### Resolution

**Status: RESOLVED**

**Implemented:**

Fixed at the server, which is the option the finding called "better still": `GraphResult` gains
`errorKey`, and `agentGraph` catches `ObjectNotFound` — which already carries its own key — and
answers `{ error: "could not read this agent's files", errorKey: err.key }`. The sentence is a
sentence and the key is a field.

That is deliberately not a client-side split on the last `": "`. Parsing prose for a colon breaks
the first time a sentence contains one, and it puts the knowledge of *which part of this string is
a path* in the layer furthest from the code that knows. The server threw the error; the server
knows.

`Empty` in `GraphView` now takes both and renders each as what it is — the sentence as prose, the
key in mono through `Truncate variant="path"`. Both are optional and either may stand alone, so the
two "nothing selected" states are unaffected. Non-`ObjectNotFound` failures keep the single-string
form, which is correct: they have no key to separate.

**Files Changed:**

- `server/src/graphIntrospect.ts` — `errorKey` on `GraphResult`
- `server/src/index.ts` — the `ObjectNotFound` branch, and the import
- `server/src/graphIntrospect.test.ts` — the shape assertions
- `client/src/types.ts` — `errorKey` on `AgentGraph`
- `client/src/components/GraphView.tsx` — `Empty` renders two elements
- `client/src/lib/truncatePath.test.ts` — what the truncator does to prose
- `.github/workflows/ci.yml` — `test:graph-introspect` added; `test:edit-versions` recorded as deliberately absent

**Verification:**

`test:truncate-path` asserts the *cause* rather than the fix: a diagnosis fed to the path truncator
loses its verb and keeps only `.env.example`. That documents why the two fields exist, and it fails
if somebody ever "improves" the truncator to guess at prose — which would break the
distinguishability property that suite exists for. `test:graph-introspect` reads the branch out of
`index.ts` and requires the key as its own field, a sentence that does not interpolate it, and the
client's `AgentGraph` declaring the field — a field the server sends that the client's type does not
know about is a field no component can read, which is the same silence this finding is about.

**Both suites were absent from CI**, which by this repository's own rule means they did not run.
`test:graph-introspect` is in it now, in the agents step. `test:edit-versions` **cannot be** — an
apply validates the generated project by importing it with Python, and that job has node and
nothing else — so its properties were moved to `test:project-store` and `test:agent-adversarial`,
both of which run there, and the workflow records why it is absent rather than leaving it looking
forgotten. The remaining forty-five server suites registered in `package.json` and missing from the
workflow are recorded as **GAP-017**.

**Regression Coverage:**

Both typecheck; `test:truncate-path` and `test:graph-introspect` pass whole. `test:relay`'s graph
assertions are unchanged — a cross-workspace graph request still answers `{ error }` with no key,
because "no such agent in this workspace" is a refusal rather than a read failure and has no
identifier to name. Naming one there would be the enumeration oracle `test:access-resolver` exists
to prevent.

**Resolved On:** 2026-08-26

---

## GAP-016 — Share is a permanently enabled no-op in the top bar of every screen

**Priority:** P3
**Category:** ORPHANED_UI
**Opportunity Score:** 20
**Confidence:** 10/10
**Tags:** `[UI_EXISTS]` `[NO_CALLER]` `[DEAD_END]`

### What Already Exists

Nothing behind it. `TopBar.tsx:10` says so plainly: *"Share still has no backend, and is still an
honest stub."*

### Evidence

- `client/src/components/TopBar.tsx:375-381`:
  ```tsx
  <button title="Share — not available yet" aria-label="Share" className={iconBtn}>
    <ShareOutIcon size={ICON.sm} />
  </button>
  ```
  No `onClick`, no `disabled`.
- **Observed live** in the interactive-element map: `{ aria: "Share", title: "Share — not available yet", dis: false }` — focusable, hoverable, in tab order, on every screen

### Current User Path

Click it. Nothing happens. The only signal is a tooltip that requires hovering the control to
discover it does nothing.

### Missing Connection

None to build — it is the label that is wrong. The product's own precedent is clear: commit
`5d0b034` removed a greyed control with an explanatory tooltip on the grounds that *"a greyed
control with 'only an owner can do this' beside it has decided somebody should keep looking at
it"*, and `EnforcementStrip` states the principle directly: *"A control that looked like it lifted
a suspension and did not would be worse than no control."*

### Complete Workflow

```text
Share button, on every screen                    ← exists
    ↓
[NOTHING]
```

### Why This Is A Real Gap

Minor in isolation, but it sits in the one strip present on every surface of the application, and
it is the only element in an otherwise rigorous UI that behaves as decoration. It also has an
obvious adjacent capability: `downloadVersion` (`lib/agentExport.ts:49`) already produces a
shareable markdown document of an agent version, reachable from two other places.

### Minimal Fix

Remove it. If the slot is wanted, point it at the export that already exists — "Export current
version" is a real share, works today, and has two working call sites to copy.

### Related Existing Capabilities

`downloadVersion` / `versionMarkdown`, the Deploy panel's public URL, workspace export.

### Scores

| Metric | Score |
| --- | ---: |
| User Impact | 3/10 |
| Existing Implementation Coverage | 1/10 |
| Workflow Importance | 2/10 |
| Discoverability Impact | 5/10 |
| Implementation Effort | 1/10 |
| Confidence | 10/10 |

### Resolution

**Status: RESOLVED**

**Implemented:**

Removed, which is what the finding recommended and what this repository's own precedent requires —
`5d0b034` removed a greyed control with an explanatory tooltip, and `EnforcementStrip` states the
principle: *"A control that looked like it lifted a suspension and did not would be worse than no
control."* A comment where it stood records why, so it does not come back as an obvious improvement.

**Deliberately not repointed at `downloadVersion`,** though that was the adjacent capability the
finding offered. Both of the export's existing entry points are **contextual** — a card's overflow
and the file browser showing a version — because what is exported is *one version of one agent*.
This bar renders on Threads, the Inbox and Activity, where no version is in view, so a third entry
point would have to guess which one it meant. That is how "Export current version" becomes "export
whichever version happened to be in the store."

**And a suite, because nothing could observe this.** A button with no `onClick` typechecks,
renders, and passed every check that existed. `test:dead-controls` reads every `.tsx` under
`client/src` and fails on a `<button>` that is enabled, unspread, not a form submit, and has no
handler. It found 365 buttons and cleared all of them.

Two details that make it a real check rather than a green one:

- **Comments are stripped first, with line numbers preserved.** Four files argue in prose about
  what a `<button>` should be — *"a real `<button>` with aria-haspopup"*, *"it cannot be a real
  `<button>`"* — and the first run reported all four as dead controls. A structural audit that
  cries wolf is one nobody keeps.
- **It was watched refusing something.** Share was temporarily reinstated and the suite failed
  with `DEAD: components/TopBar.tsx:372`, then passed again once removed. A check nobody has seen
  refuse anything might be stuck at true — the same discipline `test:connector-stripe` applies to
  its scanner.

Its limits are written into its own header: it catches a control with *no* handler, which is the
shape that shipped. A handler that is present and does nothing is a different failure, and GAP-008's
exhaustive switch answers that one through the typechecker instead.

**Files Changed:**

- `client/src/components/TopBar.tsx` — the button, its import, and the header line
- `client/src/components/deadControls.test.ts` — new
- `client/package.json`, `.github/workflows/ci.yml` — registered in both, per the house rule

**Verification:**

`test:dead-controls` passes over 156 components and 365 buttons; the negative case was verified by
reintroducing the control. It also asserts by name that `ShareOutIcon` is absent from the top bar,
that no control there explains itself with a *"not available yet"* tooltip, and that
`downloadVersion` still has exactly its two contextual call sites — so a future "tidy-up" that
removed the real share while leaving the stub fails here.

**Regression Coverage:**

`test:type-scale` and `test:colour-system` — the client's other whole-source audits — both pass, and
the client typechecks. `ShareOutIcon` stays in `panelIcons.tsx`: it is a glyph library entry rather
than a feature, and removing an icon nobody renders is a different change.

**Resolved On:** 2026-08-26

---

# Backend Capabilities With No UI

| Capability | Where it lives | Why it has no entry point |
|---|---|---|
| `TurnVariantStore` (`begin`/`finish`/`forTurn`) | `turnVariants.ts:73` | Never instantiated outside tests — **GAP-010** |
| `planEffort` / `planForCapability` / `relativeCost` | `effort.ts:83,103,199` | The one adapter §3.2 required; never called — **GAP-005** |
| `POST/GET/DELETE /v1/turns/:id/attachments` | `http/turns.ts:229,194,313` | No client caller — **GAP-004** |
| `noteMemoryDecision` | `inbox/generators.ts:353` | Only reachable from a test — **GAP-012** |
| `offersApproval` | `checkPolicy.ts:98` | The precondition for a control that was never built — **GAP-013** |
| Changing an existing agent's `mcp_tools` | — | No command exists at all — **GAP-011** |
| `approvalBatchApprove` / `policyEngine` / `evalCiGate` | `plans.ts`, `entitlements.ts` | Gate nothing; **sold on the pricing page** — **GAP-014** |

**Not orphaned — checked and cleared.** `renderEdgeConfig`/`toCloudflare` (used by
`abuse/render.cli.ts`), `creditRefusal` (`billing/gate.ts:166`), `versionMarkdown` (used by
`downloadVersion`, which has two callers), `sendLoadEnforcement` (called at `socket.ts:687` on
connect), every one of the 116 WS commands (each has a sender and a component caller), and every
HTTP route including `/v1/workspace/export`, `/v1/workspace/delete`, `/v1/secrets/import` and
`PATCH /v1/users/me`.

# UI Dead Ends

| Control | Where | What happens |
|---|---|---|
| **Files** on a forked agent's version | `AgentVersions.tsx` | `loadAgentVersion` sent, zero frames back, panel unchanged — **GAP-001 + GAP-003** |
| ⊕ picker rows | `AttachPicker.tsx` | Picked, priced, rendered, dropped at send — **GAP-004** |
| ⋯ → Reasoning effort | `EffortControl.tsx` | Persists; no request is ever shaped by it — **GAP-005** |
| Connector tiles (6 of them) | `ConnectorDeck.tsx` | Dims and persists; the run is unchanged — **GAP-006** |
| `enable_gate` (primary) | `ungated_high_impact` card | No case in `runAction` — **GAP-008** |
| `view_evidence` (primary) | `memory_proposal` card | No case, and `stopPropagation` blocks the expansion that would have worked — **GAP-008/012** |
| `save_memory`, `reject_memory` | `memory_proposal` overflow | No case; the menu closes, reading as success |
| `cancel_deploy`, `remove_server`, `dismiss_all`, `view_all_failures` | four card types | No case; the commands exist elsewhere |
| **Share** | `TopBar.tsx:375` | Enabled, focusable, no handler — **GAP-016** |
| `‹ n/m ›` variant switcher | `TurnMetadata.tsx:143-165` | Unreachable; would render both arrows disabled — **GAP-010** |
| `DraftAttachment.error` retry | `AttachmentRail.tsx:36,71-77` | No code path can set `error` — there is no round trip to fail |

# Feature → Feature Disconnects

```text
Fork ──▶ [MISSING: copy objects] ──▶ Object store
   Every read of a fork's source throws; every write path refuses.                    GAP-001

Restore ──▶ [MISSING: materialise] ──▶ runtime/agents/<slug> ──▶ Run · Deploy
   The run and the deploy execute the version the history says was replaced —
   and the deploy then republishes it as the newest version.                          GAP-002

Composer attachments ──▶ [MISSING: POST] ──▶ turn_attachments ──▶ [MISSING] ──▶ Prompt
   Two links absent; the client-side budget check still blocks Send.                  GAP-004

Conversation settings.reasoning_effort ──▶ [MISSING] ──▶ effort.planEffort ──▶ Provider
   The sibling column (permission_mode) IS enforced, which makes the gap invisible.   GAP-005

conversation_connectors ──▶ MCP servers ✓   ──▶ Reviewed connectors ✗
   One list, one gesture, two meanings.                                               GAP-006

Object store ──▶ [MISSING: on-demand materialise] ──▶ runnable · run · deploy         GAP-007

Inbox card ──▶ [MISSING: runAction case] ──▶ cancelDeploy · removeMcpServer ·
                                             bulkInboxAction · setMcpToolImpact       GAP-008

Entitlement refusal ──▶ [MISSING: which plan grants this] ──▶ Checkout                GAP-009

Regenerate ──▶ [MISSING: dispatch] ──▶ turn_variants ──▶ [MISSING: wire] ──▶ Switcher GAP-010

MCP registry ──▶ Generation ✓   ──▶ [MISSING] ──▶ Existing agent's grants            GAP-011

memory_proposal ──▶ [MISSING: decision] ──▶ [MISSING: store] ──▶ [MISSING: prompts]  GAP-012

Check summary promises approval ──▶ [MISSING: control] ──▶ [UNREACHABLE: paid mode]  GAP-013
```

# Partial Workflows

| Workflow | Steps that exist | Missing transition |
|---|---|---|
| Fork → use | create row · copy manifest · grid card · detail view | **copy objects**, materialise |
| Restore → run/deploy | publish forward · broadcast files · Code view refresh | **materialise to disk** |
| Attach → send → answer | picker · rail · budget · cap | **POST**, then **prompt injection** |
| Set effort → dispatch | control · PATCH · resolve chain · adapter | **read at dispatch**, **shape the request** |
| Scope connectors → run | deck · PUT · decisions read | **filter credentials, tools and egress** |
| Regenerate → compare | action row · model menu · store · switcher UI | **dispatch**, **begin/finish**, **wire counts** |
| Grant MCP tools → change them | discovery · per-tool grant · manifest · Capabilities tab | **any mutation at all** |
| Proposal → answer → apply | derivation · card · evidence · predicate | **decision command**, **store**, **consumer** |
| Fork PR → approve → paid run | check · dry-run default · policy · `approvedForSha` | **the control**, and the state is circular |

# Orphaned Backend Logic

### Confirmed orphaned (no production caller; reachable only from tests)

- `turnVariants.ts` — `TurnVariantStore` in its entirety (GAP-010)
- `effort.ts` — `planEffort`, `planForCapability`, `relativeCost` (GAP-005)
- `inbox/generators.ts:353` — `noteMemoryDecision` (GAP-012)
- `checkPolicy.ts:98` — `offersApproval` (GAP-013)
- `POST/GET/DELETE /v1/turns/:id/attachments` — routes with no client (GAP-004)

### Likely orphaned (declared, gate nothing, documented as such)

- `approvalBatchApprove`, `policyEngine`, `evalCiGate` — no `EntitlementKind`, no check (GAP-014)
- `traceRetentionDays` / `auditRetentionDays` on `TierEntitlements` — the sweeper reads
  `PlanLimits.retentionDays` directly (`lifecycle/retention.ts:226`), so the entitlement copies
  are a second, unread representation of the same fact

### Uncertain — flagged, not claimed

- `activity/feed.ts` — `refusalKind`, `isConfirmationRefusal`: no caller outside tests, but the
  feed's classification pipeline is data-driven and these may be reached by name
- `checkpoints/store.ts:fileArtifactsFor`, `db/repositories/agents.ts:nextVersionNumber`,
  `db/repositories/oauth.ts:isUsable` — each looks like a helper superseded by a newer path;
  none was traced far enough to call dead

# Orphaned UI

- **Share** — enabled, no handler, on every screen (GAP-016)
- **`‹ n/m ›` variant switcher** — complete, unreachable, and `onSwitchVariant` is never passed (GAP-010)
- **`DraftAttachment.error` tone + retry** — no code path sets `error` (GAP-004)
- **`view_evidence` / `save_memory` / `reject_memory` / `enable_gate` / `cancel_deploy` /
  `remove_server` / `dismiss_all` / `view_all_failures`** — eight rendered controls, no dispatch (GAP-008)
- **`isClamped` / the effort clamp marker** (`turnMetadata.ts:69`) — can never fire, because
  `effort_requested` and `effort_applied` are only ever equal or both null (GAP-005)

# Missing Feedback Loops

| Operation | What is missing |
|---|---|
| Any point-to-point read that throws | **Everything.** No error frame, no empty state, no log the user can see — **GAP-003** |
| A forked agent, everywhere | No signal that it is broken; the grid tags it `IDLE · UNVERIFIED` — **GAP-001** |
| Restore, then run or deploy | No signal that the disk and the store disagree; the drift badge actively reassures — **GAP-002** |
| Graph read failure | The diagnosis is truncated to a filename — **GAP-015** |
| Every dead Inbox action | Silent no-op; the overflow closes, which reads as success — **GAP-008** |
| Effort setting | No indication it was not applied; the clamp marker that would have shown it cannot fire — **GAP-005** |
| Connector toggle | The tile dims — the only feedback — and it is wrong for six of nine rows — **GAP-006** |

# Events / Webhooks / Notifications Not Surfaced

The event plumbing is in good shape. `access.denied` is written per refusal and read by the
Access History; `recheck` reaches every socket on a grant change; the deploy channel streams
stages and logs; the enforcement strip renders the ladder's own sentence; the inbox reconciler
derives from facts. Two gaps:

- **`check_run.requested_action`** — GitHub can deliver it, `githubWebhook.ts` has no branch, and
  the check summary already advertises the action it would carry (**GAP-013**).
- **`memory_proposal`** is emitted by a real observer (`index.ts:9302`) into a card that cannot be
  answered (**GAP-012**).

# Persistence Gaps

| Setting | Local state | Request | Persisted | Reloaded | **Used at runtime** |
|---|:--:|:--:|:--:|:--:|:--:|
| Permission mode | ✓ | ✓ | ✓ | ✓ | **✓** |
| Reasoning effort | ✓ | ✓ | ✓ | ✓ | **✗ GAP-005** |
| Connector toggle — MCP server | ✓ | ✓ | ✓ | ✓ | **✓** |
| Connector toggle — the other six | ✓ | ✓ | ✓ | ✓ | **✗ GAP-006** |
| Composer attachments | ✓ | **✗** | ✗ | ✗ | **✗ GAP-004** |
| Turn notes / pins / feedback | ✓ | ✓ | ✓ | ✓ | ✓ |
| Spend ceiling, CI config, rubric, grants | ✓ | ✓ | ✓ | ✓ | ✓ |

# Integration Gaps

```text
Object store  ↔ Run          ✗   the run reads the local disk (GAP-007)
Object store  ↔ Deploy       ✗   the deploy uploads the local disk (GAP-002)
Object store  ↔ Fork         ✗   no objects are written at all (GAP-001)
Object store  ↔ Restore      ✗   the disk is never updated (GAP-002)
Connectors    ↔ Conversation ✗   MCP only (GAP-006)
Secrets       ↔ Connectors   ✓   resolved per run, refreshed, egress-pinned
OAuth         ↔ Connectors   ✓   short-lived tokens minted per run
Effort        ↔ Provider     ✗   the adapter is never called (GAP-005)
Attachments   ↔ Prompt       ✗   never even sent (GAP-004)
Runs          ↔ Cost         ✓   per-step cost streams into the thread and the grid
Runs          ↔ Retry/Cancel ✓   pause / resume / branch / cancel all wired
Billing       ↔ Usage        ✓   metering, holds, ceilings, periods
Entitlements  ↔ UI           ~   refused correctly; the upsell names the wrong plan (GAP-009)
MCP           ↔ Agents       ~   at generation only (GAP-011)
```

# State Machine Gaps

| Entity | Backend states | Frontend | Gap |
|---|---|---|---|
| Agent (source availability) | in-store · on-disk · neither | one boolean, from disk only | A published agent with no local directory is reported unrunnable and cannot be repaired — **GAP-007** |
| Socket read | success · refusal · **failure** | success · refusal | The third is invisible — **GAP-003** |
| Check provider mode | `dry_run` · `paid` | `dry_run` only | `paid` is unreachable by construction — **GAP-013** |
| `memory_proposal` | open · saved · rejected | open | Neither terminal state can be entered — **GAP-012** |
| Turn variants | 1..n | always 1 | No writer — **GAP-010** |
| Enforcement, deployment, MCP server, thread, run, connector | complete | complete | ✓ |

# Permission / Entitlement / Billing Gaps

```text
Capability → entitlement → limit → usage → blocked → explanation → upgrade → unlocked
    ✓            ✓          ✓        ✓        ✓           ✓          ✗          ✗
```

Everything up to the explanation is right, and unusually well built. The last two links break:

- **`nextTier` names the wrong plan** for `members`, `githubPhase2` and `perAgentAccessGrants` on
  Free — GAP-009. Pro is single-user; both features are Team-only.
- **The in-app plan list shows no feature differences at all** (`UsagePanel.tsx:356-390`), so the
  card's claim cannot be checked anywhere in the product.
- **Three advertised features have no gate and no surface** — GAP-014.
- **Per-agent narrowing does not reach `pauseRun` / `applyEdit` / `cancelDeploy` / `addExample`**
  — *already recorded in CHANGELOG v0.3.8 "Still owed" and asserted by `test:capabilities`.*
  Listed for completeness, not counted as a finding.

# Data Visibility Gaps

The product is strong here — cost per run over two windows, p50/p95, drift, outcomes, missing
credentials, model mix, tool usage, provenance lines, access history, secret rotations, secret
scan findings, the audit log, and the abuse ladder are all surfaced. What the backend knows and
nobody can see:

- **Why a read failed.** The message goes to the server console (**GAP-003**).
- **That an agent's published version has no objects.** Derivable and never derived (**GAP-001**).
- **That the disk and the store disagree.** Not computed anywhere (**GAP-002**).
- **`secret_usages`** — `manager.ts:325,344` records which credential an agent reached for, and the
  Secrets panel reads it (`/usage`), but the table is empty in this database, so the read path is
  untested against real data. *Flagged as uncertain, not claimed as a gap.*

# Actionability Gaps

```text
Fork is broken        → no signal, no repair                                 GAP-001
Version restored      → no signal that the run path did not follow           GAP-002
Read failed           → no state at all, so no action can be offered         GAP-003
Attachment picked     → no way to make it reach the model                    GAP-004
MCP grant unresolved  → the chip explains it; nothing can remove it          GAP-011
Proposal raised       → all three answers are dead controls                  GAP-012
Fork PR needs paid    → the summary names an approval nobody can give        GAP-013
Refused for a feature → the upgrade offered does not include it              GAP-009
```

# Lifecycle Gaps

| Entity | Create | View | Use | Configure | Inspect | Modify | Duplicate | Archive | Delete |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Agent | ✓ | ✓ | ~ **007** | ~ **011** | ✓ | ✓ | ✗ **001** | ✓ | ✓ |
| Agent version | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | — | restore ~ **002** |
| Thread | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| Run | ✓ | ✓ | ✓ | ✓ | ✓ | branch ✓ | ✓ | — | retention |
| Turn | ✓ | ✓ | ✓ | notes/pins ✓ | ✓ | ✗ **010** | ✗ **010** | — | ✓ |
| Attachment | ✗ **004** | — | — | — | — | — | — | — | — |
| Connector | ✓ | ✓ | ✓ | ~ **006** | ✓ | ✓ | — | — | ✓ |
| MCP server | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ |
| MCP grant | ✓ gen only | ✓ | ✓ | ✗ **011** | ✓ | ✗ **011** | — | — | ✗ **011** |
| Dataset / eval | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ |
| Deployment | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | forget ✓ |
| Secret | ✓ | ✓ | ✓ | ✓ | ✓ | rotate ✓ | — | — | ✓ |
| Workspace / member / grant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ |

# Discoverability Gaps

**Completely unreachable** — no path exists at any URL, command or shortcut:

- Turn variants and the variant switcher (**GAP-010**)
- Sending an attachment (**GAP-004**)
- Changing an existing agent's MCP grants (**GAP-011**)
- Approving real providers for a fork PR (**GAP-013**)
- Answering a memory proposal (**GAP-012**)

**Reachable but poorly surfaced:**

- The ⊕ menu says *"Nothing to attach yet — Generate an agent…"* whenever the file list is
  unavailable, which conflates "this agent has no files" with "the read failed" (**GAP-001/003**)
- The Graph error's diagnosis is hover-only (**GAP-015**)
- Which features a plan unlocks is on the public pricing page and nowhere in the product (**GAP-009**)
- Effort and permission mode both live behind a `⋯` overflow with no persistent indication of the
  current value on the composer bar

# Changelog / Recent Feature Audit

| Release | Feature | Loop status |
|---|---|---|
| v0.3.5 | Composer M2 — ⊕ attachments | **Backend and UI complete; the send is missing.** GAP-004 |
| v0.3.5 | Composer M3 — reasoning effort | **Persisted and rendered; never applied.** GAP-005 |
| v0.3.5 | Composer M3 — permission mode | ✓ complete and enforced |
| v0.3.5 | Composer M3 — connector deck | **Enforced for MCP servers only.** GAP-006 |
| v0.3.5 | Composer M4 — turn variants | **No writer; the switcher is unreachable.** GAP-010 |
| v0.3.5 | Composer M4 — notes / pins / feedback | ✓ complete |
| v0.3.4 | Subscriptions | ✓ gates work; **the upsell names the wrong plan** (GAP-009) and three flags gate nothing (GAP-014) |
| v0.3.2 | Inbox | **Eight of twenty-nine actions are dead; two card types have a dead primary.** GAP-008/012 |
| v0.3.1 | Agents tab | ✓ except fork (GAP-001) and grants (GAP-011) |
| v0.3.0 | Agent lifecycle (fork/archive/rename) | **Fork was wired without an object copy.** GAP-001 |
| v0.3.0 | PR checks | ✓ configurable; **the approval it advertises does not exist** (GAP-013) |
| v0.3.8 | Access tab | ✓ complete; known gaps already recorded |

The pattern is consistent and worth naming: **the v0.3.x releases connected the entry points and
the persistence, and the *last* link — the one where the stored value changes what the machine
actually does — is the one that slipped.** Effort, attachments, connector scoping and variants
are four instances of the same shape.

# Cross-Feature Dependency Map

```text
Agents
 ├── Threads          ✓
 ├── Runs             ? runnable is derived from the local disk only
 ├── Versions         ✓ (restore does not reach the run path)
 ├── Fork             ✗ objects are never copied
 ├── Connectors       ✓ at generation · ✗ per conversation
 ├── MCP grants       ? generation only, never editable
 ├── Permissions      ✓ per-agent grants, one resolver
 ├── Deploy           ? reads the local disk
 └── Billing          ✓

Runs
 ├── Trace / Logs     ✓
 ├── Cost             ✓ live per-step
 ├── Pause/Resume     ✓
 ├── Cancel           ✓
 ├── Branch           ✓
 ├── History          ✓ windowed
 └── Notifications    ✓ inbox + activity feed

Composer
 ├── Model            ✓
 ├── Permission mode  ✓
 ├── Effort           ✗ persisted, never applied
 ├── Connectors       ✗ MCP servers only
 ├── Attachments      ✗ never sent
 ├── Notes/Pins       ✓
 └── Variants         ✗ no writer

Inbox
 ├── Derivation       ✓
 ├── Evidence         ✓
 ├── Snooze/Dismiss   ✓
 ├── Undo             ✓
 └── Actions          ✗ 8 of 29 dead

Billing
 ├── Usage            ✓
 ├── Limits           ✓
 ├── Enforcement      ✓
 ├── Checkout         ✓
 ├── Upgrade path     ✗ names the wrong plan
 └── Pricing claims   ✗ three unbuilt features sold

GitHub
 ├── Link/Push/Pull   ✓
 ├── Checks           ✓
 ├── Shadow runs      ✓
 ├── Secret scan      ✓
 └── Fork PR approval ✗ promised, unreachable
```

`✓ connected · ? partially connected or unclear · ✗ meaningful missing connection`

# Recommended Fix Order

## Phase 1 — Quick wins (hours; each closes a loop that already exists)

1. **GAP-003** — give `answer()` a per-call-site error shape. *Two hours; makes every
   subsequent failure visible, including ones not yet found.* **Do this first** — it is what
   makes the rest observable.
2. **GAP-001** — publish the fork's objects instead of copying the manifest bare. *Four lines.*
3. **GAP-002** — materialise after `restoreAgentVersion`, as undo already does. *One line.*
4. **GAP-009** — resolve the unlocking tier from the plan catalogue instead of `nextTier`.
5. **GAP-014** — delete three rows from `pricing.html`.
6. **GAP-015** — split the sentence from the key before truncating.
7. **GAP-016** — remove Share, or point it at `downloadVersion`.
8. **GAP-008** — add the six `runAction` cases whose commands already exist, and make the switch
   exhaustive so the next one cannot ship dead.

## Phase 2 — Product loop completion (days; the last link on shipped features)

9. **GAP-004** — POST the attachments on send, surface 409/413 on the rail, then feed resolved
   content into the prompt builders. *Until then, hide ⊕ rather than let it block Send.*
10. **GAP-005** — call `planEffort` at the five dispatch sites and put `requested`/`applied` on
    the usage payload, which makes the clamp marker real.
11. **GAP-007** — one `ensureProjectDir` helper that materialises on demand; call it from the run
    dispatch, `planDeploy` and the deploy upload. *Subsumes the durable half of GAP-002 and makes
    a second replica correct for the first time.*
12. **GAP-006** — `JAROKU_CONNECTORS` allowlist: filter credentials first (the security half),
    then egress, then the generated `TOOLS` list.
13. **GAP-012** — a decision command reaching `noteMemoryDecision`, or withdraw the type and
    correct the comment.

## Phase 3 — Deep integration (weeks; new surface or cross-system design)

14. **GAP-010** — make Regenerate dispatch, open and close a variant around it, and wire
    `variant_ordinal`/`variant_total` so the switcher becomes reachable.
15. **GAP-011** — a grant/revoke command for an existing agent's MCP tools, re-emitting the
    manifest. *Revocation alone closes both observed broken states at half the cost.*
16. **GAP-013** — either drop the promise from `modeReason` (one line, do this now) or build the
    Check Run requested-action round trip.

---

## The question this audit kept asking

> **What has Jaroku already built that a user currently cannot access, connect, understand,
> persist, recover from, or continue using?**

The answer is unusually specific for a codebase this disciplined, and it is one shape repeated:
**the value is stored, the value is displayed, and the value is not read by the thing it was
supposed to change.** Effort, attachments, connector scoping, variants, memory decisions, fork
objects and restored versions are seven instances of it. In every one of them the expensive
part — schema, store, route, component, empty state, suite — is finished, and the missing piece
is between five and fifty lines.

---

# Implementation Log

Every finding above, with what closed it and what proves it closed. A row here is a claim that the
whole path works — not that a suite passes, which is the distinction §19 of the implementation
brief spends a page on.

| Gap | Status | Files Changed | Verification |
|---|---|---|---|
| GAP-001 | RESOLVED | `index.ts`, `projectStore.test.ts`, `agentAdversarial.test.ts` | `test:project-store` proves the bare-row fork still throws and the published one reads back byte for byte; `test:agent-adversarial` holds the call site |
| GAP-002 | RESOLVED | `index.ts`, `projectStore.test.ts`, `agentAdversarial.test.ts`, `editVersions.test.ts` | `test:project-store` proves the bare row is unreadable and the disk stale, then that publish + materialise fixes both; finding was understated — see its Resolution |
| GAP-004 | RESOLVED | `http/turns.ts`, `index.ts`, `wsRelay.ts`, `threadStore.ts`, `attachments.test.ts`, `socket.ts`, `BuildPane.tsx`, `AttachmentRail.tsx` | `test:attachments` gained a 15-claim reachability audit — every arithmetic assertion in it was already true of code that never ran on a turn |
| GAP-005 | RESOLVED | `effort.ts`, `index.ts`, `planner.ts`, `generator.ts`, `editor.ts`, `explainer.ts`, `models.py`, `effort.test.ts` | `test:effort` gained a per-request ceiling section and a reachability audit over all four dispatch sites, three payload sites and the run env |
| GAP-006 | RESOLVED | `index.ts`, `tool_templates/__init__.py` + all six templates, `connectorLoop.test.ts` | `test:connector-loop` §9 holds all three consumers at once — egress, credentials and the runtime guard — plus the dispatch read as text |
| GAP-007 | RESOLVED | `agents.ts`, `index.ts`, `agentFiles.test.ts`, `ci.yml` | `test:agent-files` proves a published agent is runnable with no directory, that the whole workspace costs one statement, and that all three call sites materialise on demand |
| GAP-008 | RESOLVED | `InboxActions.tsx`, `InboxCardActions.tsx`, `inboxStore.ts`, `InboxView.tsx`, `inboxBoard.test.ts`, `registry.ts`, `types.ts`, `inboxActionIcons.tsx` | `test:inbox-board` reads the server's vocabulary and requires a case for all 29; the exhaustive switch failed the build naming four omissions while being written |
| GAP-009 | RESOLVED | `entitlements.ts`, `entitlementGate.ts`, `plans.ts`, `index.ts`, `entitlements.test.ts`, `entitlementStore.ts`, `UpsellCard.tsx`, `UsagePanel.tsx`, `types.ts` | `test:entitlements` holds all seven kinds from both Free and Pro, plus the top of the ladder answering null; `test:entitlement-store` holds the client guard |
| GAP-014 | RESOLVED | `web/pricing.html`, `checkoutSurfaces.test.ts` | `test:checkout-surfaces` maps every sold feature row to an `EntitlementKind` and asserts the three removed names stay gone |
| GAP-015 | RESOLVED | `graphIntrospect.ts`, `index.ts`, `graphIntrospect.test.ts`, `types.ts`, `GraphView.tsx`, `truncatePath.test.ts`, `ci.yml` | `test:truncate-path` asserts what the truncator does to prose; `test:graph-introspect` holds the two-field shape on both sides |
| GAP-016 | RESOLVED | `TopBar.tsx`, `deadControls.test.ts` (new), `client/package.json`, `ci.yml` | `test:dead-controls` clears 365 buttons and was watched refusing a reinstated Share at `TopBar.tsx:372` |
| GAP-003 | RESOLVED | `wsRelay.ts`, `channels.test.ts`, `wsRelay.test.ts`, `types.ts`, `buildStore.ts`, `socket.ts`, `AddMenu.tsx`, `BuildPane.tsx` | `test:channels` audits all 13 call sites from source; `test:relay` drives a throwing read and asserts the frame |
