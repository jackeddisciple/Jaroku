# Flow — debug a run

**Goal.** Work out why an agent did what it did.

## The primitive

Every run emits a frozen, versioned event stream — one JSON object per line
(`schema/events.md`). The timeline, the state-diff view, the eval dashboard, the cost figures and
the branch feature are all consumers of it.

## Steps

| # | Step | Observed |
|---|---|---|
| 1 | Select a run | ✓ |
| 2 | Read the timeline; `j`/`k` | ✓ |
| 3 | Expand a step (`↵`) | ✓ |
| 4 | Read `state_before` → `state_after` | ✗ |
| 5 | Pause mid-graph | ✗ |
| 6 | Edit the state and branch from a checkpoint | ✗ |
| 7 | Compare against a shadow run | ✗ |

## Depth that exists and could not be reached

`PauseResumeControls.tsx` · `StateBranchEditor.tsx` · `ShadowRuns.tsx` · `SemanticDiff.tsx` ·
`traceDiff.ts` · the `debug` channel. All `IMPLEMENTED / NOT CURRENTLY OBSERVABLE`.
