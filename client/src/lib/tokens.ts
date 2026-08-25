// Design tokens — the single place the panel's visual language is decided.
//
// `palette.ts` holds colour_system.pdf's tokens: what colours exist. This is the layer above it:
// what they MEAN. Which surface is a card and which is the thing a card sits on, which single
// colour is allowed to say "you are here", what a colour says when it is neither a surface nor a
// status. Reviewed-vs-bespoke is the distinction the plan gate is organised around, and it was once
// carried by a green ✓ against a faint + — a difference the eye reads as "one is done, one isn't"
// rather than "one is audited, one is about to be invented".
//
// EVERY VALUE HERE NOW COMES FROM `palette.ts`, and the ones that cannot be spelled from it are
// derived from it in this file rather than typed. That is the change: these used to be hex
// literals, checked against the design section of a document by eye.
//
// THE WHOLE FILE WAS BUILT FOR A NEAR-BLACK PAGE and colour_system.pdf is a light system, so a
// number of the arguments below are not merely re-valued but reversed — `GLOW` most of all, whose
// entire premise was that a hovered card on `#0d0d0f` cannot get darker, only brighter. On
// `#FBFBFA` the opposite is true. Where that has happened the old reasoning is stated and then
// answered, because a comment arguing for the opposite of what the code does is worse than none.
//
// They are exported as raw values rather than Tailwind classes because several consumers need them
// as SVG stroke / inline style values, and a token that only exists as a class name can't be handed
// to a canvas or an icon. The trace panel and the graph view said "not migrated onto this yet —
// this file exists so they *can* be, in a later pass". This is that pass; both are on it.

import { BORDER, CANVAS, DEEP_HARBOR, SEMANTIC, TEXT as INK, alpha } from "./palette.ts";

/**
 * Category accents. Each answers "what kind of thing is this", never "how is it doing".
 *
 * FOUR HUES THE SPECIFICATION DOES NOT NAME, and §09 is where they are allowed to exist: "Agent
 * personality: 3D agent avatars may introduce additional personality colours; those belong to the
 * agent layer, not the global theme." A tool's provenance is exactly that layer — it says what an
 * agent is made of, and it appears on badges inside an agent's own card, never on the chrome.
 *
 * THE VALUES CHANGED AND THE MEANINGS DID NOT. Every one of these was tuned for a near-black page:
 * `#5eead4` teal, `#c084fc` violet, `#a5b4fc` periwinkle and `#f472b6` rose are all high-lightness
 * pastels, which is what a colour has to be to read on `#0d0d0f` — and every one of them is very
 * nearly invisible on `#FBFBFA`. So each has been re-struck at the saturation register §07's own
 * four semantics sit in, keeping its hue identity and its argument.
 *
 * THEY ARE SPACED AGAINST §07 AS WELL AS AGAINST EACH OTHER, which is the constraint that decided
 * the exact hues. `reviewed` is pushed to the cyan side so it cannot be read as `success` green;
 * `mcp` is pushed to the magenta side so it cannot be read as `danger` red. `state` and `bespoke`
 * are an indigo and a violet rather than two blues, because `warning` is now §07's blue and a badge
 * a user could mistake for a status is a badge that has stopped saying what kind of thing this is.
 */
export const ACCENT = {
  /** Reviewed connector tools — audited templates copied in verbatim, read-only.
   *  Cool teal reads as locked/verified. Also GraphView's KIND_ACCENT.tool, so the graph and the
   *  plan card make one decision rather than two that happen to look alike. */
  reviewed: "#1D6C87",
  /** Bespoke tools — about to be written by a model, for this agent only.
   *  Violet, deliberately NOT amber: amber is spoken for (see STATUS.pending) and a tool category
   *  wearing the running colour would collide with the one meaning it already has. Muted rather
   *  than bright, because §09's last line is "no purple brand" — this is a badge on an agent's
   *  card, and a saturated violet at any size larger than that starts to read as the product's. */
  bespoke: "#683D8C",
  /** State fields — the agent's shape rather than its capabilities.
   *  Indigo; also GraphView's KIND_ACCENT.action. */
  state: "#3742A8",
  /** MCP tools — discovered from a third-party server nobody here has reviewed.
   *
   *  Rose, chosen because it is unlike every other accent AND unlike every STATUS colour and
   *  every GraphView KIND_ACCENT. That distance is the point: this badge's whole job is to
   *  be unmistakable at a glance, and an accent a user could confuse with "reviewed" teal or
   *  "pending" amber would fail at exactly the moment it matters. It is deliberately not red
   *  either — MCP is not an error, and crying wolf on every external tool would teach people
   *  to stop looking. */
  mcp: "#A83E82",
} as const;

