# SCREEN — Fleet strip

| | |
|---|---|
| **Screen ID** | `CKP-04` |
| **Screen name** | Fleet strip |
| **Route / path** | band 2 of the Cockpit |
| **Parent area** | Cockpit |
| **Purpose** | Every deployed agent, each saying one true thing about itself |
| **Primary user goal** | *"Which of my agents is in trouble?"* |

## The card's sentence — the reason this is a strip and not a status page

`lib/fleetSentence.ts:1-8` states the brief and the failure mode:

> **"Get this wrong and the Cockpit is a status page."** … the failure mode is specific: a strip of
> twenty cards each reading the same word. A status enum rendered as a label is what the Railway
> dashboard already gives, and it is the reason somebody is opening Railway instead of this. So the
> property this module has to hold is not correctness — a status word is perfectly correct — it is
> **specificity**. Every card must say something that is true of it and not of the twenty beside it.

The sentence is **composed, not templated**: at most three clauses joined by a middot, in this
precedence:

1. **What is happening now** — *"2 running"*, *"3 queued"*
2. **What is waiting on the user** — *"1 waiting on you"*. This clause outranks everything except an
   outright failure, *"because it is the only clause the reader can act on"*, and it is never trimmed
3. **What last happened** — *"last job 4m ago"*, *"11 jobs today"*

When the agent cannot be reached the sentence is **replaced, not prefixed**: *"Not connected"* and
nothing else — because *"a card that says 'not connected · 11 jobs today' invites the reader to
wonder which half is current"*, and those counts are stale by construction.

Observed: **`last job 2d ago`** — clause 3.

## Card anatomy

| Slot | Content |
|---|---|
| name | agent display name, at `title` |
| `#` | opens the **operate thread** — `sendCreateThread(id, name, "operate")` |
| version | `v3`, or the connection label when it is not `connected` |
| line 2 | the composed sentence |
| line 3 | the health strip / sparkline (`AgentSparkline.tsx`) |
| top-right | `⋮` overflow |
| whole card | an `absolute inset-0` button **behind** the content — clicking filters the list to this agent |

The card-wide target sits *behind* rather than *around* the content, so the `#` and `⋮` are not
nested buttons (`FleetStrip.tsx:310-329`, `:366-369`).

## Connection states

`cockpitCopy.ts:88-96`: `connected` (no label) · `unconnected` · `unauthorised` · `public`.

`public` also adds a warning wherever money is about to move: *"anyone holding the URL can spend
this workspace's provider key"*, and it is repeated in the pre-flight gate (`WorkGate.tsx:56-58`).
Only `connected` was observable.

## Keyboard and semantics

`role="list"` / `role="listitem"`, a **roving tabindex** (`tabIndex={i === 0 ? 0 : -1}`) and an
arrow-key handler. The fleet strip is fully keyboard-traversable — the one Cockpit surface that is.

`overflow-x-auto` is on the **track**, not the page, so wide content scrolls inside its own box
(`FleetStrip.tsx:516`, `:538`), with a fade affordance. Overflow was not observable — one card.

## State list

| State | Screenshot | Notes |
|---|---|---|
| one card, `connected` | [`../work-list/default.png`](../work-list/default.png) | Observed |
| selected (filtering the list) | [`../work-list/filtered-by-fleet-card.png`](../work-list/filtered-by-fleet-card.png) | Observed — gains a ring |
| overflowing | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `FleetStrip.tsx:538` |
| `unconnected` / `unauthorised` / `public` | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `cockpitCopy.ts:88-96` |
| running / waiting clauses | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `lib/fleetSentence.ts` |

## Implementation references

`FleetStrip.tsx` (32 KB) · `lib/fleetSentence.ts` + `fleetSentence.test.ts` ·
`AgentSparkline.tsx` + `sparklineHits.test.ts` · `lib/cockpitLayout.ts` (`CARD_WIDTH`,
`CARD_HEIGHT`, `SPINE_X`) · `StatusBadge.tsx` (`StatusDot`)
