// What an avatar IS, as a type — five axes, a seed, and two names.
//
// I2: AN AVATAR IS A FROZEN RECIPE, NOT A RENDER. The roster is committed data and the renderer is a
// pure function of it, which is what makes an agent's face a fact about that agent rather than a
// side effect of whichever version of the code drew it last. Nothing generates a recipe at runtime;
// `newGRecipe` is a curation-time tool and `test:gloss-roster` is what enforces that, because a type
// cannot.
//
// THE CONTRACT LANDS BEFORE THE CONTENT, which is the whole reason this file is its own commit: the
// curation pass produces two dozen literals, and two dozen literals written against a shape nobody
// fixed first is two dozen literals that have to be rewritten.
//
// SIX FIELDS, AND THE SEED IS THE SIXTH. §5 says "an id, a display label and the five axis values",
// and five axes do not determine a character — the haircut, the eyes, the nose, the mouth and the
// shade of the body all come out of `seed` through the part generators. Two entries with identical
// axes and different seeds are two different people, which is most of what a roster of twenty-four
// humanoids IS. Leaving the seed off would have meant a roster of five distinguishable characters.
//
// WHAT IS DELIBERATELY NOT A FIELD:
//
//   `colorIx` — which of the palette's five colours the body is poured in. §3's first criterion says
//   two characters differing only in a palette shade are ONE character, so shade is not a curation
//   axis; it falls out of the seed like the haircut does. Promoting it to a field would invite
//   exactly the pair the criterion forbids.
//
//   `parts` — the per-feature parameter bag `ensureGParams` fills in. It is derived from the seed,
//   it runs to a few hundred numbers per character, and a roster carrying it would be a roster
//   nobody could review and a diff nobody could read.

import { PALETTES } from "./gpalette.js";

/**
 * The only species this product deals.
 *
 * §3.2, and it is not an arbitrary narrowing: the other eight are animals and objects, and a grid
 * of agent cards wearing a bear, a slime and a robot reads as a mascot sheet rather than as
 * identity. `humanoid` is also the one species that names its own palette and material — see
 * `GLOSS_PALETTES` — which is why every entry has to state both to get anything but skin.
 */
export const GLOSS_SPECIES = "humanoid";

/**
 * The two body forms a person may be.
 *
 * `BODY_IDS` upstream is four — sphere, cube, rock and slime — and the humanoid's own species
 * profile already refuses the last two: "those two are creature shapes, and naming the two forms a
 * person may be is what keeps them off this species". A recipe CAN pin `rock`, because a pinned
 * axis wins over the profile, and the result is a boulder with a haircut. So the union is narrowed
 * here rather than left open and policed by review.
 *
 * Sorted, like every other list in this file, because the sort is checkable and a typed order is not.
 */
export const GLOSS_BODIES = ["cube", "sphere"] as const;
export type GlossBody = (typeof GLOSS_BODIES)[number];

/**
 * Whether the character has a body under the head.
 *
 * Upstream pins the humanoid to `biped` on the argument that "a floating humanoid head with no body
 * reads as a decapitation, not a character". Both are in the union because a card is not a contact
 * sheet: at 96px a head-only character gets roughly twice the face, and whether that is worth the
 * decapitation is a thing to settle by looking rather than by reading. What the roster actually uses
 * is recorded in D1.
 */
export const GLOSS_STANCES = ["biped", "none"] as const;
export type GlossStance = (typeof GLOSS_STANCES)[number];

/**
 * The palettes a roster entry may name, and the three it may not.
 *
 * §3.3 IS A RULE ABOUT THIS PRODUCT, NOT ABOUT THE PALETTES. Amber means IN FLIGHT in Jaroku —
 * forty-eight call sites, the node glow and the stream pulse say so — and an agent that is
 * permanently orange, in a grid whose cards carry status on their borders and glyphs, reads as
 * permanently running. That is a colour telling a lie about state, which is the one thing the whole
 * status vocabulary exists to prevent.
 *
 * SO THE EXCLUSION IS MEASURED AGAINST THE PRODUCT'S OWN AMBER rather than eyeballed. `#B77A1B` is
 * hue 37°, saturation 0.74, lightness 0.41; `isAmberish` draws a band around it, and a palette is
 * out when TWO OR MORE of its five colours fall inside — two of five is a two-in-five chance that
 * the body colour, which is the largest area of the character, lands there.
 *
 *   ember    three of five   the palette is a fire
 *   apricot  two of five     ditto, one step cooler
 *   circuit  two of five     and upstream keeps it out of its own deal anyway: "a page's palette,
 *                            not a character's"
 *
 * `skin` scores ZERO, which is the check working rather than a let-off: skin tones sit at hue 25
 * but light and unsaturated, and a naive hue-only band would have excluded the humanoid's own
 * palette. The lightness term is what tells a flesh tone from a warning.
 *
 * A PALETTE PASSING IS NOT ENOUGH. Four of the survivors have one amber-range colour each, and a
 * seed can still land the body on it — so `test:gloss-roster` resolves every entry's ACTUAL body
 * colour and applies the same rule again. The list is the coarse filter; the per-entry check is the
 * one that would catch a real mistake.
 */
