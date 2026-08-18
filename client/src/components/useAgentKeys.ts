// §5.5's keyboard-first grid, for as long as the Agents view is on screen.
//
// IT EXTENDS THE BINDING LAYER RATHER THAN ADDING A SECOND ONE, which §5.5 asks for by name: "The
// command palette and J/K trace navigation already exist from v0.1.1 — extend that binding layer
// rather than adding a second one." That layer is `CommandPalette`'s global handler, which stands
// down for non-modified keys whenever a full-screen view is up — so the view that owns the screen
// owns the bare keys, and the chords (⌘K, ⌘P, ⌘/) stay the app's. `useThreadKeys` is the same
// arrangement for the Threads view, and this is deliberately its twin: J/K move a card here exactly
// as they move a row there and a step in the trace, because a person learns one pair of movement
// keys and the surface decides what moves.
//
// J/K MOVE BY ONE CARD, NOT BY ONE ROW, and that is a choice rather than an oversight. The grid
// reflows between three, four and five columns with the window and the density, so "down" is a
// different number of cards at different widths — a cursor that jumped by the current column count
// would move a different distance every time somebody dragged the panel. One card at a time is the
// same everywhere and is what the list-shaped J/K in the rest of this app already means.
//
// MOUNTED WITH THE VIEW, so there is nothing to unregister when somebody navigates away and no "am I
// visible" flag to keep in step with the thing that is actually visible.

import { useEffect } from "react";
import { useUiStore } from "../store/uiStore.ts";
import type { AgentCardView } from "../types.ts";

/** Anything that swallows a bare letter: the search field, a rename in progress, the composer. */
function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

export interface AgentKeyHandlers {
  /** The cards in the order they RENDER — the sort reorders them, so this is what the cursor walks. */
  cards: AgentCardView[];
  /** Where the cursor is, by slug, or null before it has been put anywhere. */
  cursor: string | null;
  setCursor: (slug: string | null) => void;
  /** `/` — focus the search field. */
  focusSearch: () => void;
  /** `Enter` — open the focused card into the three-pane detail. */
  onOpen: (agent: AgentCardView) => void;
  /** `⌘Enter` — start a new thread on it, skipping the detail entirely (§6). */
  onNewThread: (agent: AgentCardView) => void;
}

export function useAgentKeys({
  cards, cursor, setCursor, focusSearch, onOpen, onNewThread,
}: AgentKeyHandlers): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      const at = cursor ? cards.findIndex((c) => c.slug === cursor) : -1;

      // ⌘Enter — §5.5's "starts a new thread on it". Before the typing guard, because a chord is an
      // application action and somebody mid-way through typing a search can still want to start
      // work on the card they have already picked out.
      if (mod && e.key === "Enter") {
        const card = at >= 0 ? cards[at] : undefined;
        if (!card) return;
        e.preventDefault();
        onNewThread(card);
        return;
      }

      // ⌘K is the palette's, always. It is named in §5.5 as the fuzzy jump, and the palette is where
      // that lives — this hook must not swallow it.
      if (mod || useUiStore.getState().paletteOpen || isTypingTarget(e.target)) return;

      const move = (delta: 1 | -1): void => {
        if (cards.length === 0) return;
        // An unplaced cursor lands on the first card going down and the last going up, rather than
        // refusing to move: the first J is the most common keystroke this view will ever see.
        const next = at === -1
          ? (delta === 1 ? 0 : cards.length - 1)
          : Math.min(cards.length - 1, Math.max(0, at + delta));
        setCursor(cards[next]?.slug ?? null);
      };

      switch (e.key) {
        case "j":
        case "J":
          e.preventDefault();
          move(1);
          return;
        case "k":
        case "K":
          e.preventDefault();
          move(-1);
          return;
        case "Enter": {
          const card = cards[at];
          if (!card) return;
          e.preventDefault();
          onOpen(card);
          return;
        }
        case "/":
          e.preventDefault();
          focusSearch();
          return;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards, cursor, setCursor, focusSearch, onOpen, onNewThread]);
}
