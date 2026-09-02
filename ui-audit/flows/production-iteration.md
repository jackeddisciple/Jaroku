# Flow — iterate on something already in production

**Goal.** A deployed agent is misbehaving; change it and get the change live.

## The route, as the product composes it

| # | Step | Surface | Observed |
|---|---|---|---|
| 1 | Notice the failures | Cockpit work list | ✓ |
| 2 | Read one | work detail | ✓ |
| 3 | `Open the trace` | trace tab | route confirmed |
| 4 | Find the failing step | trace | ✗ |
| 5 | Describe the fix | **build** thread | ✓ (surface) |
| 6 | Review the diff | `DiffCard` | ✗ |
| 7 | Apply | — | ✗ |
| 8 | Publish a version | agent detail → Versions | ✗ |
| 9 | Deploy | Deploy panel | ✗ |
| 10 | The fleet card's version changes | fleet strip | ✗ |

## ⚠ The seam this flow exposes

Steps 1–4 happen in the **Cockpit**, steps 5–8 in **Threads / agent detail**, step 9 in **Deploy**,
step 10 back in the **Cockpit**. Four areas, and the only automatic hand-off is step 3.

There is **no control anywhere in the Cockpit that says "fix this agent"** — no route from a failing
job to a build thread for the agent that failed. The `#` opens an *operate* thread, which explicitly
cannot hold a diff.

And at step 10 the two ends of the loop disagree about what version is live: the fleet card says
`v3`, agent detail says `v1`. See [`../findings/inconsistencies.md`](../findings/inconsistencies.md) §2.

## Unresolved gaps

Steps 4–10 need a provider key and a Railway token.
