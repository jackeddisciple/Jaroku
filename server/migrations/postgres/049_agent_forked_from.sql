-- 049_agent_forked_from — an agent remembers what it was copied from.
--
-- WHY A COLUMN, WHEN 048 ADDED NONE AND ARGUED THAT A COLUMN YOU CAN DERIVE IS A SECOND COPY THAT
-- GOES STALE. Because this one is not derivable. The Agents tab's tag families include `Forked`, and
-- nothing in this schema records that a fork happened: `forkAgent` writes a new `agents` row and a
-- new `agent_versions` row whose manifest happens to equal another agent's, and neither says where it
-- came from.
--
-- WHAT WAS THERE INSTEAD, AND WHY IT IS NOT AN ANSWER. The fork's first version carries
-- `summary = 'forked from <slug> v<n>'`, which a reader can see and a parser could pick apart. That
-- is reading a display string as an API — the exact thing `ThreadView.eval_progress` exists to avoid
-- ("`fragment` renders `eval 34/120` for a person to read; a client that parsed that back out would
-- be reading a display string as an API, and the first change to the wording would silently stop the
-- projection"). A summary is prose somebody may reword; a foreign key is not.
--
-- THE COST OF NOT HAVING IT was a tag that could never render. `agentTags` reads `forked_from`, the
-- tag family lists `Forked`, and the wire shape had no such field — so the branch was unreachable
-- code claiming to be a feature, which is worse than an absent feature because nothing looks wrong.
--
-- NULLABLE, AND NULL IS THE ORDINARY CASE. Every agent that already exists was generated, imported or
-- dropped in by hand, and none of them was forked — so there is nothing to backfill and no default
-- that would be true. `upsertFromDisk` does not touch it: a directory knows nothing about forks, and
-- a reconciliation that cleared this would lose the fact on the next boot, which is the trap
-- `display_name` was in and `display_name_is_custom` exists to close.
--
-- ON DELETE SET NULL, and the direction matters. If the source is ever removed the copy survives with
-- its provenance forgotten rather than being taken down with it — the same posture threads take when
-- an agent goes (§3.2: nothing is destroyed as a side effect of something else being destroyed). In
-- practice this product soft-deletes rather than deletes, so the row stays and so does the link; the
-- action is the backstop for the workspace cascade.
--
-- NOT A COMPOSITE KEY TO (workspace_id, id), which migration 018 made available and which most
-- children here use. A fork and its source are always in the same workspace — `forkAgent` reads the
-- source through a scoped repository and writes the copy into the same context — so the pair would
-- carry a column that can never disagree with the one already on the row.
ALTER TABLE agents ADD COLUMN forked_from uuid REFERENCES agents(id) ON DELETE SET NULL;

COMMENT ON COLUMN agents.forked_from IS
  'The agent this one was copied from, or NULL. Set once by forkAgent and never written again — a fork''s provenance does not change, and the copy is an independent agent from the moment it exists.';
