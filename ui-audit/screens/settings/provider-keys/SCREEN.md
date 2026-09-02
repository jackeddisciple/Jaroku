# SCREEN — Provider keys

| | |
|---|---|
| **Screen ID** | `SET-02` |
| **Screen name** | Provider keys |
| **Route / path** | popover; `uiStore.providerPanelOpen` |
| **Parent area** | Settings |
| **Purpose** | Which model provider this workspace runs on, and whether a key is present |

## Entry points

- The **gear at the foot of the icon rail** (`Sidebar.tsx:457`)
- The composer's model chip
- The command palette's `PROVIDER` group
- `Add a key` in the composer's no-key notice

## The anchoring problem

The gear sits at the **bottom-left** of the window. The popover it opens is anchored to the
**`Dry run (free)` control in the top-right**, roughly 1300px away. The control that opened it and
the surface that appeared share no edge and no visual link. Recorded in
[`../../../findings/ux-debt.md`](../../../findings/ux-debt.md).

## Data displayed

Four providers — Claude, OpenAI, Gemini, Dry run (free) — each with whether a key is present. The
key value is never rendered.

## State list

| State | Screenshot |
|---|---|
| popover open, no keys | `popover-open.png` |
| a key present | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — no key configured |

## Implementation references

`Sidebar.tsx:454-463` · `store/providerStore.ts` · `lib/providerKeys.ts` · `lib/bareKeys.ts` ·
channel `providers` · keys land in `runtime/.env`
