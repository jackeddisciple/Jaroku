# Components — run

| Component | Source | Purpose |
|---|---|---|
| `TraceTimeline` | `TraceTimeline.tsx` | the step column |
| `StepRow` | `StepRow.tsx` | one step |
| `StepDetail` / `StepDetailPanel` | | an expanded step |
| `StateDiff` | `StateDiff.tsx` | before → after |
| `PauseResumeControls` | `PauseResumeControls.tsx` | pause, resume |
| `StateBranchEditor` | `StateBranchEditor.tsx` | fork from a checkpoint |
| `ShadowRuns` | `ShadowRuns.tsx` | parallel comparison runs |
| `GraphView` | `GraphView.tsx` (49 KB) | the LangGraph |
| `GraphCanvas` | `GraphCanvas.tsx` | the canvas host |
| `graphIcons.tsx` | | node glyphs |
| `ProblemsPanel` | `ProblemsPanel.tsx` | validation problems |

## Step types

Four, with deliberately low-saturation colour pairs so the dense column does not become a rainbow —
`llm_call` · `tool_call` · `state_update` · `router`. Values in
[`../legacy/current-tokens.md`](../legacy/current-tokens.md).

## One decision, two surfaces

`GraphView`'s `KIND_ACCENT` shares its values with `tokens.ts` `ACCENT` on purpose — *"so the graph
and the plan card make one decision rather than two that happen to look alike."* This is the
opposite of the Activity share-bar failure, where two surfaces each had their own palette.
