// Design tokens — the single place the panel's visual language is decided.
//
// jarokudoc.md §4.2 already fixed the *surface* palette (near-black layers, off-white ink, three
// status colors) and tailwind.config.js carries it as utility classes. What was missing is the
// layer above that: what a colour *means* when it isn't a surface or a status. Reviewed-vs-bespoke
// is the distinction the plan gate is organised around, and until now it was carried by a green ✓
// against a faint + — a difference the eye reads as "one is done, one isn't" rather than "one is
// audited, one is about to be invented".
//
// So: three category accents, each owning one idea. They are exported as raw hex rather than
// Tailwind classes because several consumers need them as SVG stroke / inline style values, and a
// token that only exists as a class name can't be handed to a canvas or an icon.
//
// The trace panel and graph view are deliberately NOT migrated onto this yet — this file exists so
// they *can* be, in a later pass, without re-deciding any of it.

/** Category accents. Each answers "what kind of thing is this", never "how is it doing". */
export const ACCENT = {
  /** Reviewed connector tools — audited templates copied in verbatim, read-only.
   *  Cool teal reads as locked/verified. Already GraphView's KIND_ACCENT.tool, so the graph
   *  can adopt this without a colour change. */
  reviewed: "#5eead4",
  /** Bespoke tools — about to be written by a model, for this agent only.
   *  Violet, deliberately NOT amber: amber is spoken for (see STATUS.pending) and a tool category
   *  wearing the running colour would collide with the one meaning it already has. */
  bespoke: "#c084fc",
  /** State fields — the agent's shape rather than its capabilities.
   *  Periwinkle; already GraphView's KIND_ACCENT.action. */
  state: "#a5b4fc",
  /** MCP tools — discovered from a third-party server nobody here has reviewed.
   *
   *  Rose, chosen because it is unlike every other accent AND unlike every STATUS colour and
   *  every GraphView KIND_ACCENT. That distance is the point: this badge's whole job is to
   *  be unmistakable at a glance, and an accent a user could confuse with "reviewed" teal or
   *  "pending" amber would fail at exactly the moment it matters. It is deliberately not red
   *  either — MCP is not an error, and crying wolf on every external tool would teach people
   *  to stop looking. */
  mcp: "#f472b6",
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
 * Never decorative. Never a category. A blue badge on a non-interactive label is precisely what
 * makes an accent unusable for selection later, because the eye stops reading blue as "this one".
 *
 * The value is GraphView's existing `SEL`, so the canvas's selection colour and the app's are one
 * decision rather than two that happen to look alike.
 */
export const INTERACTION = {
  accent: "#6b8afd",
  /** The same hue at the alpha a fill or a ring wants, where the solid colour would shout. */
  soft: "rgba(107,138,253,0.16)",
} as const;

/** Status colours. Unchanged from doc §4.2 — restated here so a consumer needs one import,
 *  not two. These answer "how is it doing", never "what kind of thing is this". */
export const STATUS = {
  ok: "#22c55e",
  pending: "#f59e0b",
  error: "#ef4444",
  /** Decided-but-not-notable: superseded, discarded, undone. Recedes rather than signals. */
  neutral: "#52525b",
} as const;

export type StatusName = keyof typeof STATUS;

/**
 * Trace step types. The fourth category set, and it belongs here for the same reason the other
 * three do: it says what *kind* of thing a step is, never how it went.
 *
 * Deliberately low-saturation. The timeline is a dense column of these and full-strength accents
 * would turn it into a rainbow (doc §4.2), so each pair is a dim fill with a legible text colour
 * rather than a bright one. They came out of lib/format.ts, where they were a pair of Tailwind
 * class names and therefore unreachable to anything that needs a value.
 */
export const STEP_TYPE = {
  llm_call: { fg: "#7fa9db", bg: "#182130" },
  tool_call: { fg: "#79c48f", bg: "#16221a" },
  state_update: { fg: "#c99a52", bg: "#241f18" },
  router: { fg: "#a98cc4", bg: "#221826" },
} as const;

/** Surfaces, for the cases that need a value rather than a class (canvas, inline style). */
export const SURFACE = {
  bg: "#0d0d0f",
  panel: "#18181b",
  active: "#1e1e22",
  /** Card border — one step lighter than `hair`, so a container reads as raised without a
   *  visible box. Was hardcoded at BuildPane's composer card and the model popover. */
  edge: "#2a2a30",
  /** Chrome: scrollbar thumbs, control dividers. */
  chrome: "#26262b",
} as const;

export const TEXT = {
  ink: "#e4e4e7",
  muted: "#71717a",
  faint: "#52525b",
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
// Three sizes and three weights, and hierarchy comes from the WEIGHT.
//
// The client had 11, 12, 13, 15, 12.5, 11.5 and 10, which is not a ladder — it is what happens
// when each component picks a size against whatever was next to it. Worse, the differences were
// carrying the hierarchy: a heading was smaller and greyer than its own content, which is how a
// panel ends up with a title you have to hunt for. Weight can separate a heading from body text
// at the same size, and at 11-13px on a dark background it separates them better than size can.
//
// So: 11 / 12 / 13, and the jumps between them are deliberately small. 400 for body, 500 for
// anything that names something, 600 for the one wordmark. Two deliberate exceptions, both
// documented at their call site: a chip's 10px floor, and the composer's input, which is the
// thing you type into and is allowed to be the largest text in the app.
//
// These are class strings rather than values because every consumer is a `className` — the same
// reason SPACE_CLASS below is.

export const TYPE = {
  /**
   * A panel's own name: "Trace", "Step Details", "Runs", "Code". Uppercase and tracked, because
   * at this size that is what separates a label from a very short sentence. Was three different
   * trackings and two sizes across five panels.
   */
  panelLabel: "text-[11px] font-medium uppercase tracking-wider text-faint",
  /** A block inside a panel: a plan section, a step's payload, a table's header row. */
  sectionLabel: "text-[11px] font-medium uppercase tracking-wider text-muted",
  /** The name of the thing a card or row is about. */
  title: "text-[13px] font-medium text-ink",
  /** Prose. The default, and the reason `font-sans` is on the body. */
  body: "text-[12px] text-ink",
  /** Subordinate prose — a caption, a hint, a reason. */
  meta: "text-[11px] text-muted",
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
// Each level is a hairline plus a shadow, never a shadow alone. On a near-black background a
// soft shadow is nearly invisible — the thing that actually separates two dark surfaces is the
// 1px edge catching light at the top of the box — and a border alone reads as a drawn rectangle.
// The pair reads as depth; either half alone reads as a mistake.
//
// The values are deliberately low-alpha and large-blur. Doc §4.2's restraint means depth should
// be something you notice only when it is missing: enough to say "this is on top", never enough
// to say "look at this shadow".
//
// Exported as ready-to-use CSS strings rather than as parts, because half of the consumers are
// React Flow nodes and popovers that need an inline style, and a token that only exists as a
// Tailwind class can't be handed to those.

export const ELEVATION = {
  /** In the page. A section boundary, not a raised object. */
  flat: "none",
  /** One step up: cards, rows that own their content. */
  raised: "0 1px 2px rgba(0,0,0,0.4)",
  /** Off the page: popovers, the step-detail panel, the code overlay. */
  floating: "0 2px 6px rgba(0,0,0,0.35), 0 12px 28px -8px rgba(0,0,0,0.55)",
  /** Above everything: modals, and the app shell against the desktop. */
  overlay: "0 4px 12px rgba(0,0,0,0.4), 0 28px 64px -16px rgba(0,0,0,0.7)",
} as const;

export type ElevationName = keyof typeof ELEVATION;

/** Border colours that pair with each elevation. `edge` is the default; `hair` recedes further. */
export const ELEVATION_BORDER = {
  flat: "#1e1e22",
  raised: SURFACE.edge,
  floating: SURFACE.edge,
  overlay: SURFACE.edge,
} as const;

/** The focus ring. One value, so a focused input and a focused button are the same idea. */
export const FOCUS_RING = "0 0 0 1px #3a3a44, 0 0 0 4px rgba(58,58,68,0.28)";

/**
 * Lift by light. The other half of ELEVATION, and the half a near-black app actually needs.
 *
 * ELEVATION answers "how far off the page is this", which is a question about the object. GLOW
 * answers "is this the one I am on", which is a question about the pointer and the keyboard —
 * and a darker shadow is the wrong tool for it, because on #0d0d0f a hovered card cannot get
 * meaningfully darker. It can only get brighter at its edge.
 *
 * Both values are neutral, deliberately. §4.2 reserves hue for status, and "you are hovering
 * this" is not a status — it is the surface acknowledging a pointer. Light without hue is the
 * only way to say it that does not spend a colour.
 */
export const GLOW = {
  /** An interactive card under the pointer, or reached by Tab. Border brightens, edge blooms. */
  hover: "0 0 0 1px #34343c, 0 0 32px -10px rgba(228,228,231,0.16)",
  /** The one action a screen is asking for. Sits on the filled control, not around it. */
  cta: "0 0 0 4px rgba(228,228,231,0.07)",
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
