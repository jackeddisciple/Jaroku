# SCREEN — Pre-flight gate

| | |
|---|---|
| **Screen ID** | `CKP-07` |
| **Screen name** | Pre-flight gate |
| **Route / path** | a modal, from either composer's send |
| **Parent area** | Cockpit |
| **Purpose** | Show what is about to happen before money moves |

![The gate](modal-open.png)

## Contents, in §8's order

```
Run this for real?

Tracey
v3 · claude-haiku-4-5 on anthropic
┌────────────────────────────────────────────┐
│ reconcile the Q3 ledger and post a summary │
└────────────────────────────────────────────┘

                            Cancel   Dispatch it
```

1. the agent
2. the deployment version · the model · the provider
3. *(only when the endpoint is public)* **its URL is public, so anyone holding it can spend the
   same key** — in `STATUS.warn`
4. **the first line** of the input, truncated with the full text as a title

## Three decisions worth recording

**It names what will happen and not what it will cost**, deliberately (`WorkGate.tsx:27-32`):

> Nothing can honestly predict the cost of a job whose graph has not run — the eval estimator works
> because it has a dataset and a history, and this has one sentence somebody just typed. A confident
> figure here would be the one number on this surface that was made up, on the tab whose whole
> argument is that its numbers are real.

**A deployment with no recorded version says so** rather than guessing one. A row written before
migration 041 has no record of which version it ran, *"and a confident 'v1' would be a lie about
somebody's production on the one screen asking them to spend money."*

**Only the first line** is shown, because the point is recognition — *"yes, that is the job I
meant"* — rather than review. A gate rendering a 600-line pasted email is a dialog somebody scrolls.

## One gate, two composers

There is exactly **one** copy of this component. The Cockpit's composer and the operate thread's
composer both render it (`WorkGate.tsx:1-12`). A second copy would be the second confirmation the
spec forbids, *"and the one that drifts is always the copy somebody made for the newer surface."*

An ambiguous message classified as a **command** still meets this gate — that is the answer to
classification uncertainty, and there is deliberately no second dialog beside it.

## Focus

`Dispatch it` is **not** the default focus (`cockpitCopy.ts:220-221`). `Cancel` is never the default
focus on any Cockpit dialog.

## State list

| State | Screenshot |
|---|---|
| open | `modal-open.png` |
| public-URL warning | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `WorkGate.tsx:56-58` |
| unrecorded version | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `GATE.unrecordedVersion` |

**No job was dispatched during this audit.** The gate was opened and cancelled.

## Implementation references

`WorkGate.tsx` · `CockpitDialog.tsx` · `cockpitCopy.ts:218-224` · `WorkComposer.tsx` ·
`BuildPane.tsx:2590-2594`
