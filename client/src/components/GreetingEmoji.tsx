// The greeting's sign-off: the product owner's twenty-five emojis after "What are we working on
// today, <name>?", one at a time, a new one every second — their call on 2026-09-11, the same day it
// replaced the cook animation, and made "buttery smooth" the same evening.
//
// THEIR OWN, IN THEIR ORDER, AS APPLE DRAWS THEM. The list is the one they sent as a screenshot of
// Apple's emoji, matched glyph by glyph against Apple Color Emoji on a Mac: the card index is the
// tabbed folder, not the filing cabinet; the calendar is the spiral one with the red month, not the
// plain notepad; the technologist is the medium-light tone, the one with blonde hair. Nothing is
// bundled — on macOS the system font IS those pictures, and Apple's artwork is licensed for Apple's
// own platforms, not for shipping inside an app. Windows and Linux draw the same emojis in their own
// fonts.
//
// ONLY WHAT THIS MACHINE CAN DRAW. `canDrawEmoji` asks once a session, in a canvas; a font that
// would draw one as a box, a monochrome outline or two glyphs side by side drops it from the cycle,
// and a machine that can draw none of them shows the question on its own.
//
// A CROSSFADE, NOT A SWAP. The new emoji rises in from a little small, overshooting by a hair, while
// the old one floats up and fades — quicker than the arrival, so the two never crowd. Three things
// make it smooth rather than merely animated:
//   - ONLY TRANSFORM AND OPACITY, the two properties a compositor runs on its own. Nothing is laid
//     out or repainted per frame, so a busy main thread cannot make it stutter.
//   - BEFORE PAINT. The animations start in a layout effect, so the first frame of a new emoji is
//     already the first frame of its arrival — never a flash of it at full size.
//   - LAYERS THAT STAY PROMOTED. `will-change` keeps both on the compositor for their whole life, so
//     there is no snap when an animation ends and a layer would otherwise be handed back.
// The moving layers sit over an invisible twin of the current emoji, which is what gives the box its
// size and its baseline — so the heading never moves. A webview without Web Animations shows one
// emoji at a time and swaps, never two stacked.
//
// STILL UNDER prefers-reduced-motion — the first emoji, held, nothing moving — and paused while the
// window is hidden, the rules the 3D gloss keeps. Hidden from screen readers: they decorate the
// question rather than say anything it does not.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { canDrawEmoji } from "../lib/emojiSupport.ts";

const E = (...cps: number[]): string => String.fromCodePoint(...cps);
/** Asks for the colour picture on the six that are plain text by default. */
const VS16 = 0xfe0f;
const ZWJ = 0x200d;
const NBSP = String.fromCharCode(0xa0);

/** The product owner's twenty-five, in their order — code points, so nothing invisible is typed. */
export const GREETING_EMOJIS: readonly string[] = [
  E(0x1f4ca), // bar chart
  E(0x1f5c2, VS16), // card index dividers
  E(0x1f4ec), // open mailbox with raised flag
  E(0x1f4d6), // open book
  E(0x1f5d3, VS16), // spiral calendar
  E(0x260e, VS16), // telephone
  E(0x1f469, 0x1f3fc, ZWJ, 0x1f4bb), // woman technologist, medium-light skin tone
  E(0x2708, VS16), // airplane
  E(0x1f381), // wrapped gift
  E(0x1f45c), // handbag
  E(0x1f3a7), // headphone
  E(0x1f9c1), // cupcake
  E(0x1f4ee), // postbox
  E(0x1f4d1), // bookmark tabs
  E(0x1f4d2), // ledger
  E(0x1f4dd), // memo
  E(0x1f45f), // running shoe
  E(0x1fab4), // potted plant
  E(0x1f3ab), // ticket
  E(0x1f4f7), // camera
  E(0x1f4e0), // fax machine
  E(0x1f570, VS16), // mantelpiece clock
  E(0x1f4b3), // credit card
  E(0x1f6cd, VS16), // shopping bags
  E(0x1f388), // balloon
];

/** A new one every second: the product owner's number. */
export const GREETING_EMOJI_MS = 1000;

/** How long the new one takes to arrive, and the old one to leave — both well inside the second. */
export const ENTER_MS = 560;
export const EXIT_MS = 300;

