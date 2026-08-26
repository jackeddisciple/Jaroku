-- 062_invite_agent_grant — the SQLite half. Read the Postgres file for why this is a json column on
-- the invitation rather than a table of its own, and for why it deliberately carries no foreign key
-- to `agents`: §16 requires that an invitation accepted after its agent was deleted still create the
-- membership and discard the grant silently, which a key would turn into an error.
--
-- `json` BECOMES `TEXT` HOLDING JSON, read back through `jsonFromColumn` exactly as every other
-- payload column on this driver is. The usual warning applies and is easy to honour here: nothing
-- queries into it. It is read once, by `acceptInvite`, for one invitation.
--
-- `ALTER TABLE ... ADD COLUMN` IN PLACE, with no rebuild. This driver allows that for a nullable
-- column with no default, which is what this is — so migration 059's rebuild idiom does not apply
-- and the three indexes it recreated by hand stay where they are.

ALTER TABLE workspace_invites ADD COLUMN agent_grant TEXT;
