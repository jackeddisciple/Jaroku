-- 076_chat_ceilings — the SQLite half. Read the Postgres file for every decision: why there are two
-- ceilings and not one, why both live on `workspaces` rather than on `conversation_settings`, why
-- the defaults are figures rather than NULL, and why zero is a real value and negative is not.
--
-- `numeric` BECOMES `REAL`, which is this driver's translation everywhere a USD figure is stored —
-- and the caveat 057 already names applies: REAL is a float, so a ceiling written on one driver and
-- compared on the other can differ in the last places. It is safe for the reason that file gives:
-- every cost this is compared against goes through `round8` before it is stored, which is orders of
-- magnitude below the precision of a limit anybody types.
--
-- NO CHECK ON THIS DRIVER, and that is 043's decision rather than a new one: SQLite cannot
-- `ALTER TABLE ... ADD CONSTRAINT`, and rewriting `workspaces` — the table every other one
-- references — to add a `>= 0` guard would hold aside the whole schema for a bound the repository
-- also enforces. The setter clamps, and the Postgres constraint is what makes it structural where
-- it can be.

ALTER TABLE workspaces ADD COLUMN chat_thread_ceiling_usd REAL NOT NULL DEFAULT 0.50;
ALTER TABLE workspaces ADD COLUMN chat_daily_ceiling_usd  REAL NOT NULL DEFAULT 2.00;
