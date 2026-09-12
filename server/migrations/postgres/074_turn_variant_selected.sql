-- 074_turn_variant_selected — which of a turn's answers is the one the conversation means.
--
-- §6.2 IS THE REASON AND IT IS ONE SENTENCE: "Only the SELECTED sibling participates in conversation
-- memory and in the context sent for subsequent turns. The unselected siblings are retained and
-- viewable but are not silently fed back to the model."
--
-- WITHOUT THIS COLUMN THAT SENTENCE IS HALF TRUE. The switcher moved the answer on screen and
-- nothing else: the window assembler picks the newest variant with a body, so somebody who
-- regenerated three times and switched back to the first read answer one while the model read
-- answer three. Every following turn was then answered against a reply the user had visibly
-- rejected — invisibly, because the screen said otherwise.
--
-- A BOOLEAN RATHER THAN A POINTER ON THE TURN, and the choice is not arbitrary. `thread_items` is
-- the turn, and a `selected_variant_ordinal` column there would be a number that has to stay in
-- range of a row count in another table — so deleting or failing to write a variant would leave a
-- turn pointing at an answer that does not exist. A flag on the variant cannot dangle: the thing it
-- is about is the row it is on.
--
-- NO UNIQUE INDEX, AND THAT IS DELIBERATE. A partial unique index — `UNIQUE (workspace_id, turn_id)
-- WHERE selected` — is the tempting constraint, and SQLite and Postgres spell partial indexes
-- differently enough that the two halves of this migration would stop being translations of each
-- other. The store writes selection inside a transaction that clears the turn's other rows first,
-- and the READ tolerates a tie by taking the highest ordinal — so two selected rows degrade to
-- "the newest one wins", which is the same answer the column's absence gives. A constraint that
-- can only be violated by a bug in one statement, protecting against an outcome identical to the
-- default, is not worth two dialects of index.
--
-- DEFAULT FALSE AND NO BACKFILL. A turn with no selected variant reads as "the newest one", which
-- is exactly what every turn did before this column existed — so nothing that is already in a
-- thread changes meaning, and the column only starts deciding anything once somebody presses the
-- switcher.
--
-- AN EXPAND: a defaulted boolean the running version does not select. No contract step.

ALTER TABLE turn_variants ADD COLUMN selected boolean NOT NULL DEFAULT false;

-- The read is "this turn's selected variant", so the flag belongs in the key rather than beside it.
CREATE INDEX turn_variants_selected ON turn_variants (workspace_id, turn_id, selected);
