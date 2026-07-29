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

export const RADIUS = {
  /** Badges and chips. */
  chip: 4,
  /** Cards. */
  card: 10,
} as const;
