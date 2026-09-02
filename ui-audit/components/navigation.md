# Components — navigation

| Component | Source | Purpose | Variants / states |
|---|---|---|---|
| Icon rail | `Sidebar.tsx:400-465` | five destinations + the gear | active · hover · focus · badged |
| Sidebar panel | `Sidebar.tsx` | workspace chip, AGENTS, PINNED, RUNS, user chip | populated · empty · filtered |
| `PaneDivider` | `App.tsx:88-101` | the seam between two panes | rest · hover (grip appears) · dragging |
| `TopBar` | `TopBar.tsx` | agent identity, provider, Deploy | per agent lifecycle |
| `StatusBar` | `StatusBar.tsx` | connection + deployed count | connected · disconnected |
| Right tab rail | `RightPanel.tsx:228-290` | ten tabs | active · hover · badged (GitHub, Secrets) |
| `FullScreenView` | `FullScreenView.tsx` | the five destinations, as a switch | — |
| `ThreadFilterBar` | `ThreadFilterBar.tsx` | five chips + a field | selected · zero-count (kept in place) |
| `CockpitPointer` | `CockpitPointer.tsx` | Inbox → Cockpit | renders **only** at count > 0 |
| `InboxPointer` | `InboxPointer.tsx` | agent detail → Inbox | the mirror of the above |
| `WorkspaceSwitcher` | `WorkspaceSwitcher.tsx` | move between workspaces | open · switching (`WorkspaceSwitchLock`) |

## The two pointers

`CockpitPointer` and `InboxPointer` are deliberately the **same component shape**, pointing in
opposite directions. That symmetry is not decoration:

> it is what makes "a pointer" a thing this codebase has rather than a thing each surface improvises.
> Nothing renders at zero, no empty state, no reserved space.

## Icon-only controls

Every one carries both a `title` and an `aria-label`. `RightPanel.tsx:255-259` states the rule:

> The tooltip is not decoration here — it is the label. A glyph nobody can name is worse than a text
> button.

The fleet card's `⋮` names its agent — `More for Tracey` — because *"twenty identical 'More' buttons
in a strip is twenty controls a screen reader cannot tell apart."*
