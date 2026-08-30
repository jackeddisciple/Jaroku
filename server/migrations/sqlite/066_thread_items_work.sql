-- 066_thread_items_work — the SQLite half. Read the Postgres file for why a work item belongs in
-- this table as a reference rather than a copy, why widening a CHECK is an expand rather than a
-- contract, and why §5's reverse-lookup index is `thread_items_ref` and not a new one.
--
-- THIS DRIVER CANNOT WIDEN A CHECK IN PLACE. `ALTER TABLE ... ADD COLUMN` is the only in-place
-- operation it performs — 065 uses it, and could, because a CHECK on a NEW column examines no
-- existing row. A CHECK already on the table is part of the table's text, so changing it means
-- writing the table again. That is the rebuild idiom of 006, 018 and 059, and 059's warning is the
-- one that matters most here: `DROP TABLE` takes its indexes with it, and an index left off the
-- rebuild is not an error — it is a table that works, answers every query, and has quietly lost a
-- UNIQUE constraint. THREE are recreated below and the third is load-bearing.
--
-- `thread_items_ws_id_unique` IS THE ONE THAT WOULD NOT FAIL LOUDLY. 055 added it so that
-- `(workspace_id, id)` could be REFERENCED, and five tables now do: turn_attachments,
-- turn_variants, turn_notes, turn_pins and turn_feedback all carry
-- `FOREIGN KEY (workspace_id, turn_id) REFERENCES thread_items (workspace_id, id)`. Rebuilt without
-- it, every one of those foreign keys points at a pair of columns with no unique index behind them,
-- and SQLite reports that at COMMIT rather than at the statement — from inside a migration, which
-- is the worst place to read it from.
--
-- AND WHY THE FIVE CHILDREN ARE EMPTIED FIRST, which is the part of this file a reader would
-- otherwise take for caution. `node:sqlite` has foreign keys ON, so `DROP TABLE thread_items`
-- performs an implicit `DELETE FROM` before it removes the table — and SQLite's own documentation
-- says that delete "may cause foreign key actions". Every one of those five references is
-- `ON DELETE CASCADE`. So the obvious rebuild — copy, drop, rename — silently deletes every note,
-- pin, rating, attachment and variant in the database on its way past, and leaves a schema that is
-- correct in every respect a test would check. 006 met the same wall and moved its child out of the
-- way first; this does the same thing five times.
--
-- WHAT IT DOES NOT DO IS RECREATE THE CHILD TABLES, and that is the one place this diverges from
-- 006 rather than copying it. 006 had to: the parent's key was moving from `(id)` to
-- `(workspace_id, id)`, so every child's foreign key had to be rewritten to match. Here the
-- parent's key does not move — `(workspace_id, id)` before and after — so the five children's
-- definitions remain exactly as correct after the rename as before it, and reproducing five table
-- definitions by hand would be five more chances to get a column wrong for no gain. Only their ROWS
-- step aside, into holding tables with no constraints at all, exactly as 006's did.
--
-- `defer_foreign_keys` COVERS THE MOMENTS IN BETWEEN. Unlike `foreign_keys` it IS settable inside a
-- transaction, it postpones enforcement to COMMIT rather than disabling it, and it resets itself
-- when the transaction ends — so the window in which the children reference a table that does not
-- exist is a window inside one transaction, and the state at COMMIT is the one that is checked.
--
-- NO RLS, on this driver, ever — see 009.

PRAGMA defer_foreign_keys = ON;

-- 1. THE CHILDREN'S ROWS, OUT OF THE WAY. Holding tables, not schemas: `CREATE TABLE ... AS SELECT`
--    carries the values and none of the constraints, which is what makes them safe to sit in while
--    the parent they point at does not exist. Emptying the real tables is what makes the implicit
--    delete inside `DROP TABLE thread_items` a no-op instead of a cascade.
CREATE TABLE turn_attachments_hold AS SELECT * FROM turn_attachments;
DELETE FROM turn_attachments;

CREATE TABLE turn_variants_hold AS SELECT * FROM turn_variants;
DELETE FROM turn_variants;

CREATE TABLE turn_notes_hold AS SELECT * FROM turn_notes;
DELETE FROM turn_notes;

CREATE TABLE turn_pins_hold AS SELECT * FROM turn_pins;
DELETE FROM turn_pins;

CREATE TABLE turn_feedback_hold AS SELECT * FROM turn_feedback;
DELETE FROM turn_feedback;

-- 2. THE PARENT, REBUILT. The same columns in the same order, the same foreign keys, one CHECK
--    widened by a seventh word.
CREATE TABLE thread_items_new (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL
    CHECK (kind IN ('message', 'plan', 'generation', 'proposal', 'run', 'eval', 'work')),
  ref_id       TEXT,
  role         TEXT,
  body         TEXT,
  created_at   TEXT NOT NULL
);

INSERT INTO thread_items_new
  (id, workspace_id, thread_id, kind, ref_id, role, body, created_at)
SELECT id, workspace_id, thread_id, kind, ref_id, role, body, created_at
  FROM thread_items;

DROP TABLE thread_items;
ALTER TABLE thread_items_new RENAME TO thread_items;

-- 3. THE THREE INDEXES, BY HAND. 044's two, and 055's unique one — see the header for why the third
--    is the one whose absence would not announce itself.
CREATE INDEX thread_items_thread ON thread_items (workspace_id, thread_id, created_at);

CREATE INDEX thread_items_ref ON thread_items (workspace_id, kind, ref_id);

CREATE UNIQUE INDEX thread_items_ws_id_unique ON thread_items (workspace_id, id);

-- 4. THE CHILDREN'S ROWS, BACK. Their tables were never dropped, so this is an insert into the
--    schema that was there all along, and the foreign keys it has to satisfy are checked at COMMIT
--    against a parent that exists again and carries its unique index.
INSERT INTO turn_attachments SELECT * FROM turn_attachments_hold;
DROP TABLE turn_attachments_hold;

INSERT INTO turn_variants SELECT * FROM turn_variants_hold;
DROP TABLE turn_variants_hold;

INSERT INTO turn_notes SELECT * FROM turn_notes_hold;
DROP TABLE turn_notes_hold;

INSERT INTO turn_pins SELECT * FROM turn_pins_hold;
DROP TABLE turn_pins_hold;

INSERT INTO turn_feedback SELECT * FROM turn_feedback_hold;
DROP TABLE turn_feedback_hold;
