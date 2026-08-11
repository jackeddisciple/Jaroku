# ADR-032: Replace the Atomic Directory Swap With an Immutable Version and a Pointer

## Status

Accepted. Introduced in Session 3, migration `014_agent_version_history`.

## Context

`projectFs.atomicSwap` replaced an agent's directory with a staged one by renaming: keep the old
copy until the new one is in place, put it back if the rename throws. Apply snapshotted the
project into `.history/<id>/v<n>/` first, and Undo restored that snapshot and popped an entry out
of `history.json`.

Every part of that is one machine. `rename(2)` is atomic within a filesystem and meaningless
across three replicas; a snapshot is a full copy made by whichever replica applied the edit; and
`history.json` is a file only that replica has. An edit applied by one replica could not be undone
by another, and a container restart lost the history entirely.

`agent_versions` already existed — written in Session 1, read by nothing — precisely so this could
happen without a schema redesign.

## Decision

**A publish is objects first, pointer second.** A version's files are written to keys nothing
refers to yet, and are never rewritten. Then one `UPDATE` moves `agents.current_version`. A reader
arriving between the two sees the previous version whole, which is exactly what the rename
promised and the only form of that promise which survives having no shared disk.

**Undo is a pointer move.** `current_version` goes back one and the version it left behind is
marked `undone_at`. Nothing is copied, because the version being pointed at was written once and
never rewritten.

**The four facts `history.json` held move onto the version row**: the instruction, the summary, the
per-file diff stat, and the size. `editCount` becomes one query for a whole workspace rather than
a directory listing per agent.

**One formula decides the next version number**, in one function, used both by the repository
inside its insert transaction and by the project store before it writes any objects.

**`runtime/agents/<slug>/` stays**, as a materialisation of the current version rather than the
source of truth.

## Alternatives considered

**Keep snapshotting, into the object store.** A `.history` prefix per applied edit. Rejected: it
is a full copy of a project per edit, for a property immutability gives away free — the previous
version's objects were never touched, so pointing at them again *is* the undo.

**Undo by deleting the superseded version row.** Simpler, and the history list would need no
filter. Rejected: the UI's history is linear, and deleting the evidence is not the same as taking
a version off the line. Marking it keeps the objects addressable for as long as retention allows,
which makes an undo reversible by a support request rather than only by regenerating.

**Reserve the version number in its own transaction before writing objects.** Would remove the
mismatch check entirely. Rejected as more machinery than the case needs: the editor already
refuses a second concurrent edit, and losing the race produces a clear refusal rather than a
version pointing at another publish's bytes.

**Write the pointer first, then the objects.** Rejected without much thought: a reader between the
two would see a version that does not exist yet, which is the failure the ordering exists to
prevent.

## Consequences

**History begins at the import**, and this is the migration's real cost. An installation with
applied edits keeps its `.history/` directory, and it is no longer what Undo reads: the first
version is the project as it stood when it was imported, and Undo covers what has been applied
since. Nothing is lost from the project itself; what is lost is stepping back through edits made
before this, which no second replica could ever have done.

A failed publish leaves objects at keys no row points at. That is garbage a retention sweep
collects, not a corrupted agent, and it is the right way round.

Every read of an agent's files is now a database read plus N object reads, where a directory
listing used to do. At the size of an agent project — a handful of files, a few kilobytes — that
is not a number worth optimising yet, and the manifest means "has this changed" can be answered
without fetching anything.
