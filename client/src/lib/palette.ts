// colour_system.pdf, as data — the one place the specification's own tokens are written down.
//
// The specification is LOCKED and it is a LIGHT system. Everything above this file used to be built
// on a near-black one: `#0d0d0f` surfaces, off-white ink, shadows at 40% black, and a `GLOW` token
// whose entire argument was that a hovered card on a near-black page cannot get darker, only
// brighter. All of that is inverted here, and the reasoning that went with it is rewritten rather
// than deleted — a comment that argues for the opposite of what the code does is worse than none.
//
// THE SPECIFICATION'S NAMES ARE KEPT VERBATIM, including `--color-` and including the ones this
// product does not have a use for. Two reasons. The first is that §09's rules are written in these
// names ("sidebar uses Pale Mist family (#E9EEEF base); main canvas remains #F7F7F5"), so a review
// against the PDF has to be able to find them. The second is that `index.css` publishes exactly
// this set as custom properties, for the three consumers a Tailwind class cannot reach — React
// Flow's own chrome, cmdk's group headings, and the scroll masks — and a variable named after the
// app rather than after the specification is a variable nobody can check.
//
// TOKENS.TS IS THE LAYER ABOVE THIS ONE. This file says what colours exist; `tokens.ts` says what
// they MEAN — which surface is a card, which one is the thing a card sits on, which single colour
// is allowed to say "you are here". Nothing in this file knows about the app.

/** §01. The neutral ladder every surface stands on, lightest-sitting-on-darkest. */
export const CANVAS = {
  /** Main application canvas. */
  canvas: "#F7F7F5",
  /** Cards and standard content surfaces. */
  surface: "#FBFBFA",
  /** Elevated panels, popovers and dialogs. */
  elevated: "#FFFFFF",
  /** Subtle containers and secondary areas. */
  subtle: "#F1F1EF",
  /** Neutral hover where no palette tint is needed. */
  hover: "#ECECEA",
  /** Neutral pressed/selected state outside palette surfaces. */
  active: "#E5E5E1",
} as const;

/**
 * §02. The sidebar is its own structural plane, and that is a decision rather than a shade.
 *
 * "It should visibly differ from the main content without becoming dark or dashboard-like. It has
 * no outer shadow and no outer radius; a quiet border separates it from the main workspace."
 *
 * Which is why these are four tokens of their own rather than four of §01's: the sidebar's hover is
 * a cool grey and the content area's is a warm one, and a single `hover` token would make the
 * sidebar warm the first time somebody reused it.
 */
export const SIDEBAR = {
  /** Sidebar base. */
  base: "#E9EEEF",
  /** Hovered navigation item. */
  hover: "#DEE6E8",
  /** Selected navigation item. */
  active: "#D3DDE0",
  /** Sidebar/content separation. */
  border: "#D2DCDD",
} as const;

/**
 * §03. Pale Mist — surfaces, selection and atmosphere.
 *
 * The reference colour is `400` (#C0C8CA) and §03 is explicit that it "is used selectively; lighter
 * derived steps carry most of the UI". `100`, `200` and `300` are the same values §02 names for the
 * sidebar, deliberately: the sidebar IS the Pale Mist family, and writing the numbers twice is what
 * lets a future surface join that family without copying the sidebar's tokens.
 */
export const PALE_MIST = {
  /** Very subtle cool surface. */
  50: "#F3F6F6",
  /** Sidebar base / cool surface family. */
  100: "#E9EEEF",
  /** Hover state. */
  200: "#DEE6E8",
  /** Active/selected state. */
  300: "#D3DDE0",
  /** Reference Palette 04 colour. */
  400: "#C0C8CA",
} as const;

/**
 * §04. Deep Harbor — interaction, emphasis and identity.
 *
 * "Use it rarely for active icons, important secondary actions, links, selected-control foregrounds
 * and occasional Agent Details/avatar environments." §09 repeats the restraint twice more: Deep
 * Harbor "remains rare and intentional", and "Not every button or heading."
 *
 * This is the app's one interaction accent — see INTERACTION in tokens.ts for the four jobs it is
 * allowed to do and why there is no fifth.
 */
export const DEEP_HARBOR = {
  /** Primary secondary accent. */
  base: "#2B4851",
  /** Stronger hover/pressed accent. */
  hover: "#24404A",
  /** Very subtle Harbor-tinted background. */
  soft: "#E8EFF0",
} as const;

/** §05. Four steps of ink, and the fourth is a state rather than a level of emphasis. */
export const TEXT = {
  /** Primary headings, names and important content. */
  primary: "#1D1D1B",
  /** Supporting text and normal metadata. */
  secondary: "#62625F",
  /** Low-emphasis metadata, timestamps and slugs. */
  muted: "#90908C",
  /** Disabled controls and unavailable content. */
  disabled: "#B5B5B0",
} as const;

/** §06. Three weights of boundary, chosen by how much the boundary is meant to be noticed. */
export const BORDER = {
  /** Very muted row/card dividers. */
  subtle: "#E6E6E2",
  /** Inputs, cards and standard boundaries. */
  default: "#DCDCD8",
  /** Focused/important boundaries. */
  strong: "#C9C9C4",
} as const;

