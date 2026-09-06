// Declarations for the vendored `grig.js`. Hand-written; see PROVENANCE.md and `types.ts`.
import type { BuiltGloss, GlossRecipeObject, MaterialFor } from "./types.ts";

export const BODY_IDS: readonly string[];
export const STANCE_IDS: readonly string[];

/**
 * A blank recipe with a seed and five nulls.
 *
 * CURATION-TIME ONLY. I2: an avatar is a frozen recipe, not a render, and nothing in shipped code
 * may call this — a roster entry that was generated at runtime is an agent whose face changes.
 * It is declared because the curation pass genuinely uses it; `test:gloss-roster` is what enforces
 * the rule, because a type cannot.
 */
export function newGRecipe(seed?: number): GlossRecipeObject;

/** Fills in every field the recipe was not told, in place, and returns it. */
export function ensureGParams(recipe: GlossRecipeObject): GlossRecipeObject;

/** Recipe → bones → meshes. Catmull-Clark subdivided at `subdiv: 2`, so it is not free. */
export function buildGloss(
  recipe: GlossRecipeObject,
  opts?: { materialFor?: MaterialFor },
): BuiltGloss;
