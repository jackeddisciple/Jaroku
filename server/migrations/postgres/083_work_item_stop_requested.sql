-- 083_work_item_stop_requested — when somebody pressed Stop on a job, kept on the job.
--
-- WHAT WAS WRONG. Stop asks the container to stop at the next node boundary, and the job went on
-- running until then — for a single-node agent, to the end. It finished `succeeded`, was billed,
-- and kept no trace that anybody had asked it to stop, so the record said a job ran as asked when
-- somebody had tried to stop it. The container now ends a run that misses its boundary, and this
-- column is what lets the row and the detail say a stop was asked for, and when.
--
-- NULLABLE AND WITHOUT A DEFAULT, which makes this an expand step: the version still serving
-- during a rolling deploy does not name the column, and null is the true answer for every job
-- nobody tried to stop.

ALTER TABLE work_items ADD COLUMN stop_requested_at timestamptz;
