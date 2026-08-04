// Paint streamed text at a reading cadence.
//
// "Everything streams" (doc §4.3) has been true of the data since the first version: the socket
// hands every delta straight to the store and the store appends it. What was never true is that
// it LOOKED like it. A model does not emit one character at a time — Anthropic's SSE deltas
// arrive as chunks, often a whole clause or a short paragraph at once — so a reply that is
// genuinely streaming renders as four or five sudden blocks separated by pauses. The pauses read
// as the app hanging and the blocks read as it un-hanging.
//
// This is a rendering detail and nothing more. The store still receives every delta the instant
// it arrives, `chatStore.replyDelta` and `planDelta` are untouched, and nothing downstream sees a
// different string. What changes is only how much of the string is on screen this frame.
//
// The rate is proportional to the backlog rather than fixed. A fixed rate has to be chosen
// against the slowest case and then falls behind a fast one, which turns smoothing into lag —
// the one thing worse than a jumpy stream is a stream that finishes visibly after the model did.
// Draining a constant FRACTION of what is waiting means a 12-character delta appears almost at
// once, a 200-character one over about a fifth of a second, and the gap never grows.
//
// Three things force an immediate flush, because in each the cadence would be a lie:
//   * the turn is no longer streaming — the text is already complete and this is a re-render
//   * the text changed to something that is not an extension of what is shown (a new turn)
//   * the reader has asked for reduced motion

import { useEffect, useRef, useState } from "react";

/**
 * How much of the outstanding text to reveal per frame. 1/6 at ~60fps is a ~100ms time
 * constant: fast enough that nobody waits for it, slow enough to read as arriving.
 */
const DRAIN = 6;

/** Never fewer than this per frame, or a two-character tail would take four frames to land. */
const MIN_STEP = 2;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The visible prefix of `full`.
 *
 * @param full the whole string received so far — the store's value, unmodified
 * @param live whether more is still expected. False flushes immediately.
 */
export function useStreamedText(full: string, live: boolean): string {
  const [shown, setShown] = useState(() => (live ? 0 : full.length));
  const frame = useRef<number | undefined>(undefined);

  // A string that is not an extension of what is on screen is a different string — a new turn
  // reusing this component, or a store correction. Revealing it character by character would
  // animate a change that never happened.
  const restart = !full.startsWith(full.slice(0, shown));

  useEffect(() => {
    if (!live || prefersReducedMotion()) {
      setShown(full.length);
      return;
    }
    if (restart) {
      setShown(full.length);
      return;
    }
    if (shown >= full.length) return;

    frame.current = window.requestAnimationFrame(() => {
      setShown((current) => {
        const backlog = full.length - current;
        if (backlog <= 0) return current;
        return current + Math.max(MIN_STEP, Math.ceil(backlog / DRAIN));
      });
    });
    return () => {
      if (frame.current !== undefined) window.cancelAnimationFrame(frame.current);
    };
  }, [full, live, shown, restart]);

  return shown >= full.length ? full : full.slice(0, shown);
}