export type AccentName = keyof typeof ACCENT;

/**
 * The interaction accent. One colour, four jobs, and nothing else.
 *
 * The palette above spends four accents on *categories* and had none at all on interaction:
 * selection, active tabs, links and focus were carried by a three percent lightness shift from
 * `bg` to `active` plus, on some rows, a 2px off-white bar. Which meant "which session am I in"
 * was the hardest question the sidebar answered, and a focus ring was a grey ring on a grey
 * control on a near-black page. Spending colour on what a thing *is* and none on what you are
 * *doing* is backwards for an app somebody drives with a keyboard.
 *
 * The four sanctioned uses, and there is no fifth:
 *   1. the active/selected row or tab
 *   2. sync and live iconography — the thing that is happening right now
 *   3. links
 *   4. focus rings
 *
 * Never decorative. Never a category. A Harbor badge on a non-interactive label is precisely what
 * makes an accent unusable for selection later, because the eye stops reading it as "this one".
 *
 * DEEP HARBOR, WHICH IS §04'S JOB DESCRIPTION ALMOST WORD FOR WORD: "active icons, important
 * interaction foregrounds, links, selected controls". It replaces a periwinkle blue that was
 * chosen for a near-black page, and §09 is emphatic about the restraint that has to come with it —
 * "remains rare and intentional", "Not every button or heading" — which is the same rule the four
 * sanctioned uses above already were.
 *
 * `soft` is the accent at an alpha rather than §04's `deep-harbor-soft`, and the two are not
 * interchangeable. The soft token is an opaque tinted BACKGROUND for a panel; this is a
 * translucent fill that has to sit correctly on whichever of four surfaces it lands on.
 */
export const INTERACTION = {
  accent: DEEP_HARBOR.base,
  /** The hover, for a link or a control answering the pointer. */
  hover: DEEP_HARBOR.hover,
  /** §04's opaque tint, for a container that is Harbor-flavoured rather than Harbor-coloured. */
  tint: DEEP_HARBOR.soft,
  /** The same hue at the alpha a fill or a ring wants, where the solid colour would shout. */
  soft: alpha(DEEP_HARBOR.base, 0.16),
} as const;

/** §07's four, under the names this app already calls them. These answer "how is it doing", never
 *  "what kind of thing is this" — and §09 forbids spending any of them on decoration, because a
 *  colour used decoratively stops being readable as a state. */
