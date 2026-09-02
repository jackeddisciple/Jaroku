# Flow — a job stops for a human decision

**Goal.** A deployed job needs a person, and a person answers it — from **both** the work list and
the operate thread.

> **⚠ This flow could not be observed.** No work item in the seed has `status = 'waiting'`, and the
> deployment does not answer, so no job could be made to stop for a decision. Everything below is
> read from source and is marked `IMPLEMENTED / NOT CURRENTLY OBSERVABLE`. **Nothing was simulated.**

---

## What the design says happens

| # | Step | Evidence |
|---|---|---|
| 1 | A job reaches `waiting` | `cockpitCopy.ts:139` — the status word is **"waiting on you"**, not "waiting", because *"'waiting' alone leaves the reader to guess whether the machine or a person is the blocker — and it is always a person"* |
| 2 | The row gains a **2px amber edge marker** | `WorkList.tsx:96-111` — and it is the **only** status that gets one: *"a list where a fifth of the rows are marked is a list nobody scans"* |
| 3 | The **rail badge** increments | `workStore.workBadgeCount` |
| 4 | The **Cockpit header count** changes | same quantity, same snapshot |
| 5 | The **Inbox shows a pointer strip** — *"1 deployed job is waiting on an answer — in the Cockpit ›"* | `CockpitPointer.tsx:34` |
| 6 | The **live region announces it** — and announces nothing else | `WorkList.tsx:467` |
| 7 | The **window title** changes while backgrounded | `lib/windowTitle.ts`, `App.tsx` `backgrounded` |
| 8 | The person answers | — |

## Do the two paths use the same dialog?

**They do not use a dialog at all in the same sense, and this is the interesting part.**

The Inbox does **not** offer an Allow button. `CockpitPointer.tsx:3-12` records the decision:

> A deployed run waiting on an MCP confirmation is blocking in the Inbox's sense and waiting on you
> in the Cockpit's. **Pick one home — the Cockpit — and give the Inbox a pointer to it rather than a
> second card. Two boards showing the same thing is how both stop being believed.**

And the mechanical reason, which is stronger than the aesthetic one:

> The moment it rendered the tool being asked about, or an Allow button, there would be two places
> one confirmation can be answered — and worse than a duplicated surface, **the two would race for
> one nonce and the loser would report a failure for a question that had been answered correctly.**

So: **one answering surface, one pointer.** The Inbox path is a navigation, not a second dialog.

The confirmation itself is `McpConfirmModal.tsx`, mounted once in `App.tsx`.

## Unresolved gaps

Every step. This flow needs a real deployed agent that requests a high-impact tool call.
