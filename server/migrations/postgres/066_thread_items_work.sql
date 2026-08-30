-- 066_thread_items_work — a job an agent was given can happen inside a conversation.
--
-- 044 closed this set at six because "which kind is this" should be a decision somebody makes while
-- looking at every other kind. This is that decision, made in the open: an operate thread's items
-- are the user's own turns, the runs those turns caused, and — new — the WORK ITEMS Part 2 records.
--
-- A `work` ROW CARRIES `ref_id` = `work_items.id`, EXACTLY AS A `run` ROW CARRIES A RUN ID. The
-- conversation stores a reference and never a copy, which is 044's own rule stated once and held
-- here: "ownership from `thread_items`, liveness from the owner." A duplicated status is a status
-- that goes stale, and this table deliberately has no `state` column to put one in.
--
-- WIDENING A CHECK IS AN EXPAND, NOT A CONTRACT, and that is worth saying because the gate cannot
-- see the difference. `migrate:check` refuses `DROP CONSTRAINT` on sight — correctly, in general,
-- because dropping a constraint the writer relies on can change behaviour mid-deploy. Here the
-- constraint that comes back is strictly WIDER than the one that went away: the version currently
-- serving writes only the original six kinds, every one of which the new constraint still permits,
-- and no row that was legal a moment ago becomes illegal. So the drop is marked, and the marker is
-- a claim in a comment beside the statement rather than a flag on a command, which is what the
-- override was designed to be.
--
-- AND THE ADD IS `NOT VALID` FOLLOWED BY `VALIDATE`, which is the answer to "is this rebuild
-- riskier on a populated Postgres than assumed". A plain `ADD CONSTRAINT ... CHECK` scans every row
-- under ACCESS EXCLUSIVE before it returns. `NOT VALID` is a catalogue write that takes no scan at
-- all and is already CORRECT here — every existing row satisfies the wider constraint by
-- construction, because it satisfied the narrower one — and `VALIDATE CONSTRAINT` then takes only
-- SHARE UPDATE EXCLUSIVE, which readers and writers do not queue behind.
--
-- THE HONEST LIMIT OF THAT: the runner puts each migration file in ONE transaction, so the locks
-- taken above are held until it commits either way. What the split buys is that the EXCLUSIVE
-- portion is two catalogue writes rather than a full scan, and the scan itself runs under the
-- weaker lock. On a `thread_items` sized by conversation volume that is the difference between a
-- blip and a pause; it is not the difference between an outage and none, and a table that had grown
-- to `steps` scale would want the validation in a migration of its own.
--
-- NO NEW INDEX. §5 asks for the reverse lookup — a work item to the conversation that produced it —
-- and `thread_items_ref (workspace_id, kind, ref_id)` from 044 already IS that index: the read is
-- `WHERE workspace_id = ? AND kind = 'work' AND ref_id = ?`, which is a prefix match on all three
-- columns. A second index on the same columns would cost a write per item to answer a question the
-- first one already answers. What the reverse lookup actually needed was for that index to SURVIVE
-- the SQLite rebuild, which is where the risk in this pair of files really is — see the other half.

-- jaroku:contract-step — a widening. See the header: the constraint that replaces this one permits
-- every kind this one permits, so nothing the running version writes becomes invalid.
ALTER TABLE thread_items DROP CONSTRAINT thread_items_kind_check;

ALTER TABLE thread_items
  ADD CONSTRAINT thread_items_kind_check
  CHECK (kind IN ('message', 'plan', 'generation', 'proposal', 'run', 'eval', 'work'))
  NOT VALID;

ALTER TABLE thread_items VALIDATE CONSTRAINT thread_items_kind_check;
