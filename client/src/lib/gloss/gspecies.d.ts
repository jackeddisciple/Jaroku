// Declarations for the vendored `gspecies.js`. Hand-written; see PROVENANCE.md.
//
// A species is a table of loaded dice, not a set of new drawings. `humanoid` is the only one this
// product deals, and it is the one species that names its own palette and material — which is why
// a roster entry has to state both explicitly to get anything other than skin.

export interface GlossSpecies {
  label: string;
  cast: Record<string, unknown>;
  palette?: string;
  material?: string;
  body?: Record<string, number>;
  stance?: Record<string, number>;
}

export const GSPECIES: Readonly<Record<string, GlossSpecies>>;
export const GSPECIES_IDS: readonly string[];
export function pickGBody(speciesId: string, rng: unknown, defaultPairs: unknown): string;
export function pickGStance(speciesId: string, rng: unknown, defaultPairs: unknown): string;
export function gcastingFor(speciesId: string): (partId: string) => unknown;
