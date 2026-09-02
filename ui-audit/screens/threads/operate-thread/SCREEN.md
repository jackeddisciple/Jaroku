# SCREEN — Operate thread

| | |
|---|---|
| **Screen ID** | `THR-03` |
| **Screen name** | Operate thread (`threads.mode = 'operate'`) |
| **Parent area** | Threads — but reached from, and about, the Cockpit |
| **Purpose** | Ask a deployed agent what it has done, or give it a job, in one conversation |
| **Primary user goal** | Find out what happened without reading a work list |

**This is a different screen from a build thread even though it reuses the component.** The brief
asks for the difference to be documented carefully, because the difference *is* the screen.

## Entry points

- The **`#` control on a Cockpit fleet card** — the only entry point in the product
  (`FleetStrip.tsx:353-377`, `sendCreateThread(agent_id, agent_name, "operate")`)
- The Threads board, once one exists — the row carries the word `operate`

## Exit points

- A **citation chip** → the Cockpit, with that work item's detail panel open
- `⌘ Open the job` on a dispatch row → the same
- The rail

## Build vs operate — the whole difference

| | Build thread | Operate thread |
|---|---|---|
| Composer placeholder | `Describe a change to Tracey — ⌘↵ to send` | `Ask Tracey what it has done, or give it a job — ⌘↵ to send` |
| `Chat \| Test` toggle | **present** | **absent** |
| Model picker (`Dry run (free) ⌄`) | **present** | **absent** |
| `⊕` attach | present | present |
| Expand ⛶ | present | present |
| `⋯` settings | present | present |
| Mic | present | present |
| Intent label above the composer | none | **`This reads the record`** / **`This will run Tracey`** |
| Can hold a plan card | yes | **no** — `BuildPane.tsx:2491` |
| Can hold a diff card | yes | **no** |
| Pre-flight gate | no | **yes** — the same `WorkGate` the Cockpit composer uses |
| Centre header | `FIX <agent>` | **`FIX <agent>` — unchanged** |

The last row is a finding. The header over an operate conversation still reads **FIX**, the word for
the build surface. See [`../../../findings/inconsistencies.md`](../../../findings/inconsistencies.md).

## The intent label — the most interesting control on the screen

Every keystroke is classified by `lib/operateIntent.ts` into **question** or **command**, and the
label above the composer says which *before* you send:

- a question → `This reads the record` (faint)
- a command → `This will run Tracey` (accent)

The classifier's rung order is the design (`operateIntent.ts:130-143`):

1. An empty message is reported as a **question**, because that is the harmless one.
2. A polite wrapper plus an action verb is a **command** however it is punctuated — *"Could you
   please cancel that order?"* is not a question about cancellation.
3. **A phrase that is *about* the record beats any verb inside it.** This is the rung that stops
   *"did you send the invoice?"* from sending an invoice, and it is the most important one.
4. A question opener is a question.
5. A question mark is a question, and it sits **above** the imperative check on purpose — *"send
   the invoice?"* is as often thinking aloud as a terse instruction, and ties are decided in favour
   of the reading that spends nothing.
6. An action verb in first position is a bare imperative — a command.
7. Anything else is a question, weakly.

The asymmetry is deliberate: reading the record is free and running the agent spends money and
touches the world, so the two labels carry different weight (`operateIntent.ts:198-207`).

A message classified as a **command** still meets the pre-flight gate. There is deliberately no
second confirmation beside it (`WorkGate.tsx:1-12`).

## The four states of the conversation

### 1. Answered from the record, with citations — `answered-with-citations.png`

Asked *"what happened with the September invoice?"*, the thread answered:

> I was asked to send the September invoice to Acme `⌘ failed`, but the container stopped reporting
> during that job. The error means it may have completed and sent the invoice, or it may not have —
> I have no record of what happened after the job started. The job ran for over 17 minutes before
> stopping `⌘ failed`.

Two inline **citation chips**, each carrying the cited item's status word. Both are live links.

### 2. The record cannot answer — `record-cannot-answer.png`

**The single most important state on this surface.** Asked *"how many customers are on the
enterprise tier?"*:

> I have no record of that. None of the jobs I was asked to do involved looking up customer tiers or
> enterprise subscriptions.

It refuses, names what it does not have, and does not guess.

### 3. A command routed to a live agent

`IMPLEMENTED / NOT CURRENTLY OBSERVABLE`. Reachable — the gate opens — but confirming would
dispatch to a container that does not answer. `BuildPane.tsx:1494-1500`, `WorkGate.tsx`.

### 4. A job answered from inside the thread

`IMPLEMENTED / NOT CURRENTLY OBSERVABLE`. Needs a `waiting` work item; none exists.

## Dispatch rows

A job given from this thread appears as a row: `Gave the agent a job. [⌘ Open the job]` — Jaroku's
own voice, not the agent's, with a chip into the Cockpit. Five are in the seed.

## Observed defect — an errored thread says nothing about it

The seeded thread `6fe64cb0` has `status = 'errored'` and holds **eleven user messages and five
dispatch rows, and not one assistant reply** (verified in `thread_items`). The conversation renders
eleven unanswered questions in a row with no error, no retry and no explanation — while the Threads
board row for the same thread correctly shows a red glyph and the word `failed`.

The list knows. The conversation does not. `default.png` is that state.

## Screenshot index

| File | State |
|---|---|
| `default.png` | The seeded thread — eleven questions, no answers, no error |
| `answered-with-citations.png` | Answered from the record, two citation chips |
| `record-cannot-answer.png` | The refusal state |

## Implementation references

| Concern | File |
|---|---|
| Pane | `BuildPane.tsx:1134` (`operating`), `:2030`, `:2068-2083`, `:2484-2491`, `:2590-2594` |
| Intent | `client/src/lib/operateIntent.ts` + `operateIntent.test.ts` |
| Gate | `client/src/components/WorkGate.tsx` |
| Copy | `client/src/lib/cockpitCopy.ts:189-224` |
| Citations | `server/src/work/citations.ts`, `factPack.ts`, `honesty.ts` |
| Thread mode | `server/src/threadMode.test.ts`, `threads.mode` column |
| Store | `client/src/store/chatStore.ts`, `threadStore.ts`, `workStore.ts` |
