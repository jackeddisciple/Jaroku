// Status badge — one component for every "how is this doing" in the generation panel.
//
// Status was being carried by bare coloured text and typographic glyphs: a green "approved", a
// faint "superseded", a ✓ or a ● in a file list, a "!" before a warning. Three problems with that.
// The glyphs are font characters, so they sat on the text baseline at whatever size and weight the
// surrounding line happened to use and never optically matched each other. Low-opacity text reads
// as de-emphasised rather than as a state. And nothing tied them together, so the same idea looked
// different in the plan card than it did in the diff card two turns below.
//
// Four states, because four is what the panel actually has: something finished, something is
// waiting on a decision, something went wrong, and something is over but unremarkable
// (superseded, discarded, undone — real states that should recede, not signal).
//
// Two shapes, same vocabulary:
//   <StatusBadge>       filled pill with a label — for a status that names itself ("approved")
//   <StatusDot>         icon only — for a status in a list where the label is the row itself
//
// Colour comes from lib/tokens.ts STATUS, so this never disagrees with the rest of the app about
// what green means.

import { ICON, STATUS, type StatusName } from "../lib/tokens.ts";
import { AlertTriangleIcon, CheckIcon, ClockIcon, XIcon } from "./panelIcons.tsx";

export type BadgeState = StatusName;

const ICON_FOR: Record<BadgeState, (p: { size?: number }) => React.ReactElement> = {
  ok: CheckIcon,
  pending: ClockIcon,
  error: AlertTriangleIcon,
  neutral: XIcon,
};

/**
 * A filled pill: icon + label.
 *
 * Filled rather than tinted text because a state is a fact about the thing, not an emphasis level
 * — and at 10-11px, coloured text on a near-black background is the first thing to disappear.
 * The fill is the accent at low alpha with the accent as text, which keeps it legible without
 * becoming a bright block competing with the content it describes.
 */
export function StatusBadge({
  state,
  label,
  title,
  icon,
  variant = "fill",
  color: colorOverride,
}: {
  state: BadgeState;
  label: string;
  title?: string;
  /**
   * Override the state's default icon. "Waiting on you" and "needs attention before you can
   * proceed" are both amber — the same urgency, different asks — and a clock would misdescribe
   * the second. The colour still carries the state; the icon narrows what kind.
   */
  icon?: (p: { size?: number }) => React.ReactElement;
  /**
   * `fill` is a status: something happened to this thing. `outline` is a property: something is
   * true *of* it — a file being new is not an event in its life, it is what it is.
   *
   * They share every dimension except the fill, so the two read as the same family at the same
   * weight, and a property never shouts louder than the status beside it. The border is an inset
   * shadow rather than a real border so both variants occupy exactly the same box.
   */
  variant?: "fill" | "outline";
  /** For a badge whose colour is not one of the four statuses. Used sparingly. */
  color?: string;
}) {
  const color = colorOverride ?? STATUS[state];
  const Icon = icon ?? ICON_FOR[state];
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded px-1.5 py-[2px] text-[10px] font-medium uppercase tracking-wider align-middle"
      style={
        variant === "fill"
          ? { color, backgroundColor: `${color}1f` }
          : { color, boxShadow: `inset 0 0 0 1px ${color}59` }
      }
    >
      <Icon size={10} />
      {label}
    </span>
  );
}

/**
 * Icon only, for rows whose label is the row itself — a file that finished writing, a tool that
 * was audited. `pulse` is for work still in flight, replacing the ● that used to animate.
 */
export function StatusDot({
  state,
  size = ICON.sm - 2,
  pulse = false,
  title,
  color,
}: {
  state: BadgeState;
  size?: number;
  pulse?: boolean;
  title?: string;
  /** Override for a category accent — an audited tool is teal, not green. */
  color?: string;
}) {
  const Icon = ICON_FOR[state];
  return (
    <span
      title={title}
      className={`inline-flex items-center ${pulse ? "animate-pulse" : ""}`}
      style={{ color: color ?? STATUS[state] }}
    >
      <Icon size={size} />
    </span>
  );
}
