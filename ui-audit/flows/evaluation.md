# Flow — evaluate an agent

**Goal.** Run an agent across a dataset and across providers, and compare.

| # | Step | Observed |
|---|---|---|
| 1 | Open the `evals` tab | ✓ (empty state) |
| 2 | Build a dataset | ✗ |
| 3 | Pick providers and models | ✗ |
| 4 | See the cost estimate | ✗ |
| 5 | Run | ✗ |
| 6 | Read the comparison grid | ✗ |
| 7 | Drill into one case | ✗ |
| 8 | Export | ✗ |

**Only step 1 was observable.** The engine needs a dataset **and** a provider key.

One design decision is recorded and worth carrying: an eval's runs are deliberately kept **off the
`trace` channel** (`lib/socket.ts:264`), so a fan-out across providers does not flood the panel
somebody is reading a single run in.
