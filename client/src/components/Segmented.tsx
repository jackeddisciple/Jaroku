// A group of mutually exclusive options. Exactly one is chosen, always, and it is visibly held down.
//
// THE OTHER KIND OF TOOLBAR GROUP, and the difference is not decoration. `ToolbarCluster` holds
// actions that spring back; this holds a MODE. §5.1: they must not look identical, because a
// grid/table toggle that looks like a refresh button teaches people that pressing refresh will
// change a mode. So a chosen segment sits on a filled surface — the same `bg-active` every other
// selected thing in this app sits on — and nothing in a cluster ever does.
//
// `role="radiogroup"` WITH `aria-checked` ON MEMBERS, which is the half of the difference a screen
// reader can hear. `aria-pressed` announces three independent toggles somebody has to try one at a
// time; a radio group announces "2 of 3, selected", which is the whole state in one phrase.
//
// TEXT OR A MARK, because §5.3 has both: the Agents density toggle is two glyphs and the Activity
// range is `24h · 7d · 30d`, which the icon specification is explicit should stay text — three
// durations have no marks that would not have to be learned.
//
// ONE HAIRLINE BETWEEN NEIGHBOURS AND THE RADIUS ON THE OUTER CORNERS, exactly as the cluster does
// it and for the same reasons, which is why both files say so rather than one importing the other's
// class string: they are two components because they are two things, and the day one of them needs a
// different construction is the day a shared string would be the reason it does not get one.
//
//   npm run test:toolbar-cluster

import { ICON } from "../lib/tokens.ts";
import type { IconComponent } from "../lib/icons/registry.ts";
import { IconButton } from "./IconButton.tsx";
import { HIT_TARGET } from "./icons.ts";

export interface SegmentOption<T extends string> {
  value: T;
  /** The accessible name AND the tooltip. For a text segment it is also what is drawn. */
  label: string;
  /** Drawn instead of the label. Omit for a text-only group. */
  icon?: IconComponent;
  /** What is drawn for a text segment, when the accessible name is longer than the word. */
  text?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = ICON.sm,
  className = "",
}: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** What the group as a whole is choosing between — "Grid density", "Date range". */
  ariaLabel: string;
  size?: number;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`inline-flex items-center divide-x divide-edge overflow-hidden rounded-control border border-edge ${className}`}
    >
      {options.map((o) =>
        o.icon ? (
          <IconButton
            key={o.value}
            icon={o.icon}
            label={o.label}
            checked={o.value === value}
            onClick={() => onChange(o.value)}
            size={size}
            className="rounded-none"
          />
        ) : (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            aria-label={o.label}
            title={o.label}
            onClick={() => onChange(o.value)}
            // THE SAME 32px FLOOR AS A MARK'S. A text segment is still a hit target, and three
            // durations set in `text-tiny` would otherwise be a 16px-tall row of things to miss.
            style={{ minHeight: HIT_TARGET }}
            className={`px-2.5 text-tiny tabular-nums transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
              o.value === value ? "bg-active text-ink" : "text-faint hover:bg-active hover:text-ink"
            }`}
          >
            {o.text ?? o.label}
          </button>
        ),
      )}
    </div>
  );
}
