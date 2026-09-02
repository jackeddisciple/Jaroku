# Components — editors

| Component | Source | Purpose | Observed |
|---|---|---|---|
| `CodeViewer` | `CodeViewer.tsx` | read an agent's file | no |
| `CodeOverlay` | `CodeOverlay.tsx` | the full-surface code drawer (`code` right-tab) | no |
| `FileList` / `AgentFiles` | `FileList.tsx`, `AgentFiles.tsx` | the file tree | header only |
| `DiffCard` | `DiffCard.tsx` (17 KB) | a proposed change, reviewable | no |
| `SemanticDiff` | `SemanticDiff.tsx` | a meaning-level diff | no |
| `StateDiff` | `StateDiff.tsx` | `state_before` → `state_after` | no |
| `StateBranchEditor` | `StateBranchEditor.tsx` | fork a run with an edited state | no |
| `DatasetBuilder` | `DatasetBuilder.tsx` (21 KB) | build an eval dataset | no |
| `ReviewRegion` | `ReviewRegion.tsx` | the apply/discard gate | no |
| `GitHubCommitBox` | `GitHubCommitBox.tsx` | the commit message | no |

**None of this area was reachable.** Every editor here needs either a provider key (to produce a
diff), a published version (to view code), or a dataset. All are marked
`IMPLEMENTED / NOT CURRENTLY OBSERVABLE` with the file above.

The one thing observable about it is the promise the empty state makes:

> **Describe a change to Tracey**
> You'll get a reviewable diff to apply or discard. **Nothing is changed until you apply it.**
