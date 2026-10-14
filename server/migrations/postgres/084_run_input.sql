-- 084_run_input — what a run was started with, kept on the run.
--
-- WHAT WAS WRONG. "Run again" re-sent nothing: no run kept its input, so the menu ran the agent with
-- no input at all, the runner fell back to its default greeting, and a run started on a job
-- description came back as a run on "Hello! Please introduce yourself…" — which failed. The text a
-- run was given is the one thing needed to run it again, and it lived only in the process that ran.
--
-- A CONTROL-PLANE COLUMN BESIDE THE FROZEN SCHEMA, like `parent_run_id`: written by the server when
-- the run starts, never emitted in an event, and not in the history rows the app is sent (they carry
-- only whether one was kept), because an input can be a whole document and the history is re-sent
-- whole. "Run again" asks the server to re-run a run by id, and the server reads it here. An empty
-- string is a run started with no input — which runs the default again, as it did the first time.
--
-- NULLABLE AND WITHOUT A DEFAULT, which makes this an expand step: the version still serving during
-- a rolling deploy does not name the column, and null is the true answer for every run started before
-- this — their inputs were never kept, and "Run again" says so rather than guessing.

ALTER TABLE runs ADD COLUMN input text;
