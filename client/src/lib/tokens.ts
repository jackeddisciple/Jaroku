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
