// The chip. One component for every tag-like piece of information in the client.
//
// A chip is a short label *about* something: a file reference, a model id, a tool name, a
// connector, a status word, a count. The client had eleven versions of it. `px-1.5 py-[2px]`
// in StatusBadge, `px-1.5 py-0.5` in McpBadge, `px-2 py-0.5` in the composer's context label,
// `px-2 py-1` in the eval targets, `px-2.5 py-1` in the connectors and the dataset strip, and
// `px-1 py-px` on the "this step" tag — all rendering the same idea at six different heights,
// often within one screen of each other. Nobody can name the difference and everybody sees it.
//
// So: one geometry, three sizes, and the variation that is actually meaningful expressed as
// props rather than as a fresh class string per call site.
//
// What a chip is NOT: a button that happens to be small. A chip can be clickable — the dataset
// strip, the MCP server strip and the connector picker are all rows of selectable chips, and
// the panels that own them already call them chip strips — but a control that performs an
// action rather than selecting a thing belongs in buttons.ts, at a control's geometry.

import { ICON, RADIUS, SURFACE } from "../lib/tokens.ts";
import { absTime, relTime } from "../lib/format.ts";
import { Icon } from "../lib/icons/registry.ts";
import { Truncate } from "./Truncate.tsx";

export type ChipSize = "sm" | "md" | "lg";
export type ChipTone = "ink" | "muted" | "faint";
export type ChipVariant = "fill" | "outline" | "bare";

/**
 * Size is chosen by what the chip sits next to, not by what it contains.
 *
 * `sm` is a badge riding on a line of text and must not outweigh it. `md` is the default — a
 * chip in a row of its own. `lg` is for a chip that is also a hit target, where anything
 * smaller is a chip you miss.
 */
const SIZE: Record<ChipSize, string> = {
  sm: "gap-1 px-1.5 text-tiny",
  md: "gap-1.5 px-2 text-tiny",
  lg: "gap-1.5 px-2.5 text-caption",
};

// ON THE GRID. `py-[3px]` was an arbitrary pixel between two grid steps, and 2/3/4 across three
// sizes is a difference nobody can see and every chip in the app inherits. Two steps: a badge
// riding on a line of text, and a chip that owns its row. The font size carries the rest.
const PAD_Y: Record<ChipSize, string> = {
  sm: "py-0.5",
  md: "py-1",
  lg: "py-1",
};

/**
 * Vertical padding on an *inline* chip is not the same decision. Padding on an inline box does
 * not grow its line, so a chip sized for a row of its own paints past the lines above and below
 * it when it lands mid-sentence. An inline chip gets just enough to read as a surface.
 */
const PAD_Y_INLINE: Record<ChipSize, string> = {
  sm: "py-0",
  md: "py-[1px]",
  lg: "py-[1px]",
};

const TONE: Record<ChipTone, string> = {
  ink: "text-ink",
  muted: "text-muted",
  faint: "text-faint",
};

export type ChipProps = {
  children?: React.ReactNode;
  /**
   * A mark before the label — an icon, a brand dot, a status dot. Rendered in a slot that keeps
   * its width whether or not the mark is there, so a chip never resizes because its state
   * changed. A control that grows when you click it is a control you mis-click.
   */
  icon?: React.ReactNode;
  /** Reserve the icon slot even with no icon. For a strip where only some chips are marked. */
  reserveIcon?: boolean;
  /** A trailing figure — a count, a score. Always tabular, so a strip of them lines up. */
  figure?: React.ReactNode;
  size?: ChipSize;
  tone?: ChipTone;
  /**
   * Left undefined on purpose. A chip in a strip usually wants bare-when-unselected, which is
   * what `selected` gives it — but a picker whose off state has to look clickable needs to say
   * so, and an explicit variant has to win over the default that `selected` implies.
   */
  variant?: ChipVariant;
  /**
   * A category accent or a status colour, for a chip whose meaning is carried by colour: the
   * MCP rose, the reviewed teal, a step type. Overrides `tone`, and tints the surface with the
   * same colour at low alpha so the fill can never disagree with the text.
   */
  color?: string;
  /** An explicit surface, for the few chips whose fill is not derived from `color`. */
  background?: string;
  /** The label is an identifier — a tool name, a file path, a model id — not prose. */
  mono?: boolean;
  /**
   * A status word rather than a name: uppercase, tracked out, one weight up. Status labels are
   * read as a glance rather than as text, and lowercase at 10px reads as a truncated sentence.
   */
  caps?: boolean;
  /**
   * Inline rather than inline-flex, for a chip inside a sentence. An inline-flex box cannot
   * break across a line, so an identifier in a wrapping paragraph has to stay inline.
   */
  inline?: boolean;
  /** Selected, for a chip in a strip. Promotes a bare chip to a filled, ink one. */
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
};

/**
 * The class string, for the handful of callers that need one rather than an element — `<Prose>`
 * marks identifiers with a real `<code>` tag, and the tokenizer that feeds it emits strings.
 * Everything about the geometry is decided here so those callers cannot drift from the rest.
 */