export const STATUS = {
  ok: SEMANTIC.success,
  pending: SEMANTIC.warning,
  error: SEMANTIC.danger,
  /**
   * Caution — a setting that is legitimate and worth noticing. The permission shield's Fast mode
   * is the first and so far only one.
   *
   * A FOURTH STATUS COLOUR, ADDED RATHER THAN BORROWED, and the composer spec is explicit about
   * why: Fast must wear "a caution tone (NOT the amber used for in-flight — reuse the warning
   * token, keeping amber's single meaning intact)". There was no warning token to reuse. The two
   * candidates were both wrong in a way worth recording:
   *
   *   `pending` amber means IN-FLIGHT in this app, everywhere, and always moves (stream-pulse).
   *   A static amber chip in the composer would be the first amber in the product that does not
   *   mean "this is happening right now", and one exception is all it takes to stop the colour
   *   answering that question.
   *
   *   `error` red means SOMETHING WENT WRONG. Fast is a supported mode a user chose on purpose,
   *   and painting a valid setting as a failure teaches people to ignore red.
   *
   * Orange rather than a second yellow, because the whole point is being distinguishable from
   * amber at a glance in a row that may contain both. And it is never the ONLY signal: §10
   * requires a word or a mark beside it, which is why Fast also carries "⚠".
   *
   * AND IT IS §07's BLUE NOW, NOT AN ORANGE, which is the one place this file departs from the
   * paragraph above rather than merely re-valuing it. §07 supplies four semantics and this app has
   * five meanings; amber is the contested one, because §07 describes its amber as "credential
   * warnings, attention and caution" — this token's job — while §09 says the semantics "retain
   * functional meaning", and in this product amber has always meant IN FLIGHT. Forty-eight call
   * sites, a node glow and a stream pulse say so against this one's two.
   *
   * So `pending` keeps amber and this takes §07's `info`, which it fits better than the wording
   * suggests: "informational states and neutral system guidance" is exactly what a supported mode
   * somebody deliberately turned on is. Blue was free — the interaction accent is Deep Harbor, a
   * near-navy, and nothing else in the product claims a mid blue.
   */
  warn: SEMANTIC.info,
  /** Decided-but-not-notable: superseded, discarded, undone. Recedes rather than signals. */
  neutral: INK.muted,
} as const;

export type StatusName = keyof typeof STATUS;

/**
 * Trace step types. The fourth category set, and it belongs here for the same reason the other
 * three do: it says what *kind* of thing a step is, never how it went.
 *
 * Deliberately low-saturation. The timeline is a dense column of these and full-strength accents
 * would turn it into a rainbow (doc §4.2), so each pair is a pale fill with a legible text colour
 * rather than a bright one. They came out of lib/format.ts, where they were a pair of Tailwind
 * class names and therefore unreachable to anything that needs a value.
 *
 * BOTH HALVES OF EVERY PAIR INVERTED. The fills were four near-black tints (`#182130` and its
 * siblings) with a light text on top; on a light page a fill has to be a pale wash and the text has
 * to be the dark half. The hues are the same four, and the pairing rule is the same: the fill is
 * the hue at the edge of perceptible, the foreground is the hue at reading contrast.
 */
export const STEP_TYPE = {
  llm_call: { fg: "#2F5F92", bg: "#EDF2F8" },
  tool_call: { fg: "#2F7048", bg: "#EBF3EE" },
  state_update: { fg: "#8A6520", bg: "#F8F2E6" },
  router: { fg: "#6B4A8A", bg: "#F3EDF8" },
} as const;

/**
 * Surfaces, for the cases that need a value rather than a class (canvas, inline style).
 *
 * §01's ladder, under this app's names for its rungs. The order is what inverted: `bg` used to be
 * the darkest thing on screen and every step up was lighter; now `bg` is the page and every step
 * up is darker, because on a light ground that is the only direction depth can go.
 */
export const SURFACE = {
  /** The application canvas — §01's `bg-canvas`. */
  bg: CANVAS.canvas,
  /** Cards, panels and the sidebar's neighbours — §01's `bg-surface`. */
  panel: CANVAS.surface,
  /**
   * Popovers, dialogs and anything that floats free of the page — §01's `bg-elevated`, which is
   * pure white and the only pure white in the system.
   *
   * A RUNG THE DARK PALETTE DID NOT HAVE. Popovers used `panel`, one step up from the page, and on
   * near-black that was enough: a shadow plus a hairline said "above". On a light page a floating
   * surface one percent off the card behind it reads as the same surface, so §01 spends a whole
   * token on it and the elevation levels below pick it up.
   */
  elevated: CANVAS.elevated,
  /** Hover, and the fill under a selected row — §01's `bg-hover`. */
  active: CANVAS.hover,
  /** Card border — one step stronger than `hair`, so a container reads as raised without a
   *  visible box. Was hardcoded at BuildPane's composer card and the model popover. */
  edge: BORDER.default,
  /** Chrome: scrollbar thumbs, control dividers, a pressed control — §01's `bg-active`. */
  chrome: CANVAS.active,
  /**
   * The strongest neutral the app draws: a seam under the pointer, a scrollbar thumb being
   * dragged. One step above `edge`, and the end of the greyscale — anything further is ink.
   * It was a hex literal in App.tsx, the only resize-handle colour not in this file.
   *
   * It used to be the BRIGHTEST neutral, for the same reason and in the opposite direction.
   */
  grip: BORDER.strong,
  /** Hairline dividers and connector lines — §06s `border-subtle`, the quietest boundary. */
  hair: BORDER.subtle,
  /** The page the shell floats on — §01s `bg-subtle`, one step under the canvas. */
  void: CANVAS.subtle,
} as const;

