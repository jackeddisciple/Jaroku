-- 014_agent_version_history — a version learns where it came from, and whether it is still on
-- the line.
--
-- `agent_versions` was written in 008 and read by nothing: it held a manifest and a number, and
-- the write path still moved a staging DIRECTORY into place. Session 3 is where that stops. The
-- files move into the object store under `ws/<workspace>/agents/<agent>/v<n>/<path>`, the
-- manifest becomes the record of what a version contains, and `agents.current_version` becomes
-- the pointer that says which one is live.
--
-- THE COLUMNS HERE ARE WHAT LINEAR HISTORY NEEDS ONCE IT IS NOT A DIRECTORY.
--
-- Today an applied edit writes `runtime/agents/.history/<id>/history.json` — the instruction,
-- the summary and the per-file diff stat — and a snapshot directory beside it. Undo restores the
-- snapshot and pops the entry. Every part of that is local disk: the replica that applied the
-- edit is the only one that can undo it, and a container restart loses the lot.
--
-- So the same four facts move onto the version row, where they are already scoped to a
-- workspace and already replicated:
--
--   source        — generation, edit, import, or deploy. What made this version. `import` is
--                   the backfill: a project that existed on disk before any of this and was
--                   published as-is, which is honestly a different provenance from an edit and
--                   should not claim to be one.
--   instruction   — what the user asked for, on an edit. NULL elsewhere.
--   summary       — what the model said it did. What the history list renders.
--   file_stats    — [{path, status, additions, deletions}] for the diff bar. The manifest says
--                   what the version CONTAINS; this says what CHANGED, and the two are
--                   different questions the UI asks separately.
--   total_bytes   — the version's size, so a retention sweep in Session 8 can cost a workspace
--                   without fetching every object to add them up.
--   undone_at     — set when `current_version` is moved back past this one.
--
-- UNDONE_AT, RATHER THAN DELETING THE ROW. The UI's history is linear: applying moves forward,
-- undo moves back one, and a new edit after an undo starts a fresh line. Deleting the row would
-- make that true by losing the evidence. Marking it keeps the version's objects addressable for
-- as long as retention allows, which is what makes an undo reversible by a support request
-- rather than only by regenerating — and it means `editCount`, which drives whether Undo is
-- offered at all, is a count of rows rather than a directory listing.
--
-- DEFAULTS ARE CHOSEN SO EXISTING ROWS ARE HONEST. Any `agent_versions` row that exists before
-- this migration was written by `addVersion`, which nothing but a test has called — so `import`
-- is the truthful label for all of them, and an empty `file_stats` is the truthful claim that
-- nobody recorded a diff.

ALTER TABLE agent_versions ADD COLUMN source      text NOT NULL DEFAULT 'import';
ALTER TABLE agent_versions ADD COLUMN instruction text;
ALTER TABLE agent_versions ADD COLUMN summary     text;
ALTER TABLE agent_versions ADD COLUMN file_stats  json NOT NULL DEFAULT '[]'::json;
ALTER TABLE agent_versions ADD COLUMN total_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE agent_versions ADD COLUMN undone_at   timestamptz;

ALTER TABLE agent_versions
  ADD CONSTRAINT agent_versions_source_check
  CHECK (source IN ('generation', 'edit', 'import', 'deploy'));

-- Descending, because every read of this table asks for the newest few: the history list, the
-- undo target, the "what is current" lookup. An ascending index answers those by scanning to the
-- end, which is invisible at three versions and is the whole cost of the query at three hundred.
--
-- agent_id leads rather than workspace_id, and that is not an exception to the rule in
-- CONTRIBUTING: `agent_versions` has no workspace_id of its own. It hangs off `agents`, whose
-- (workspace_id, slug) is unique and whose uuid is therefore already workspace-scoped — so the
-- scope is enforced by the join the repository always makes, and duplicating the column here
-- would create a second copy of a fact that could disagree with the first.
CREATE INDEX agent_versions_agent_version ON agent_versions (agent_id, version DESC);
