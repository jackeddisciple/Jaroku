// §5.3's pinned rail — sticky at the top of the thread, collapsible, and PERSONAL.
//
// WHY PINS EXIST, in the spec's own terms: "Jaroku is conversation-first — generation and every
// subsequent edit live as turns in one thread. In a long thread, the original generation turn and
// key plan decisions are exactly what you keep scrolling back to. The right panel tracks graph and
// trace state; nothing tracks conversation history, so this is a real gap rather than a duplicate
// affordance."
//
// PERSONAL, NOT SHARED, and that is the whole distinction from notes: "Two people debugging the
// same thread care about different anchors." The privacy is enforced by the primary key and the
// repository's WHERE (migration 058), not here — this component only ever renders what it was
// given, which is one person's pins.
//
// COLLAPSED STATE IS REMEMBERED PER USER PER CONVERSATION, and only locally. A rail somebody
// collapsed in one thread should stay open in the next, because the reason to collapse it is that
// THIS thread's pins are not what they are looking at right now.

import { useState } from "react";
import { Glyph, Icon, GLYPH } from "../icons.ts";
import { Truncate } from "../Truncate.tsx";

export interface PinnedTurn {
  turnId: string;
  /** §5.3: "first ~60 chars of the turn, or its plan title if the turn produced a plan." */
  label: string;
  /** Which kind of turn it was, so the rail's glyphs stay scannable. */
  kind: "plan" | "gen" | "proposal" | "reply" | "work";
}

const KIND_ICON = {
  plan: Icon.Effort,
  gen: Icon.Build,
  proposal: Icon.Regenerate,
  reply: Icon.Note,
  // A JOB GIVEN TO A DEPLOYED AGENT (Part 3). `AttachRun`, which is this app's mark for an
  // execution — the same glyph the composer offers when somebody attaches a run — rather than a
  // seventh symbol for a thing that already has one.
  work: Icon.AttachRun,
} as const;

/** §5.3: "Pin label = first ~60 chars of the turn, or its plan title." */
export const PIN_LABEL_MAX = 60;

export function pinLabel(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PIN_LABEL_MAX ? flat : `${flat.slice(0, PIN_LABEL_MAX - 1)}…`;
}

export function PinRail({
  pins,
  onOpen,
  onUnpin,
  /** Per user per conversation, in local state only — see the header. */
  collapsed,
  onToggleCollapsed,
}: {
  pins: PinnedTurn[];
  onOpen: (turnId: string) => void;
  onUnpin: (turnId: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  if (pins.length === 0) return null;

  return (
    // STICKY, so it stays reachable in a thread long enough to need it — which is the only kind of
    // thread that has pins in it. `z-10` keeps it above the turns scrolling under it.
    <div className="sticky top-0 z-10 mb-3 rounded-card border border-edge bg-panel/95 backdrop-blur-sm">
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-tiny text-muted transition-colors duration-fast hover:text-ink"
      >
        <Glyph icon={Icon.Pin} size={GLYPH.meta} />
        <span className="uppercase tracking-wider">Pinned</span>
        <span className="ml-auto tabular-nums text-faint">{pins.length}</span>
        <span className={`text-faint transition-transform duration-fast ${collapsed ? "-rotate-90" : ""}`} aria-hidden>
          ⌄
        </span>
      </button>

      {!collapsed && (
        <div className="border-t border-hair px-1 pb-1 pt-1">
          {pins.map((p) => (
            <div
              key={p.turnId}
              onMouseEnter={() => setHovered(p.turnId)}
              onMouseLeave={() => setHovered(null)}
              className="flex items-center gap-2 rounded-control px-1.5 py-1 transition-colors duration-fast hover:bg-active/50"
            >
              <span className="shrink-0 text-faint" aria-hidden>
                <Glyph icon={KIND_ICON[p.kind]} size={GLYPH.meta} />
              </span>
              <button
                type="button"
                onClick={() => onOpen(p.turnId)}
                className="min-w-0 flex-1 text-left"
                // §5.3: "Click scrolls to the turn and flashes a highlight."
                title="Scroll to this turn"
              >
                <Truncate className="text-caption text-ink">{p.label}</Truncate>
              </button>
              {/* Only on hover, because a row of × marks turns a rail of anchors into a list of
                  things to delete. It stays keyboard-reachable through focus-within on the row. */}
              <button
                type="button"
                onClick={() => onUnpin(p.turnId)}
                aria-label={`Unpin ${p.label}`}
                title="Unpin"
                className={`shrink-0 text-faint transition-opacity duration-fast hover:text-ink focus:opacity-100 ${
                  hovered === p.turnId ? "opacity-100" : "opacity-0"
                }`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
