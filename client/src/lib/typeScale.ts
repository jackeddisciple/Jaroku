// The type system, as data — typography.pdf, and the one place its eight steps are written down.
//
// The specification is LOCKED and it decides two things: which families the product speaks in, and
// the ladder every piece of text stands on. Both were previously spread across three files that
// agreed by coincidence — `tailwind.config.js` held the families, `tokens.ts` held five class
// strings it called a scale, and the other eight hundred call sites wrote a pixel count by hand.
// That is not a scale; it is what happens when each component picks a size against whatever was
// beside it, which is how the client ended up rendering 9, 10, 11, 12, 13, 15, 18, 19, 32 and 34.
//
// So the ladder lives here as VALUES, and the Tailwind config below it is generated from the same
// table rather than transcribed from the same PDF. A copy of a spec guarantees nothing about
// agreeing with it; `typeScale.test.ts` is what makes the agreement a claim rather than a hope.
//
// WHY VALUES AND NOT CLASS STRINGS. `tokens.ts` exports `TYPE` as `className` fragments because
// every consumer of those is a `className`. These are not: the config needs numbers, the suite
// needs to compare against the specification's own table, and React Flow's nodes need a family
// string it can hand to an inline style. A token that only exists as a class name cannot be
// handed to a canvas.

/** One rung. Size and line height in px, weight as a CSS numeric — the specification's own units. */
export type TypeStep = {
  readonly size: number;
  readonly weight: number;
  readonly lineHeight: number;
  /** What §02's table says the step is for. Quoted, so the suite can hold the code to the PDF. */
  readonly use: string;
};

/**
 * §02's table, in its own order — largest to smallest.
 *
 * `section` and `title` are deliberately identical in every number. The specification lists them
 * as two rows because they are two JOBS: a section is the name of a region ("BLOCKING",
 * "ATTENTION"), a title is the name of a thing inside one (an agent, an item). Collapsing them to
 * one token would save a line here and cost the distinction at every call site, and the two drift
 * apart the first time a section needs tracking a title does not.
 */
export const TYPE_SCALE = {
  display: { size: 32, weight: 600, lineHeight: 40, use: "Rare major headings / hero moments" },
  page: { size: 24, weight: 600, lineHeight: 30, use: "AGENTS, INBOX, major surfaces" },
  section: { size: 16, weight: 600, lineHeight: 22, use: "BLOCKING, ATTENTION, sections" },
  title: { size: 16, weight: 600, lineHeight: 22, use: "Agent names, prominent item titles" },
  body: { size: 14, weight: 400, lineHeight: 20, use: "Descriptions and normal content" },
  label: { size: 13, weight: 500, lineHeight: 18, use: "Navigation, buttons, controls" },
  caption: { size: 12, weight: 400, lineHeight: 16, use: "IDs, timestamps, metadata" },
  tiny: { size: 11, weight: 500, lineHeight: 14, use: "Very small status / secondary details" },
} as const satisfies Record<string, TypeStep>;

export type TypeStepName = keyof typeof TYPE_SCALE;

/**
 * The reading default: `body`.
 *
 * The base was 12px, chosen at the time because a census found that is what the app actually
 * rendered — 432 elements at 11px and 171 at 12 against 36 at 13, so a 13px base described almost
 * nothing on screen. That reasoning was right about the method and is now answered by the ladder
 * itself: every one of those call sites carries an explicit rung as of this pass, so the base no
 * longer competes with them. What it sets is the size of text nobody sized, and §02 names exactly
 * one step for that — Body, "descriptions and normal content".
 */
export const BASE_STEP: TypeStepName = "body";

/**
 * §03's weight rules, named. Hierarchy is supposed to come from size, spacing, contrast and
 * placement — the specification says so in as many words — so this exists to be quoted at a
 * review rather than to be spread over call sites.
 *
 * `bold` is on the ladder and deliberately unused by every step above. §03 calls 700 "rare;
 * reserved for strong emphasis, not normal headings", and a weight that no rung claims is the
 * only way to keep that true: a heading reaching for 700 has to do it by hand, in a diff.
 */
export const WEIGHT = {
  /** Default reading weight. */
  regular: 400,
  /** Controls, labels and subtle emphasis. */
  medium: 500,
  /** Headings, agent names and important UI. */
  semibold: 600,
  /** Rare. Strong emphasis, never a normal heading. */
  bold: 700,
} as const;

/** The three weights actually shipped as font files. 700 is on the ladder and off the bundle. */
export const LOADED_WEIGHTS = [WEIGHT.regular, WEIGHT.medium, WEIGHT.semibold] as const;

// ── Families ────────────────────────────────────────────────────────────────
// §01. Two families and no third. Geist Sans is the product's voice; Geist Mono is code's voice.
//
// The third family is worth a paragraph because it was here and is gone. A display serif carried
// the pre-session headings — first-run, sign-in, account onboarding — on the argument that those
// screens are a PAGE rather than an instrument and deserve a voice the status bar does not speak
// in. §01 answers that directly: "Geist Sans is the primary typeface across the product", and §05
// makes the rule a principle rather than a preference. So the serif is out, its headings stand on
// `display`, and the bundle carries one fewer family.

/** Geist Sans, with the fallback §01 names. Everything users read and interact with. */
export const SANS_STACK = [
  "Geist Sans",
  "system-ui",
  "-apple-system",
  "Segoe UI",
  "sans-serif",
] as const;

/** Geist Mono. Actual code, terminal output, logs, stack traces, diffs — and nothing else. */
export const MONO_STACK = [
  "Geist Mono",
  "ui-monospace",
  "SFMono-Regular",
  "Menlo",
  "monospace",
] as const;

/** Ready for an inline `style` or a third-party control that cannot be reached by a class. */
export const SANS_FAMILY = SANS_STACK.join(", ");
export const MONO_FAMILY = MONO_STACK.join(", ");

/**
 * §04, as a rule something can check.
 *
 * The list is here rather than in a comment because §05 is the part people get wrong: "do not
 * switch fonts merely because a string looks technical". A slug, a version, a timestamp and a
 * model name all LOOK like code and none of them is — they are metadata, they sit in sentences and
 * in rows beside prose, and setting them in Mono is what made two thirds of this client's text
 * monospaced. The test for Mono is not "does this look technical" but "would fixed-width columns
 * materially help somebody parse it".
 */
export const MONO_IS_FOR = [
  "source code and code snippets",
  "terminal and shell output",
  "logs and stack traces",
  "diffs and their hunk headers",
  "file paths, where a column of them aligns",
  "line numbers beside code",
] as const;

/** The other half of §04, and the half that changed: every one of these is Sans now. */
export const SANS_IS_FOR = [
  "navigation and page titles",
  "agent names, IDs and slugs",
  "versions",
  "timestamps and durations",
  "buttons and controls",
  "descriptions and prose",
  "provider and model labels",
  "status labels",
  "settings",
  "figures, counts and costs",
] as const;

/**
 * Tailwind's `fontSize` shape, generated from the table rather than written twice.
 *
 * Each rung carries its line height AND its weight, which is what makes the ladder self-enforcing:
 * `text-title` is a whole decision, not a font-size that still needs a weight class beside it to
 * mean anything. A call site that genuinely wants a different weight still overrides it, in a diff
 * somebody reads.
 */
export const tailwindFontSize = (): Record<string, [string, { lineHeight: string; fontWeight: string }]> =>
  Object.fromEntries(
    Object.entries(TYPE_SCALE).map(([name, step]) => [
      name,
      [`${step.size}px`, { lineHeight: `${step.lineHeight}px`, fontWeight: String(step.weight) }],
    ]),
  );
