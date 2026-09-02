# States — errors

## The shape

**A title that names what failed, a cause in the product's own words, and — where one exists — a
recovery control.** Jaroku does not show error codes to users.

## Observed

### Graph — could not be drawn

> **This graph could not be drawn**
> this agent has no published version to build a graph from
> `Try again`

Title · cause · recovery. The cause is a product fact, not an exception.

### Session expired

> your session expired

Rendered as a notice above the sign-in form, in the form's own card.

### Cockpit — six failure sentences

The product's most careful error copy. **Each names the thing and then the action**
(`cockpitCopy.ts:118-126`):

| Kind | Sentence |
|---|---|
| `unauthorised` | The stored token is wrong. **Reconnect this agent.** |
| `agent_error` | The agent raised an error. **The trace opens on the failing step.** |
| `rejected` | Jaroku sent something this agent refused — **this is a bug on our side.** |
| `unreachable` | The container could not be reached. |
| `stopped_reporting` | The container stopped reporting. **It may have completed, and it may have spent money.** |
| `busy` | The agent was at capacity. |

Two of these are unusual and worth keeping:

- **`rejected` blames the product.** *"this is a bug on our side"* — the product takes the fault
  rather than reporting a failure the user cannot act on.
- **`stopped_reporting` refuses to be confident.** It is the absence of an observation rather than
  an observation, so it hedges in both directions, and the detail panel expands the hedge:
  *"Whatever steps are on this trace really happened — their cost is real — but nothing is known
  about what came after them."*

### The refused dispatch

> That was refused, so what you typed is back in the box.

An error that states the recovery **as a fact that has already happened**.

## ⚠ Where an error is not shown

**An operate thread with `status = 'errored'` renders no error at all.** The seeded thread shows
eleven unanswered questions with no notice, no retry and no explanation, while the Threads board row
for the same thread shows a red glyph and the word `failed`. The list knows; the conversation does
not. See [`../screens/threads/operate-thread/SCREEN.md`](../screens/threads/operate-thread/SCREEN.md).

## Not observable

| Error | Evidence |
|---|---|
| Backend died | `BackendFailure.tsx`, `lib/hostBackend.ts` |
| Socket disconnected mid-run | `store/diagnosticsStore.ts`, `server/src/liveDiagnostics.ts` |
| Generation / validation failure | `ProblemsPanel.tsx`, `server/src/validator.ts` |
| Entitlement refusal | `store/entitlementStore.ts` — answered **on the channel the command belonged to**, so each surface shows its own refusal |
| Connector failure | `server/src/connectorLoop.test.ts` |