export const EXCLUDED_PALETTES = ["apricot", "circuit", "ember"] as const;

/** Every palette the roster may name, sorted, with the three above removed. */
export const GLOSS_PALETTES = PALETTES.map((p) => p.id)
  .filter((id) => !(EXCLUDED_PALETTES as readonly string[]).includes(id))
  .sort() as readonly string[];

/**
 * Is this colour close enough to the product's amber to be mistaken for it at card size?
 *
 * HUE, SATURATION AND LIGHTNESS, ALL THREE. Hue alone calls a pale flesh tone amber; hue and
 * saturation alone calls a cream amber. The band is deliberately generous on the red side — 8°
 * rather than 20° — because the failure is a character reading as "running", and a hot coral does
 * that as readily as a true amber does.
 *
 * Exported because `test:gloss-roster` applies it to resolved body colours, which is where it does
 * the work: the palette list is a filter over five colours, and this is the question asked of the
 * one colour a character is actually poured in.
 */
export function isAmberish(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return false;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return h >= 8 && h <= 52 && s >= 0.6 && l <= 0.72;
}

/**
 * One committed avatar.
 *
 * `id` AND `label` ARE BOTH HERE AND THEY ARE NOT THE SAME FACT, for the reason `agents.slug` and
 * `agents.display_name` are two columns. The id is the mapping: it is what `agents.avatar_id`
 * stores, what the deterministic backfill hashes into, and what a workspace's avatars are pinned to
 * for as long as those rows exist. The label is what a person reads in the picker and can be
 * reworded on a Tuesday without moving a single agent's face.
 */
export interface GlossRecipe {
  /** Stable, kebab-case, and the sort key. Never re-used and never re-pointed. */
  id: string;
  /** What the picker shows. Free to reword; changing it moves nothing. */
  label: string;
  /**
   * What the part generators are dealt from. Everything not on an axis — the haircut, the eyes, the
   * nose, the mouth, the body's shade — comes out of this one integer.
   */
  seed: number;
  /** Always `"humanoid"`. On the entry rather than implied, so the roster reads as recipes. */
  species: typeof GLOSS_SPECIES;
  body: GlossBody;
  stance: GlossStance;
  /** One of `GLOSS_PALETTES`. Named explicitly, because the species would otherwise pin `skin`. */
  palette: string;
  /** One of `MATERIAL_IDS`. Named explicitly, for the same reason. */
  material: string;
}

/**
 * A roster entry as the vendored runtime wants it.
 *
 * THE FIVE AXES ARE WRITTEN IN BEFORE `ensureGParams` RUNS, which is the whole mechanism: every
 * field in that function uses `??=`, so it fills only what it was not told. That is how the gloss
 * sheet's filter bar pins a dimension, and it is the only reason a humanoid can wear anything other
 * than skin — the species profile names `palette: 'skin'` and `material: 'skin'`, and a stated axis
 * wins because the `??=` finds a value already there.
 *
 * `colorIx` and `parts` go in as null and empty and come back filled, deterministically, from
 * `seed`.
 */
export function toGlossRecipe(entry: GlossRecipe): {
  seed: number;
  species: string;
  body: string;
  stance: string;
  palette: string;
  colorIx: number | null;
  material: string;
  parts: Record<string, unknown>;
} {
  return {
    seed: entry.seed,
    species: entry.species,
    body: entry.body,
    stance: entry.stance,
    palette: entry.palette,
    colorIx: null,
    material: entry.material,
    parts: {},
  };
}
