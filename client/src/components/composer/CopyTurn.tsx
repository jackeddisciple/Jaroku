// Copy, §5.1 — the first tenant of the message action row.
//
// TWO DECISIONS, AND BOTH ARE ABOUT WHAT NOT TO DO.
//
//   IT COPIES THE MARKDOWN SOURCE, NOT THE RENDERED TEXT. People paste this into issues, PRs and
//   docs, and rendered text arrives there as a wall of prose with the code fences gone — which is
//   the one part they were copying. `document.getSelection()`-style copying of the DOM node would
//   have been fewer lines and would have silently destroyed every response worth copying.
//
//   THERE IS NO TOAST. The icon swaps to a check for 1.2 seconds. A toast for a copy is noise: it
//   is a confirmation of something the user just did deliberately, rendered in the one place the
//   app reserves for things that happened without them. §5.1 says so directly, and the check is
//   §10-compliant on its own — a shape change rather than only a colour one.
//
// The clipboard write can fail — a browser without permission, an insecure origin, a Tauri webview
// with the API gated — and a check that appears anyway would be a lie about where the text went.
// So the state only advances once the write resolves.

import { useEffect, useRef, useState } from "react";
import { GLYPH, HIT_TARGET, Glyph } from "../icons.ts";
import { CheckIcon } from "../panelIcons.tsx";
import { Icon } from "../../lib/icons/registry.ts";

/** §5.1: "Icon swaps to a check for 1.2s". */
const CHECK_MS = 1200;

export function CopyTurn({
  /** The markdown SOURCE of the turn. Never the rendered node's text. */
  source,
  className = "",
}: {
  source: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(source);
      setState("copied");
    } catch {
      // Named rather than swallowed. A copy that silently did nothing is the failure people
      // discover by pasting the wrong thing somewhere else.
      setState("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), CHECK_MS);
  };

  const copied = state === "copied";

  return (
    <>
      <button
        type="button"
        onClick={() => { void copy(); }}
        // The name changes with the state, because for a screen reader the check IS the feedback
        // and an unchanged label would mean nothing was announced at all.
        aria-label={copied ? "Copied" : state === "failed" ? "Copy failed" : "Copy response as markdown"}
        title={state === "failed" ? "Couldn't reach the clipboard" : "Copy the markdown source"}
        className={`inline-flex items-center justify-center rounded-control transition-colors duration-fast
          focus-visible:outline-none focus-visible:shadow-focusring
          ${copied ? "text-ok" : state === "failed" ? "text-err" : "text-muted hover:bg-active hover:text-ink"}
          ${className}`}
        style={{ minWidth: HIT_TARGET, minHeight: HIT_TARGET }}
      >
        {copied ? (
          // THE ONE HAND-WRITTEN <svg> LEFT IN THIS FILE, AND IT IS GONE. It drew its own path at
          // its own `strokeWidth`, which made a transient success state the only mark in the app
          // that did not come from the factory — so it was also the only one that would not have
          // moved when the token did. `CheckIcon` is the same shape through the same factory, and
          // it stays out of the registry for the reason the old comment gave: a check is not one
          // of the jobs §5 and §6 name, it is the copy control wearing a moment of feedback.
          <CheckIcon size={GLYPH.action} />
        ) : (
          <Glyph icon={Icon.turn.copy} size={GLYPH.action} />
        )}
      </button>
      {/* §10: "Live region announces stream start/finish and 'copied'." The visible check is a
          hover-adjacent affordance; this is how it reaches somebody who is not looking at it. */}
      <span aria-live="polite" className="sr-only">{copied ? "Copied to clipboard" : ""}</span>
    </>
  );
}
