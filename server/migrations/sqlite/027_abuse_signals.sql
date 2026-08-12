-- 027_abuse_signals — the SQLite half. Read the Postgres file for why signals are rows rather
-- than log lines, why `workspace_id` is nullable, why the weight is copied rather than joined,
-- and why the subject is a digest instead of an address.
--
-- Same translation as every migration before it: uuid -> TEXT, timestamptz -> TEXT ISO-8601,
-- jsonb -> TEXT holding JSON, bigserial -> INTEGER PRIMARY KEY AUTOINCREMENT. There is no RLS
-- here and there never will be; the repository layer is the whole of the enforcement on this
-- driver, which is why every method takes a context rather than trusting one to have been set.
--
-- AUTOINCREMENT rather than a bare INTEGER PRIMARY KEY: without it SQLite reuses the ids of
-- deleted rows, and these rows ARE deleted — the retention sweeper takes them like everything
-- else. An id that comes back after a delete is one an alert or an appeal can point at and get
-- somebody else's incident.

CREATE TABLE abuse_signals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  subject       TEXT,
  kind          TEXT NOT NULL,
  weight        REAL NOT NULL,
  detail        TEXT NOT NULL DEFAULT '{}',
  target_type   TEXT,
  target_id     TEXT,
  observed_at   TEXT NOT NULL
);

CREATE INDEX abuse_signals_ws_time ON abuse_signals (workspace_id, observed_at DESC);
CREATE INDEX abuse_signals_subject_time ON abuse_signals (subject, observed_at DESC)
  WHERE subject IS NOT NULL;
CREATE INDEX abuse_signals_kind_time ON abuse_signals (kind, observed_at DESC);
