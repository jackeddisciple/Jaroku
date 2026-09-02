# Components — containers

| Component | Source | Purpose |
|---|---|---|
| `Card` | used by `ActivityCards.tsx` and others | a titled surface with an icon, context line and a freshness slot |
| `CollapsibleRegion` | `CollapsibleRegion.tsx` | FILES, VERSION HISTORY |
| `Panel` / `PanelGroup` | `react-resizable-panels` via `App.tsx` | the resizable columns |
| `FullScreenView` | `FullScreenView.tsx` | a destination replacing centre + right |
| `RightPanel` | `RightPanel.tsx` | the ten-tab host |
| `WorkspacePanel` | `WorkspacePanel.tsx` | the six-section overlay |
| `EmptyState` | `EmptyState.tsx` | `full` and `line` variants |

## Radius — four steps, chosen by size

`tokens.ts` `RADIUS`. The rule that picks between them is **size, not component type**, because a
corner radius reads as a proportion of the box it turns:

| Step | px | For |
|---|---|---|
| `chip` | 4 | chips, badges, inline code — under ~22px tall |
| `control` | 6 | buttons, inputs, tabs, rows, popover items — 24–36px |
| `card` | 10 | cards, popovers, panels |
| `modal` | 14 | modals and the composer |

Four, because *"the app has four sizes of box and no more."* It had nine before, *"which is how a
composer card ended up 6px rounder than the popover that opens out of it."* A pill is not on this
scale — something whose radius is half its height is a **shape**, and stays `rounded-full`.

## Elevation — four steps, each a hairline plus a shadow

| Step | For |
|---|---|
| `flat` | a section boundary, not a raised object |
| `raised` | cards, rows that own their content |
| `floating` | popovers, the step-detail panel, the code overlay |
| `overlay` | modals, and the app shell against the desktop |

Never a shadow alone. See [`../legacy/design-arguments.md`](../legacy/design-arguments.md).
