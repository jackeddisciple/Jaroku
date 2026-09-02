# Implementation cross-reference

**screen → route → component → major children → state/data → feature module.**

There are no routes. Every "route" below is the `uiStore` state that puts the screen on screen.

| Screen | State that shows it | Component | Major children | Store | Channel | Server |
|---|---|---|---|---|---|---|
| Sign in | no session | `auth/AuthFlow.tsx` | — | `sessionStore` | — | `auth/` |
| Onboarding | `onboarded_at IS NULL` | `onboarding/account/AccountOnboarding.tsx` | 5 step components | `accountOnboardingStore` | — | `/v1/users/me/onboarding/*` |
| Workspace shell | `navView === null` | `App.tsx` | `Sidebar` · `BuildPane` · `RightPanel` · `TopBar` · `StatusBar` | `uiStore` | many | — |
| Workspace panel | `workspaceSection !== null` | `WorkspacePanel.tsx` | `AccessPanel` · `BillingSection` · `AccountSection` | `memberStore` · `auditStore` · `billingStore` | `members` `access` `audit` `billing` | — |
| Threads board | `navView === "threads"` | `ThreadsView.tsx` | `ThreadFilterBar` · `ThreadRow` · `ThreadGlyph` | `threadStore` | `threads` | `threadStore.ts` |
| Build thread | a build thread selected | `BuildPane.tsx` | composer · `ReviewRegion` · `DiffCard` | `buildStore` · `chatStore` | `gen` `edit` `reply` `history` | `planner` `generator` `editor` |
| **Operate thread** | `activeThread.mode === "operate"` | `BuildPane.tsx` (`operating`) | composer · citation chips · `WorkGate` | `chatStore` · **`workStore`** | `reply` **`work`** | `work/factPack.ts` `citations.ts` `honesty.ts` |
| Agents board | `navView === "agents"` | `AgentsView.tsx` | `AgentCard` · `AgentTagRow` | `agentGridStore` | `agents` | `agents.ts` |
| Agent detail | `rightTab === "agent"` | `AgentTabs.tsx` | `AgentOverview` · `AgentVersions` · `AgentFiles` · `AgentOps` | `agentGridStore` | `agents` `agentFiles` | `agentHealth.ts` `agentGrid.ts` |
| **Cockpit** | `navView === "work"` | **`CockpitView.tsx`** | `FleetStrip` · `WorkList` · `WorkDetail` · `WorkComposer` · `WorkGate` | **`workStore`** | **`work`** | **`work/`** |
| Trace | `rightTab === "trace"` | `TraceTimeline.tsx` | `StepRow` · `StepDetailPanel` · `StateDiff` | `traceStore` | `trace` `runSteps` `debug` `log` | `store.ts` `worker.ts` |
| Graph | `rightTab === "graph"` | `GraphView.tsx` | `GraphCanvas` | `graphStore` | `graph` | `graphIntrospect.ts` |
| Evals | `rightTab === "evals"` | `EvalsPanel.tsx` | `EvalRunBar` · `DatasetBuilder` · `EvalDashboard` | `evalStore` | `eval` | `evalRunner.ts` `judge/` |
| Deploy | `rightTab === "deploy"` | `DeployPanel.tsx` | — | `deployStore` | `deploy` | `deployManager.ts` `railwayApi.ts` |
| Connections | `rightTab === "connections"` | `ConnectionsPanel.tsx` | — | `connectionStore` | `connections` | `connectors.ts` `oauth/` |
| MCP | `rightTab === "mcp"` | `McpPanel.tsx` | `McpConfirmModal` · `McpBadge` | `mcpStore` | `mcp` | `mcpClient.ts` `mcpRegistry.ts` |
| Secrets | `rightTab === "secrets"` | `SecretsPanel.tsx` | `SecretsGate` · `SecretsList` | `secretsStore` | — (HTTP) | `secrets/` |
| GitHub | `rightTab === "github"` | `GitHubPanel.tsx` | `GitHubSync` · `GitHubStaging` · `GitHubChecks` · `GitHubHistory` | `githubStore` | `github` | `githubApp.ts` `githubWebhook.ts` |
| Usage | `rightTab === "usage"` | `UsagePanel.tsx` | `StatRow` | `billingStore` · `enforcementStore` | `billing` `enforcement` | `pricing.ts` |
| Inbox | `navView === "inbox"` | `InboxView.tsx` | `InboxCard` · `InboxActions` · `CockpitPointer` | `inboxStore` | `inbox` | `inbox/` |
| Activity | `navView === "activity"` | `ActivityDashboard.tsx` | `ActivityHero` · `ActivityCards` · `ActivityFeed` | `activityStore` | `activity` | `activity/` |
| Command palette | `paletteOpen` | `CommandPalette.tsx` | — | `uiStore` | — | — |

