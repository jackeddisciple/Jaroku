// ◉◉◉ The connector deck — control 5 in the bar, §3.2.
//
// WHAT THE TOGGLE ACTUALLY DOES, because this is the control most likely to be mistaken for a
// display filter: it scopes which connectors' tools are offered to the model FOR THIS CONVERSATION
// ONLY. It does not disconnect anything at workspace level, and the dropdown says so in as many
// words — §3.2 requires that sentence. It is a real capability: "it's how a user stops an agent
// from reaching for Slack while debugging a Postgres path."
//
// A DISABLED CONNECTOR STAYS IN THE DECK, GRAYSCALE AT 60%. The spec gives the reason in seven
// words — "its absence would be more confusing than its dimming" — and the layout rules that
// enforce it live in lib/connectorDeck.ts with their own suite, because a deck that quietly shrank
// would look correct on any workspace with three connectors.
//
// THE FAN-OUT IS PURELY AFFECTIVE AND IS SKIPPED UNDER `prefers-reduced-motion` (§3.2, §10). It
// carries no information the static deck does not.
//
// AND THE HEALTH ROW IS NOT DECORATION. §3.2: "This is the surface where a user is thinking about
// connectors, so it's the right place to learn a token is dying." A credential that expires in
// three days is otherwise learned about when an agent fails at 2am.

import { useRef, useState } from "react";
import { Glyph, GLYPH, HIT_TARGET } from "../icons.ts";
import { Icon } from "../../lib/icons/registry.ts";
import { Popover, PopoverNote } from "./Popover.tsx";
import { Checkbox } from "../Checkbox.tsx";
import { Truncate } from "../Truncate.tsx";
import { EmptyState } from "../EmptyState.tsx";
import {
  DECK, deckLayout, monogramColor, monogramLetter, tileOffset, tileZ, type DeckConnector,
} from "../../lib/connectorDeck.ts";
import { STATUS, SURFACE } from "../../lib/tokens.ts";

/** One tile. A logo when the connector has one, a deterministic monogram when it does not. */
function Tile({
  connector,
  index,
  total,
  hovered,
}: {
  connector: DeckConnector;
  index: number;
  total: number;
  hovered: boolean;
}) {
  return (
    <span
      title={`${connector.label}${connector.enabled ? "" : " — off for this conversation"}`}
      className="inline-flex shrink-0 items-center justify-center overflow-hidden transition-[margin] duration-fast motion-reduce:transition-none"
      style={{
        width: DECK.tile,
        height: DECK.tile,
        borderRadius: DECK.radius,
        marginLeft: tileOffset(index, hovered),
        zIndex: tileZ(index, total),
        // The ring in the COMPOSER'S BACKGROUND COLOUR, not a border colour — §3.2's own note.
        // Without it the overlap reads as mud rather than as separation.
        boxShadow: `0 0 0 ${DECK.ring}px ${SURFACE.panel}`,
        background: connector.logoUrl ? SURFACE.active : monogramColor(connector.id),
        // §3.2: a connector disabled for this conversation renders grayscale at 60%.
        filter: connector.enabled ? undefined : "grayscale(1)",
        opacity: connector.enabled ? 1 : 0.6,
        position: "relative",
      }}
    >
      {connector.logoUrl ? (
        <img src={connector.logoUrl} alt="" width={DECK.tile} height={DECK.tile} className="block object-cover" />
      ) : (
        <span className="text-tiny leading-none text-white/90" aria-hidden>
          {monogramLetter(connector.label)}
        </span>
      )}
      {connector.warning && (
        // The dot that makes somebody open the dropdown and find the row. Small, on the tile, and
        // in the warning tone rather than the in-flight amber — see STATUS.warn.
        <span
          className="absolute right-0 top-0 block rounded-full"
          style={{ width: 6, height: 6, background: STATUS.warn, boxShadow: `0 0 0 1px ${SURFACE.panel}` }}
          aria-hidden
        />
      )}
    </span>
  );
}

