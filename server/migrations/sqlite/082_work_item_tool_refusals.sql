-- 082_work_item_tool_refusals — the tool calls a job was refused, kept on the job.
--
-- WHAT WAS WRONG. A deployed agent that asked for a high-impact tool and was DENIED — by a person,
-- or by nobody answering inside the two minutes — carried on without it, apologised in its answer,
-- and ended `succeeded` with a green tick and a bill. Nothing on the row, the detail panel or the
-- figures said a tool had been refused, so somebody reviewing the list later saw nine successful
-- jobs where nine had been refused the thing they were for.
--
-- THE STATUS STAYS WHAT IT WAS, because the run did complete; what was missing is the fact, and
-- this column is where it is recorded: a JSON array of {server, tool, outcome, at}, outcome being
-- `denied` or `timed_out`. Text rather than a JSON type, so both drivers read it the same way.
--
-- NULLABLE AND WITHOUT A DEFAULT, which makes this an expand step: the version still serving
-- during a rolling deploy does not name the column, and null is the true answer for every job
-- that was refused nothing.

ALTER TABLE work_items ADD COLUMN tool_refusals text;
