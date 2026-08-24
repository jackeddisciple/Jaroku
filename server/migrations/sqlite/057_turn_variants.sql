-- 057_turn_variants — the SQLite half. Read the Postgres file for every decision: why a
-- regeneration is a new row rather than an edit, why every metadata column is per-variant, why
-- `agent_version_id` records what a variant PRODUCED and never what is published, why `ordinal` is
-- a number a person reads rather than a timestamp ordering, and why the backfill nulls what it
-- does not know instead of guessing.
--
-- Same translation as every migration on this driver: uuid -> TEXT, timestamptz -> TEXT holding
-- ISO-8601 UTC, numeric -> REAL, integer -> INTEGER. Ids and timestamps Postgres would default are
-- supplied by the repository, because SQLite has no `now()` that writes the same string shape.
--
-- `numeric` BECOMES `REAL`, AND THAT IS THE TRANSLATION WORTH NAMING. Postgres's numeric is exact
-- and REAL is a float, so a cost written on one driver and summed on the other can differ in the
-- last places. It is safe here for the reason pricing.ts already relies on: every USD value in this
-- codebase is rounded to eight decimals by `round8` before it is stored, which is orders of
-- magnitude below any real step cost — so the rounding cannot accumulate into a visible aggregate.
--
-- The CHECK that is a separate statement on Postgres is inline on the column, and the UNIQUE
-- constraint is a UNIQUE INDEX, because SQLite has no `ALTER TABLE ... ADD CONSTRAINT`.
--
-- NO RLS, on this driver, ever — see 009. The repository layer's WHERE is the whole of the
-- enforcement, which is why every method in the variant store takes a context first.

CREATE TABLE turn_variants (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  turn_id          TEXT NOT NULL,
  ordinal          INTEGER NOT NULL,

  model_id         TEXT,
  provider         TEXT,
  -- BOTH LEVELS. §6.2 renders the clamp marker by comparing them; one column would make
  -- "XHigh requested; this model caps at High" underivable after the fact.
  effort_requested TEXT CHECK (effort_requested IN ('low', 'medium', 'high', 'xhigh')),
  effort_applied   TEXT CHECK (effort_applied   IN ('low', 'medium', 'high', 'xhigh')),

  duration_ms      INTEGER,
  tokens_in        INTEGER,
  tokens_out       INTEGER,
  cost_usd         REAL,

  agent_version_id TEXT,

  created_at       TEXT NOT NULL,

  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES thread_items (workspace_id, id) ON DELETE CASCADE
);

-- One variant per number per turn — the constraint that stops two concurrent regenerations both
-- claiming to be variant 2 and leaving a switcher with two 2s in it.
CREATE UNIQUE INDEX turn_variants_turn_ordinal
  ON turn_variants (workspace_id, turn_id, ordinal);

CREATE INDEX turn_variants_turn ON turn_variants (workspace_id, turn_id, ordinal);

-- --- the backfill -----------------------------------------------------------------------------
--
-- §7: "Existing turns backfill into turn_variants as ordinal = 1, carrying whatever model/duration
-- data already exists; null the rest rather than guessing."
--
-- The id is built out of `randomblob` — the standard v4 expression, the same one 044 uses and for
-- the same reason: the Postgres column is a real `uuid` and shapeParity compares the two drivers'
-- rows, so an id that merely looks like one in a listing would not do.
INSERT INTO turn_variants (id, workspace_id, turn_id, ordinal, created_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
         || substr(lower(hex(randomblob(2))), 2) || '-'
         || substr('89ab', abs(random()) % 4 + 1, 1)
         || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       ti.workspace_id, ti.id, 1, ti.created_at
  FROM thread_items ti
 WHERE ti.kind IN ('plan', 'generation', 'proposal')
   AND NOT EXISTS (
     SELECT 1 FROM turn_variants v
      WHERE v.workspace_id = ti.workspace_id AND v.turn_id = ti.id);