---

## The Cockpit's data surface

A redesign needs to know what data a screen actually has before it can propose a different one.

### The store

`client/src/store/workStore.ts` holds, from one snapshot:

| Field | Feeds |
|---|---|
| the fleet (`FleetCardView[]`) | the strip, the composer's destination, the gate |
| the work list (windowed) | the record |
| `workspaceCounts` | **the rail badge, the Cockpit header count and the Inbox pointer — one quantity, three renders** |
| `filters` (`scope` · `status` · `agentId`) | the filter bar |
| the loaded work item | the detail panel |

Helpers: `lib/workRow.ts` · `workWindow.ts` · `workLive.ts` · `rowFacts.ts` · `cockpitFormat.ts` ·
`cockpitLayout.ts` · `cockpitComposer.ts` · `fleetSentence.ts` · `workLink.ts`

### The channel and its commands

Channel **`work`** (`lib/socket.ts:535`). Commands sent from the client:

| Command | Sent by |
|---|---|
| `sendListWork()` | the view on mount, the refresh control, the palette's "Show what is waiting" |
| `sendLoadWorkItem(id)` | a work row, a citation chip, a deep link |
| `sendDispatchWork(...)` | the gate's confirm, from either composer |
| `sendCancelWork(id)` | the detail's Stop |
| `sendRetryWork(id)` | the detail's Retry |
| `sendReconnectAgent(deployment_id)` | the fleet card's Reconnect dialog |
| `sendKillAgent(deployment_id)` | the fleet card's Kill dialog |
| `sendCreateThread(agent, name, "operate")` | the fleet card's `#` |

### The server side

`server/src/work/` — `workStore.ts` (persistence) · `dispatcher.ts` (the run-token and control-plane
path to a deployed container) · `lifecycle.ts` (status transitions) · `payload.ts` · `snapshot.ts` ·
`cost.ts` · `factPack.ts` (what an operate answer is allowed to know) · `citations.ts` ·
`honesty.ts` · `actions.ts` · `replay.ts`

`factPack.ts` and `honesty.ts` are the two worth reading before redesigning the conversation
surface: together they are why the thread said *"I have no record of that"* instead of guessing.

---

## The 27 WebSocket channels

The client's relay handler (`lib/socket.ts:114-680`) switches on 27 channel names:

`history` · `trace` · `runSteps` · `log` · `agents` · `agentFiles` · `graph` · `gen` · `edit` ·
`debug` · `eval` · `mcp` · `providers` · `connections` · `billing` · `deploy` · `github` ·
`session` · `enforcement` · `audit` · `access` · `members` · `inbox` · **`work`** · `activity` ·
`threads` · `reply`

*(`docs/tauri.md` says "twenty-one channels"; the switch has 27. The doc predates the Cockpit.)*

Two behave unlike the rest:

- **`session`** is the only channel about the *connection* rather than the work.
- **`audit`** is the only channel answered **to one socket alone**; every other channel broadcasts a
  full snapshot to the workspace.

## The desktop shell

| Concern | File |
|---|---|
| Window, and the min size | `src-tauri/src/window.rs` |
| Backend port resolution | `src-tauri/src/ports.rs` → injected into `client/src/lib/hostConfig.ts` |
| The supervised Node sidecar | `src-tauri/src/sidecar.rs`, `tree.rs` |
| Deep links (`jaroku://`) and `open_checkout` | `src-tauri/src/deeplink.rs` → `client/src/lib/deepLink.ts` |
| Backend status → the page | `src-tauri/src/status.rs` → `client/src/lib/hostBackend.ts` |
| Session token → OS credential store | `src-tauri/src/secrets.rs` → `client/src/lib/sessionVault.ts` |

**The frontend has exactly three Tauri-aware modules** — `sessionVault.ts`, `deepLink.ts`,
`hostBackend.ts` — and all three reach the shell through `window.__TAURI__` rather than
`@anthropic-ai`-style imports, so a browser build gains no dependency. `hostConfig.ts` is
deliberately **not** one of them.
