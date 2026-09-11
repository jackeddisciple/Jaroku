// The greeting's sign-off: the product owner's twenty-five emojis after "What should we cook today,
// Sumu?", one at a time, a new one every second, each popping in — their call on 2026-09-11, the
// same day it replaced the cook animation.
//
// THEIR OWN, IN THEIR ORDER, AS APPLE DRAWS THEM. The list is the one they sent as a screenshot of
// Apple's emoji, matched glyph by glyph against Apple Color Emoji on a Mac: the card index is the
// tabbed folder, not the filing cabinet; the calendar is the spiral one with the red month, not the
// plain notepad; the technologist is the medium-light tone, the one with blonde hair. Nothing is
// bundled — on macOS the system font IS those pictures, and Apple's
// artwork is licensed for Apple's own platforms, not for shipping inside an app. Windows and Linux
// draw the same emojis in their own fonts.
//
// ONLY WHAT THIS MACHINE CAN DRAW. `canDrawEmoji` asks once a session, in a canvas; a font that
// would draw one as a box, a monochrome outline or two glyphs side by side drops it from the cycle,
// and a machine that can draw none of them shows the question on its own.
//
// A FIXED BOX, so the centred heading does not shift every second: 1em wide at the 1.25em the
// emoji has always been set at, on the text's baseline like the emoji before it, and held to the
// last word by a no-break space. The pop is Web Animations on an inner box — a transform does
// nothing to an inline one — and a webview without `animate` simply swaps.
//
// STILL UNDER prefers-reduced-motion — the first emoji, held, no pop — and paused while the window
// is hidden, the rules the 3D gloss keeps. Hidden from screen readers: the words already say cook.

import { useEffect, useRef, useState } from "react";
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

const POP: Keyframe[] = [
  { transform: "scale(0.3)", opacity: 0 },
  { transform: "scale(1.15)", opacity: 1, offset: 0.6 },
  { transform: "scale(1)", opacity: 1 },
];

const REDUCED = "(prefers-reduced-motion: reduce)";

/** Which of the twenty-five this machine draws as emoji — asked once; fonts do not change under a running app. */
let drawable: readonly string[] | null = null;
function drawableHere(): readonly string[] {
  if (!drawable) drawable = GREETING_EMOJIS.filter((e) => canDrawEmoji(e));
  return drawable;
}

export function GreetingEmoji() {
  const [emojis, setEmojis] = useState<readonly string[]>([]);
  const [at, setAt] = useState(0);
  const inner = useRef<HTMLSpanElement>(null);

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
      if (motion.matches) setAt(0);
      else if (document.visibilityState !== "hidden") {
        timer = window.setInterval(() => setAt((n) => (n + 1) % emojis.length), GREETING_EMOJI_MS);
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

  // THE POP, each time the emoji changes — the first one included. Cancelled when the next begins or
  // the greeting goes, so a window that stopped painting mid-pop never has two piled on one box.
  useEffect(() => {
    const el = inner.current;
    if (!el || typeof el.animate !== "function" || window.matchMedia(REDUCED).matches) return;
    const pop = el.animate(POP, { duration: 320, easing: "ease-out" });
    return () => pop.cancel();
  }, [at, emojis]);

  if (emojis.length === 0) return null;
  return (
    <>
      {NBSP}
      <span aria-hidden className="inline-block text-center leading-none" style={{ fontSize: "1.25em", width: "1em" }}>
        <span ref={inner} className="inline-block">
          {emojis[at % emojis.length]}
        </span>
      </span>
    </>
  );
}
