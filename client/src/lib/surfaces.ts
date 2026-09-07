// UI-4.pdf — "Radius, Shape, Elevation & Visual Hierarchy" — as data.
//
// This file is to UI-4 what `palette.ts` is to colour_system.pdf: the one place the specification's
// own tables are written down, under the specification's own names, knowing nothing about the app.
// `tokens.ts` is the layer above it — which rung a button climbs, which one a dialog does — and
// `surfaceSystem.test.ts` is what holds the copies to each other.
//
// WHY A SECOND SPEC FILE RATHER THAN MORE OF `tokens.ts`. The two specifications answer different
// questions and are locked separately: colour_system.pdf decides what things are COLOURED, UI-4
// decides what SHAPE they are and how far off the page they sit. `tokens.ts` already imports the
// first and derives from it; it imports this one the same way. Keeping the transcription apart from
// the interpretation is what makes a review against the PDF possible at all — the tables below can
// be read straight down the page beside it, which is not true of a file that also argues about what
// a card is.
//
// THE SPECIFICATION IS LOCKED, so drift is the only interesting failure here too. Nobody disagrees
// with the table on purpose; what happens is that one of the three places a radius lives gets
// edited and the other two do not. `surfaces.ts` holds the numbers, `tailwind.config.js` carries
// them as classes, `index.css` publishes them as custom properties for the consumers a class cannot
// reach. A Tailwind config cannot import a `.ts` module without moving the whole config to
// TypeScript, and a stylesheet cannot import anything at all, so the scale genuinely is written
// three times. The suite is what makes them agree.

/**
 * §04. The radius scale — nine rungs, in the specification's own order and under its own names.
 *
 * NINE WHERE THIS CLIENT HAD FOUR, and the four were not a subset. The client's scale was
 * `chip` 4 / `control` 6 / `card` 10 / `modal` 14, chosen by the size of the box rather than by what
 * the component was called, on the argument that a corner radius reads as a proportion of the
 * corner it turns. §05 keeps that argument — "radius follows hierarchy" — and then makes a
 * distinction the four-rung scale could not: a BUTTON and an INPUT are the same size box and are
 * two different rungs, 8px and 10px, because an input is a surface you put something into and a
 * button is a control you press. One is softer than the other on purpose.
 *
 * So `control` moved 6 → 8 and `card` moved 10 → 12; `chip` became `xs` and `modal` became `lg` at
 * the spec's own 16. Three rungs are new: `input` at 10, and `xl`/`hero` at 20 and 24 for the
 * expressive agent surfaces the client had no rung for and was rounding at 14.
 *
 * `pill` IS ON THE SCALE AND `rounded-full` IS NOT THE SAME THING. The client kept 999px
 * deliberately off its scale, on the argument that something whose radius is half its height is a
 * SHAPE rather than a corner treatment. §04 lists it as a token anyway, and §05 says why: "Pills
 * are semantic: reserve 999px for statuses, counts and filters." Naming it is what lets that rule
 * be a rule — a scale that does not contain the pill cannot say where the pill is allowed. A circle
 * is still `rounded-full`: an avatar is round because it is round, not because it is a status.
 */
export const RADIUS_SCALE = {
  /** Tiny technical elements and compact surfaces. */
  xs: 4,
  /** Very compact controls. */
  sm: 6,
  /** Buttons and standard controls. */
  control: 8,
  /** Inputs and compact interactive surfaces. */
  input: 10,
  /** Standard cards, Inbox items, Thread containers. */
  card: 12,
  /** Agent cards, dialogs, major containers. */
  lg: 16,
  /** Prominent surfaces. */
  xl: 20,
  /** Special hero and expressive agent surfaces. */
  hero: 24,
  /** Status tags, badges and semantic pills only. */
  pill: 999,
} as const;

export type RadiusName = keyof typeof RADIUS_SCALE;

/**
 * §04's table as the custom properties `index.css` publishes, spelled the specification's way.
 *
 * The same reasoning as `palette.ts`'s `SPEC_TOKENS`: §05's rules are written in these names
 * ("buttons 8px; inputs 10px; standard cards 12px"), so a review against the PDF has to be able to
 * find them, and a variable named after the app rather than after the specification is a variable
 * nobody can check against the page it came from.
 */
export const RADIUS_TOKENS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(RADIUS_SCALE).map(([name, px]) => [`--radius-${name}`, `${px}px`]),
);

/**
 * §05. The shape rules, as the two things about the scale that are not a number.
 *
 * SIZE IS NOT THE ONLY AXIS ANY MORE, which is the change §05 makes to how a rung gets picked. The
 * client's rule was purely proportional — pick the rung that suits the size of the box — and §05
 * adds hierarchy on top of it: "Radius follows hierarchy." A dialog is 16px because it is a major
 * container, not because of how many pixels tall it happens to be, and an expressive agent surface
 * is 20–24px because it is expressive. Two boxes of one size can sit on two rungs now, and the
 * question that separates them is what they are FOR.
 *
 * THE SIDEBAR IS THE RULE'S SHARPEST CASE AND IT IS A ZERO. "Sidebar: 0px outer radius; structural,
 * not floating." It is the same sentence colour_system.pdf §02 already made about its shade — the
 * sidebar is a plane the app is built on rather than an object sitting on the page — and a rounded
 * corner on it would undo, in one property, what a whole cool-grey palette is saying.
 */
export const SHAPE = {
  /** The sidebar is structural: no outer radius, and see `ELEVATION_SPEC` for no outer shadow. */
  sidebarOuterRadius: 0,
  /** Agent avatar containers. A range, because §04 gives the artwork its own silhouette inside. */
  avatarRadius: { min: RADIUS_SCALE.xl, max: RADIUS_SCALE.hero },
} as const;
