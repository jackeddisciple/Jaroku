# Jaroku — UI Audit

An archaeological record of the Jaroku desktop application **as it exists today**.

This package answers one question: **what exists right now?** It does not answer "what should
Jaroku look like?" Nothing here is a redesign, a recommendation, or a proposal.

---

## ⚠ The current design tokens are LEGACY

The values in [`legacy/current-tokens.md`](legacy/current-tokens.md) are recorded so that a reader
can understand what the current implementation does. They are **not** a design-system foundation,
they are **not** constraints on a future system, and nothing here recommends preserving any of them.

The one thing worth carrying forward is not a value. `client/src/lib/tokens.ts` and
`client/src/lib/typeScale.ts` carry paragraphs of written reasoning next to individual decisions —
why amber could not be borrowed for a caution state, why a shadow never appears without a hairline,
why one weight on the type ladder is deliberately claimed by no rung. Those arguments record real
past failures. They are extracted, as prose and without their values, in
[`legacy/design-arguments.md`](legacy/design-arguments.md).

---

## How this audit was produced

Every screenshot in this package was captured from the **live Jaroku desktop application** running
locally — the Tauri v2 shell (`npm run tauri:dev`), which spawns the real Node server and serves the
real React bundle. No screenshot is a mock, a browser render, a crop of a design file, or a
reconstruction. Where a state was reached by contrivance, the caption says so.

| | |
|---|---|
| Application | Jaroku 0.3.11, Tauri v2 desktop shell |
| Host | macOS 15 (Darwin 25.6.0), Apple Silicon |
| Capture | Native window capture at 2× (2880×1684 for a 1440×842 window) |
| Backend | The repository's own Node server + SQLite (`server/jaroku.db`) |
| Model provider | None configured — the workspace falls back to the free `fake-dry-run` provider |

### The two accounts this audit was taken from

The local server's dev issuer allows signing in as any address, and the seeded database spreads its
data across several workspaces. Two were used, deliberately, because between them they cover both
ends of every state:

| Account | Workspace | What it shows |
|---|---|---|
| `adarsh@jaroku.dev` | personal, and a second team workspace | Empty and first-use states; the team-only Members surface |
| `e2e@jaroku.test` | personal | The only populated Cockpit: 1 live deployment, 9 work items, 1 operate thread |
| `audit-newcomer@jaroku.test` | created during the audit | First sign-in / onboarding entry |

---

## Application areas

Jaroku's shell is a **sidebar rail with five full-screen destinations**, a three-pane working layout
underneath them, and a **right-hand panel of ten tabs**. Everything in the product is reached from
one of those two sets, plus the workspace panel and the command palette.

| Area | Folder | Exists? |
|---|---|---|
| Authentication | [`screens/auth/`](screens/auth/) | Yes |
| Onboarding | [`screens/onboarding/`](screens/onboarding/) | Yes — 5 steps in code; see the finding below |
| Workspace shell | [`screens/workspace/`](screens/workspace/) | Yes |
| Threads | [`screens/threads/`](screens/threads/) | Yes — and **two kinds of thread** |
| Agents | [`screens/agents/`](screens/agents/) | Yes |
| **Cockpit** | [`screens/cockpit/`](screens/cockpit/) | Yes — a fifth top-level destination |
| Runs / traces / graph | [`screens/runs/`](screens/runs/) | Yes |
| Evaluations | [`screens/evaluations/`](screens/evaluations/) | Yes |
| Deployments | [`screens/deployments/`](screens/deployments/) | Yes |
| Connections | [`screens/connections/`](screens/connections/) | Yes |
| MCP | [`screens/mcp/`](screens/mcp/) | Yes |
| Secrets | [`screens/secrets/`](screens/secrets/) | Yes |
| Inbox | [`screens/inbox/`](screens/inbox/) | Yes |
| Activity | [`screens/activity/`](screens/activity/) | Yes |
| Access | [`screens/access/`](screens/access/) | Yes — Members (team workspaces only) and Audit |
| Settings | [`screens/settings/`](screens/settings/) | Yes — split across two unrelated surfaces |
| Billing | [`screens/billing/`](screens/billing/) | Yes |
| **GitHub** | [`screens/github/`](screens/github/) | Yes — **an area the audit brief did not name** |
| **Usage** | [`screens/usage/`](screens/usage/) | Yes — **an area the audit brief did not name** |

**A `memory/` folder was not created.** The brief's folder list is a hypothesis, and Memory is not a
destination in this product. `FullScreenView.tsx:12-16` records that the fourth tab was Memory in
v0.3.0, that nothing was ever built behind it, and that what shipped instead is the Inbox. Creating
the folder would document a feature that does not exist.

---

## Index

