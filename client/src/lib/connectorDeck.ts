// How the connector deck is laid out — §3.2's rendering spec, as rules rather than as CSS.
//
// The deck is a stack of connector logos beside the connect icon, and §12.9 states its behaviour
// as an acceptance criterion: "1/2/3 render as tiles; 5 renders 3 tiles + +2; a disabled connector
// renders grayscale and stays in the deck." Every clause of that has a wrong answer that looks
// fine on the one workspace somebody tested with.
//
// THREE TILES, THEN A COUNTER. Not because four would not fit — because at 20px with an 8px
// overlap, the fourth logo is a sliver. §3.2: "Beyond three, individual logos are unreadable at
// 20px and the deck becomes noise." A counter says the same thing in less space and says it
// accurately.
//
// A DISABLED CONNECTOR STAYS IN THE DECK, GRAYSCALE. This is the clause most likely to be
// "simplified" away, and the spec pre-empts it: "its absence would be more confusing than its
// dimming." A deck that shrank when you switched something off would read as the connector having
// been removed from the workspace, which is precisely the thing the toggle does NOT do.
//
// WHICH ALSO DECIDES WHAT THE COUNTER COUNTS. It counts every connector past the third, enabled or
// not — the deck is a picture of what this conversation HAS, and the dimming is what says which of
// them it will use.
//
//   npm run test:connector-deck

/** One connector, as the deck needs to know it. */
export interface DeckConnector {
  id: string;
  label: string;
  /** From the connector record. Null for a self-hosted MCP server — see `monogramColor`. */
  logoUrl: string | null;
  /** False when this conversation has switched it off. Still rendered, grayscale. */
  enabled: boolean;
  /** A dying or broken credential. Puts a dot on the tile and a row in the dropdown. */
  warning?: string | null;
}

/** §3.2: "Max 3 tiles rendered, then a +N counter chip in the same footprint." */
export const MAX_TILES = 3;

/** §3.2's metrics. Exported so the component cannot quietly disagree with the suite. */
export const DECK = {
  /** Logo tile, px. */
  tile: 20,
  radius: 6,
  /** Each subsequent tile overlaps the one before it by this much. */
  overlap: -8,
  /** Hover fans them out to this, over `tokens` fast motion. Skipped under reduced motion. */
  overlapHovered: -4,
  /** The ring in the composer's background colour, so the overlap reads as separation not mud. */
  ring: 2,
} as const;

export interface DeckLayout {
  /** The tiles actually drawn, leftmost first. */
  tiles: DeckConnector[];
  /** How many are represented by the `+N` chip. Zero when there is no chip. */
  overflow: number;
  /** Whether anything at all is drawn. False means the empty state, not an empty deck. */
  present: boolean;
  /** True when any connector has a credential warning — the deck gets a dot. */
  hasWarning: boolean;
}

/**
 * What the deck draws for this set of connectors.
 *
 * ORDER IS THE CALLER'S, NOT SORTED HERE. A deck that reordered itself when you disabled something
 * would move every tile, and the whole reason enabled and disabled tiles sit together is that the
 * deck should be a stable picture of what a conversation has.
 */
export function deckLayout(connectors: readonly DeckConnector[]): DeckLayout {
  const tiles = connectors.slice(0, MAX_TILES);
  return {
    tiles,
    overflow: Math.max(0, connectors.length - MAX_TILES),
    present: connectors.length > 0,
    hasWarning: connectors.some((c) => Boolean(c.warning)),
  };
}

/**
 * The z-index for the tile at `index`.
 *
 * DESCENDING, so leftmost is on top and the deck reads left to right — §3.2 says so directly. The
 * naive ascending order puts the LAST tile on top, which makes the stack read right-to-left and
 * turns the first connector into the one most hidden by its neighbours.
 */
export function tileZ(index: number, total: number): number {
  return total - index;
}

/** The horizontal offset for the tile at `index`, in px. The first tile never shifts. */
export function tileOffset(index: number, hovered: boolean): number {
  if (index === 0) return 0;
  return hovered ? DECK.overlapHovered : DECK.overlap;
}

/**
 * A deterministic background colour for a connector with no logo.
 *
 * §3.2: "a monogram tile — first letter of the connector name on a background colour derived
 * deterministically from the connector slug, so the same connector is always the same color."
 *
 * DETERMINISTIC IS THE WHOLE REQUIREMENT. A random colour per render makes the deck flicker; a
 * colour derived from the INDEX makes a connector change colour when another one is added. Only
 * the slug is stable across both, and it is the thing a person actually associates with the tile.
 *
 * The hash is FNV-1a — small, well-distributed for short strings, and not a security primitive
 * pretending to be one. The output is an HSL hue, with saturation and lightness fixed so every
 * monogram sits at the same weight against the panel rather than one being a bright block.
 */
export function monogramColor(slug: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    hash ^= slug.charCodeAt(i);
    // The FNV prime, as shifts, because the multiply overflows 32 bits in JavaScript.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return `hsl(${hash % 360} 45% 38%)`;
}

/** The letter on a monogram tile. Uppercased, and never empty for a connector that has a name. */
export function monogramLetter(label: string): string {
  const first = label.trim()[0];
  return first ? first.toUpperCase() : "?";
}
