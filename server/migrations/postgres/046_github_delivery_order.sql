-- 046_github_delivery_order — a push delivered twice, and two pushes delivered out of order.
--
-- GitHub's webhook delivery is at-least-once and unordered, and this path assumed neither.
--
-- THE HISTORY ROW WAS AN APPEND. `applyPush` calls `record(kind:"fetch")` per delivery, which
-- INSERTs unconditionally, while the module's own header says the path is idempotent — "the route
-- records a head sha it was told about, and being told twice writes the same sha twice". That is
-- true of `patchLink` and false of `record`: a redelivery put the same push in the History list
-- twice. The only guard was `DeliveryLog`, a 500-entry Set built per process, which cannot survive
-- a restart and cannot help a second replica. `delivery_id` is GitHub's own `X-GitHub-Delivery`,
-- and the partial unique index is what makes writing it twice a no-op rather than a second row.
--
-- NULLABLE, AND THE INDEX IS PARTIAL, because most rows in this table are not deliveries at all —
-- a push Jaroku made, a link created, a scan overridden. Those have no delivery id and must not
-- collide with each other, which a total unique index over a null-heavy column does differently on
-- the two drivers anyway.
--
-- AND THE WATERMARK WAS A BLIND OVERWRITE. `last_known_remote_sha` was set from whatever arrived
-- last, and `last_synced_at` records RECEIPT time, so it orders deliveries rather than commits.
-- Two pushes seconds apart, delivered out of order, left the column at the earlier head — and the
-- panel's behind/ahead badge is computed against it, so it reported divergence from a commit that
-- was no longer the tip. `remote_seen_at` is the push's OWN time, taken from the payload, and the
-- write refuses a timestamp older than the one stored — the same "reject the stale writer" shape
-- `Editor.apply`'s `current_version !== baseVersion` check already uses one feature over.

ALTER TABLE github_events ADD COLUMN delivery_id text;

-- KEYED BY LINK AS WELL AS DELIVERY, because one delivery legitimately produces one row PER
-- LINK: two agents in the same workspace can be linked to the same repository and branch
-- through different subdirectories, and both want their own History entry. What must not
-- happen twice is the same delivery against the same link. Every row the predicate admits is
-- webhook-caused and therefore carries a link.
CREATE UNIQUE INDEX github_events_delivery
  ON github_events (workspace_id, delivery_id, link_id)
  WHERE delivery_id IS NOT NULL;

ALTER TABLE github_links ADD COLUMN remote_seen_at timestamptz;