| | |
|---|---|
| **Screens** | [`screens/`](screens/) — one folder per screen, each with a `SCREEN.md` and its states |
| **Flows** | [`flows/`](flows/) — end-to-end journeys |
| **Components** | [`components/`](components/) — the reusable inventory, by category |
| **States** | [`states/`](states/) — how this product communicates state, across screens |
| **Navigation** | [`navigation/`](navigation/) — sitemap, sidebar, keyboard, search |
| **Legacy** | [`legacy/`](legacy/) — current token values, and the arguments beside them |
| **Findings** | [`findings/`](findings/) — inconsistencies, UX debt, missing states |
| **Screenshots** | [`screenshots-index.md`](screenshots-index.md) — every image, with its screen and state |
| **Interactions** | [`interactions.md`](interactions.md) — trigger → response → state → recovery |
| **Visual structure** | [`visual-structure.md`](visual-structure.md) — composition, density, silhouettes |
| **Accessibility** | [`accessibility.md`](accessibility.md) — observed behaviour; no conformance claimed |
| **Implementation** | [`implementation-map.md`](implementation-map.md) — screen → component → store → channel → server |

---

## Audit limitations — read this before trusting a gap

### The Cockpit was audited against a real deployment record, but not a reachable container

This is the single most important limitation in the package, and it is the one the brief warned
about. The `e2e@jaroku.test` workspace holds a genuine deployment row (`dep_0199476e`, Railway,
`status = live`, `version = 3`) and nine genuine work items. That was enough to reach the fleet
strip, the work list, the work detail for two failure kinds and one success, the filter bar, the
dispatch composer, the pre-flight gate and the operate thread — all captured live.

It was **not** enough to reach any state that requires a container that answers. The deployment's
URL is `http://127.0.0.1:4599`, and nothing is listening there. **No deployment was created and no
job was dispatched during this audit**, so no state below was simulated or faked.

**Unreachable Cockpit states — 17, each marked `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` with its
evidence:**

| State | Evidenced at |
|---|---|
| Work status `queued` | `client/src/lib/cockpitCopy.ts:137` · `WorkGlyph.tsx` |
| Work status `running` | `cockpitCopy.ts:138` · `WorkGlyph.tsx` |
| Work status `waiting` (waiting on a person) | `cockpitCopy.ts:139` · `workStore.ts` `workBadgeCount` |
| Work status `cancelled` | `cockpitCopy.ts:142` |
| Failure kind `unauthorised` | `cockpitCopy.ts:119` |
| Failure kind `rejected` | `cockpitCopy.ts:121` |
| Failure kind `unreachable` | `cockpitCopy.ts:122` |
| Failure kind `busy` | `cockpitCopy.ts:124` |
| Fleet connection `unconnected` | `cockpitCopy.ts:88-95` |
| Fleet connection `unauthorised` | `cockpitCopy.ts:88-95` |
| Fleet connection `public` (+ its warning in the gate) | `WorkGate.tsx:56-58` |
| The new-items pill | `cockpitCopy.ts:267-273` (`LIVE.pill`) |
| The optimistic "Sending…" row | `cockpitCopy.ts:272` |
| A status changing in place | `lib/workLive.ts` |
| The work list under virtualisation at large row counts | `WorkList.tsx` |
| The fleet strip overflowing its track | `FleetStrip.tsx:538` |
| Runtime logs with content | `AgentOps.tsx` `LogPane` — **and see the finding: unreachable anyway** |

### Other limitations

- **No provider key is configured.** Every model-backed surface fell back to `fake-dry-run`. Real
  token counts, real costs and a populated Usage chart were therefore not observable.
- **Only one role was available.** The seeded accounts are all `owner`. Member, admin and viewer
  denial behaviour is documented from `capabilities.ts` and `Capable.tsx` and marked as such.
- **Billing is Free on every workspace,** and no Stripe key is configured, so paid, trial,
  usage-warning, limit-reached and payment-issue states were not observable.
- **No GitHub App is installed,** so the GitHub panel was only observable in its not-connected state.
- **The evaluation engine was never run** (it needs a dataset and a provider key), so only the empty
  state of Evals is observable.

### Unknowns

- Whether the fleet strip's scroll affordance behaves correctly at overflow — there is one card.
- Whether the work list reorders under live updates — no live updates occurred.
- Whether `busy` and `unreachable` read differently from `stopped_reporting` in the detail panel:
  the sentences differ in `cockpitCopy.ts`, but only two of six were seen rendered.

---

## The four questions a redesigner must not have to ask

The brief names four. They are answered here:

- **"What does the operator see the morning after a job failed overnight?"** →
  [`screens/cockpit/work-list/SCREEN.md`](screens/cockpit/work-list/SCREEN.md) and
  [`screens/cockpit/work-detail/SCREEN.md`](screens/cockpit/work-detail/SCREEN.md)
- **"How does someone give a deployed agent a real job?"** → [`flows/dispatch.md`](flows/dispatch.md)
- **"What happens when an agent needs a human decision and nobody is looking?"** →
  [`flows/waiting-approval.md`](flows/waiting-approval.md) — partly unreachable, and it says so
- **"How does a build thread differ from an operate thread?"** →
  [`screens/threads/operate-thread/SCREEN.md`](screens/threads/operate-thread/SCREEN.md)
