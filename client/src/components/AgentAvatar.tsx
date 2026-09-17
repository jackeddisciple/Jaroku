// An agent's face, and the banner cut from the same picture's palette.
//
// TWO COMPONENTS IN ONE FILE BECAUSE THEY ARE TWO CROPS OF ONE DECISION. `agents.picture` names a
// PAIR — a square portrait and a wide band in that portrait's own hue — and every surface that draws
// the band also draws the portrait over it. Splitting them across two files would let a card resolve
// the banner from one place and the portrait from another, which is the one way this feature can be
// wrong and still render: Iris's face on Bruno's green.
//
// ── WHAT THIS REPLACES, AND WHY IT IS SO MUCH SMALLER ──────────────────────────────────────────
//
// The card used to draw a procedurally-generated 3D character on a shared WebGL canvas floating
// above the grid, with a build queue, a frame budget, a gaze region and an emoji placeholder for the
// seconds before a character landed. Every one of those parts existed to make the renderer safe, and
// none of them existed to make the product better: browsers cap live WebGL contexts at eight to
// sixteen and kill the oldest silently, so a grid of cards each owning a canvas went blank at random
// on a real workspace, and the single shared canvas was the fix for a problem the feature had
// introduced.
//
// AN `<img>` HAS NONE OF THAT. There is no context to budget, no queue, so no placeholder state to
// design, no loop to park on blur, and nothing to measure every frame. What is on screen a moment
// after the card mounts is the picture, and what is on screen on a machine with no GPU is the same
// picture.
//
// ── WHAT IS STILL A DECISION ───────────────────────────────────────────────────────────────────
//
// NULL DRAWS THE INITIAL, NOT A GREY SQUARE. `picture` is nullable and always written — but a row
// from before migration 079's backfill is a real possibility during a rolling deploy, and so is an
// id naming a picture somebody removed from the set. The initial is the same treatment the creator
// avatar on the card's own footer already uses, so a card in that state reads as the product minus
// one picture rather than as a card with a hole in it.
//
// `aria-hidden`, AT EVERY SIZE, exactly as the mark it replaces was. The agent's name is beside the
// picture on all three surfaces, and a screen reader announcing "Iris" before the word "Iris" is
// noise. That is true everywhere this is used, which is why it is not a prop.

import { faceFor } from "../lib/agentFaces.ts";
import { RADIUS } from "../lib/tokens.ts";

/**
 * The sizes a face is drawn at. Three, and each is a surface rather than a preference.
 *
 * THE FLOOR IS NO LONGER AN ARGUMENT ABOUT THE RENDERER. The 3D character this replaces had one at
 * 52px, because below it the haircut and the glasses that separated two characters stopped
 * separating anything and the renderer was being run to produce a smudge. An illustration has no
 * such cost: at 16px it is a coloured disc, which is exactly as findable in a column of forty as the
 * emoji it replaces and is the same picture as the one on the card.
 */
export const AVATAR_SIZE = {
  /**
   * The sidebar's agent list.
   *
   * SIXTEEN, IN THE TAB ICONS' OWN COLUMN — the product owner's call, and it is the size the emoji
   * that used to sit here was given a box of. The row's 10px of left padding lands a 16px picture on
   * the same 16px the five destinations above it start at, so the agents read as part of one rail
   * rather than as a wider list hanging off it.
   */
  sidebar: 16,
  /** The portrait on an agent card, straddling its banner. */
  card: 56,
  /** The compact density's, which is the one thing compact shrinks besides dropping a line. */
  compact: 44,
  /** The agent detail header, where there is room for the face to be looked at. */
  header: 96,
} as const;

/**
 * The radius, per size, and both values are §04's.
 *
 * "Agent avatars: 20–24px container radius; artwork may have its own silhouette" — the one row of
 * that table given as a RANGE rather than a rung, and the range is what lets a 56px portrait and a
 * 96px one both read as the same shape. 20px on 56 is a soft squircle; 20px on 96 would be nearly
 * square, so the header takes the top of the range.
 *
 * AT SIDEBAR SIZE IT IS A CIRCLE, and that needs no branch: `border-radius` is clamped by the
 * browser to half the box, so 20px on a 16px picture IS a circle. Which is the right shape there —
 * a squircle at 16px is a rounded rectangle nobody can see the corners of.
 */