/** The arrival: up from a little below and a little small, fading in. */
export const ENTER: Keyframe[] = [
  { transform: "translateY(10%) scale(0.55)", opacity: 0 },
  { transform: "translateY(0) scale(1)", opacity: 1 },
];
/** The departure: up and away, shrinking and fading. */
export const EXIT: Keyframe[] = [
  { transform: "translateY(0) scale(1)", opacity: 1 },
  { transform: "translateY(-10%) scale(0.7)", opacity: 0 },
];
/** A soft back-out: overshoots by about one percent (1.012 at 390ms, measured) and settles without a wobble. */
const ENTER_EASE = "cubic-bezier(0.34, 1.28, 0.64, 1)";
const EXIT_EASE = "cubic-bezier(0.5, 0, 0.75, 0)";

/** Keeps a layer on the compositor for its whole life — see the header. */
const LAYER = { willChange: "transform, opacity", backfaceVisibility: "hidden" } as const;

const REDUCED = "(prefers-reduced-motion: reduce)";
/** Whether this webview runs Web Animations at all. One that does not swaps, one emoji at a time. */
const canAnimate = typeof Element !== "undefined" && typeof Element.prototype.animate === "function";
/** A layout effect in a browser; a plain one where there is no layout, as in a suite rendering markup. */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Which of the twenty-five this machine draws as emoji — asked once; fonts do not change under a running app. */
let drawable: readonly string[] | null = null;
function drawableHere(): readonly string[] {
  if (!drawable) drawable = GREETING_EMOJIS.filter((e) => canDrawEmoji(e));
  return drawable;
}

export function GreetingEmoji() {
  const [emojis, setEmojis] = useState<readonly string[]>([]);
  /** How many changes there have been: the current emoji is `n`, the one leaving is `n - 1`. */
  const [n, setN] = useState(0);
  const enter = useRef<HTMLSpanElement>(null);
  const exit = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setEmojis(drawableHere());
  }, []);

  // THE CLOCK. One interval, stopped while the window is hidden and never started under reduced motion.
  useEffect(() => {
    if (emojis.length < 2) return;
    const motion = window.matchMedia(REDUCED);
    let timer: number | undefined;
    const stop = (): void => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const sync = (): void => {
      stop();
      if (motion.matches) setN(0);
      else if (document.visibilityState !== "hidden") {
        timer = window.setInterval(() => setN((k) => k + 1), GREETING_EMOJI_MS);
      }
    };
    // OLDER WEBKIT HAS NO `addEventListener` ON A MEDIA QUERY LIST — Safari before 14, which a
    // Catalina machine's webview can still be. `addListener` is the same subscription.
    const listen = (on: boolean): void => {
      if (typeof motion.addEventListener === "function") {
        if (on) motion.addEventListener("change", sync);
        else motion.removeEventListener("change", sync);
      } else if (on) motion.addListener(sync);
      else motion.removeListener(sync);
    };
    sync();
    listen(true);
    document.addEventListener("visibilitychange", sync);
    return () => {
      stop();
      listen(false);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [emojis]);

  // THE CROSSFADE, before paint — the first emoji arrives on its own, every later one as the last
  // leaves. Cancelled when the next change begins or the greeting goes.
  useBeforePaint(() => {
    if (!canAnimate || emojis.length === 0 || window.matchMedia(REDUCED).matches) return;
    const running = [
      enter.current?.animate(ENTER, { duration: ENTER_MS, easing: ENTER_EASE, fill: "backwards" }),
      n > 0 ? exit.current?.animate(EXIT, { duration: EXIT_MS, easing: EXIT_EASE, fill: "forwards" }) : undefined,
    ];
    return () => running.forEach((a) => a?.cancel());
  }, [n, emojis]);

  if (emojis.length === 0) return null;
  const count = emojis.length;
  const current = emojis[n % count]!;
  const leaving = emojis[(n - 1 + count) % count]!;
  return (
    <>
      {NBSP}
      <span
        aria-hidden
        className="relative inline-block text-center leading-none"
        style={{ fontSize: "1.25em", width: "1em" }}
      >
        <span className="invisible">{current}</span>
        {canAnimate && n > 0 && (
          <span key={`exit-${n}`} ref={exit} className="absolute inset-0" style={LAYER}>
            {leaving}
          </span>
        )}
        <span key={`enter-${n}`} ref={enter} className="absolute inset-0" style={LAYER}>
          {current}
        </span>
      </span>
    </>
  );
}
