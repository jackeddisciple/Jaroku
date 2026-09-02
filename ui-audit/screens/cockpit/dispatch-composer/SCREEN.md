# SCREEN — Dispatch composer

| | |
|---|---|
| **Screen ID** | `CKP-06` |
| **Screen name** | Dispatch composer |
| **Route / path** | band 5 of the Cockpit, pinned to the bottom |
| **Parent area** | Cockpit |
| **Purpose** | Give a deployed agent a real job |

## Anatomy

Two lines and nothing else:

```
Tracey — will run for real
┌──────────────────────────────────────────────────────────┬───┐
│ Give Tracey a real job…                                  │ ➤ │
└──────────────────────────────────────────────────────────┴───┘
```

The destination label is **visible before sending, not after** (`BuildPane.tsx:2068`), and it says
what will happen rather than naming a mode.

## Every label it can wear

`cockpitCopy.ts:189-210`:

| Condition | Placeholder | Status line |
|---|---|---|
| ready | `Give <agent> a real job…` | — |
| no agent | `Pick an agent first` | — |
| unconnected | `This agent is not connected` | *Reconnect it before giving it work.* |
| busy | `This agent is at capacity` | *It is already running as many jobs as it allows.* |
| forbidden | `You cannot dispatch work in this workspace` | *Dispatching a job needs the run:execute capability.* |
| in flight | `Sending…` | *Sending it now.* |

On refusal the typed text is **put back in the box**, and the product says so:
*"That was refused, so what you typed is back in the box."*

## How it differs from the build composer

It has **no `⊕`, no expand, no `⋯`, no model picker, no Chat/Test toggle and no microphone** — an
input and a send button. Compare
[`../../threads/build-thread/default.png`](../../threads/build-thread/default.png).

Two composers that look alike and do very different things — see
[`../../../findings/inconsistencies.md`](../../../findings/inconsistencies.md).

## Observed behaviour

- Text survives cancelling the gate.
- Text is **cleared** when a citation navigates into the Cockpit from an operate thread.

## State list

| State | Screenshot |
|---|---|
| ready, empty | [`../work-list/default.png`](../work-list/default.png) |
| filled | `filled.png` |
| gate open | [`../preflight-gate/modal-open.png`](../preflight-gate/modal-open.png) |
| in flight / unconnected / busy / forbidden | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `cockpitCopy.ts:191-208` |

## Implementation references

`WorkComposer.tsx` · `lib/cockpitComposer.ts` · `cockpitCopy.ts:189-224` · `WorkGate.tsx` ·
`store/workStore.ts` · `server/src/work/dispatcher.ts`
