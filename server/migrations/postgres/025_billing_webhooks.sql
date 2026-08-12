-- 025_billing_webhooks — what has already been acted on.
--
-- Stripe delivers at least once, and says so: a webhook it does not get a 2xx for is retried,
-- and a 2xx it does not receive because the connection dropped is retried too. So the same
-- event WILL arrive twice, and "did we already do this" has to be a question the database
-- answers rather than a property of the handler being fast.
--
-- IT IS NOT THE SAME PROBLEM `usage_events.idempotency_key` SOLVES, which is why it is a
-- separate table rather than another key in that one. A usage row is idempotent because writing
-- it twice would be one charge recorded twice; a webhook is idempotent because ACTING on it
-- twice would apply a state transition twice — a plan change reapplied after a later one has
-- superseded it, a cancellation undone by its own retry. The unit of protection is the event,
-- not the row it happens to write.
--
-- NO workspace_id, AND NO POLICY. A webhook arrives before we know whose it is: the whole first
-- job of the handler is to resolve a customer or subscription id to a workspace, and a row that
-- required the answer in order to record the question could not be written for the events that
-- fail to resolve — which are exactly the ones worth keeping. It is a platform-level log, like
-- `plans`, and nothing tenant-scoped reads it.
CREATE TABLE billing_webhook_events (
  -- The provider's own event id. THE primary key, not a surrogate: it is what makes a
  -- redelivery collide, and a surrogate id with a unique index on this would be the same thing
  -- with an extra column.
  id           text PRIMARY KEY,
  type         text NOT NULL,
  -- Which workspace it turned out to be about, once resolved. Nullable and NOT a foreign key:
  -- an event for a customer nobody recognises is the one that most needs recording, and a
  -- constraint would refuse exactly that row.
  workspace_id uuid,
  received_at  timestamptz NOT NULL DEFAULT now(),
  -- Set when the handler finished with it. A row with this NULL is one that arrived and did not
  -- complete — a crash mid-transition — and it is the queue an operator would replay.
  processed_at timestamptz,
  -- Why it was not acted on, when it was not: an unknown customer, an event type nothing maps,
  -- a workspace since deleted. Kept because "we ignored it" and "we never saw it" are different
  -- answers to the same support question.
  outcome      text
);

CREATE INDEX billing_webhook_events_unprocessed ON billing_webhook_events (received_at)
  WHERE processed_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON billing_webhook_events TO jaroku_app;
