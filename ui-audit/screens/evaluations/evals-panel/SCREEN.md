# SCREEN — Evals

| | |
|---|---|
| **Screen ID** | `EVL-01` |
| **Screen name** | Evals |
| **Route / path** | the `evals` right-panel tab |
| **Parent area** | Evaluations |
| **Purpose** | Run one agent across a dataset and across providers, and compare |

## Empty state — observed

> **No evals yet**
> Build a dataset of inputs, run it across providers, and compare quality, latency and cost side by
> side.

## Regions when populated

| Region | Component |
|---|---|
| Run bar — provider/model selection, estimate, start | `EvalRunBar.tsx` |
| Dataset builder | `DatasetBuilder.tsx` (21 KB) |
| Dashboard — the comparison grid | `EvalDashboard.tsx` |
| Drill-down — one case, one provider | `EvalDrillDown.tsx` |

## Why an eval's runs are kept off the trace channel

`lib/socket.ts:264` records it: an eval's runs are deliberately **not** sent on the `trace` channel,
so a fan-out across providers does not flood the panel a person is reading a single run in.

## State list — none beyond empty were reachable

| State | Notes |
|---|---|
| empty | **Observed** — `empty.png` |
| configured | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — needs a dataset |
| running | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `EvalRunBar.tsx`, `server/src/evalRunner.ts` |
| completed | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `EvalDashboard.tsx` |
| failed | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `server/src/evalRetry.test.ts` |
| comparison | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `EvalDashboard.tsx` |
| regression / improvement | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `server/src/evalAggregate.ts` |

The eval engine needs a dataset **and** a provider key. Neither exists in this environment, so this
area is documented from source with one observed state.

## Implementation references

`EvalsPanel.tsx` · `EvalDashboard.tsx` · `EvalDrillDown.tsx` · `EvalRunBar.tsx` ·
`DatasetBuilder.tsx` · `store/evalStore.ts` · `lib/evalExport.ts`, `csv.ts` · channel `eval` ·
`server/src/evalRunner.ts`, `evalStore.ts`, `evalAggregate.ts`, `evalEstimate.ts`, `judge/`
