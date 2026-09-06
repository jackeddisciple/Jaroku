// Declarations for the vendored `gface.js`. Hand-written; see PROVENANCE.md and `types.ts`.
import type { BuiltGloss, GlossFaceLife } from "./types.ts";

export const GLOSS_FACES: readonly string[];

/** One animator per built character. It owns every write to that character's face meshes. */
export function createGlossFace(built: BuiltGloss, opts?: { gaze?: boolean }): GlossFaceLife;
