// The two weights of action a first-run screen has, in one place.
//
// Both screens had been writing the same filled-ink button out by hand — same padding, same
// radius, same inline `style={{ background: TEXT.ink, color: SURFACE.bg }}`, same
// `hover:opacity-90` — which is how "Get started" and "Continue with Anthropic" end up a pixel
// apart the first time somebody adjusts one of them.
//
// Two things changed while extracting it, and both are the same rule:
//
//   1. Hover lifts instead of dimming. `hover:opacity-90` fades the one control the screen is
//      asking you to press — it moves AWAY as the pointer arrives, which is backwards. The ring
//      (GLOW.cta) is a control coming up to meet you instead, and it is the same treatment the
//      provider cards use one screen later. It was a halo of light around a near-black button and
//      it is a halo of ink around a charcoal one; what it says did not change.
//
//   2. Focus is a first-class state, not a fallback. `focus:` fires on a mouse press too, so a
//      clicked button kept a ring nobody asked for and the ring stopped meaning "the keyboard is
//      here". `focus-visible:` is what actually says that.
//
// The `kbd` slot is the keyboard-first rule made visible (§4.5: shortcuts shown inline to teach
// them). It is only honest on the control that has autofocus, so it is opt-in per call site
// rather than baked in.

import { SURFACE, TEXT } from "../../lib/tokens.ts";
import { alpha } from "../../lib/palette.ts";

interface CtaProps {
  children: React.ReactNode;
  onClick: () => void;
  autoFocus?: boolean;
  /** A shortcut to teach, rendered as a key cap. Only pass it where the key really works. */
  kbd?: string;
  title?: string;
  className?: string;
}

/** The decision the screen exists to ask. One per screen, filled — §08's charcoal, canvas on ink. */
export function PrimaryCta({ children, onClick, autoFocus, kbd, title, className = "" }: CtaProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      autoFocus={autoFocus}
      title={title}
      className={`group inline-flex items-center gap-2.5 rounded-control px-5 py-2.5 text-label
        font-medium outline-none focus-visible:shadow-focusring transition-shadow duration-base ease-state
        hover:shadow-glow-cta focus-visible:shadow-focusring ${className}`}
      style={{ background: TEXT.ink, color: SURFACE.bg }}
    >
      {children}
      {kbd && (
        // Sits ON the filled surface, so its patch is drawn from the surface's own contrast rather
        // than from a border colour off the neutral scale — which would be invisible here.
        //
        // IT WAS A DARKER PATCH AND IT IS A LIGHTER ONE. The button was near-black on a near-black
        // page and the chip deepened it; the button is charcoal on an off-white page now, and the
        // only direction left is up. Same idea, same alpha, opposite end.
        <kbd
          aria-hidden
          className="rounded-chip px-1.5 py-0.5 text-tiny leading-none"
          style={{ background: alpha(SURFACE.bg, 0.16), color: SURFACE.bg }}
        >
          {kbd}
        </kbd>
      )}
    </button>
  );
}

/**
 * The other way forward. Not a lesser answer — a different one.
 *
 * Bordered rather than bare, because on both screens the secondary path is a real choice
 * ("try it free", "go back and look again") and a bare text link next to a filled button reads as
 * a footnote. It carries the same glow on hover as the cards, so the two weights differ in fill
 * and nothing else.
 */
export function GhostCta({ children, onClick, autoFocus, kbd, title, className = "" }: CtaProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      autoFocus={autoFocus}
      title={title}
      className={`inline-flex items-center gap-2.5 rounded-control border border-edge px-5 py-2.5
        text-label text-ink outline-none focus-visible:shadow-focusring transition-shadow duration-base ease-state
        hover:shadow-glow focus-visible:shadow-focusring ${className}`}
    >
      {children}
      {kbd && (
        <kbd
          aria-hidden
          className="rounded-chip bg-active px-1.5 py-0.5 text-tiny leading-none text-muted"
        >
          {kbd}
        </kbd>
      )}
    </button>
  );
}