export function chipClass({
  size = "md",
  tone = "muted",
  mono = false,
  caps = false,
  inline = false,
  interactive = false,
}: {
  size?: ChipSize;
  tone?: ChipTone;
  mono?: boolean;
  inline?: boolean;
  caps?: boolean;
  interactive?: boolean;
} = {}): string {
  return [
    inline ? "inline" : "inline-flex items-center",
    "align-middle rounded-xs",
    SIZE[size],
    inline ? PAD_Y_INLINE[size] : PAD_Y[size],
    TONE[tone],
    mono ? "font-mono" : "",
    // A CAPS CHIP NEVER BREAKS. It is a status word read at a glance — three to twelve characters,
    // uppercase, tracked out — and the rule below is written for long unbreakable identifiers,
    // which is the opposite kind of content. Left to that rule, the sidebar's plan badge rendered
    // `FREE` as `FR` over `EE` in the account row on the default screen.
    caps ? "font-medium uppercase tracking-wider whitespace-nowrap" : "",
    // Chips hold names that can be long and unbreakable — a tool id, a file path, an endpoint.
    // Breaking inside one beats overflowing the row it sits in.
    "[overflow-wrap:anywhere]",
    interactive ? "transition-colors duration-fast" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function Chip({
  children,
  icon,
  reserveIcon = false,
  figure,
  size = "md",
  tone = "muted",
  variant,
  color,
  background,
  mono = false,
  caps = false,
  inline = false,
  selected,
  onClick,
  disabled,
  title,
  className = "",
}: ChipProps) {
  const interactive = Boolean(onClick);
  // A selected chip in a strip is a filled, ink chip — that is what selection means everywhere
  // else in the app, and a strip that invented its own selected look would be a third language.
  // An explicit `variant` still wins, for a picker whose OFF state has to look clickable.
  const effectiveVariant: ChipVariant =
    selected === true ? "fill" : (variant ?? (selected === false ? "bare" : "fill"));
  const effectiveTone = selected === true ? "ink" : tone;

  const surface: React.CSSProperties = {};
  if (color) {
    surface.color = color;
    if (effectiveVariant === "fill") surface.backgroundColor = `${color}1f`;
    // An inset shadow rather than a border, so an outlined chip occupies exactly the same box
    // as a filled one and the two sit level in a row.
    if (effectiveVariant === "outline") surface.boxShadow = `inset 0 0 0 1px ${color}59`;
  } else if (effectiveVariant === "outline") {
    surface.boxShadow = `inset 0 0 0 1px ${SURFACE.edge}`;
  }
  if (background) surface.backgroundColor = background;

  const cls = [
    chipClass({ size, tone: color ? tone : effectiveTone, mono, caps, inline, interactive }),
    !color && !background && effectiveVariant === "fill" ? "bg-active" : "",
    // A SELECTED CHIP STILL ANSWERS THE POINTER. It only got a hover response while unselected,
    // so the connector chips and the Chat/Test segments went dead the moment they were chosen —
    // and those are exactly the chips somebody clicks twice.
    interactive && !selected ? "hover:text-ink" : "",
    interactive && selected ? "hover:brightness-125" : "",
    interactive ? "active:brightness-110" : "",
    disabled ? "opacity-50 cursor-not-allowed" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      {(icon || reserveIcon) && (
        <span className="inline-flex shrink-0 items-center justify-center" aria-hidden>
          {icon}
        </span>
      )}
      {children}
      {figure !== undefined && figure !== null && (
        <span className="shrink-0 tabular-nums opacity-70">{figure}</span>
      )}
    </>
  );

  if (interactive) {
    return (
      <button type="button" onClick={onClick} disabled={disabled} aria-disabled={disabled} title={title} className={cls} style={surface}>
        {body}
      </button>
    );
  }
  return (
    <span title={title} className={cls} style={surface}>
      {body}
    </span>
  );
}

/** The chip radius, for the rare consumer that needs the number (a canvas, an inline style). */
export const CHIP_RADIUS = RADIUS.xs;

// ── The date variant ────────────────────────────────────────────────────────
//
// A TIMESTAMP, AS A CHIP. Calendar mark, then the formatted date, in one hairline pill at the
// chip's existing height. It is a VARIANT rather than a second component in the strict sense that
// matters: no second geometry, no second radius, no second file — it is `Chip` with its icon slot
// filled and its content formatted, and every size, padding and tone decision above still owns it.
// A `DateChip.tsx` would be the twelfth chip this codebase had to reconcile.
//
// THERE IS NO OVERDUE STATE, AND THERE IS NOT GOING TO BE ONE. Jaroku has no due dates — every one
// of the twelve sites this renders at is a TIMESTAMP: last activity, published, deployed at, run
// finished, first seen, last rotated, dispatched at. A red date chip would be a deadline this
// product does not have, and an amber one would be worse, because amber means a run is in flight
// right now and a date is by definition a thing that already happened. If `work_items` ever grows a
// deadline column, that is a conversation, not a colour.
//
// ONE FORMATTER, WHICH IS `lib/format.ts`'s. `relTime` on the face and `absTime` in the tooltip —
// the same pair every timestamp in this product already uses, so a date in a chip and the same date
// in a row read identically. A second date formatter would be a second answer to "how long ago",
// and the two would disagree at exactly the boundaries people notice.
//
// LONG VALUES FADE THROUGH `Truncate`, never a hard cut — the chip has a max width at several of
// its sites and an absolute date in a narrow column is the case that overflows.
//
//   npm run test:date-chip

export function DateChip({
  at,
  size = "sm",
  className = "",
  title,
}: {
  /** An ISO timestamp. `null` renders nothing at all — see below. */
  at: string | null | undefined;
  size?: ChipSize;
  className?: string;
  /** A better sentence than the absolute date — "Last synced 4 March, 09:12". */
  title?: string;
}) {
  // NOTHING RATHER THAN A DASH. A missing count is a section that exists and has an unknown size,
  // which is worth saying; a missing timestamp is an event that has not happened, and a calendar
  // pill containing an em dash claims there is a date to know.
  if (!at) return null;
  return (
    <Chip
      size={size}
      variant="outline"
      tone="faint"
      className={`max-w-[180px] ${className}`}
      title={title ?? absTime(at)}
      icon={<Icon.activity.dateRange size={ICON.badge} />}
    >
      <Truncate title={title ?? absTime(at)}>{relTime(at)}</Truncate>
    </Chip>
  );
}
