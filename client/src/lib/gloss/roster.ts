// The committed roster: every avatar this product has, frozen.
//
// DATA ONLY, AND THAT IS WHAT MAKES IT REVERTIBLE. If the characters turn out to be wrong — too
// similar at card size, too loud against a hairline UI, the wrong twenty-four out of a possible
// hundred — the fix is a revert of the commit that filled this array, with no code touched and no
// migration to unwind. That property is worth more than any individual entry in it.
//
// FROZEN MEANS FROZEN. `agents.avatar_id` stores an `id` from this list, and the backfill hashes an
// agent's uuid into this array IN SORT ORDER. So:
//
//   REMOVING an entry orphans every agent wearing it.
//   RE-POINTING an id at a different recipe changes those agents' faces without touching their rows.
//   RE-ORDERING moves every backfilled agent to a different avatar on the next migration.
//
// Appending is the safe operation, and it is safe only because the sort is asserted rather than
// typed — `test:gloss-roster` re-derives it, the same discipline `EMOJI_PALETTE` follows one package
// over and for the same reason: an order somebody typed is an order somebody can retype.
//
// AND NOTHING HERE IS GENERATED. Each entry came off the gloss sheet, run locally against the
// scratch checkout with `species=humanoid` pinned, looked at, and written down. See `docs/` for the
// contact sheet and §10's D1 for how many and why.

import type { GlossRecipe } from "./recipe.ts";

/**
 * Sorted by `id`, and the sort is the mapping.
 *
 * Empty until the curation pass lands. The shape is fixed here so that commit cannot invent a
 * different one — the same reason `agentCategories.ts` exists before the picker does.
 */
export const GLOSS_ROSTER: readonly GlossRecipe[] = [];

/** By id, for the one lookup every render site does. Built once rather than per card. */
export const ROSTER_BY_ID: ReadonlyMap<string, GlossRecipe> = new Map(
  GLOSS_ROSTER.map((r) => [r.id, r]),
);

/**
 * Which avatar an agent wears when nobody has chosen one.
 *
 * THE SAME FNV-1a AND THE SAME DISCIPLINE AS THE EMOJI ASSIGNMENT, deliberately: two hashes in one
 * product is two answers to "which list does this agent map into", and the day somebody improves one
 * of them is the day half the identities in every workspace move. Migration 068's backfill spells
 * the same arithmetic in SQL, because a migration that needs the application running is a migration
 * that runs twice.
 *
 * IT DOES NOT PROBE, WHICH IS THE ONE PLACE IT DIFFERS FROM `assignEmoji`. §6 says taking an avatar
 * another agent already uses is ALLOWED and warned — so a duplicate is a thing the product permits
 * on purpose, and a probe would be enforcing a rule the picker deliberately does not.
 */
export function avatarIdFor(agentUuid: string): string | null {
  if (GLOSS_ROSTER.length === 0) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < agentUuid.length; i++) {
    h ^= agentUuid.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return GLOSS_ROSTER[(h >>> 0) % GLOSS_ROSTER.length]!.id;
}
