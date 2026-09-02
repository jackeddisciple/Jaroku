# States — destructive actions

Every destructive action found, with **the confirmation actually observed** and whether its weight
matches its consequence.

| Action | Where | Consequence | Confirmation observed | Weight matches? |
|---|---|---|---|---|
| **Dispatch a job** | Cockpit / operate composer | spends real money, touches the real world | **full pre-flight gate** naming agent, version, model, provider, and the input | ✓ |
| **Kill an agent's service** | fleet card `⋮` | ends a service Jaroku **cannot** restore | named dialog, `destructive`, last, behind a hairline | ✓ *(but unreachable — clipped)* |
| **Reconnect an agent** | fleet card `⋮` | restarts the service; in-flight runs lose their checkpoints | dialog, warning verbatim from the spec | ✓ *(but unreachable)* |
| **Stop a running job** | work detail | scoped to one item on screen | a single press, no dialog | ✓ — deliberately |
| **Approve a high-impact tool call** | `McpConfirmModal` | a production run acts on the world | a modal | not observable |
| **`Forget` a deployment** | Deploy panel | drops the record of live production | **no dialog observed** | ⚠ **no** |
| **`Deploy another`** | Deploy panel | spends money on real hosting | none beyond the button | ⚠ **no** |
| **Archive a thread** (`e`) | Threads board | reversible | **none** — immediate, notice after | ✓ — reversible |
| **Archive an agent** | agent card `⋮` | reversible | red menu item, no dialog observed | ✓ |
| **Delete a secret** | Secrets list | credential loss | not observable | unknown |
| **Remove a member** | Members | access loss | not observable — *ownership is transferred rather than dropped* (`socket.ts:1636`) | unknown |
| **Revoke a connector** | Connections | agents lose an account | not observable | unknown |
| **Delete workspace data** | Workspace → Data | irreversible | not observable | unknown |
| **Billing changes** | Workspace → Billing | money | leaves the window to Stripe | not observable |

## The graded ladder, and its stated reason

`cockpitCopy.ts:226-237`:

> **Giving all three the same confirmation teaches people to click through all three.** Stop is
> scoped to one item that is on screen, so it is a single press. Reconnect and Kill affect other
> people's jobs, so each gets a dialog — and Kill's names the agent, because a dialog that does not
> name what it is about is one somebody confirms over the wrong card.

## Is a destructive control ever focused by default?

**No.** `cockpitCopy.ts:220-221` and `WorkGate.tsx:24-26` are explicit that the confirming control is
not the default focus, and `Cancel` is never the default focus either. Checked on the pre-flight
gate at runtime: opening it and pressing `Esc` cancelled; nothing was dispatched.

## ⚠ The finding

The Cockpit's three consequences are graded carefully **against each other**. The Deploy panel's two
— `Forget` and `Deploy another` — are at least as consequential as `Reconnect` and carry no dialog
at all. **The ladder is local to the Cockpit rather than a property of the product.**
