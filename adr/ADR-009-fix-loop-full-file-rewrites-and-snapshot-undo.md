# ADR-009: Implement Editing as Full File Rewrites With a Reviewable Diff and Snapshot Undo

## Status

Accepted. Introduced in v0.1.0 (22 July 2026). Read-only protection extended to tool wiring in
v0.1.12 and to deployment artifacts in v0.2.3.

## Context

Once an agent exists, changing it is the operation the user performs most. "Add a tool that
summarises the last five orders" has to become a change to a real project on disk.

Three design questions had to be answered.

**Patches or whole files?** A patch is smaller and cheaper. It is also applied against line
numbers, and a model's line references are frequently wrong. A patch that applies at the wrong
offset produces code that is syntactically plausible and semantically wrong, which is the worst
possible failure because it may still import and run.

**Automatic or reviewed?** An AI that silently edits a user's files is a tool the user cannot
trust, and trust is the entire product. But a review surface that shows a wall of new code is
not a review either.

**What does undo mean?** Reversing a diff is an operation that can fail, particularly if the
project has changed since. The user's expectation of undo is "put it back exactly as it was",
and only one implementation satisfies that literally.

There is a fourth constraint specific to this product. Some files in an agent project are not
the model's to touch: reviewed connector templates, the MCP manifest and bridge, the project
metadata, and the deployment artifacts. Editing any of them would let a conversational request
widen the agent's reach or change what a public container does, with nobody approving it.

## Decision

**The AI never silently edits files.** The flow is:

```
instruction -> staged copy of the project with the model's files applied
            -> full validation (the same contract as generation)
            -> reviewable diff card (per-file hunks, additions and deletions)
            -> Apply | Undo | Discard
```

Five properties define it.

**Edits are full file rewrites, not patches.** The model receives the project's actual current
files and returns complete replacements. Nothing is applied against a line reference, so
nothing can apply against the wrong lines.

**A proposal lives in staging.** `runtime/agents/.staging/<id>__edit/` is a full copy of the
project with the model's files applied. The live project is untouched until an explicit Apply.
The proposal passes the same validation contract as a fresh generation: it parses, it imports,
required symbols are present, and there are no unsafe writes.

**Certain files are hard read-only, and the stream is rejected the moment the model opens one.**
The block list covers every reviewed connector filename in the catalog whether installed or
not, `tools/__init__.py`, `jaroku.json`, the top-level `__init__.py`, `mcp_tools.json`,
`mcp_bridge.py`, and the four deployment artifacts. The refusal message points at the right
move, for example asking for a wrapper tool that adapts a connector's results instead.

**Apply snapshots first, then swaps.** The current project is copied to
`runtime/agents/.history/<id>/v<n>/` before the atomic swap, and the history entry is written
only after the swap succeeds. Undo restores the latest snapshot the same way. History is
linear and survives reloads, because the sidebar's Undo availability is derived from
`history.json` rather than from memory.

**A no-op is a valid outcome.** If the model declines and explains why, or re-emits files
byte-identical to what is already there, the result is a proposal with zero files and the
summary explaining it, not a fabricated diff.

A run in flight blocks mutation, and the check is pool aware rather than only
interactive-aware: an evaluation job reading the agent's files from a subprocess right now
would make its trace describe code that never ran.

## Alternatives Considered

### Option 1: Full file rewrites, staged, reviewed as a diff, undone from a snapshot

- Pros
  - Nothing applies against a line reference, so the misapplied-patch failure class does not
    exist.
  - The review surface is a diff, which shows change rather than a wall of code.
  - Undo is byte exact, because it restores a copy rather than reversing an operation.
  - The same validation as generation, so an edit cannot produce a project a generation could
    not.
  - Read-only enforcement can happen at file-open time, because the streaming protocol
    announces each path before its content.
- Cons
  - Rewriting a whole file costs more output tokens than a patch.
  - A full copy per proposal costs disk, briefly.
  - Snapshots accumulate under `.history/`.
  - A large project produces a large diff, so review effort scales with the change surface the
    model chose rather than the change the user asked for.

### Option 2: Patch based edits

- Pros
  - Far fewer output tokens, so cheaper and faster.
  - Reviewing a patch is reviewing exactly the change.
  - No copies and no snapshots needed if the patch is reversible.
- Cons
  - Patches apply against line numbers, and model line references are unreliable. A patch that
    applies at the wrong offset produces plausible, wrong code.
  - Reversing a patch is not the same as restoring the previous state, and it can fail.
  - Partial application leaves a project in a state neither the user nor the model intended.

### Option 3: Direct edits with version control as the safety net

- Pros
  - No staging, no snapshots, no diff card to build. The user's own tooling handles history.
  - Familiar to any developer who uses git.
- Cons
  - Assumes the agent project is in a repository, which it need not be.
  - Makes "nothing lands unreviewed" false. The review happens after the fact, if at all.
  - The user is now responsible for the safety property the product claims to provide.
  - Read-only enforcement on reviewed connectors becomes advisory.

## Consequences

### Positive

- Undo is exact, and was verified byte identical across repeated cycles.
- A proposal that fails validation is discarded and is never applyable, so the edit path cannot
  produce a broken project.
- Reviewed connector protection is real. A genuine request to loosen a read-only guard on a
  reviewed connector was refused cleanly rather than rewritten, which is the behaviour the
  guarantee depends on.
- The diff card is a shared review surface with generation's plan card and streaming file list,
  so the same vocabulary describes what will change, what is changing, and what changed.
