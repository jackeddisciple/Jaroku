# SCREEN — Build thread

| | |
|---|---|
| **Screen ID** | `THR-02` |
| **Screen name** | Build thread (`threads.mode = 'build'`) |
| **Route / path** | the centre pane, with a build thread selected |
| **Parent area** | Threads |
| **Purpose** | Describe an agent or a change to one, review what comes back, apply it |
| **Primary user goal** | Change the agent and see the diff before it lands |

## The centre pane

Header reads `FIX <agent>`. Empty state:

> **Describe a change to Tracey**
> You'll get a reviewable diff to apply or discard. Nothing is changed until you apply it.

## The composer — the build variant

Left group, then right group:

| Control | Purpose |
|---|---|
| `⊕` | attach — files, runs, commits (`⌘/`) |
| ⛶ | expand to the modal composer |
| `⋯` | composer settings — reasoning effort, permission mode |
| `○ Dry run (free) ⌄` | **the model picker** |
| `Chat \| Test` | **the send-mode toggle** |
| 🎤 | voice input (`useVoiceInput.ts`) |
| ➤ | send (`⌘↵`) |

`Chat` talks to Jaroku — generate, edit, explain. `Test` sends the agent's own runtime input and
produces a **Run** (`uiStore.ts:75-78`). The last Test input is remembered per agent **and per
workspace** — agent slugs stopped being globally unique in Session 1, so a workspace-blind key
named two different agents belonging to two different tenants (`uiStore.ts:84-90`).

## What a build thread can hold that an operate thread cannot

Plan cards, diff cards, generation streams, file-write streams, the review region, and the
apply/undo controls. `BuildPane.tsx:2491` states it plainly: *"an operate thread cannot HOLD a
plan or a diff."*

## Data displayed

The message stream; the plan and its approval gate; the diff and its hunks; token counts and cost
per turn; the no-provider-key notice.

## State list

| State | Screenshot | Notes |
|---|---|---|
| empty / new | `default.png` | Observed |
| planning | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — needs a provider key |
| plan ready | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `ReviewRegion.tsx`, fixtures exist |
| generating | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `buildStore` `fileStart/fileDelta/fileEnd` |
| diff proposed | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `DiffCard.tsx`, `SemanticDiff.tsx` |
| applied / undone | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `edit` channel |
| error | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `ProblemsPanel.tsx` |

## Implementation references

`BuildPane.tsx` (134 KB) · `components/composer/` · `ReviewRegion.tsx` · `DiffCard.tsx` ·
`DiffBar.tsx` · `SemanticDiff.tsx` · `ProblemsPanel.tsx` · `store/buildStore.ts`, `chatStore.ts` ·
channels `gen`, `edit`, `reply`, `history`
