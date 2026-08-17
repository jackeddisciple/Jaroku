// §4.7's keyboard, for as long as the Threads view is on screen.
//
// EVERY ACTION IS REACHABLE WITHOUT A MOUSE, which is the product's own rule rather than a nicety —
// and the bindings are deliberately the ones the rest of the app already uses. J/K moves a row here
// exactly as it moves a trace step there, which is the whole reason those two are the same keys: a
// person learns one pair of movement keys, and the surface decides what moves.
//
// WHICH MEANS THE TWO CANNOT BOTH LISTEN. `CommandPalette` owns the global handler and drives trace
// navigation; it now stands down for non-modified keys while a full-screen view is up, so the view
// that owns the screen owns the keyboard. Modified chords — ⌘K, ⌘P, ⌘/ — keep working throughout,
// because those are the app's rather than a surface's.
//
// MOUNTED WITH THE VIEW, so there is nothing to unregister when somebody navigates away and no
// "am I visible" flag to keep in step with the thing that is actually visible.

import { useEffect } from "react";
import { THREAD_FILTERS, type ThreadFilter } from "../lib/threadFilter.ts";
import { openThread } from "../lib/threadNav.ts";
import { sendArchiveThread, sendCreateThread } from "../lib/socket.ts";
import { useThreadStore } from "../store/threadStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { ThreadView } from "../types.ts";

/** Anything that swallows a bare letter: the filter field, a rename in progress, the composer. */
function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

export interface ThreadKeyHandlers {
  /** The rows the cursor moves through, already filtered and in the order they render. */
  rows: ThreadView[];
  /** Where the cursor is, by thread id, or null before it has been put anywhere. */
  cursor: string | null;
  setCursor: (id: string | null) => void;
  setFilter: (f: ThreadFilter) => void;
  /** `/` — focus the text filter. */
  focusFilter: () => void;
}

export function useThreadKeys({ rows, cursor, setCursor, setFilter, focusFilter }: ThreadKeyHandlers): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;

      // ⌘N / Ctrl+N — a new thread. Handled before the typing guard, because a chord is an
      // application action and somebody mid-way through typing a filter can still want a new thread.
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        sendCreateThread();
        return;
      }

      // The palette owns every other chord. Bare keys are this view's, and never while typing —
      // `webhook` in the filter field must not archive four threads on its way to the `k`.
      if (mod || useUiStore.getState().paletteOpen || isTypingTarget(e.target)) return;

      const at = cursor ? rows.findIndex((r) => r.id === cursor) : -1;
      const move = (delta: 1 | -1): void => {
        if (rows.length === 0) return;
        // An unplaced cursor lands on the first row going down and the last going up, rather than
        // refusing to move: the first J is the most common keystroke this view will ever see.
        const next = at === -1
          ? (delta === 1 ? 0 : rows.length - 1)
          : Math.min(rows.length - 1, Math.max(0, at + delta));
        setCursor(rows[next]?.id ?? null);
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
          const row = rows[at];
          if (!row) return;
          e.preventDefault();
          openThread(row);
          return;
        }
        case "e":
        case "E": {
          // §3.4: archiving is immediate, with no modal in between. The notice below names what was set
          // aside AFTER the fact — it is a statement about what happened, not a gate to clear first.
          const row = rows[at];
          if (!row || row.archived_at !== null) return;
          e.preventDefault();
          // What was outstanding, captured BEFORE the archive: afterwards the row is gone from the list
          // and its fragment has been recomputed for an archived thread. A thread with nothing
          // outstanding produces no notice at all (§3.4).
          useThreadStore.getState().noteArchived(row);
          // The cursor moves to the neighbour BEFORE the row leaves, so the next J/K continues from
          // where the eye is rather than from a row that is no longer in the list.
          setCursor(rows[at + 1]?.id ?? rows[at - 1]?.id ?? null);
          sendArchiveThread(row.id);
          return;
        }
        case "p":
        case "P": {
          // Pins the selected thread's AGENT, not the thread. A thread is a session and sessions end;
          // an agent is the thing somebody comes back to, which is what the sidebar's PINNED section
          // is for.
          const row = rows[at];
          if (!row?.agent_id) return;
          e.preventDefault();
          useUiStore.getState().togglePinnedAgent(row.agent_id);
          return;
        }
        case "/":
          e.preventDefault();
          focusFilter();
          return;
      }

      // 1–5 — the filter chips, by position. Positional rather than by name because the chips never
      // move (§4.4 keeps a zero-count chip in place), so the number is a stable address.
      const digit = Number(e.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= THREAD_FILTERS.length) {
        e.preventDefault();
        setFilter(THREAD_FILTERS[digit - 1]!);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, cursor, setCursor, setFilter, focusFilter]);
}
