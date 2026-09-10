// new-theme.pdf, as data — the one place the specification's own tokens are written down.
//
// THE SPECIFICATION IS NEUTRAL-FIRST AND IT IS SMALLER THAN THE ONE BEFORE IT. The previous system
// was a light one too, so this is not the inversion that pass was; what it is is a NARROWING. Three
// whole families are struck out — the Pale Mist secondary palette, the cool-grey sidebar plane
// drawn from it, and Deep Harbor, the one coloured interaction accent — and §05 replaces all three
// with a sentence: "No separate coloured brand accent. Jaroku's brand is the neutral/off-white
// system itself." §06 says the same thing as an instruction, twice: "No purple/blue brand accent:
// Jaroku should not look like a purple SaaS dashboard. Use charcoal and neutral contrast for
// primary actions."
//
// SO THE REASONING THAT ARGUED FOR THOSE FAMILIES IS REWRITTEN RATHER THAN DELETED, the same way
// the dark system's was when this file was first written. A comment that argues for a colour the
// file no longer has is worse than none, and the arguments were good ones — the sidebar plane in
// particular was a real decision, and what replaces it has to be a decision too rather than an
// absence somebody fills in later.
//
// THE SPECIFICATION'S NAMES ARE KEPT VERBATIM, including `--color-`. Two reasons. The first is that
// §06's rules are written in these names ("use #E6E6E2 for the very muted row dividers"), so a
// review against the PDF has to be able to find them. The second is that `index.css` publishes
// exactly this set as custom properties, for the three consumers a Tailwind class cannot reach —
// React Flow's own chrome, cmdk's group headings, and the scroll masks — and a variable named after
// the app rather than after the specification is a variable nobody can check.
//
// TOKENS.TS IS THE LAYER ABOVE THIS ONE. This file says what colours exist; `tokens.ts` says what
// they MEAN — which surface is a card, which one is the thing a card sits on, which single colour
// is allowed to say "you are here". Nothing in this file knows about the app.

/** §01. The neutral ladder every surface stands on, lightest-sitting-on-darkest. */
export const CANVAS = {
  /** Main application background. */
  canvas: "#F6F6F4",
  /** Cards and standard surfaces. */
  surface: "#FAFAF9",
  /** Elevated panels, popovers and dialogs. */
  elevated: "#FFFFFF",
  /** Subtle containers and secondary areas. */
  subtle: "#F0F0EE",
  /** Hover state for neutral surfaces. */
  hover: "#ECECEA",
  /** Pressed/selected neutral state. */
  active: "#E5E5E1",
} as const;

/** §02. Four steps of ink, and the fourth is a state rather than a level of emphasis. */
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

/** §03. Three weights of boundary, chosen by how much the boundary is meant to be noticed. */
export const BORDER = {
  /** Default row/card dividers; intentionally very quiet. §06 names this value twice. */
  subtle: "#E6E6E2",
  /** Inputs, cards and standard component boundaries. */
  default: "#DCDCD8",
  /** Focused/important boundaries when more definition is required. */
  strong: "#C9C9C4",
} as const;

/**
 * §04. The four that mean something.
 *
 * §06: "Semantic colours are functional: green, amber, red and blue appear only when their meaning
 * is useful. Keep them muted rather than neon." They are the one part of this palette that may
 * never be spent on decoration, because a colour used decoratively stops being readable as a state
 * — and in a system with no brand accent left they are the only saturated colours on screen, which
 * makes that rule matter more here than it did before, not less.
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
 * THE SIDEBAR PLANE, DRAWN FROM §01 RATHER THAN FROM A FAMILY OF ITS OWN.
 *
 * The previous specification gave the sidebar four tokens and a secondary palette to strike them
 * from, on the argument that it "should visibly differ from the main content without becoming dark
 * or dashboard-like" and that a shared `hover` would make the sidebar warm the first time somebody
 * reused it. The first half of that argument survives and the second no longer applies: there is
 * one neutral family now, so there is no cool hover for a warm one to drift into.
 *
 * WHAT IS KEPT IS THE STRUCTURE. The sidebar is still its own plane and it is still one step UNDER
 * the canvas — `surfaceSystem.test.ts` asserts that numerically, because it is the one rule a
 * palette edit could silently reverse — so the column reads as the thing the workspace sits beside
 * rather than as a card floating on it. What is gone is the cool cast.
 *
 * These are aliases, not new values: four of §01's six under the names eighty call sites already
 * say. The alternative was rewriting `bg-sidebar` to `bg-void` in twenty files to gain nothing, and
 * losing the ability to say "the sidebar is a plane" in the palette at all.
 */
