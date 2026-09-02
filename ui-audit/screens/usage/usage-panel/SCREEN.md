# SCREEN — Usage

| | |
|---|---|
| **Screen ID** | `USG-01` |
| **Screen name** | Usage |
| **Route / path** | the `usage` right-panel tab |
| **Parent area** | Usage — **an area the audit brief's folder list does not name** |
| **Purpose** | What this workspace has spent this period, against which ceilings |

## Structure

Header: `Free plan` · the period (`1 Sep – 1 Oct`) · an export control.

### Four meters

Each is a label, a figure, its ceiling, and a track:

| Meter | Observed | Note |
|---|---|---|
| Spent this period | `$0.00 of $5.0000` | carries a `Change` action |
| On our provider key | `$0.00 of $2.0000` | *what this plan covers on our key. Connect your own to run past it.* |
| Runs this period | `0 of 500` | |
| Eval runs this period | `0 of 20` | |

The ceilings are shown to **four decimal places** (`$5.0000`), which is a formatting decision worth
noting against the cost figures beside them at two.

### Three breakdowns

- `BY AGENT` — one row: *the platform, on your behalf* — `0 tok  $0.00`
- `MOST EXPENSIVE RUNS` — *No runs this period.*
- `BY KIND` — `storage.bytes` / *our key* — `$0.00`

### The footnote

> ⓘ Cost is summed from a run's steps, never from the run row — a run that crashes mid-graph never
> writes a total, and its steps record what it really spent.

This is the product's cost-accounting model stated in the UI, and it is the same rule the Cockpit's
work detail relies on when it says a figure is a floor rather than a total.

## State list

| State | Screenshot | Notes |
|---|---|---|
| free, zero usage | `default.png` | Observed |
| usage present | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — 53 rows exist in `usage_events`, none in this period |
| approaching a ceiling | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `EnforcementStrip.tsx` |
| ceiling reached | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `workspace_enforcements` |

## Implementation references

`UsagePanel.tsx` (28 KB) · `StatRow.tsx` · `store/billingStore.ts`, `enforcementStore.ts` ·
`lib/csv.ts` (export) · `tokens.ts` `SHARE_RAMP` / `SHARE_ORDER` · channels `billing`,
`enforcement` · `server/src/pricing.ts`, `runtime/pricing.json`
