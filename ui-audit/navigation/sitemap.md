# Navigation — sitemap

Jaroku has **no router and no URL**. There is no address bar, no back button, no history stack and
no breadcrumb anywhere in the product. Every "route" below is a piece of state in
`client/src/store/uiStore.ts`, and every navigation is a store write.

This is a deliberate design, stated at `uiStore.ts:238-251`:

> One nullable field is the whole mechanism … There is no Escape-to-close, no back button, no
> breadcrumb and no "last active" fallback to remember — the sidebar is the single source of
> navigation and is already displaying what you would fall back to, so the app never has to store
> an answer to "where was I".

A redesign needs to know this before it starts: **there is nothing to deep-link to inside the app
except a work item**, and there is no way to go "back".

---

## The shell

```
┌─────────────────────────────────────────────────────────────────────────┐
│  TopBar — agent name · slug · lifecycle dot · Dry run (free) · Deploy    │
├────┬────────────────┬──────────────────────────────┬───────────────┬────┤
│    │                │                              │               │    │
│ R  │  Sidebar       │  Centre pane                 │  Right panel  │ R  │
│ a  │  panel         │  (BuildPane / thread)        │  (10 tabs)    │ a  │
│ i  │                │                              │               │ i  │
│ l  │  AGENTS        │  FIX <agent>                 │  TRACE …      │ l  │
│    │  RUNS          │                              │               │    │
│    │                │  ── composer ──              │               │    │
├────┴────────────────┴──────────────────────────────┴───────────────┴────┤
│  StatusBar — connected · N deployed                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

A full-screen destination replaces the **centre pane and the right panel together**, keeping the
rail, the sidebar panel, the TopBar and the StatusBar. The sidebar deliberately does not move,
collapse or lose its selection (`FullScreenView.tsx:18-22`).

## Primary navigation — the rail

Five destinations, in this fixed order, `uiStore.ts:44`:

| # | Destination | `NavDestination` | Icon | Badge |
|---|---|---|---|---|
| 1 | Threads | `threads` | `#` (hash) | count of threads needing you |
| 2 | Agents | `agents` | sparkles | none |
| 3 | **Cockpit** | `work` | gauge | count of work items `waiting` |
| 4 | Inbox | `inbox` | tray | count of blocking inbox items |
| 5 | Activity | `activity` | pulse | none |

Below them, anchored to the foot of the rail, a **gear** — which does *not* open settings. It calls
`setProviderPanel(true)` (`Sidebar.tsx:457`) and opens the **Provider keys** popover. See
[`findings/inconsistencies.md`](../findings/inconsistencies.md).

### The two-field navigation model

`navView` and `navSection` are two separate fields and they move apart on purpose
(`uiStore.ts:284-300`):

- `navView` — is a full-screen destination *showing*?
- `navSection` — which destination is the person *in*?

Selecting a row inside a destination collapses the full-screen view (sets `navView = null`) but
keeps `navSection`, so the rail item stays lit while the three panes come back. This is the
mechanism behind the desync recorded in [`findings/ux-debt.md`](../findings/ux-debt.md).

## Secondary navigation — the right panel

Ten tabs, `RightPanel.tsx:59-81`, in rail order top to bottom:

| Tab | `RightTab` | Shown |
|---|---|---|
| Agent | `agent` | only when an agent has been opened from the Agents grid |
| Graph | `graph` | always |
| Trace | `trace` | always |
| Evals | `evals` | always |
| MCP | `mcp` | always |
| Connections | `connections` | always |
| Deploy | `deploy` | always |
| Secrets | `secrets` | always |
| GitHub | `github` | always, with a badge |
| Usage | `usage` | always |

An eleventh `RightTab` exists — `code` — which is not in the rail; it renders as the full-surface
`CodeOverlay` drawer instead.

## Modal / panel navigation

| Surface | Opened by | Dismissed by |
|---|---|---|
| Command palette | `⌘K` / `⌘P` | `Esc`, selecting a row |
| Workspace panel | the workspace switcher → "… settings", the user chip | its own `×` |
| Provider keys popover | the rail's gear | `Esc`, outside click |
| Work detail panel | a work row, or a citation chip | `×`, `Esc` (focus returns to the row) |
| Pre-flight gate | the dispatch composer's send | `Cancel`, `Esc` |
| Fleet card overflow | the card's `⋮` | outside click, `Esc` |
| Code overlay | the `code` right-tab | its own close |
| Reconnect / Kill dialogs | the fleet card overflow menu | `Cancel`, `Esc` |

## Deep links

The Tauri shell registers the `jaroku://` scheme (`tauri.conf.json` → `plugins.deep-link`,
handled in `src-tauri/src/deeplink.rs`). Two paths are handled by the client:

| Link | Effect | Observed? |
|---|---|---|
| `jaroku://billing/success` | returns from the Stripe checkout hop and starts polling `GET /v1/billing/subscription` | No — no Stripe key configured |
| a work-item deep link | opens the Cockpit with that item's detail panel | No — `IMPLEMENTED / NOT CURRENTLY OBSERVABLE`, `client/src/lib/workLink.ts`, `lib/deepLink.ts` |

`open_checkout` (`src-tauri/src/deeplink.rs`) is the **only** hop out of the window in the entire
product, and it checks the URL against an exact-host allowlist first.

## Every path into the Cockpit

| Path | Lands on | Filter set? |
|---|---|---|
| Rail item 3 | Cockpit, unfiltered | no |
| Command palette → "Open the Cockpit" | Cockpit, unfiltered | no |
| Command palette → "Show what is waiting" | Cockpit | **yes** — scope `all`, status `waiting` |
| Command palette → "Dispatch to \<agent\>" (only when a query is typed) | Cockpit | yes — that agent |
| Clicking a fleet card's body | Cockpit | yes — "Only \<agent\>" chip |
| Inbox `CockpitPointer` strip | Cockpit, unfiltered | no — `openCockpitForAgent(null)` |
| A work-item deep link | Cockpit, detail open | not observed |

The `CockpitPointer` renders **only when at least one job is `waiting`** (`CockpitPointer.tsx:34`),
and it points *from the Inbox into the Cockpit* — not, as might be expected, from an agent's detail
page. The symmetric `InboxPointer` points the other way, from agent detail into the Inbox.
`IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — no work item is `waiting` in the seed.

## Every path out of the Cockpit

| From | To | How |
|---|---|---|
| Work detail | the run's trace | "Open the trace" button |
| Work detail | a retry of the job | "Retry" button |
| Fleet card `#` | the agent's **operate thread** | `sendCreateThread(agent, "operate")` |
| Fleet card overflow → Reconnect / Kill | a confirm dialog | `CockpitDialog` |
| A citation chip in an operate thread | back **into** the Cockpit, detail open | `workLink.ts` |
| The rail | any other destination | — |

**"Open the trace" is the same route the rest of the product uses.** It sets the right panel's
`trace` tab against the work item's `run_id`, which is the identical surface a local run opens.