/**
 * Segments of a share-of-total bar, in order.
 *
 * A NEUTRAL RAMP, AND ONE COPY OF IT. Two surfaces drew provider shares — the Activity hero's
 * spend strip and the Model mix card — and each had its own hardcoded palette handing Anthropic
 * `#c98a5e` and Groq `#c99a52`, both within a few degrees of `STATUS.pending`. So a workspace
 * using one model painted a full-width amber bar under the word SPEND, which reads as a warning
 * or as something in flight rather than as a proportion, on the one page built to be quiet.
 *
 * Share is categorical, not semantic: no segment means anything is wrong or anything is
 * happening. Five steps of neutral lightness keep adjacent segments apart inside one bar — which
 * is all a share chart needs — and none of them can be mistaken for a state. Every one of these
 * surfaces names its series in a row beneath the bar, which is what lets the bar be quiet.
 *
 * THE RAMP RUNS THE OTHER WAY NOW. It descended from a light grey into the page, because on
 * near-black the first segment had to be the brightest to be seen at all. Here it climbs from ink
 * towards the page: the largest share is the darkest step, and the tail fades towards the surface
 * it sits on. Struck from §05's own ink ladder rather than from a fresh set of greys, so a share
 * bar and the caption naming it are the same family of neutral.
 */
export const SHARE_RAMP = ["#62625F", "#7C7C78", "#90908C", "#A8A8A3", "#C1C1BB"] as const;

/** The order series are assigned ramp steps in, so two surfaces colour one provider alike. */
export const SHARE_ORDER = ["anthropic", "openai", "google", "together", "groq"] as const;

/**
 * §05's ink, under this app's names for it.
 *
 * `ink` is charcoal rather than pure black, the same way it was off-white rather than pure white
 * before — the reason is unchanged and only the direction of it moved. §08 gives the same value a
 * second name, `brand-strong`, "charcoal for primary high-contrast actions", which is why a filled
 * primary button is `bg-ink text-bg`: the app's one loud control is its ink turned inside out.
 */
export const TEXT = {
  ink: INK.primary,
  muted: INK.secondary,
  faint: INK.muted,
  /**
   * §05's fourth step, and it is a STATE rather than a fourth level of emphasis.
   *
   * New here. The dark palette had three inks and expressed "unavailable" as `opacity-40` on
   * whatever the control already was, which on a near-black page is indistinguishable from a
   * fourth grey. §05 names the colour, so a disabled control can say so in the palette's own terms
   * rather than by being faded — and a faded control inside a faded panel compounds, which is how
   * a disabled row ends up less legible than the empty space beside it.
   */
  disabled: INK.disabled,
} as const;

// ── Rhythm ──────────────────────────────────────────────────────────────────
// The 4px grid from doc §4.2, named by role instead of by number. Naming the *relationship*
// (within a group vs. between sections) is what keeps the rhythm consistent when it's applied
// across five components by hand.

export const SPACE = {
  /** Between rows that belong to the same group — tool to tool, note to note. */
  tight: 8,
  /** Between a section's header and its first row. */
  header: 10,
  /** Between two distinct sections. */
  section: 20,
  /** Between two distinct moments — the plan and the generation it produced. */
  block: 24,
} as const;

