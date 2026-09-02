# Components — overlays

## The layer scale

`tokens.ts` `LAYER` — six steps, named for what lives at each. It exists because there was no scale
at all and components picked `z-10` … `z-50` by eye:

> which is how an inbox row's overflow menu ended up at `z-10`, **below** the two panel layers it
> opens over, while an agent card's menu sat at `z-50`, **above** the full-screen code drawer.

| Step | Value | For |
|---|---|---|
| `content` | 0 | everything, unless it is one of the five below |
| `sticky` | 10 | a sticky section header, a column head |
| `panel` | 20 | a pane sliding over its own column |
| `menu` | 30 | dropdowns, popovers, context menus, and the scrim that dismisses them |
| `overlay` | 40 | a full-surface drawer with the page dimmed |
| `modal` | 50 | a modal that must be answered. The top, and nothing shares it |

⚠ **A z-index cannot escape a clipping ancestor**, and the fleet card's menu is the case where the
scale is respected and the result is still invisible.

## Inventory

| Component | Layer | Dismiss | Focus trap | Notes |
|---|---|---|---|---|
| `CommandPalette` | modal | `Esc`, select | yes (cmdk) | Scrim is `void` at a real opacity — *"a modal earns the strongest dim in the app: nothing behind it is meant to be read"* |
| `CockpitDialog` | modal | `Esc`, `Cancel` | yes | Confirming control is **never** the default focus |
| `WorkGate` | modal | `Esc`, `Cancel` | yes | Wraps `CockpitDialog`; **one copy, two callers** |
| `McpConfirmModal` | modal | — | yes | Mounted in `App.tsx`; unobservable |
| `GrantDialog`, `InviteWithGrantDialog` | modal | `Esc` | yes | Unobservable |
| `WorkspacePanel` | overlay | its `×` | — | Full-surface |
| `CodeOverlay` | overlay | close | — | The `code` right-tab |
| `WorkDetail` | panel | `×`, `Esc` | **no — deliberately** | `role="complementary"`; returns focus to its row |
| Provider keys popover | menu | `Esc`, outside | — | ⚠ anchored far from its trigger |
| Fleet card `⋮` | menu | `Esc`, outside | — | ⚠ **clipped** |
| Agent card `⋮` | menu | `Esc`, outside | — | Renders correctly outside the card |
| Composer `⋯` / `⊕` | menu | `Esc`, outside | — | |
| Workspace switcher | menu | `Esc`, outside | — | |

## The palette's own bug, recorded in its source

`Command.Dialog` spreads everything it does not name onto the `Command` **root**, which is a child of
the content — so the positioning the dialog needed was applied one level too deep and the card was
never painted (commit `370cf37`, and the comment survives at `CommandPalette.tsx:196-204`). Worth
knowing because it is the kind of bug a redesign on a different primitive will meet again.

⚠ **The palette's list is clipped with no scroll affordance** — see [`../findings/ux-debt.md`](../findings/ux-debt.md).

## Elevation

Every overlay is a hairline **plus** a shadow, never a shadow alone. See
[`../legacy/design-arguments.md`](../legacy/design-arguments.md) for why, and why the rule survived
a palette inversion with its reasoning reversed.