const RADIUS_FOR = (size: number): number => (size >= AVATAR_SIZE.header ? RADIUS.hero : RADIUS.xl);

export function AgentAvatar({
  picture,
  name,
  size = AVATAR_SIZE.card,
  ring,
  className = "",
}: {
  /** The stored id — `agents.picture`. Null draws the initial. */
  picture: string | null | undefined;
  /** The agent's name, for the initial when there is no picture. */
  name: string;
  size?: number;
  /**
   * A band of the surface's own colour around the picture, naming which surface.
   *
   * FOR THE PLACES THE PICTURE OVERLAPS SOMETHING — the card, where it straddles the seam between
   * the banner and the sheet, and the detail header, where it straddles the banner and the pane.
   * The ring is what makes it read as sitting ON the surface rather than as a hole cut through both.
   *
   * IT NAMES A SURFACE RATHER THAN TAKING A COLOUR, because a ring in any colour other than the one
   * directly behind the picture is a halo. Both values are §01 tokens, so there is no call site at
   * which an off-palette value can be passed: `elevated` is the card's white frame, `canvas` is the
   * detail pane's ground.
   */
  ring?: "elevated" | "canvas";
  className?: string;
}) {
  const face = faceFor(picture);
  const radius = RADIUS_FOR(size);

  // THE RING IS A BOX-SHADOW RATHER THAN A BORDER OR A PADDED WRAPPER. A border would eat into the
  // picture's own box and shrink the face by twice its width; a wrapper would be a second element to
  // keep the radius of in step. A spread shadow grows outwards from the shape it is on, so the
  // picture stays the size it was asked to be and the ring follows its corners for free.
  const style = {
    width: size,
    height: size,
    borderRadius: radius,
    ...(ring ? { boxShadow: `0 0 0 3px var(--color-bg-${ring === "canvas" ? "canvas" : "elevated"})` } : {}),
  };

  if (!face) {
    return (
      <div
        style={style}
        // THE CREATOR AVATAR'S TREATMENT, one size up. `bg-active` with ink on it is what this app
        // already draws an initial on, in the card's footer and the sidebar's account row, and a
        // second spelling of the same fallback would be a second thing to keep in step.
        className={`flex shrink-0 items-center justify-center bg-active font-medium text-ink ${className}`}
        aria-hidden
      >
        {/* THE SIZE IS THE BOX'S, so the letter has to be told its own. Forty-four percent is what
            reads as filled without touching the corners at any of the four sizes above — the same
            proportion the emoji placeholder this replaces was held at. */}
        <span style={{ fontSize: Math.round(size * 0.44), lineHeight: 1 }}>
          {name.trim().slice(0, 1).toUpperCase() || "?"}
        </span>
      </div>
    );
  }

  return (
    <img
      src={face.portrait}
      alt=""
      aria-hidden
      // LAZY AND ASYNC, because a workspace with forty agents is forty portraits and the grid
      // scrolls. `decoding="async"` keeps the decode off the thread that is drawing the row the
      // picture is in, which is the half `loading` does not cover.
      loading="lazy"
      decoding="async"
      width={size}
      height={size}
      style={style}
      className={`shrink-0 object-cover ${className}`}
    />
  );
}

/**
 * The banner: the same picture's wide band, as a background.
 *
 * A BACKGROUND RATHER THAN AN `<img>`, which is the one place these two differ in kind. The band is
 * drawn at whatever shape the surface gives it — a wide strip on a card, something else on the
 * detail header — and `cover` is what crops it to fit; an `<img>` would need `object-fit` and a
 * wrapper to clip it, for the same result and two more elements.
 *
 * NOTHING IS DRAWN WHEN THERE IS NO PICTURE. Not a grey band, not a gradient: the surface above it
 * collapses to nothing and the card's own text sits where it always did. A placeholder band would be
 * the same on every agent that is missing one, which is the failure the feature exists to fix.
 */
export function AgentBanner({
  picture,
  className = "",
  style,
}: {
  picture: string | null | undefined;
  className?: string;
  style?: React.CSSProperties;
}) {
  const face = faceFor(picture);
  if (!face) return null;
  return (
    <div
      aria-hidden
      className={`bg-cover bg-center ${className}`}
      style={{ ...style, backgroundImage: `url(${face.banner})` }}
    />
  );
}