/** Tailwind class equivalents, for the common case where a class is what's wanted. */
export const SPACE_CLASS = {
  tight: "mt-2",
  header: "mt-2.5",
  section: "mt-5",
  block: "mt-6",
} as const;

// ── Icons ───────────────────────────────────────────────────────────────────
// One ladder, so no two icons in the panel are optically different weights. Lucide is drawn on a
// 24px grid at stroke 2; scaled down to 14px that reads heavy next to 12px text, hence 1.75.

export const ICON = {
  /**
   * Inside a chip or a badge. The one size below `xs`, and a real role rather than a rounding
   * error: a badge's glyph sits inside a box whose height is set by 10px caps text, so `xs` fills
   * it edge to edge and reads as an icon with a label stuck to it rather than as one mark.
   *
   * Named because it was already in use — a bare `size={10}` at a dozen call sites, StatusBadge's
   * included — and an unnamed size in use twelve times is a step of the ladder whether or not the
   * ladder admits it.
   */
  badge: 10,
  /**
   * Subordinate to a line of text — a note's lock, a disclosure chevron, a file's type, a stat's
   * glyph. These qualify what is beside them rather than anchoring it, and at `sm` they compete
   * with the thing they are qualifying. The number was being written out by hand at half a dozen
   * call sites before it was named.
   */
  xs: 12,
  /** Inline with body text — section headers, tool rows, stats. */
  sm: 14,
  /** Standalone controls. */
  md: 16,
  strokeWidth: 1.75,
} as const;

/**
 * The wordmark, which is the one glyph that is allowed off the icon ladder — it is a logo, not a
 * control, and it is drawn to be read at a size rather than to sit level with 12px text.
 *
 * Three steps because the mark appears in three registers and no more: beside the app's own name
 * in the chrome, as a screen's mark on sign-in and the onboarding composer, and as the first-run
 * hero. It was 18 / 26 / 26 / 30 / 40 across five files before it was named, and the 30 was a
 * fourth register nobody had decided on.
 */
export const BRAND = {
  /** In the title bar, beside the app name. */
  chrome: 18,
  /** A screen's own mark — sign-in, the onboarding composer, an agent's thumbnail. */
  screen: 26,
  /** The first-run hero, and only there. */
  hero: 40,
} as const;

// ── Type ────────────────────────────────────────────────────────────────────
// The roles, standing on typography.pdf's ladder. `typeScale.ts` holds the ladder itself — eight
// rungs, each with its size, weight and line height — and this is the layer above it: which rung a
// panel's name climbs, which one a row title does.
//
// It used to hold the sizes too, as three hand-written pixel counts. The reasoning then was that
// the client had 11, 12, 13, 15, 12.5, 11.5 and 10 — not a ladder but what happens when each
// component picks a size against whatever is next to it — and that at 11-13px weight separates a
// heading from its body better than size can. §02 supplies a real ladder for the first half of
// that and §03 agrees with the second: "most of the hierarchy should come from size, spacing,
// contrast and placement rather than repeatedly using 600/700".
//
// So the rungs carry their own weight now and these strings no longer name one. `text-tiny` IS
// 11px at 500; writing `font-medium` beside it would be a second opinion about a decision the
// ladder already made, and the two would drift the day the rung moved.
//
// These are class strings rather than values because every consumer is a `className` — the same
// reason SPACE_CLASS below is.

export const TYPE = {
  /**
   * A panel's own name: "Trace", "Step Details", "Runs", "Code". Uppercase and tracked, because
   * at this size that is what separates a label from a very short sentence. Was three different
   * trackings and two sizes across five panels.
   */
  panelLabel: "text-tiny uppercase tracking-wider text-faint",
  /** A block inside a panel: a plan section, a step's payload, a table's header row. */
  sectionLabel: "text-tiny uppercase tracking-wider text-muted",
  /** The name of the thing a card or row is about. §02's Label — "navigation, buttons, controls". */
  title: "text-label text-ink",
  /** Prose. The default, and the reason `font-sans` is on the body. */
  body: "text-caption text-ink",
  /** Subordinate prose — a caption, a hint, a reason. */
  meta: "text-tiny text-muted",
} as const;