export const SIDEBAR = {
  /**
   * Sidebar base — §01's CANVAS, the same value the workspace beside it is painted in.
   *
   * IT WAS A STEP DARKER AND THAT IS THE CHANGE. `CANVAS.subtle` put the column six levels under
   * the workspace, which is how a flat panel says "I am a different region" — and once the window
   * carries a real material it is the wrong tool twice: the difference is already being made by
   * translucency, and a darker ground under it reads as the column having gone grey rather than
   * having gone soft. Both surfaces start at the same colour now, and what separates them is that
   * one of them lets the desktop through. See `--sidebar-material-tint` in index.css.
   *
   * The hover and active steps below are unchanged and are still §01's, so a pointed-at row is ten
   * levels under this rather than four — more contrast than it had, not less.
   */
  base: CANVAS.canvas,
  /** Hovered navigation item. */
  hover: CANVAS.hover,
  /** Selected navigation item. */
  active: CANVAS.active,
  /** Sidebar/content separation — §03's default boundary. */
  border: BORDER.default,
} as const;

/**
 * THE RUNS CAPSULE, AND IT EXTENDS THE SPECIFICATION — say so rather than bury it.
 *
 * `new-theme.pdf` names four semantic colours and no pink. This pair was asked for explicitly, with
 * these values, for one thing: the count of runs an agent has, on its sidebar row. It is
 * DELIBERATELY NOT in `SEMANTIC` above, because §06 says those four appear "only when their meaning
 * is useful" — a run count is a quantity, not a state, and filing it beside success/danger would be
 * the exact dilution that rule protects against.
 *
 * IT LIVES HERE RATHER THAN AS A HEX AT THE CALL SITE for the reason this whole module exists:
 * `test:colour-system` fails any source file that carries a colour of its own, and it is right to.
 * A palette entry is reviewable and moves in one place; nine hex literals in nine components are
 * what that suite was written after.
 *
 * IT SURVIVED THIS PASS ON PURPOSE and it is the only thing that did which the document does not
 * name. The PDF is behind the code by this one pair. Nothing automated can notice that — the suite
 * checks the four files against each other, not against the document — so it is written down here.
 */
export const RUNS = {
  /** The capsule's ground — Tailwind's pink-100. */
  soft: "#FCE7F3",
  /** Its mark and figures — Tailwind's pink-600. */
  ink: "#DB2777",
} as const;

/**
 * §05. There is no brand colour, and that is the brand.
 *
 * "No separate coloured brand accent. Jaroku's brand is the neutral/off-white system itself." So
 * `base` has no value — the specification writes NONE in the table — and the one thing it would
 * have been used for is named separately: "Use charcoal for primary high-contrast actions when
 * needed."
 *
 * `strong` is the same value as `TEXT.primary` on purpose, and the specification writes it out
 * twice for that reason. A filled charcoal button is ink turned inside out, and the two moving
 * apart would make a primary action a slightly different black from the heading above it. It is
 * also, as of this pass, the app's INTERACTION accent — see INTERACTION in tokens.ts for what
 * replaced Deep Harbor and why one charcoal is enough.
 */