- The one-click fix path routes a failed trace step into this same loop, pre-filled with the
  error and the relevant code. There is no second edit mechanism.

### Negative

- Output token cost is higher than a patch-based approach, on every edit.
- `.history/` grows with every applied edit and is not currently pruned.
- Undo is linear and single-step-at-a-time: it restores the latest snapshot, so recovering a
  state three edits ago means three undos.
- A model that rewrites more files than necessary produces a larger diff than the change
  warrants, which costs review attention.

### Trade-offs

- Token cost was traded for correctness. A misapplied patch produces wrong code that may still
  run, which is a worse outcome than a more expensive edit.
- Disk was traded for exactness of undo.
- Read-only enforcement was made unconditional rather than configurable. There is no flag that
  lets an edit touch a reviewed template, because a flag is a thing a user can be talked into
  setting.

## Implementation Notes

- `server/src/editor.ts` owns the loop and is marked read-every-line territory in its header.
- The staged proposal directory is `agents/.staging/<id>__edit/`, a full copy with the model's
  files applied, so validation runs against a complete project rather than a fragment.
- `readOnlyPaths` in `server/src/projectFs.ts` computes the block list, and it covers every
  connector filename in the catalog whether installed or not, so the model cannot introduce a
  file masquerading as a reviewed template.
- Snapshots are written to `agents/.history/<id>/v<n>/` and recorded in `history.json` only
  after the swap succeeds, so a crash between the two leaves no history entry claiming a
  snapshot that does not exist.
- The diff is computed with `structuredPatch` from the `diff` package, per file, with addition
  and deletion counts for the card.
- Edits reuse the same delimiter protocol as generation, which is what makes rejecting a
  read-only file at open time possible.
- `JAROKU_EDIT_FIXTURE` replays a recorded edit proposal. The included fixtures cover a no-op,
  a syntax error, a prompt tweak, a connector-bait attempt and a real limit.
- The tool wiring check in the validator complements the read-only rule: connector template
  *files* are read-only, but `tools/__init__.py` decides which tools get bound and previously
  was not. A reviewed tool could be silently dropped from `TOOLS` or shadowed by name. Both
  are now rejected.

## Security Considerations

- The read-only set is a security boundary, not a convenience. `mcp_tools.json` is the whole of
  an agent's MCP access and `mcp_bridge.py` is the reviewed code that honours it, so an edit
  able to rewrite either could widen the agent's reach with nobody approving it. `serve.py` and
  the Dockerfile decide what a publicly reachable container does.
- Asking to change any of those points the user at the panel that owns the decision, because
  changing an agent's scope is the user's decision rather than an edit's.
- Path confinement applies to every emitted path, and the agent id is validated so a
  client-supplied id cannot traverse out of `agents/`.
- An edit proposal executes model-written code during validation's import step, exactly as
  generation does, with the same 20 second bound and the same stated limitation.
- Blocking mutation while a run is in flight prevents a class of confusion rather than a class
  of attack: rewriting files a subprocess is importing changes code out from under a run, and
  the resulting trace describes something that never executed.

## Performance Considerations

- Full file output costs more tokens than a patch, proportional to the size of the files the
  model chooses to rewrite.
- Copying a project per proposal is cheap in absolute terms, because agent projects are tens of
  kilobytes.
- Validation dominates edit latency, and its most expensive step is the import check with its
  20 second ceiling.
- Apply is a snapshot copy plus an atomic swap, both fast and both independent of project size
  in the swap case.

## Operational Considerations

- `runtime/agents/.history/<id>/` holds the snapshots and `history.json`. Undo availability
  after a reload is derived from that file, so deleting it loses the ability to undo but not
  the project.
- `runtime/agents/.staging/` is cleared on server start; an interrupted proposal is an orphan.
- "Cannot modify the agent while a run is in progress" is the pool-aware guard. Wait for the
  run or cancel the evaluation.
- History is not pruned automatically. On a long-lived installation with many edits, `.history/`
  is the directory that grows.

## Rejected Alternatives

**Patch based edits** were rejected because patches apply against line references and model line
references are unreliable. The failure mode is the dangerous one: a patch that applies at the
wrong offset produces code that is syntactically valid and semantically wrong, which may import
cleanly and run. Full file rewrites remove the entire failure class at the cost of tokens.

**Direct edits with version control as the safety net** were rejected because it makes the
product's core guarantee conditional on the user's tooling. It assumes the agent project is in
a repository, it moves review to after the fact, and it reduces reviewed connector protection
from an enforced property to a convention.

## Related Decisions

- ADR-005: The generated agent contract
- ADR-006: Delimiter framed streaming protocol for generated files and plans
- ADR-007: Staging directories with atomic swap, gated by layered validation
- ADR-014: Reviewed connector templates copied byte for byte
- ADR-015: MCP servers treated as untrusted code
- ADR-025: One composer with deterministic intent routing
- ADR-027: Deployment into the user's own hosting account

## References

- `server/src/editor.ts`, `server/src/projectFs.ts`, `server/src/validator.ts`
- `server/fixtures/edit-noop.txt`, `edit-syntax-error.txt`, `edit-prompt-tweak.txt`,
  `edit-real-connector-bait.txt`, `edit-touches-connector.txt`, `edit-real-limit.txt`
- `client/src/components/DiffCard.tsx`, `client/src/components/DiffStat.tsx`
- README section "The fix loop: propose, apply, undo"
- CHANGELOG v0.1.0 "Conversational Agent Editing", v0.1.12, v0.2.3