// ── Radius ──────────────────────────────────────────────────────────────────
// Four steps, and the rule that picks between them is *size*, not component type: a corner
// radius reads as a proportion of the box it turns, so the same 10px looks tight on a modal and
// bulbous on a 20px pill. Naming the steps after the size of thing they belong to is what keeps
// two people making the same choice.
//
// Four because the app has four sizes of box and no more. Before this it had nine values —
// `rounded`, `-sm`, `-md`, `-lg`, `-xl`, `-2xl`, and three arbitrary pixel counts — spread across
// components that sit next to each other, which is how a composer card ended up 6px rounder than
// the popover that opens out of it.
//
// A pill is not on this scale. Something whose radius is half its height is a *shape*, not a
// corner treatment, and it stays `rounded-full` so it keeps working when the height changes.

export const RADIUS = {
  /** Chips, badges, pills-that-aren't-round, inline code. Under ~22px tall. */
  chip: 4,
  /** Buttons, inputs, tabs, rows, popover items. Roughly 24–36px tall. */
  control: 6,
  /** Cards, popovers, panels — anything that holds other things. */
  card: 10,
  /** Modals and the composer: the largest boxes, and the only ones that float free. */
  modal: 14,
} as const;

// ── Elevation ───────────────────────────────────────────────────────────────
// Depth, in four steps, so the eye can tell what is active from what is merely present.
//
// Each level is a hairline plus a shadow, never a shadow alone, and the reason has flipped without
// the rule changing. On a near-black background a soft shadow was nearly invisible and the 1px edge
// catching light at the top of the box did the separating. On `#F7F7F5` the shadow is the half that
// works and the hairline is the half that would otherwise read as a drawn rectangle. Either alone
// still reads as a mistake; it is simply the other one carrying the weight now.
//
// THE ALPHAS DROPPED BY ROUGHLY A FACTOR OF FIVE, which is the whole difference between a light
// system's depth and a dark one's. `rgba(0,0,0,0.4)` under a card is invisible on near-black and a
// bruise on off-white. And the shadow is struck from INK rather than from black: a neutral-warm
// page casts a neutral-warm shadow, and pure black under `#FBFBFA` goes grey-blue.
//
// The values are deliberately low-alpha and large-blur. §09's neutral-first restraint means depth
// should be something you notice only when it is missing: enough to say "this is on top", never
// enough to say "look at this shadow".
//
// Exported as ready-to-use CSS strings rather than as parts, because half of the consumers are
// React Flow nodes and popovers that need an inline style, and a token that only exists as a
// Tailwind class can't be handed to those.

export const ELEVATION = {
  /** In the page. A section boundary, not a raised object. */
  flat: "none",
  /** One step up: cards, rows that own their content. */
  raised: `0 1px 2px ${alpha(INK.primary, 0.06)}`,
  /** Off the page: popovers, the step-detail panel, the code overlay. */
  floating: `0 2px 6px ${alpha(INK.primary, 0.06)}, 0 12px 28px -8px ${alpha(INK.primary, 0.1)}`,
  /** Above everything: modals, and the app shell against the desktop. */
  overlay: `0 4px 12px ${alpha(INK.primary, 0.08)}, 0 28px 64px -16px ${alpha(INK.primary, 0.16)}`,
} as const;

export type ElevationName = keyof typeof ELEVATION;

/**
 * Depth's other axis: what is in front of what.
 *
 * ELEVATION says how far off the page a surface looks. This says which surface wins when two
 * overlap, and there was no scale for it at all — the client picked `z-10`, `z-20`, `z-30`,
 * `z-40` and `z-50` per component, by eye. Which is how an inbox row's overflow menu ended up at
 * `z-10`, BELOW the two panel layers it opens over, while an agent card's menu sat at `z-50`,
 * ABOVE the full-screen code drawer.
 *
 * Six steps, named for what lives at each. A number is chosen by asking what kind of thing this
 * is, never by asking what it needs to beat today.
 *
 * The values are Tailwind's own `z-*` steps, so a call site can write the class and stay on the
 * scale. This exists to be the place the question is answered, and to be quotable in a comment.
 */