export const BRAND = {
  /** No separate coloured brand accent; Jaroku's brand is the neutral system itself. */
  base: null,
  /** Charcoal for primary high-contrast actions when needed. */
  strong: "#1D1D1B",
} as const;

/**
 * Every token the specification names, under the name it names it by.
 *
 * This is what `index.css` publishes as custom properties and what `colourSystem.test.ts` checks
 * the stylesheet and the Tailwind config against. `--color-brand` is deliberately absent rather
 * than empty: a variable that resolves to nothing is a variable somebody will use by accident,
 * and §05's point is that there is nothing there to use.
 *
 * THE SIDEBAR HAS NO TOKENS HERE ANY MORE, and that is the shape of this change rather than an
 * oversight. Its four values are §01's, and publishing them a second time under a second set of
 * names is how two tokens that are meant to be the same colour stop being it.
 */
export const SPEC_TOKENS: Readonly<Record<string, string>> = {
  "--color-bg-canvas": CANVAS.canvas,
  "--color-bg-surface": CANVAS.surface,
  "--color-bg-elevated": CANVAS.elevated,
  "--color-bg-subtle": CANVAS.subtle,
  "--color-bg-hover": CANVAS.hover,
  "--color-bg-active": CANVAS.active,

  "--color-text-primary": TEXT.primary,
  "--color-text-secondary": TEXT.secondary,
  "--color-text-muted": TEXT.muted,
  "--color-text-disabled": TEXT.disabled,

  "--color-border-subtle": BORDER.subtle,
  "--color-border-default": BORDER.default,
  "--color-border-strong": BORDER.strong,

  "--color-runs-soft": RUNS.soft,
  "--color-runs-ink": RUNS.ink,

  "--color-success": SEMANTIC.success,
  "--color-warning": SEMANTIC.warning,
  "--color-danger": SEMANTIC.danger,
  "--color-info": SEMANTIC.info,

  "--color-brand-strong": BRAND.strong,
} as const;

/**
 * §06's proportion, as a number something can check.
 *
 * "Neutral-first: approximately 85–90% of the interface should remain neutral. Colour should
 * communicate meaning rather than decorate the UI."
 *
 * The floor rather than the band, because being MORE neutral than 90% is not a violation of
 * neutral-first — it is the same instruction followed further. What the number guards is the drift
 * downwards, one reasonable-looking coloured call site at a time.
 *
 * IT MOVED 75 → 85 WITH THIS PALETTE, which is the arithmetic consequence of deleting the accent
 * rather than a new ambition: the previous band was 75–85% with Pale Mist supplying "the cool
 * atmospheric layer", and there is no atmospheric layer now. Everything that is not a status, a
 * category badge or a run count is a grey.
 *
 * `colourSystem.test.ts` counts this in CALL SITES rather than in tokens. Counting tokens was the
 * first attempt and it reported 45%, which says nothing: the palette has one canvas token covering
 * a whole screen and steps that mostly do not appear. A class census is a fair proxy for area in an
 * app whose surfaces are all painted by classes.
 */
export const NEUTRAL_SHARE_FLOOR = 0.85;

/** Hex to `r, g, b`, for the few places that need the channels — a scrim, a glow, a ring. */
export const channels = (hex: string): string => {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
};

/** The same, at an alpha. Written out so a translucent accent is never a hex somebody guessed. */
export const alpha = (hex: string, a: number): string => `rgba(${channels(hex)}, ${a})`;

/**
 * `hex` moved `t` of the way towards `toward`, as a hex. For the rare shade that has to stay tied to
 * a palette value rather than become a new one somebody guessed — see `SHIELD_BLUE` in tokens.ts.
 */
export const mix = (hex: string, toward: string, t: number): string => {
  const from = channels(hex).split(", ").map(Number);
  const to = channels(toward).split(", ").map(Number);
  return `#${from.map((v, i) => Math.round(v + (to[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
};
