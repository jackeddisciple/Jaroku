# Flow — reconnect an agent whose token is wrong

**Goal.** An agent is `unconnected` or `unauthorised`; rotate its token and bring it back.

> **⚠ This flow is BLOCKED BY A DEFECT, not only by the environment.**

---

## What should happen

| # | Step | Evidence |
|---|---|---|
| 1 | A job fails with `unauthorised` — *"The stored token is wrong. **Reconnect this agent.**"* | `cockpitCopy.ts:119` |
| 2 | The fleet card's sentence is **replaced** with `Not connected` — never appended | `lib/fleetSentence.ts` |
| 3 | Open the card's `⋮` | `FleetStrip.tsx:137-150` |
| 4 | Choose `Reconnect` | `FleetStrip.tsx:184-189` |
| 5 | A dialog warns: *"This will briefly take the agent offline: setting the token on Railway restarts the service, and any run in flight — including a paused one — loses its checkpoint."* | `cockpitCopy.ts:240-247` |
| 6 | Confirm `Reconnect anyway` | `sendReconnectAgent(deployment_id)` |
| 7 | The card shows the restart | — |

## ⚠ Step 3 does not work

The overflow menu is clipped by the fleet card's own `overflow-hidden` (`FleetStrip.tsx:306`), so
**`Reconnect` is not visible and cannot be clicked.**

The failure sentence at step 1 tells the operator to reconnect the agent. The control it names is
unreachable from the screen that names it.

Reconnect is deliberately offered at **every** connection state, not only `unconnected`, because *"a
token can be rotated on Railway under a card that still reads `connected`, and the repair has to be
reachable before the first job fails to prove it."* That intent is sound and the clip defeats all of
it.

## Permissions

`<Capable cmd="reconnectAgent">` → **absent** when the role lacks `deploy:manage`.
`REFUSAL.reconnect` exists — *"Reconnecting an agent needs the deploy:manage capability."* — and is
**never used**.

## Offline warning during the restart

`OFFLINE` in `cockpitCopy.ts:173` · `IMPLEMENTED / NOT CURRENTLY OBSERVABLE`.

## Unresolved gaps

Steps 3–7. Blocked by the clipping defect **and** by having no reachable container.