export const LAYER = {
  /** In the flow. Everything, unless it is one of the five below. */
  content: 0,
  /** Pinned to an edge of its own scroller: a sticky section header, a column head. */
  sticky: 10,
  /** A pane sliding over its own column, or a notice strip layered above one. */
  panel: 20,
  /** A dropdown, a popover, a context menu — and the scrim that dismisses it. */
  menu: 30,
  /** A full-surface drawer over the shell, with the page dimmed behind it. */
  overlay: 40,
  /** A modal that must be answered. The top, and nothing shares it. */
  modal: 50,
} as const;

/** Border colours that pair with each elevation. `edge` is the default; `hair` recedes further. */
export const ELEVATION_BORDER = {
  flat: BORDER.subtle,
  raised: SURFACE.edge,
  floating: SURFACE.edge,
  overlay: SURFACE.edge,
} as const;

/**
 * The focus ring. One value, so a focused input and a focused button are the same idea.
 *
 * The accent, because a focus ring is one of the four things the accent is for. It was a neutral
 * grey once — #3a3a44 with a grey halo — which on a grey control on a near-black page was very
 * nearly nothing, and "where am I" is the one question a keyboard user asks constantly. The same
 * sentence is true here with the greys the other way up, which is why it stays the accent: Deep
 * Harbor against `#FBFBFA` is the strongest contrast the palette can make without using a status.
 */
export const FOCUS_RING = `0 0 0 1px ${INTERACTION.accent}, 0 0 0 4px ${INTERACTION.soft}`;

/**
 * Weight by shade. The other half of ELEVATION, and the half whose argument this palette reversed.
 *
 * ELEVATION answers "how far off the page is this", which is a question about the object. This
 * answers "is this the one I am on", which is a question about the pointer and the keyboard.
 *
 * IT USED TO BE CALLED LIFT BY LIGHT, and the reasoning was sound for the page it was written for:
 * on `#0d0d0f` a hovered card cannot get meaningfully darker, so it can only get brighter at its
 * edge — a border that brightens and a soft off-white bloom around it. On `#FBFBFA` that is exactly
 * backwards. There is no brighter; a card under the pointer has nowhere to go but down, so the
 * border deepens to §06's strongest and the bloom is ink at a low alpha. The name is the only thing
 * that had to change, and it changed because a token called GLOW that draws a shadow is a token
 * whose next reader will use it wrong.
 *
 * Both values are neutral, deliberately. §07 reserves hue for status and §09 reserves Deep Harbor
 * for interaction that MEANS something; "you are hovering this" is neither — it is the surface
 * acknowledging a pointer. Shade without hue is the only way to say it that does not spend a
 * colour.
 */
export const GLOW = {
  /** An interactive card under the pointer, or reached by Tab. Border deepens, edge settles. */
  hover: `0 0 0 1px ${BORDER.strong}, 0 0 32px -10px ${alpha(INK.primary, 0.12)}`,
  /** The one action a screen is asking for. Sits on the filled control, not around it. */
  cta: `0 0 0 4px ${alpha(INK.primary, 0.07)}`,
} as const;

// ── Motion ──────────────────────────────────────────────────────────────────
// Two durations and one easing, because a transition that communicates a state change has to be
// perceptible and then out of the way. Anything slower than `base` starts to feel like latency,
// which is the opposite of what a state change should say.

export const MOTION = {
  /** Hover, colour, opacity — things that must feel instant. */
  fast: 120,
  /** A state change with something to show: a check landing, a panel sliding. */
  base: 180,
  ease: "cubic-bezier(0.2, 0, 0, 1)",
} as const;
