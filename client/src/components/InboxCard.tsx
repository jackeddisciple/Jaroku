// One card. Its SIZE is its severity, and colour barely participates.
//
// THIS IS THE CORE DESIGN DECISION OF THE SURFACE (§4.3) and what makes the tab distinct from every
// other list in the app. A blocking card is large and carries its evidence and its form; an
// attention card is medium and carries a subject, a context line and one action; a proposal is
// compact. Somebody scanning the board reads priority from the shape before they read a word.
//
// WHICH MEANS COLOUR HAS ALMOST NOTHING TO DO, and the constraints on it are unusually tight:
//
//   ROSE APPEARS ONCE — a 2px hairline on the left edge of a blocking card. Nothing else is rose.
//
//   AMBER IS NOT AVAILABLE. Amber means RUNNING in this product, and v0.2.2 redrew the wordmark
//   precisely because an amber outline read as a warning. Attention items are neutral-strong:
//   heavier type and a higher position, never a warning colour.
//
//   The four signals that are not severity each have their own carrier: urgency is the age bar,
//   type is the icon, count is the `×40` badge, and resolution is the card physically collapsing.
//
// THREE ELEVATIONS, ONE PER SIZE, from the four-level scale v0.2.2 established — each of them a
// border PLUS a shadow, because on a near-black background a shadow alone is invisible and a border
// alone reads as a drawn rectangle.

import { ELEVATION, ICON, MOTION, RADIUS, SURFACE, TEXT } from "../lib/tokens.ts";
import { ageFraction } from "../lib/inboxBoard.ts";
import { relTime } from "../lib/format.ts";
import { INBOX_ICON } from "./inboxIcons.tsx";
import { InboxCardActions } from "./InboxCardActions.tsx";
import { InboxEvidence } from "./InboxEvidence.tsx";
import { Truncate } from "./Truncate.tsx";
import type { InboxItemView, InboxSeverity } from "../types.ts";

/**
 * The one place rose is used in this product.
 *
 * It is `ACCENT.mcp` by value and deliberately NOT imported under that name: this is not an MCP
 * badge, and a reader following the import would arrive at a comment about third-party tools. The
 * two share a hex because the palette has one rose, and §4.3 asked for the rose.
 */
const ROSE = "#f472b6";

/** §4.3's three sizes, as the geometry each one actually gets. */
const SIZE: Record<InboxSeverity, { pad: string; title: string; elevation: string; border: string }> = {
  // Large. The inline resolve form is visible without expanding, and evidence has room.
  blocking: {
    pad: "px-3 py-2.5",
    title: "text-[13px] font-medium",
    elevation: ELEVATION.overlay,
    border: SURFACE.edge,
  },
  // Medium: subject, context line, primary action. NEUTRAL-STRONG rather than coloured — the weight
  // and the position do the work amber is not allowed to.
  attention: {
    pad: "px-3 py-2",
    title: "text-[12px] font-medium",
    elevation: ELEVATION.floating,
    border: SURFACE.edge,
  },
  // Compact. A proposal is a question, not a problem, and it should not out-weigh one.
  proposal: {
    pad: "px-2.5 py-1.5",
    title: "text-[12px]",
    elevation: ELEVATION.raised,
    border: "#1e1e22",
  },
};

/**
 * §4.3's urgency carrier: a hairline under the card that fills as the item ages.
 *
 * A HAIRLINE AND NOT A PROGRESS BAR. It is one pixel of neutral against the card's own edge, because
 * what it says is "this has been here a while" and not "this is 62% complete" — a bar somebody reads
 * as progress on a card that is waiting for THEM is the wrong sentence entirely.
 *
 * NEUTRAL, NOT RED AS IT FILLS. Colour is spent: rose is the blocking edge and amber means running.
 * An age bar that reddened would be inventing a third meaning for a signal that already has one.
 */
function AgeBar({ item, now }: { item: InboxItemView; now: number }) {
  const fraction = ageFraction(item.first_seen_at, now);
  return (
    <div className="mt-2 h-px w-full bg-hair" aria-hidden>
      <div
        className="h-px transition-[width] motion-reduce:transition-none"
        style={{
          width: `${Math.round(fraction * 100)}%`,
          background: TEXT.faint,
          transitionDuration: `${MOTION.base}ms`,
          transitionTimingFunction: MOTION.ease,
        }}
      />
    </div>
  );
}

