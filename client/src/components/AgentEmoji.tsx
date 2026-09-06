// One emoji, bare, on whatever surface it lands on.
//
// THE WHOLE COMPONENT IS A RULE ABOUT WHAT NOT TO DRAW. No circle, no rounded square, no tinted
// box, no gradient backdrop, no border, no fixed-size cell. A chip or a badge around this would be
// the first filled container in a product that draws structure in hairlines — and at 16px the
// container would be larger and louder than the thing inside it.
//
// SO IT IS A `<span>` WITH A FONT SIZE AND NOTHING ELSE. Size comes from `font-size` rather than
// from a box, which is what lets the glyph sit on the text baseline with the agent's name and take
// normal inline spacing to it rather than a fixed-width gutter. `line-height: 1` is the one other
// property, and it is there for §13's walk: an emoji with an unusually tall glyph must not push its
// row taller than its neighbours, and a default line box is exactly how that happens.
//
// ALWAYS `aria-hidden`. The agent's name is right beside it — a screen reader announcing "tractor"
// before every agent name is noise, not information. That is true at all seven sites, which is why
// it is not a prop.
//
// IT IS IDENTITY, NEVER STATE, and it never enters the tag row. The tag row has a precedence ladder
// — Attention > Runtime > Deploy > Health > Lifecycle — that trims to three plus a `+n` chip, so an
// identity mark in it would be trimmed away exactly when the card is busiest, which is when you most
// need to know which agent you are looking at.
//
// NULL RENDERS NOTHING. Migration 067's column is nullable and every row is backfilled, but a row
// written by a version that predates the backfill is a real possibility on a rolling deploy — and a
// placeholder glyph would be a mark that is the same on every agent, which is the failure the
// feature exists to fix.
//
//   npm run test:emoji-render

/** §8.4's four registers. Named, so no call site writes a pixel count against the card it is on. */
export const EMOJI_SIZE = {
  /** A dense row — a thread's agent attribution, a work row, a fleet card, the palette. */
  row: 14,
  /** The sidebar's agent list. The reason this feature exists. */
  sidebar: 16,
  /** An agent card in the grid. */
  card: 18,
  /** The agent detail's header, beside the display name. */
  header: 20,
  /** The picker itself, in the identity section. */
  picker: 32,
} as const;

export function AgentEmoji({
  emoji,
  size = EMOJI_SIZE.row,
}: {
  emoji: string | null | undefined;
  size?: number;
}) {
  if (!emoji) return null;
  return (
    <span aria-hidden style={{ fontSize: size, lineHeight: 1 }}>
      {emoji}
    </span>
  );
}
