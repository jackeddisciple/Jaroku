// The cook who signs off the empty chat's question — the product owner's own Lottie animation
// (`assets/cook.json`, 2026-09-11), drawn where the woman-cook emoji was and at exactly its size.
//
// THE EMOJI'S BOX, MEASURED. The greeting is 24px and the emoji was set at 1.25em, so 30px — and
// Apple Color Emoji draws a 30px square for it whose bottom sits 4px under the baseline (measured
// in Chrome: advance 30, ink 27×30, from 26px above the baseline to 4px below). This box is that
// square: 1em at the same 1.25em, lowered by 4/30 of an em, so the line does not move by a pixel —
// measured again with the player in it: 30×30, 26 above and 4 below, the row's height unchanged.
// `inline-flex` so the player's <svg> is a flex item rather than an inline one on a line box of its
// own, and the box's baseline stays its bottom edge before the player arrives and after.
//
// IT HAS TO PLAY ON EVERY DESKTOP, which is four rules, each held by `test:cook-animation`:
//   - THE LIGHT PLAYER. `lottie_light` is the SVG renderer without the expression engine, which
//     runs expressions with `eval` — refused by the desktop CSP (`script-src 'self'`). The file has
//     no expressions, no images and no URLs, so it needs nothing the webview might not have.
//   - LOADED HERE, LAZILY. Both imports happen on mount, so the player and the animation stay out
//     of the first chunk and a suite that renders markup never touches `document`.
//   - FAILING SOFT. If either import fails — an update half-applied, a disk error — the emoji it
//     replaced is drawn instead, exactly as it was, rather than an empty box or an unhandled throw.
//   - OLD WEBKIT. Safari before 14 has no `addEventListener` on a media query list, and that is
//     what a Catalina machine's webview can still be; `addListener` is the same subscription.
//
// STILL UNDER prefers-reduced-motion, on a frame from the middle of the loop rather than its first,
// which is the pan before anything is in it — the same rule the 3D gloss keeps.

import { useEffect, useRef, useState } from "react";
import type { AnimationItem } from "lottie-web";

/**
 * The emoji the animation replaced: woman, light skin tone, zero-width joiner, cooking. Built from
 * code points rather than typed, because the joiner is invisible in source and an edit that drops it
 * splits the cook into a woman and a frying pan.
 */
export const COOK_EMOJI = String.fromCodePoint(0x1f469, 0x1f3fb, 0x200d, 0x1f373);

export function CookAnimation() {
  const ref = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let anim: AnimationItem | null = null;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = (): void => {
      if (!anim) return;
      if (motion.matches) anim.goToAndStop(Math.floor(anim.totalFrames / 2), true);
      else anim.play();
    };
    const fall = (): void => {
      if (alive) setFailed(true);
    };
    const listen = (on: boolean): void => {
      if (typeof motion.addEventListener === "function") {
        if (on) motion.addEventListener("change", apply);
        else motion.removeEventListener("change", apply);
      } else if (on) motion.addListener(apply);
      else motion.removeListener(apply);
    };

    Promise.all([import("lottie-web/build/player/lottie_light"), import("../assets/cook.json")])
      .then(([{ default: lottie }, { default: animationData }]) => {
        if (!alive || !ref.current) return;
        anim = lottie.loadAnimation({
          container: ref.current,
          renderer: "svg",
          loop: true,
          autoplay: false,
          animationData,
        });
        anim.addEventListener("data_failed", fall);
        apply();
      })
      .catch(fall);
    listen(true);
    return () => {
      alive = false;
      listen(false);
      anim?.destroy();
    };
  }, []);

  // The emoji exactly as the greeting drew it before the animation, box and all.
  if (failed) {
    return (
      <span aria-hidden className="leading-none" style={{ fontSize: "1.25em" }}>
        {COOK_EMOJI}
      </span>
    );
  }
  return (
    <span
      ref={ref}
      aria-hidden
      className="inline-flex shrink-0"
      style={{ fontSize: "1.25em", width: "1em", height: "1em", verticalAlign: "-0.1333em" }}
    />
  );
}
