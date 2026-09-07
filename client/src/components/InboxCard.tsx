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
// ONE ELEVATION FOR ALL THREE, WHICH USED TO BE THREE. Each size took its own rung of the
// four-level scale v0.2.2 established, running E3 / E2 / E1 down the severities — and UI-4 §07
// answers that in one sentence: "E2/E3 are reserved for genuinely floating content." A card in a
// column does not float, whatever it is asking for, so §11's `E0 → E1` applies to all three and the
// severity is carried by the three axes that were always doing the work anyway.
//
// THE BORDER IS STILL PAIRED WITH IT, because either half alone reads as a mistake. Which half
// carries the weight depends on the page: on the near-black one this was written for, a shadow alone
// was invisible and the hairline did the separating; on §01's light ladder the shadow works and the
// hairline is what stops a card reading as a drawn rectangle. At E0 the hairline is the whole of it,
// which is exactly what §12 means by a normal card being border-led rather than shadow-led.

import { ACCENT, ICON, MOTION, RADIUS, SURFACE, TEXT } from "../lib/tokens.ts";
import { ageFraction } from "../lib/inboxBoard.ts";
import { absTime } from "../lib/format.ts";
import { DateChip } from "./Chip.tsx";
import { INBOX_ICON } from "./inboxIcons.tsx";
import { InboxCardActions } from "./InboxCardActions.tsx";
import { InboxEvidence } from "./InboxEvidence.tsx";
import { Truncate } from "./Truncate.tsx";
import type { InboxItemView, InboxSeverity } from "../types.ts";

/**
 * The one place rose is used in this product.
 *
 * It is `ACCENT.mcp` and it keeps a local name, which is the same decision it always was for a
 * different reason. It used to be the hex written out, because this is not an MCP badge and a
 * reader following the import would arrive at a comment about third-party tools — but a hex is a
 * copy, and the palette moved under it: `#f472b6` was a rose on near-black and is a highlighter on
 * `#FBFBFA`. So the value is imported and the NAME stays local. The two share a colour because the
 * palette has one rose, and §4.3 asked for the rose.
 */
const ROSE = ACCENT.mcp;

/**
 * §4.3's three sizes, as the geometry each one actually gets.
 *
 * DEPTH IS NOT ONE OF THE AXES ANY MORE, and it was the wrong one to have reached for. The three
 * severities ran down the elevation ladder — E3 under a blocking card, E2 under an attention one,
 * E1 under a proposal — which UI-4 §07 forbids in one sentence: "E2/E3 are reserved for genuinely
 * floating content." A card sitting in a column is not floating however urgent it is, and §11 gives
 * every Inbox card the same answer regardless of severity: E0, rising to E1 under the pointer.
 *
 * WHICH COSTS NOTHING, BECAUSE DEPTH WAS NEVER WHAT SAID "URGENT". A shadow under a card in a
 * scrolling column is very nearly invisible at any alpha this system permits; what actually
 * separated these three was the padding, the title's rung and the border's weight, and all three
 * are still here. §02's own instruction is the argument — typography, spacing and contrast before
 * decoration — and a blocking card that was distinguishable ONLY by being 20px deeper would have
 * been the failure §12 describes as everything being emphasized.
 */
const SIZE: Record<InboxSeverity, { pad: string; title: string; border: string }> = {
  // Large. The inline resolve form is visible without expanding, and evidence has room.
  blocking: {
    pad: "px-3 py-2.5",
    title: "text-label",
    border: SURFACE.edge,
  },
  // Medium: subject, context line, primary action. NEUTRAL-STRONG rather than coloured — the weight
  // and the position do the work amber is not allowed to.
  attention: {
    pad: "px-3 py-2",
    title: "text-caption font-medium",
    border: SURFACE.edge,
  },
  // Compact. A proposal is a question, not a problem, and it should not out-weigh one.
  proposal: {
    pad: "px-2.5 py-1.5",
    title: "text-caption",
    border: SURFACE.hair,
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
      className="shrink-0 rounded-xs px-1 py-px text-tiny tabular-nums text-muted"
      style={{ background: SURFACE.active, borderRadius: RADIUS.xs }}
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
    // §11: an Inbox card is `E0 → E1`, which is a class rather than an inline value because the
    // arrow is a HOVER and only half of it can be written as a style. The rest of the geometry
    // stays inline — the border is computed from two pieces of state and the collapse animates a
    // max-height — so this is the one property that moves out.
    <div
      data-inbox-item={item.id}
      onClick={onClick}
      className={`relative overflow-hidden text-left transition-[max-height,opacity,margin,box-shadow] hover:shadow-raised motion-reduce:transition-none ${size.pad} ${
        leaving ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      style={{
        borderRadius: RADIUS.card,
        border: `1px solid ${selected ? SURFACE.grip : size.border}`,
        background: SURFACE.panel,
        // Collapsing rather than merely fading: the column closes up behind it, which is what makes a
        // board visibly shrink as somebody works.
        maxHeight: leaving ? 0 : 480,
        marginBottom: leaving ? -8 : undefined,
        transitionDuration: `${MOTION.base}ms`,
        transitionTimingFunction: MOTION.ease,
      }}
    >
      {/* §4.3: ROSE APPEARS ONCE, and this is it — but on the GLYPH, not on the container's edge.
          It was a two-pixel stripe down the card's left side, which is the one place this palette
          never puts colour: a tinted container edge reads as a property of the box, and severity is
          a property of the thing inside it. Tinting the mark says the same thing in the same
          colour, in the place the eye is already going to read what the card is about. It also
          stops the stripe from colliding with the selection bar the six other lists in this app
          draw at exactly those coordinates. */}
      <div className="flex items-start gap-2">
        <span
          className="mt-px shrink-0 text-muted"
          style={{ color: item.severity === "blocking" ? ROSE : undefined }}
          aria-hidden
        >
          <Icon size={ICON.sm} />
        </span>
        <Truncate className={`min-w-0 flex-1 text-ink ${size.title}`} title={item.subject}>
          {item.subject}
        </Truncate>
        <CountBadge count={item.count} />
      </div>

      {/* The context line: what it is about, and how long it has been waiting. Indented to the
          subject's column, so the icon gutter stays a gutter. */}
      <div className="ml-6 mt-0.5 flex items-center gap-1.5 text-tiny text-muted">
        {/* §7.2: FIRST SEEN. The Inbox takes no status GLYPH (§2.4 — every card is in the same
            phase, so a mark repeated identically on all of them carries nothing), and this is a
            different pattern with a different argument: an age is the one fact that genuinely
            differs card to card here, and it is what the age bar beside it is drawn from. */}
        <DateChip at={item.first_seen_at} title={`First seen ${absTime(item.first_seen_at)}`} />
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
