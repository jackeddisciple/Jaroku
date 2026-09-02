# SCREEN — Threads board

| | |
|---|---|
| **Screen ID** | `THR-01` |
| **Screen name** | Threads |
| **Route / path** | `navView = "threads"` (rail item 1) |
| **Parent area** | Threads |
| **Purpose** | Every conversation in this workspace, grouped and filterable |
| **Primary user goal** | Find the conversation that needs me |

## Entry points

Rail item 1 · command palette "Open Threads" · "Go to thread…" · `⌘N` (creates and opens one)

## Exit points

- Clicking a row → collapses to the three panes with that thread open
- `↵` on the cursor row → the same
- The rail → any other destination

## Main content regions

1. Header — `THREADS <count>`, a refresh control, a `+`
2. A `filter…` field, full width
3. Five chips: **All · Needs you · Running · Recent · Archived**, each with its count
4. The list, **grouped by day** with an uppercase group label (`NEEDS YOU`, `RECENT`, `30 AUG`)

## Row anatomy

| Slot | Content |
|---|---|
| glyph | `ThreadGlyph` — status mark on the spine |
| title | the thread's title, or its first message |
| meta | agent name · **mode** · status · cost |
| right | relative time |

**The mode is on the row.** A thread reads `Tracey · operate · failed · $0.01`. This is the only
place in the product where the build/operate distinction is visible in a list.

## Data displayed

Title, agent name snapshot, mode, status, cost, last activity.

## Interactive elements

Filter field · five chips · rows · refresh · `+`. Full keyboard grammar — see
[`../../../navigation/keyboard.md`](../../../navigation/keyboard.md).

## Plan / permission

None visible. The board is not gated.

## State list

| State | Screenshot | Notes |
|---|---|---|
| empty | `default.png` | The `adarsh@jaroku.dev` workspace |
| populated | `populated.png` | One operate thread, in `NEEDS YOU` |
| filtered, no matches | `filtered-empty.png` | `Nothing under Running` |
| archived | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — nothing archived in the seed |
| running | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — no run was in flight |

**A zero-count chip stays in place** (`useThreadKeys.ts:145-147`) so that the digits `1`–`5` remain
stable addresses.

## Interaction list

| Trigger | Response | State change |
|---|---|---|
| `e` on a row | archives **immediately, no modal** | row leaves; a notice names what was set aside |
| `p` on a row | pins the row's **agent**, not the thread | sidebar `PINNED` |
| `/` | focuses the filter | — |
| `1`–`5` | selects a chip by position | — |
| click a row | opens the thread, collapses the board | `navView = null`, `navSection` kept |

## Screenshot index

| File | State |
|---|---|
| `default.png` | Empty board |
| `populated.png` | One operate thread |
| `filtered-empty.png` | `Running` chip, no matches |

## Implementation references

`ThreadsView.tsx` · `ThreadRow.tsx` · `ThreadGlyph.tsx` · `ThreadFilterBar.tsx` ·
`useThreadKeys.ts` · `store/threadStore.ts` · `lib/threadFilter.ts`, `threadGroups.ts`,
`threadArchive.ts`, `threadCost.ts`, `threadNav.ts` · channel `threads`
