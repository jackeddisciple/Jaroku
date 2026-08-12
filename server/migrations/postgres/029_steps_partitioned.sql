-- 029_steps_partitioned — `steps` becomes one table per month.
--
-- WHY THIS TABLE AND NO OTHER. `steps` is the one that gets huge: a run is one row and its steps
-- are hundreds, every one carrying four JSON payloads. Session 1's own note said so — "steps is
-- the table that gets huge. Plan for partitioning by month in Session 8; get the index order
-- right now so it is cheap later" — and the index order it chose is why this migration is a
-- rewrite of the table rather than a rewrite of every query.
--
-- WHAT IT BUYS, AND IT IS ONE THING: RETENTION BECOMES INSTANT AND FREE. A plan promises a
-- retention window, and enforcing one on a monolithic table means `DELETE FROM steps WHERE
-- started_at < …` over tens of millions of rows — hours of I/O, a bloated table that VACUUM has
-- to reclaim, and a lock profile that makes it a maintenance window rather than a cron job.
-- `DROP TABLE steps_2026_01` is a catalogue update. The sweeper in the next commit is a few
-- lines because of this migration, not despite it.
--
-- PARTITIONED ON A `text` COLUMN, AND THAT IS DELIBERATE. `started_at` is ISO-8601 text — the
-- frozen event schema's shape, and `schema/events.md` is not editable. ISO-8601 sorts
-- lexicographically exactly as it sorts chronologically, which is the entire reason that format
-- was chosen in the first place, so RANGE partitioning on the text is correct without a cast: a
-- bound of '2026-08-01' to '2026-09-01' contains '2026-08-12T09:14:22.001Z' and nothing from
-- July or September. Converting the column to timestamptz would have been the textbook answer
-- and would have changed the shape a step is read back as, which is the one thing this migration
-- may not do — see `test:shape-parity`, which exists to catch exactly that.
--
-- THE PRIMARY KEY GAINS THE PARTITION KEY, because Postgres requires it: a unique index on a
-- partitioned table has to contain the partitioning column, or uniqueness could only be enforced
-- within each partition. `(id, started_at)` is still unique on `id` in practice — ids are uuids —
-- and the ON CONFLICT (id) DO NOTHING that makes at-least-once trace ingestion safe needs a
-- unique index it can name, which is why `steps_id_key` is created below as well.
--
-- THERE IS A DEFAULT PARTITION, and it is not optional. An INSERT with no matching partition
-- FAILS — and the row it would fail on is a trace step, which means a run that outlives the last
-- created partition silently loses its trace. The default catches those, `lifecycle/partitions.ts`
-- creates months ahead of time so it stays empty, and a non-empty default is a metric with an
-- alert on it rather than a surprise.

-- --- the new shape -----------------------------------------------------------------------------

ALTER TABLE steps RENAME TO steps_legacy;
ALTER INDEX IF EXISTS steps_ws_run_seq RENAME TO steps_legacy_ws_run_seq;
DROP INDEX IF EXISTS idx_steps_run_seq;

CREATE TABLE steps (
  id             text NOT NULL,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id),
  run_id         text NOT NULL,
  seq            integer NOT NULL,
  type           text NOT NULL,
  name           text NOT NULL,
  input          json,
  output         json,
  state_before   json,
  state_after    json,
  tokens         bigint,
  cost           double precision,
  latency_ms     double precision NOT NULL DEFAULT 0,
  error          text,
  parent_step_id text,
  started_at     text NOT NULL,
  checkpoint_id  text,
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

-- THE FOREIGN KEY TO `runs` IS DELIBERATELY NOT RECREATED.
--
-- It was `run_id REFERENCES runs(id)`, and on a partitioned table it would be enforced per
-- partition, adding an index and a lock to the hottest insert path in the system for a guarantee
-- the ingest already provides: a step is only ever written for a run this process just wrote. It
-- also makes `DROP TABLE steps_2026_01` — the entire point of this migration — a cascade
-- question rather than a catalogue update. The trace is append-only and its ordering is `seq`,
-- not referential integrity.

-- The default, first, so no window exists in which an insert has nowhere to go.
CREATE TABLE steps_default PARTITION OF steps DEFAULT;

-- Every month the existing data spans, plus the current one and the two after it. Generated
-- rather than listed, because a migration cannot know when it will be applied — a database
-- restored from a year-old dump needs a year of partitions, and one created this morning needs
-- three.
DO $$
DECLARE
  m date;
  lo date;
  hi date;
BEGIN
  SELECT COALESCE(date_trunc('month', MIN(started_at)::timestamptz)::date, date_trunc('month', now())::date)
    INTO lo FROM steps_legacy;
  hi := (date_trunc('month', now()) + interval '3 months')::date;
  m := lo;
  WHILE m < hi LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS steps_%s PARTITION OF steps FOR VALUES FROM (%L) TO (%L)',
      to_char(m, 'YYYY_MM'),
      to_char(m, 'YYYY-MM-DD'),
      to_char((m + interval '1 month')::date, 'YYYY-MM-DD')
    );
    m := (m + interval '1 month')::date;
  END LOOP;
END
$$;

-- --- the data ----------------------------------------------------------------------------------
--
-- One statement, inside the migration's own transaction: either every step is in the new table
-- or none is, and there is no state in which two tables both hold half a trace. A step whose
-- `started_at` is malformed enough not to fall in any month lands in the default partition rather
-- than failing the migration — losing the run that produced it would be a worse outcome than
-- keeping a row in the wrong place.
INSERT INTO steps (
  id, workspace_id, run_id, seq, type, name, input, output, state_before, state_after,
  tokens, cost, latency_ms, error, parent_step_id, started_at, checkpoint_id
)
SELECT
  id, workspace_id, run_id, seq, type, name, input, output, state_before, state_after,
  tokens, cost, latency_ms, error, parent_step_id, started_at, checkpoint_id
FROM steps_legacy;

DROP TABLE steps_legacy;

-- --- indexes -----------------------------------------------------------------------------------
--
-- Declared on the parent, which creates a matching index on every partition and on every one
-- created later. Same order as Session 1 chose — workspace first, because every query starts
-- from the tenant — and it is now also the order that lets the planner prune partitions.
CREATE INDEX steps_ws_run_seq ON steps (workspace_id, run_id, seq);

-- The unique index `ON CONFLICT (id) DO NOTHING` needs. It has to include the partition key to
-- exist at all on a partitioned table, so this is `(id, started_at)` — and the ingest's conflict
-- target stays `(id)`, which Postgres resolves against the PRIMARY KEY above.
CREATE UNIQUE INDEX steps_id_started ON steps (id, started_at);

-- --- the backstop --------------------------------------------------------------------------------
--
-- The policy is declared on the PARENT and inherited by every partition, including ones created
-- years from now. That is the property that makes partitioning safe here: a monthly maintenance
-- job that had to remember to add a policy would eventually forget, and the failure mode of
-- forgetting is a month of every tenant's traces readable by every other.
ALTER TABLE steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE steps FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON steps;
CREATE POLICY tenant_isolation ON steps
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON steps TO jaroku_app;
