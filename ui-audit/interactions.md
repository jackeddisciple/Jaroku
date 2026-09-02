# Interaction inventory

For the important ones: **trigger → visible response → state change → navigation → loading →
success → failure → recovery.**

---

## The Cockpit's verbs

### Dispatch

| | |
|---|---|
| **Trigger** | `⌘↵` or the send button in either the Cockpit or an operate composer |
| **Visible response** | the **pre-flight gate** opens over a scrim |
| **State change** | none until confirmed |
| **Navigation** | none |
| **Loading** | an optimistic row reading `Sending…` — *NOT OBSERVED* |
| **Success** | the row moves `queued → running → succeeded` — *NOT OBSERVED* |
| **Failure** | the composer's text is **put back**, and the product says so: *"That was refused, so what you typed is back in the box."* |
| **Recovery** | retype, or `Retry` from the detail |

### Confirm at the gate

Trigger `Dispatch it` — **not** the default focus. `Esc` and `Cancel` both dismiss; the composer
keeps its text. **Observed: cancelled.**

### Cancel a running job

Trigger `Stop` in the work detail. A **single press, no dialog**, deliberately — it is scoped to one
item on screen. Disabled with a stated reason without `run:execute`.
`IMPLEMENTED / NOT CURRENTLY OBSERVABLE`.

### Retry a finished job

Trigger `Retry` in the work detail. Present and enabled on both observed failures. Disabled with a
stated reason without `run:execute`.

### Filter by agent from a fleet card

| | |
|---|---|
| **Trigger** | click the fleet card's body (an `absolute inset-0` button *behind* the content) |
| **Visible response** | the card gains a ring; an `Only Tracey ×` chip appears in the filter bar |
| **State change** | `workStore.filters.agentId` |
| **Side effect** | **the agent column disappears from every row** — it is redundant once filtered |
| **Recovery** | the chip's `×`, or `Show every agent` |

**Observed.**

### Clear a filter

Trigger the chip's `×`. Also cleared as a **side effect of following a citation**, which is
unannounced. **Observed.**

### Open detail

Trigger click a row (the row is one `<button>`; controls sit outside it so nothing swallows the
click). The panel slides over the list; the list stays live and clickable. **Observed.**

### Close detail, and where focus returns

Trigger `×` or `Escape`. **Focus returns to the row that opened it**, from anywhere inside the panel
(`WorkDetail.tsx:234-256`). **Observed.**

### Follow a citation

| | |
|---|---|
| **Trigger** | click an inline citation chip in an operate thread |
| **Visible response** | the view becomes the Cockpit |
| **State change** | the work item loads; its row highlights; the detail panel opens |
| **Side effects** | the agent filter is **cleared**; the dispatch composer's text is **cleared** |
| **Recovery** | none offered — no "back" |

**Observed.**

### Answer an approval

`IMPLEMENTED / NOT CURRENTLY OBSERVABLE`. One answering surface (`McpConfirmModal`), one pointer
(the Inbox strip).

### Reconnect · Kill

Trigger the fleet card's `⋮` → the item. **Both unreachable** — the menu is clipped.
Each opens a `CockpitDialog`; `Cancel` is never the default focus; Kill's dialog names the agent.

---

## Elsewhere in the product

| Interaction | Trigger | Response | Notes |
|---|---|---|---|
| **Click** a thread row | click / `↵` | opens it, collapses the board | `navView → null`, `navSection` kept |
| **Hover** an agent card | pointer | reveals a two-line thread preview and the model chip | a real state change, not a highlight |
| **Focus** | Tab | `FOCUS_RING` — one value everywhere | |
| **Keyboard** | see [`navigation/keyboard.md`](navigation/keyboard.md) | | |
| **Drag/drop** | Inbox cards between lanes | `useInboxDrag.ts` | not observed |
| **Resize** | drag a pane seam | 1px painted, 5px hit, grip on hover | observed |
| **Expand/collapse** | FILES, VERSION HISTORY, a trace step, the composer ⛶ | | observed |
| **Inline editing** | the pencil on agent detail | rename | not observed |
| **Copy** | the job-id chip — *"Copy this job's id"* | | observed as a control |
| **Delete** | secrets, members, connectors | | not observed |
| **Archive** | `e` on a thread; `Archive` on an agent card | **immediate, no modal**, notice after | observed as controls |
| **Duplicate / Fork** | `Fork` on an agent card, ⧉ | | observed as controls |
| **Retry** | work detail | | observed |
| **Undo / redo** | `⌘Z` in the Inbox | a toast | not observed |
| **Run** | `r`, or Test-mode send | | gated by `bareKeys` |
| **Stop / pause / resume** | trace controls | | not observed |
| **Deploy** | the TopBar's `Deploy`, or the Deploy panel | | observed as controls |
| **Publish / rollback** | agent versions | | not observed |
| **Approve / reject** | `McpConfirmModal`, plan gate | | not observed |

## Two interaction rules the product states about itself

**The row is the target, and controls sit outside it.** *"A button nested in a button is a hit area
that swallows the row's own click, which is the bug the Inbox's `view_evidence` control had."*
(`WorkList.tsx:112-115`)

**The whole strip is the target for a one-sentence pointer.** *"a hit area smaller than the thing it
describes is a control people miss."* (`CockpitPointer.tsx:36-38`)
