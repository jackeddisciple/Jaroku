// The connector picker at the right end of the tray behind the composer.
//
// The product owner's design, 2026-09-10, and it replaces the row of connector chips that sat above
// the composer. Connectors here are the audited templates a NEW agent is generated with — the same
// selection the chips held, and only offered while describing one.
//
// NOTHING CHOSEN: a cable mark. Clicking it opens a horizontal row of logos, each on a round blob
// a step darker than the tray, and nothing else — no names, which the tooltips and the accessible
// names carry. Clicking a logo toggles it and closes the row — the product owner's call on
// 2026-09-11 — so each pick lands on the tray at once; picking another is opening it again.
//
// SOMETHING CHOSEN: the logos take the cable's place on the tray, in the order they were picked,
// overlapping like a hand of cards. Past three the rest become "+N" in the same footprint — the
// composer deck's own rule (`deckLayout`), so the two decks in this composer count the same way.
//
// ON THE TRAY THEY ARE BARE LOGOS, with no blob behind them — the product owner's call on 2026-09-11
// (the blobs belong to the row). Each sits on a backing in the tray's own colour, which is invisible
// except where it tucks over the logo before it: without it two overlapping logos print through each
// other's gaps and read as one smudge; with it the overlap reads as cards. It is also why the deck
// lifts rather than fills when hovered — a fill would show every backing as a pale disc.
//
// TWO MOTIONS, AND THEY ARE DIFFERENT ON PURPOSE — the product owner's call on 2026-09-11. The row
// OPENS smoothly: its blobs rise out of the tray one after another, nearest the trigger first, on
// the app's `smooth` curve (`pop-smooth`). A pick LANDS with a bounce: the logo springs onto the
// tray (`pop`), and so does a new "+N". Both only on arrival — a logo already on the tray keeps its
// key and never replays — and neither under reduced motion, where things simply appear.
//
// THE LOGOS ARE THE PRODUCT OWNER'S FILES, from assets/connectors, prepared into
// client/public/connectors/<id>.png: each on a transparent background (Postgres's white knocked out),
// and Stripe's wordmark cropped to its "s", which is the only part readable at this size.

import { useRef, useState } from "react";
import { Icon } from "../../lib/icons/registry.ts";
import { ICON } from "../../lib/tokens.ts";
import { MAX_TILES, deckLayout } from "../../lib/connectorDeck.ts";
import { Popover } from "./Popover.tsx";

export interface TrayConnector {
  id: string;
  label: string;
  /** What ticking it hands the agent — the tooltip, since the row itself shows only logos. */
  hint: string;
}

/** Where a connector's logo lives. See the header. */
export const connectorLogo = (id: string): string => `/connectors/${id}.png`;

/** A logo on the tray, and the invisible backing it sits on — 2px of tray colour all round. */
const TRAY_LOGO = 18;
const TRAY_BACK = 22;
/** How far each logo on the tray tucks under the one before it. */
const TUCK = -8;
/** The blobs in the row. */
const ROW_BLOB = 30;
/** How far apart the row's blobs start rising, so the row arrives as a ripple rather than a block. */
const STAGGER_MS = 25;

export function TrayConnectors({
  options,
  selected,
  onToggle,
  disabled = false,
}: {
  options: readonly TrayConnector[];
  /** Ids, in the order they were picked. */
  selected: readonly string[];
  onToggle: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  const chosen = selected.flatMap((id) => options.filter((o) => o.id === id));
  const deck = deckLayout(chosen.map((c) => ({ id: c.id, label: c.label, logoUrl: connectorLogo(c.id), enabled: true })));
  const names = chosen.map((c) => c.label).join(", ");

  // ← and → walk the row, which is how a horizontal row is walked; the popover's own ↑ ↓ still work.
  const onRowKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const items = Array.from(rowRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const next = e.key === "ArrowRight" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={deck.present ? `Connectors: ${names}` : "Add connectors"}
        title={deck.present ? names : "Add connectors to the agent you describe"}
        // `-mr-1.5`: at the tray's right end, the mark lines up with the tray's own padding rather
        // than with the edge of its hover fill. The cable darkens when hovered like the tray's other
        // controls; the deck lifts instead — see the header.
        className={`group/deck -mr-1.5 inline-flex h-6 items-center rounded-control px-1.5 text-muted transition-colors
          duration-fast hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring
          disabled:cursor-not-allowed disabled:opacity-40 ${deck.present ? "" : "hover:bg-grip/60"}`}
      >
        {deck.present ? (
          <span
            className="inline-flex items-center transition-transform duration-fast group-hover/deck:-translate-y-px
              motion-reduce:transition-none"
            aria-hidden
          >
            {deck.tiles.map((c, i) => (
              <span
                key={c.id}
                // The invisible backing — see the header — and it lands with the bounce.
                className="inline-flex shrink-0 animate-pop items-center justify-center rounded-full bg-chrome
                  motion-reduce:animate-none"
                // The first sits on top, as a hand of cards is held; each after it tucks under.
                style={{ width: TRAY_BACK, height: TRAY_BACK, marginLeft: i === 0 ? 0 : TUCK, zIndex: MAX_TILES - i, position: "relative" }}
              >
                <img src={c.logoUrl ?? ""} alt="" width={TRAY_LOGO} height={TRAY_LOGO} className="block" draggable={false} />
              </span>
            ))}
            {deck.overflow > 0 && (
              // The count, on the same invisible backing and tucked the same way, padded by the tuck
              // so it is centred in the part that shows. Keyed by the count, so a new count bounces.
              <span
                key={deck.overflow}
                className="inline-flex shrink-0 animate-pop items-center justify-center rounded-full bg-chrome text-tiny
                  text-muted motion-reduce:animate-none"
                style={{ height: TRAY_BACK, minWidth: TRAY_BACK - TUCK, paddingLeft: -TUCK, paddingRight: 2, marginLeft: TUCK, position: "relative" }}
              >
                +{deck.overflow}
              </span>
            )}
          </span>
        ) : (
          <Icon.composer.trayConnectors size={ICON.sm} />
        )}
      </button>
      {/* Right-aligned to the trigger, which sits at the tray's right end: a row opening leftwards
          stays over the composer instead of running off past it. And BARE — no panel behind the
          row, just the logos on their blobs, the product owner's call on 2026-09-11. */}
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={triggerRef} label="Connectors" align="right" width={0} bare>
        <div ref={rowRef} onKeyDown={onRowKey} className="flex items-center gap-1.5">
          {options.map((o, i) => {
            const on = selected.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                // Each pick closes the row, so it lands on the tray at once; see the header.
                onClick={() => {
                  onToggle(o.id);
                  setOpen(false);
                }}
                aria-pressed={on}
                aria-label={o.label}
                title={`${o.label} — ${o.hint}`}
                // A chosen logo wears the ink ring, and the tray behind shows it too; the ring is the
                // row's only way of saying so, which is why it is the strongest edge the palette has.
                // Rises in smoothly — see the header.
                className={`flex shrink-0 animate-pop-smooth items-center justify-center rounded-full bg-edge transition-colors
                  duration-fast hover:bg-grip/60 focus-visible:outline-none focus-visible:shadow-focusring
                  motion-reduce:animate-none ${on ? "ring-2 ring-ink" : ""}`}
                // The rightmost — nearest the trigger — rises first, and the ripple runs leftwards.
                style={{ width: ROW_BLOB, height: ROW_BLOB, animationDelay: `${(options.length - 1 - i) * STAGGER_MS}ms` }}
              >
                <img src={connectorLogo(o.id)} alt="" width={16} height={16} className="block" draggable={false} />
              </button>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}
