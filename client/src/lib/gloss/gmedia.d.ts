// Declarations for the vendored `gmedia.js`. Hand-written; see PROVENANCE.md and `types.ts`.
import type { MaterialFor } from "./types.ts";

export const MATERIALS: readonly { id: string; label: string }[];
export const MATERIAL_IDS: readonly string[];

/** Three overbright softboxes in a grey room, prefiltered once. Half of the gloss look is here. */
export function studioEnv(renderer: unknown): unknown;

/** One factory per environment, caching by finish and colour. Parts never construct a material. */
export function makeMaterialFactory(env: unknown): MaterialFor;

/**
 * The lights, the shadow rig and the surface shadows land on.
 *
 * `shadows: "wall"` is the contact-sheet arrangement: a plane just behind the characters, a nearly
 * head-on key, and a short shadow thrown down-right onto it. That is what a grid of cells wants —
 * the floor variant needs ground to stand on, which a card does not have.
 */
export function dressScene(
  scene: unknown,
  renderer: unknown,
  opts?: { span?: number; pool?: number; shadows?: boolean | "wall"; wallZ?: number },
): { key: unknown; wall?: unknown; floor: unknown };
