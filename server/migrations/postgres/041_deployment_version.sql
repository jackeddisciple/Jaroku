-- 041_deployment_version — which version a deploy built from.
--
-- WHY THIS WAS MISSING, AND WHY IT MATTERS NOW. `deployments` has recorded the agent, the host, the
-- provider and the model since 002, and never the version — because for two sessions nothing asked.
-- The Deploy panel shows an agent's current deployment and its status, and "which version is that"
-- was answerable by looking at the agent, since the agent's current version was the one deployed.
--
-- §B.8.2's canvas is what broke that. It pins a `deploys` lane against a COMMIT — "the ▼ sits under
-- whichever commit is currently live" — and to draw it you need the version the deploy built from,
-- not the version the agent has now. Those are the same thing right up until somebody publishes
-- while a deploy is in flight, at which point the marker lands under the wrong commit and says
-- something false with complete confidence.
--
-- The canvas shipped inferring it from timestamps: the newest pushed version that existed when the
-- deploy row was created. That is right in the ordinary case and wrong in exactly the case worth
-- being right about, which is not a trade worth keeping when the honest value is one column and the
-- deploy path already holds it — `DeployManagerDeps.agents` is there, and its own comment says
-- "needed to record what a deploy wrote".
--
-- NULLABLE, AND NULL MEANS "DEPLOYED BEFORE THIS MIGRATION". Backfilling from `agents.current_version`
-- would write today's version onto a deploy from three weeks ago and make every historical row
-- confidently wrong — the same class of claim this column exists to stop making. A null draws no
-- marker, which is the honest rendering of a fact nobody recorded.
--
-- AN INTEGER AND NOT A FOREIGN KEY TO `agent_versions`, which is the one choice here worth naming.
-- `deployments.agent_id` is TEXT — the agent SLUG, from the frozen pre-008 shape — so a composite
-- key to (agent_id, version) has nothing to point at, and a uuid FK would mean carrying a second
-- identifier for the same thing. The version number is what the panel, the trailer and the canvas
-- all speak, and 008 made it unique per agent.

ALTER TABLE deployments ADD COLUMN version integer;

COMMENT ON COLUMN deployments.version IS
  'The agent version this deploy built from. NULL for rows written before migration 041 — never backfilled, because a guess here is a confident lie about somebody''s production.';
