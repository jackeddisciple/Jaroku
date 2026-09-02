# Flow — version an agent

| # | Step | Observed |
|---|---|---|
| 1 | Apply a change | ✗ |
| 2 | Publish a version | ✗ |
| 3 | Read VERSION HISTORY on agent detail | ✓ — *"Nothing has been published for this agent yet."* |
| 4 | The validator's verdict on the live version | ✓ — *"Nothing has been published, so nothing has been validated."* |
| 5 | Roll back | ✗ |
| 6 | Export a version | ✓ (control observed: `Export current version`) |

## ⚠ Two meanings of "version"

`agents.current_version` and `deployments.version` are different numbers with the same word on
screen. For the seeded agent they are **1** and **3**. See
[`../findings/inconsistencies.md`](../findings/inconsistencies.md) §2.