/**
 * §07. The four that mean something.
 *
 * §09: "Semantic colours: green, amber, red and blue retain functional meaning and are not replaced
 * by the secondary palette." They are the one part of this palette that may never be spent on
 * decoration, because a colour used decoratively stops being readable as a state.
 */
export const SEMANTIC = {
  /** Live, healthy, resolved and successful states. */
  success: "#3B8F5A",
  /** Credential warnings, attention and caution. */
  warning: "#B77A1B",
  /** Failures, destructive states and critical errors. */
  danger: "#C94A43",
  /** Informational states and neutral system guidance. */
  info: "#4B78B8",
} as const;

/**
 * §08. There is no brand colour, and that is the brand.
 *
 * "No single coloured brand accent; Jaroku remains neutral/off-white." So `brand` has no value —
 * the specification writes NONE in the table — and the two things it would have been used for are
 * named separately: charcoal carries a primary high-contrast action, Deep Harbor is the secondary
 * accent and explicitly "not the primary brand colour".
 *
 * `strong` is the same value as `TEXT.primary` on purpose. A filled charcoal button is ink turned
 * inside out, and the two moving apart would make a primary action a slightly different black from
 * the heading above it.
 */
export const BRAND = {
  /** No single coloured brand accent; Jaroku remains neutral/off-white. */
  base: null,
  /** Charcoal for primary high-contrast actions. */
  strong: "#1D1D1B",
  /** Deep Harbor is the secondary accent, not the primary brand colour. */
  secondary: "#2B4851",
} as const;

/**
 * Every token the specification names, under the name it names it by.
 *
 * This is what `index.css` publishes as custom properties and what `colourSystem.test.ts` checks
 * the stylesheet and the Tailwind config against. `--color-brand` is deliberately absent rather
 * than empty: a variable that resolves to nothing is a variable somebody will use by accident,
 * and §08's point is that there is nothing there to use.
 */
export const SPEC_TOKENS: Readonly<Record<string, string>> = {
  "--color-bg-canvas": CANVAS.canvas,
  "--color-bg-surface": CANVAS.surface,
  "--color-bg-elevated": CANVAS.elevated,
  "--color-bg-subtle": CANVAS.subtle,
  "--color-bg-hover": CANVAS.hover,
  "--color-bg-active": CANVAS.active,

  "--color-sidebar": SIDEBAR.base,
  "--color-sidebar-hover": SIDEBAR.hover,
  "--color-sidebar-active": SIDEBAR.active,
  "--color-sidebar-border": SIDEBAR.border,

  "--color-pale-mist-50": PALE_MIST[50],
  "--color-pale-mist-100": PALE_MIST[100],
  "--color-pale-mist-200": PALE_MIST[200],
  "--color-pale-mist-300": PALE_MIST[300],
  "--color-pale-mist-400": PALE_MIST[400],

  "--color-deep-harbor": DEEP_HARBOR.base,
  "--color-deep-harbor-hover": DEEP_HARBOR.hover,
  "--color-deep-harbor-soft": DEEP_HARBOR.soft,

  "--color-text-primary": TEXT.primary,
  "--color-text-secondary": TEXT.secondary,
  "--color-text-muted": TEXT.muted,
  "--color-text-disabled": TEXT.disabled,

  "--color-border-subtle": BORDER.subtle,
  "--color-border-default": BORDER.default,
  "--color-border-strong": BORDER.strong,

  "--color-success": SEMANTIC.success,
  "--color-warning": SEMANTIC.warning,
  "--color-danger": SEMANTIC.danger,
  "--color-info": SEMANTIC.info,

  "--color-brand-strong": BRAND.strong,
  "--color-brand-secondary": BRAND.secondary,
} as const;

/**
 * §09's proportion, as a number something can check.
 *
 * "Neutral-first: roughly 75–85% of the interface remains neutral. Pale Mist supplies the cool
 * atmospheric layer; Deep Harbor remains rare and intentional."
 *
 * The floor rather than the band, because being MORE neutral than 85% is not a violation of
 * neutral-first — it is the same instruction followed further. What the number guards is the drift
 * downwards, one reasonable-looking coloured call site at a time.
 *
 * `colourSystem.test.ts` counts this in CALL SITES rather than in tokens. Counting tokens was the
 * first attempt and it reported 45%, which says nothing: the palette has one canvas token covering
 * a whole screen and five Pale Mist steps that mostly do not appear. A class census is a fair proxy
 * for area in an app whose surfaces are all painted by classes.
 */
export const NEUTRAL_SHARE_FLOOR = 0.75;

/** Hex to `r, g, b`, for the few places that need the channels — a scrim, a glow, a ring. */
export const channels = (hex: string): string => {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
};

/** The same, at an alpha. Written out so a translucent accent is never a hex somebody guessed. */
export const alpha = (hex: string, a: number): string => `rgba(${channels(hex)}, ${a})`;
