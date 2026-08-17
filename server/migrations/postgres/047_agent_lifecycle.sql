-- 047_agent_lifecycle — an agent can be put away, brought back, and renamed.
--
-- WHAT WAS MISSING. Every other resource in this product has a lifecycle: datasets are created,
-- renamed and deleted; examples added, updated and deleted; MCP servers added and removed; threads
-- archived and restored; deployments cancelled and forgotten; links linked and unlinked; secrets
-- added, rotated and deleted; invitations issued and revoked; members added and removed. The AGENT
-- — the product's central object — had none. There was no `deleteAgent`, `renameAgent` or
-- `archiveAgent` anywhere: no command, no route, no repository method, no affordance. An agent
-- created by mistake was permanent, in the sidebar, in the filter counts, in the eval picker and in
-- the composer's target list, forever.
--
-- The only way one left was `syncFromDisk`, which soft-deletes a row whose directory is gone AND
-- which has no published versions — so an agent that has ever been generated or edited (that is,
-- every agent the product builds) could not be removed by any means short of SQL.
--
-- ARCHIVE RATHER THAN DELETE, which is the shape the rest of this schema already chose. Threads are
-- archived and never deleted, and the reasons given there apply at least as strongly here: an
-- agent's versions, runs, traces, evals and costs ARE the record, and destroying the row would
-- destroy the thing every past comparison points at. `archived_at` is therefore a decision somebody
-- made and can unmake, and it is deliberately NOT `deleted_at`.
--
-- WHY IT CANNOT BE `deleted_at`. That column means something else and is written by something else:
-- it is the sweep's mark for "the directory this row mirrored has gone", and `upsertFromDisk` CLEARS
-- it every time the directory comes back. An archive stored there would be undone by the next boot
-- that materialised the project. Two facts, two columns; the sweep keeps its own and never touches
-- this one.
ALTER TABLE agents ADD COLUMN archived_at timestamptz;

-- WHY A RENAME NEEDS A SECOND COLUMN, and why it is named after the one that already solved this.
--
-- `display_name` is written from disk metadata by `upsertFromDisk`, whose ON CONFLICT overwrites it
-- on every reconciliation. A rename stored there alone would survive exactly until the next sync
-- read `jaroku.json` again — the same trap `threads.title` was in, solved the same way:
-- `title_is_custom` is what makes auto-titling stop, and this is what makes the disk stop.
--
-- The flag is on the ROW rather than inferred from a comparison, because "the user chose this name
-- and it happens to equal the file's" is a real state and a comparison cannot see it.
ALTER TABLE agents ADD COLUMN display_name_is_custom boolean NOT NULL DEFAULT false;

-- The sidebar's default list is "not archived", and so is every read that feeds a picker. One
-- partial-shaped index over the two columns the list already filters on: the workspace, and whether
-- the row has been put away.
CREATE INDEX agents_ws_archived ON agents (workspace_id, archived_at);