/**
 * Law 3's badge: `×40`.
 *
 * ABSENT AT ONE, rather than rendering `×1`. A count is information only when it is more than one —
 * every card on the board would otherwise carry a badge saying nothing, which is the same noise a
 * zero-count chip would be.
 */
function CountBadge({ count }: { count: number }) {
  if (count < 2) return null;
  return (
    <span
      className="shrink-0 rounded-chip px-1 py-px text-[10px] tabular-nums text-muted"
      style={{ background: SURFACE.active, borderRadius: RADIUS.chip }}
      title={`${count} occurrences, collapsed into one item`}
    >
      ×{count}
    </span>
  );
}

export function InboxCard({
  item,
  now,
  leaving = false,
  selected = false,
  expanded = false,
  children,
  onClick,
}: {
  item: InboxItemView;
  now: number;
  /**
   * §5.6: the card is on its way out.
   *
   * IT COLLAPSES AND FADES rather than disappearing, which is §4.3's answer to "how is resolution
   * communicated" — and under `prefers-reduced-motion` it still LEAVES, it just does not animate.
   * That distinction is the whole of the reduced-motion rule: the state change is not optional, the
   * movement is.
   */
  leaving?: boolean;
  /** Where the keyboard is. Not the same as which card is expanded — see `expanded`. */
  selected?: boolean;
  /**
   * §4.5: clicking a card expands it IN PLACE. It does not navigate.
   *
   * WHICH IS NOT THE SAME AS BEING SELECTED. `selected` is where the keyboard is and moves with J/K;
   * this is what somebody opened. Two different questions, two different marks — and conflating them
   * would mean moving the cursor opened four cards on the way past.
   */
  expanded?: boolean;
  /** Anything the board wants under the card — the drag affordance, a per-card notice. */
  children?: React.ReactNode;
  /**
   * The card was clicked.
   *
   * TAKES THE EVENT, because a shift-click is a range selection rather than an expansion and the
   * board is what knows the difference. A handler with no arguments would have made the card decide,
   * and the card does not know what is selected.
   */
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  const size = SIZE[item.severity];
  const Icon = INBOX_ICON[item.icon];

  return (
    <div
      data-inbox-item={item.id}
      onClick={onClick}
      className={`relative overflow-hidden text-left transition-all motion-reduce:transition-none ${size.pad} ${
        leaving ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      style={{
        borderRadius: RADIUS.card,
        border: `1px solid ${selected ? "#3a3a44" : size.border}`,
        boxShadow: size.elevation,
        background: SURFACE.panel,
        // Collapsing rather than merely fading: the column closes up behind it, which is what makes a
        // board visibly shrink as somebody works.
        maxHeight: leaving ? 0 : 480,
        marginBottom: leaving ? -8 : undefined,
        transitionDuration: `${MOTION.base}ms`,
        transitionTimingFunction: MOTION.ease,
      }}
    >
      {/* §4.3: ROSE APPEARS ONCE, and this is it. Two pixels on the left edge of a blocking card. */}
      {item.severity === "blocking" && (
        <span className="absolute inset-y-0 left-0 w-[2px]" style={{ background: ROSE }} aria-hidden />
      )}

      <div className="flex items-start gap-2">
        <span className="mt-px shrink-0 text-muted" aria-hidden>
          <Icon size={ICON.sm} />
        </span>
        <Truncate className={`min-w-0 flex-1 text-ink ${size.title}`} title={item.subject}>
          {item.subject}
        </Truncate>
        <CountBadge count={item.count} />
      </div>

      {/* The context line: what it is about, and how long it has been waiting. Indented to the
          subject's column, so the icon gutter stays a gutter. */}
      <div className="ml-6 mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
        <span className="text-faint">{relTime(item.first_seen_at)}</span>
        {item.snoozed_until && (
          <>
            <span className="text-faint">·</span>
            <span className="text-faint">snoozed</span>
          </>
        )}
      </div>

      {/* §4.5: THE EXPANDED STATE CARRIES THE EVIDENCE — a trace snippet, a diff stat, the last lines
          of a build log — and, where the fix is possible without leaving, the form itself. A blocking
          card shows its evidence without being expanded, which is what "large" actually buys. */}
      {(expanded || item.severity === "blocking") && <InboxEvidence item={item} />}

      {children}

      <AgeBar item={item} now={now} />

      <InboxCardActions item={item} expanded={expanded} />
    </div>
  );
}
