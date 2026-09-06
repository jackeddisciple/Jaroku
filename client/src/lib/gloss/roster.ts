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
 * Twenty-eight characters, sorted by `id`, and the sort is the mapping.
 *
 * TWENTY-EIGHT, IN §3'S 24–40 BAND AND NEAR ITS BOTTOM. See D1 for the reasoning; the short version
 * is that the count is bounded above by the picker rather than by the renderer. Every entry has to
 * be TELLABLE APART from every other at 96px, and past about thirty humanoids drawn from one part
 * generator the marginal character is a near-duplicate of one already there — which costs a row of
 * the picker and buys nothing.
 *
 * HOW THEY WERE CHOSEN, in §3's order:
 *
 *   DISTINCT AT 96px. Picked off a contact sheet rendered at exactly the size the card draws, not
 *   off the gloss sheet at 150px. Silhouette does the separating: thirteen hair styles including
 *   two bald heads, both body forms, and glasses on seven. The closest pair on the first sheet —
 *   two pale blonde flocked spheres with their eyes shut — was broken by replacing one of them,
 *   because two characters differing only in shade are one character.
 *
 *   HUMANOID ONLY, and BIPED only. The head-only stance is upstream's house look for creatures and
 *   it is wrong here: a card shows a worker, and a floating head reads as a mask. `GLOSS_STANCES`
 *   keeps both because that is the runtime's vocabulary; the roster uses one, and the suite says so.
 *
 *   NOTHING READS AS RUNNING. Three palettes are excluded by measurement (`EXCLUDED_PALETTES`) and
 *   every entry's RESOLVED body colour is checked again, because a passing palette with an unlucky
 *   seed still lands amber. And one exclusion that no rule refused: `ginger` hair. It is a minority
 *   area so the palette rule does not see it, and on the sheet it still read orange — the same kind
 *   of call as the five emoji withdrawn by hand, and recorded the same way so it is not folklore.
 *
 *   MATERIAL VARIETY. All eleven finishes appear. The two that upstream calls treats stay treats:
 *   one chrome and one resin in twenty-eight, which is about the rate a gloss sheet deals them.
 *
 * Nineteen of the twenty-eight are the `skin` palette, which is the humanoid's own. The rest are
 * pale schemes that shift the skin tone rather than replace it. A sheet where a third of the faces
 * are mint is a novelty aisle, not a cast.
 */
export const GLOSS_ROSTER: readonly GlossRecipe[] = [
  { id: "alder",    label: "Alder",    seed: 1000,
    species: "humanoid", body: "cube",    stance: "biped", palette: "skin",     material: "ceramic" },
  { id: "ash",      label: "Ash",      seed: 105729,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "denim",    material: "ceramic" },
  { id: "basalt",   label: "Basalt",   seed: 524645,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "skin",     material: "ceramic" },
  { id: "birch",    label: "Birch",    seed: 629374,
    species: "humanoid", body: "cube",    stance: "biped", palette: "skin",     material: "ceramic" },
  { id: "cedar",    label: "Cedar",    seed: 1153019,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "bloom",    material: "chrome" },
  { id: "clover",   label: "Clover",   seed: 1676664,
    species: "humanoid", body: "cube",    stance: "biped", palette: "skin",     material: "crazed" },
  { id: "cobalt",   label: "Cobalt",   seed: 1990851,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "skin",     material: "crazed" },
  { id: "coral",    label: "Coral",    seed: 2200309,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "skin",     material: "flocked" },
  { id: "dune",     label: "Dune",     seed: 2619225,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "mist",     material: "flocked" },
  { id: "fennel",   label: "Fennel",   seed: 2409767,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "skin",     material: "flocked" },
  { id: "flint",    label: "Flint",    seed: 2933412,
    species: "humanoid", body: "cube",    stance: "biped", palette: "dusk",     material: "glossy" },
  { id: "gorse",    label: "Gorse",    seed: 3352328,
    species: "humanoid", body: "cube",    stance: "biped", palette: "skin",     material: "glossy" },
  { id: "hazel",    label: "Hazel",    seed: 3457057,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "denim",    material: "glossy" },
  { id: "indigo",   label: "Indigo",   seed: 3666515,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "skin",     material: "pearl" },
  { id: "juniper",  label: "Juniper",  seed: 3875973,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "skin",     material: "pearl" },
  { id: "kelp",     label: "Kelp",     seed: 4085431,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "skin",     material: "pearl" },
  { id: "larch",    label: "Larch",    seed: 5027992,
    species: "humanoid", body: "cube",    stance: "biped", palette: "skin",     material: "resin" },
  { id: "linen",    label: "Linen",    seed: 5342179,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "skin",     material: "rubber" },
  { id: "maple",    label: "Maple",    seed: 5446908,
    species: "humanoid", body: "cube",    stance: "biped", palette: "skin",     material: "rubber" },
  { id: "marble",   label: "Marble",   seed: 5656366,
    species: "humanoid", body: "cube",    stance: "biped", palette: "skin",     material: "rubber" },
  { id: "nettle",   label: "Nettle",   seed: 5761095,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "skin",     material: "rubber" },
  { id: "onyx",     label: "Onyx",     seed: 5970553,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "mist",     material: "skin" },
  { id: "opal",     label: "Opal",     seed: 6284740,
    species: "humanoid", body: "cube",    stance: "biped", palette: "dusk",     material: "skin" },
  { id: "pebble",   label: "Pebble",   seed: 6598927,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "moss",     material: "wood" },
  { id: "quartz",   label: "Quartz",   seed: 6703656,
    species: "humanoid", body: "cube",    stance: "biped", palette: "skin",     material: "wood" },
  { id: "rowan",    label: "Rowan",    seed: 7017843,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "skin",     material: "wood" },
  { id: "sage",     label: "Sage",     seed: 7339949,
    species: "humanoid", body: "cube",    stance: "biped", palette: "skin",     material: "wool" },
  { id: "slate",    label: "Slate",    seed: 7436759,
    species: "humanoid", body: "sphere",  stance: "biped", palette: "skin",     material: "wool" },
];

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
