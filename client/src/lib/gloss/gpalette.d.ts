// Declarations for the vendored `gpalette.js`. Hand-written; see PROVENANCE.md.

export interface GlossPalette {
  id: string;
  label: string;
  /** Five hex strings. `colorIx` indexes this, so its LENGTH is part of a recipe's meaning. */
  colors: readonly string[];
}

export const PALETTES: readonly GlossPalette[];
export const PALETTE_IDS: readonly string[];
export const PALETTE_BY_ID: Readonly<Record<string, GlossPalette>>;
export const HAIR_COLORS: readonly { id: string; label: string; hex: string; w: number }[];

/** A lightened version of a colour, for a sheen tint only — never for a shadow. */
export function tint(hex: string, k?: number): string;
export function pickOutfit(i: number, body: string, hair: string): unknown;
