# SCREEN — Trace

| | |
|---|---|
| **Screen ID** | `RUN-01` |
| **Screen name** | Trace |
| **Route / path** | the `trace` right-panel tab |
| **Parent area** | Runs |
| **Purpose** | Every step a run took, as a frozen event stream |
| **Primary user goal** | Find the step that went wrong |

**The trace is the product's one primitive.** Every other surface consumes it: the timeline renders
it live, the state-diff view reads `state_before`/`state_after`, the eval dashboard aggregates it,
the cost figures are summed from it, and branching forks from a checkpoint correlated to it.

## Header

`TRACE  <run label>` — or `no run selected`.

## Empty state

> No trace yet — Run the agent below and every LLM call, tool call and routing decision it makes
> streams in here.

## Populated

A dense vertical timeline of steps. Each row: a **step-type chip**, a name, and a right-aligned
figure. The four step types have their own low-saturation colour pairs (`tokens.ts` `STEP_TYPE`),
deliberately pale because *"the timeline is a dense column of these and full-strength accents would
turn it into a rainbow"*:

| Type | Fill | Foreground |
|---|---|---|
| `llm_call` | `#EDF2F8` | `#2F5F92` |
| `tool_call` | `#EBF3EE` | `#2F7048` |
| `state_update` | `#F8F2E6` | `#8A6520` |
| `router` | `#F3EDF8` | `#6B4A8A` |

## Interactive elements

| Control | Does |
|---|---|
| `j` / `k` | move the step cursor |
| `↵` | expand / collapse the selected step |
| click a step | opens `StepDetailPanel` |
| pause / resume | `PauseResumeControls.tsx` |
| branch from a step | `StateBranchEditor.tsx` |

## Entry points

The tab · the command palette's `Open Trace` · a run row in the sidebar · **`Open the trace` in a
Cockpit work detail** — the same route, not a second one.

## State list

| State | Screenshot | Notes |
|---|---|---|
| empty | `empty.png` | Observed |
| populated | `populated.png` | Observed — a completed dry-run |
| running / streaming | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` |
| paused | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `PauseResumeControls.tsx`, `debug` channel |
| branched | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `StateBranchEditor.tsx` |
| failed, opening on the failing step | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — promised by `FAILURE_SENTENCE.agent_error` |

## Implementation references

`TraceTimeline.tsx` · `StepRow.tsx` · `StepDetail.tsx` · `StepDetailPanel.tsx` · `StateDiff.tsx` ·
`StateBranchEditor.tsx` · `PauseResumeControls.tsx` · `ShadowRuns.tsx` ·
`store/traceStore.ts` · `lib/stateDiff.ts`, `traceGraphMap.ts`, `rerun.ts` ·
channels `trace`, `runSteps`, `debug`, `log` · `schema/events.md`
