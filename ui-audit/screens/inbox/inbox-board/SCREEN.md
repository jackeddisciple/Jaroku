# SCREEN — Inbox

| | |
|---|---|
| **Screen ID** | `INB-01` |
| **Screen name** | Inbox |
| **Route / path** | `navView = "inbox"` (rail item 4) |
| **Parent area** | Inbox |
| **Purpose** | What is waiting on **you**, as a board of items to answer |
| **Primary user goal** | Clear the things only a person can decide |

**The Inbox is the fourth destination and it is not Memory.** `FullScreenView.tsx:12-16` records that
v0.3.0 named the fourth tab Memory, that nothing was ever built behind it, and that what shipped
instead is *"the surface the idea was for — a memory Jaroku proposes from a failure → fix → pass
triple is an ITEM on this board, answered where it is raised, rather than a tab somebody has to go
and read."*

## Composition — three lanes and a lane rail

| Region | Contents |
|---|---|
| Header | `INBOX <count>` · refresh |
| **Lane rail** (left, 32px) | five icons with counts: inbox · alert · shield · sparkles · clock |
| **BLOCKING** | items that stop work — count in the header |
| **ATTENTION** | *Nothing to look at* |
| **PROPOSALS** | *Nothing to decide* |

Each lane has its **own** empty sentence, and the two observed differ by verb — *look at* vs
*decide* — which is the same discipline the Cockpit's three empty states follow.

## Card anatomy

A card is a title, a relative time, a hairline, and an action row. The one observed:

> 🔑 **Add a provider key to start building**
> 2d ago

## The Cockpit pointer

`CockpitPointer.tsx` renders **at the top of this board**, above the lanes, when at least one
deployed job is `waiting`:

> ⌂ **1** deployed job **is** waiting on an answer — *in the Cockpit* ›

It renders a count and a destination **and nothing else** — deliberately thirty lines of markup
rather than a card:

> The moment it rendered the tool being asked about, or an Allow button, there would be two places
> one confirmation can be answered — and worse than a duplicated surface, the two would race for one
> nonce and the loser would report a failure for a question that had been answered correctly.

`IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — nothing is `waiting` in the seed.

## Interactive elements

Cards (click to expand) · lane-rail filters · per-card actions (`InboxCardActions.tsx`) ·
drag between lanes (`useInboxDrag.ts`) · an undo toast (`InboxUndoToast.tsx`).

Full keyboard grammar: `j`/`k`/`↵`/`e`/`x`/`s`/`Esc`/`/`/digits/`⌘Z` — see
[`../../../navigation/keyboard.md`](../../../navigation/keyboard.md). **This board and Threads are
the two with a complete row grammar; the Cockpit's list is the one without.**

## Undo

`⌘Z` and a toast. The toast is honest about the socket: an earlier version *"claimed forty items
were dismissed over a socket that silently dropped the command"* (`lib/socket.ts:1986`), so the
notice now follows the send rather than preceding it.

## State list

| State | Screenshot | Notes |
|---|---|---|
| empty | `empty.png` | The `adarsh@jaroku.dev` workspace |
| one blocking item | `default.png` | Observed |
| card expanded | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `InboxCard.tsx`, `InboxEvidence.tsx` |
| attention / proposals populated | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — 9 rows exist in `inbox_items`, all `BLOCKING`-kind |
| dragging | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `useInboxDrag.ts` |
| undo toast | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `InboxUndoToast.tsx` |
| Cockpit pointer | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `CockpitPointer.tsx:34` |

## Implementation references

`InboxView.tsx` (28 KB) · `InboxCard.tsx` · `InboxCardActions.tsx` · `InboxActions.tsx` (25 KB) ·
`InboxEvidence.tsx` · `InboxTray.tsx` · `InboxUndoToast.tsx` · `CockpitPointer.tsx` ·
`inboxIcons.tsx` · `useInboxKeys.ts` · `useInboxDrag.ts` · `store/inboxStore.ts` ·
`lib/inboxBoard.ts` · channel `inbox` · `server/src/inbox/`
