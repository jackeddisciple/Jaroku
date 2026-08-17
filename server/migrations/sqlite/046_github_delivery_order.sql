-- 046_github_delivery_order — the SQLite half. Read the Postgres file for why a redelivered push
-- put the same row in History twice, why the watermark could end up at the earlier of two commits,
-- and why the unique index is partial.
--
-- Same translation as everywhere else: timestamptz -> TEXT ISO-8601. SQLite supports partial
-- indexes, so the constraint is the same one.
--
-- NO RLS, on this driver, ever — see 009.

ALTER TABLE github_events ADD COLUMN delivery_id TEXT;

-- KEYED BY LINK AS WELL AS DELIVERY, because one delivery legitimately produces one row PER
-- LINK: two agents in the same workspace can be linked to the same repository and branch
-- through different subdirectories, and both want their own History entry. What must not
-- happen twice is the same delivery against the same link. Every row the predicate admits is
-- webhook-caused and therefore carries a link.
CREATE UNIQUE INDEX github_events_delivery
  ON github_events (workspace_id, delivery_id, link_id)
  WHERE delivery_id IS NOT NULL;

ALTER TABLE github_links ADD COLUMN remote_seen_at TEXT;
