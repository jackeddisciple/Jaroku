# SCREEN — The workspace shell (three panes)

| | |
|---|---|
| **Screen ID** | `WS-01` |
| **Screen name** | Workspace shell |
| **Route / path** | none — `App.tsx` renders it whenever `navView === null` |
| **Parent area** | Workspace |
| **Purpose** | The working layout: build an agent, watch it run, read the result |
| **Primary user goal** | Change an agent and see what the change did |

## Composition

Four columns, left to right, inside a bordered shell that floats on `CANVAS.subtle`:

| Region | Width | Resizable |
|---|---|---|
| Icon rail | 32px fixed | no |
| Sidebar panel | `SIDEBAR_MIN_PX` floor, drag to `SIDEBAR_MAX_PCT` | yes |
| Centre pane (`BuildPane`) | flex | yes (against the right panel) |
| Right panel | flex | yes |
| Right tab rail | 32px fixed | no |

Above them a **TopBar**; below them a **StatusBar**. Both are persistent across every destination.

Both resizable columns take a **measured pixel floor converted to a percentage**, not a percentage
floor (`App.tsx:57-86`, `lib/paneFloor.ts`) — because a percentage floor put the composer's mic and
send button outside the composer's own box at 1440px.

## Persistent elements

| Element | Content |
|---|---|
| TopBar | wordmark · agent name · agent slug · lifecycle dot (`draft`) · `Dry run (free)` · `Deploy` |
| StatusBar | `● connected` (left) · `N deployed` (right) |
| Icon rail | five destinations + the provider-keys gear |
| Sidebar panel | workspace chip · AGENTS · PINNED · RUNS · user chip |

## Contextual elements

| Element | Appears when |
|---|---|
| `AdminModeBanner` | admin mode is on — resets on every launch by design (`docs/tauri.md`) |
| `EnforcementStrip` | a workspace enforcement is active (`enforcementStore`) |
| `InviteNotice` | a pending invite is redeemable |
| `FinishSetupBanner` | onboarding was abandoned |
| `RoleRefusal` | the role cannot reach the current surface |
| `WorkspaceSwitchLock` | a workspace switch is in flight |
| `McpConfirmModal` | an MCP tool call needs confirmation |
| `CodeOverlay` | the `code` right-tab is selected |

## Data displayed

Agent name and slug; lifecycle state; the selected provider/model; connection state; deployed count;
the agent list with per-agent lifecycle glyphs; the run list with a count.

## Interactive elements

Everything in [`../../../navigation/sidebar.md`](../../../navigation/sidebar.md), plus the composer
(documented in [`../../../components/inputs.md`](../../../components/inputs.md)) and the right
panel's ten tabs.

## State list

| State | Screenshot |
|---|---|
| default, agent selected | `agent-selected.png` |
| default, thread open | `default.png` |
| empty / first use | `empty-first-use.png` |

The **empty/first-use** state is materially different: the sidebar reads `No agents yet` and
`No runs yet`, the centre pane becomes a **NEW AGENT** column with connector chips, and the composer
placeholder changes to describe an agent rather than a change.

## Related screens

Every destination; every right-panel tab.

## Implementation references

| Concern | File |
|---|---|
| Shell | `client/src/App.tsx` |
| Panes | `react-resizable-panels`; floors in `client/src/lib/paneFloor.ts` |
| Sidebar | `client/src/components/Sidebar.tsx` (50 KB) |
| Centre | `client/src/components/BuildPane.tsx` (134 KB — the largest file in the client) |
| Right panel | `client/src/components/RightPanel.tsx` |
| TopBar / StatusBar | `client/src/components/TopBar.tsx`, `StatusBar.tsx` |
| Window sizing | `src-tauri/src/window.rs:25-33` |