export function ConnectorDeck({
  connectors,
  disabled = false,
  onToggle,
  onAddConnector,
}: {
  connectors: DeckConnector[];
  disabled?: boolean;
  /** Scopes this CONVERSATION. Never disconnects at workspace level — see the header. */
  onToggle: (connectorId: string, enabled: boolean) => void;
  onAddConnector: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const layout = deckLayout(connectors);

  const enabledCount = connectors.filter((c) => c.enabled).length;

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        disabled={disabled}
        aria-label={`Connectors — ${enabledCount} of ${connectors.length} available to this conversation`}
        aria-expanded={open}
        aria-haspopup="menu"
        title={
          connectors.length === 0
            ? "No connectors in this workspace"
            : `${enabledCount} of ${connectors.length} connector${connectors.length === 1 ? "" : "s"} available here`
        }
        className="inline-flex items-center gap-1.5 rounded-control px-1 text-muted transition-colors duration-fast
          hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring
          disabled:cursor-not-allowed disabled:opacity-30"
        style={{ minWidth: HIT_TARGET, minHeight: HIT_TARGET }}
      >
        {layout.present && (
          <span className="inline-flex items-center" aria-hidden>
            {layout.tiles.map((c, i) => (
              <Tile key={c.id} connector={c} index={i} total={layout.tiles.length} hovered={hovered} />
            ))}
            {layout.overflow > 0 && (
              // "+N in the same footprint" — the same 20px box, so the deck's width does not jump
              // between a workspace with three connectors and one with nine.
              <span
                className="inline-flex shrink-0 items-center justify-center text-tiny text-muted"
                style={{
                  width: DECK.tile, height: DECK.tile, borderRadius: DECK.radius,
                  marginLeft: tileOffset(1, hovered), background: SURFACE.active,
                  boxShadow: `0 0 0 ${DECK.ring}px ${SURFACE.panel}`, zIndex: 0,
                }}
              >
                +{layout.overflow}
              </span>
            )}
          </span>
        )}
        <Glyph icon={Icon.composer.connectors} size={GLYPH.toolbar} />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} triggerRef={triggerRef} label="Connectors" width={320}>
        {connectors.length === 0 ? (
          <EmptyState
            size="inline"
            icon={({ size }) => <Glyph icon={Icon.composer.connectors} size={size ?? GLYPH.empty} />}
            title="No connectors yet"
            hint={
              <button type="button" onClick={onAddConnector} className="text-accent hover:underline">
                Connect one…
              </button>
            }
          />
        ) : (
          <>
            <div className="px-2 pb-1 pt-0.5 text-tiny uppercase tracking-wider text-faint">
              Connectors available to this conversation
            </div>
            {connectors.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-2 rounded-control px-2 py-1.5 transition-colors duration-fast hover:bg-active/50"
              >
                <span className="shrink-0">
                  <Tile connector={{ ...c, warning: null }} index={0} total={1} hovered={false} />
                </span>
                <Truncate className="min-w-0 flex-1 text-caption text-ink">{c.label}</Truncate>
                <Checkbox
                  checked={c.enabled}
                  onChange={() => onToggle(c.id, !c.enabled)}
                  label={`${c.enabled ? "Disable" : "Enable"} ${c.label} for this conversation`}
                  title="Scopes this conversation only — the connector stays connected to the workspace"
                />
              </div>
            ))}

            {connectors.filter((c) => c.warning).map((c) => (
              // The health row. Here rather than in a notification, because this is where somebody
              // is already thinking about connectors — §3.2.
              <div key={`warn-${c.id}`} className="flex items-start gap-2 px-2 py-1.5 text-tiny">
                <span className="shrink-0" style={{ color: STATUS.warn }} aria-hidden>⚠</span>
                <span className="min-w-0 flex-1 text-muted">{c.label} {c.warning}</span>
              </div>
            ))}

            <PopoverNote>
              {/* THE SENTENCE §3.2 REQUIRES. Without it the checkboxes read as "disconnect", and
                  somebody debugging a Postgres path would be afraid to switch Slack off. */}
              Switching one off here scopes this conversation only — the connector stays connected
              to the workspace.
              <button
                type="button"
                onClick={onAddConnector}
                className="mt-1.5 block text-accent hover:underline"
              >
                + Add a connector…
              </button>
            </PopoverNote>
          </>
        )}
      </Popover>
    </div>
  );
}
