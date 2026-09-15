// A chat's name typing itself out when it changes — the way a topic title arrives.
//
// ONLY ON A CHANGE, NEVER ON FIRST SIGHT. Opening a chat, scrolling the sidebar or reloading shows the
// name as it is; what animates is the moment the name BECOMES something else, which is the moment
// worth noticing — "Hi" turning into "Greeting" once the first answer is in.
//
// A NAME SOMEBODY TYPED IS NOT RETYPED. A rename is the person's own words landing where they put them,
// and replaying it at them would be decoration. So is the reader who has asked for reduced motion: the
// new name is simply there.
//
//   npm run test:typed-text

import { useEffect, useRef, useState } from "react";

/** How long each character takes at most. */
export const MS_PER_CHAR = 35;

/** The longest a whole name may take, however long it is. */
export const MAX_TYPING_MS = 1200;

/** How many characters of a name of `length` characters are shown `elapsed` ms after it began typing. */
export function typedLength(length: number, elapsed: number): number {
  if (length <= 0) return 0;
  const per = Math.min(MS_PER_CHAR, MAX_TYPING_MS / length);
  return Math.max(0, Math.min(length, Math.floor(Math.max(0, elapsed) / per) + 1));
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The part of `text` on screen right now.
 *
 * Characters, not UTF-16 units, so an emoji in a name is never cut in half mid-typing. Remembers the
 * last name it showed rather than whether it has mounted, so React's development double-mount does not
 * mistake the first render for a change.
 */
export function useTypedText(text: string, animate = true): string {
  const [shown, setShown] = useState(text);
  const last = useRef(text);

  useEffect(() => {
    if (last.current === text) return;
    last.current = text;
    if (!animate || prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      setShown(text);
      return;
    }
    const chars = Array.from(text);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number): void => {
      const n = typedLength(chars.length, now - start);
      setShown(chars.slice(0, n).join(""));
      if (n < chars.length) frame = requestAnimationFrame(tick);
    };
    setShown("");
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      // Interrupted — by unmounting, or by yet another name — the name is shown whole rather than cut.
      setShown(last.current);
    };
  }, [text, animate]);

  return shown;
}
