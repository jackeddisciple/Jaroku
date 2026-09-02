# SCREEN — Cockpit, no agents live

| | |
|---|---|
| **Screen ID** | `CKP-01` |
| **Screen name** | Cockpit — empty |
| **Parent area** | Cockpit |
| **Purpose** | Say why the tab is empty, and where to go |

This is the only `full` empty state in the tab — *"a genuine state of the product, not a gap that
clears"* (`cockpitCopy.ts:153`).

## Copy, verbatim

> **No agents are live yet.**
> Deploy an agent from its Deploy panel and it will appear here, with everything it has been asked
> to do.
> `Open the Deploy panel`

The fleet strip, the filter bar and the dispatch composer are all **absent** — there is nothing to
filter and nothing to dispatch to.

## Screenshot index

| File | State |
|---|---|
| `empty.png` | `adarsh@jaroku.dev`, no deployments |

## Implementation references

`CockpitView.tsx` · `cockpitEmpty.test.ts` · `EmptyState.tsx` · `cockpitCopy.ts:152-165`
