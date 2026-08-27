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
import { sendArchiveThread } from "../lib/socket.ts";
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
  /**
   * §5's `⌘Enter` — start renaming the cursor row in place.
   *
   * The view owns which row is being renamed, because this hook is mounted on the view and has no
   * handle on a row. Without it §5's second binding was simply absent: `useThreadKeys` returned on
   * every chord but `⌘N`, `ThreadRow` entered edit mode only from `onDoubleClick`, and renaming — in
   * a view whose §4.7 rule is "every action must be reachable without a mouse" — was mouse-only.
   */
  startRename: (id: string) => void;
}

export function useThreadKeys({
  rows, cursor, setCursor, setFilter, focusFilter, startRename,
}: ThreadKeyHandlers): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;

      // ⌘N IS THE PALETTE'S NOW, and it is not handled in two places either.
      //
      // It was handled here and nowhere else, while the palette drew its keycap on a surface
      // reachable from every screen — so the chord worked on the Threads board and did nothing on
      // the other four, where on Windows Ctrl+N fell through to the browser and opened a new
      // window. It is bound beside ⌘K and ⌘P now, for the reason those are: a chord is about the
      // application rather than about what is on screen. Nothing is lost here — the board is one of
      // the screens the global binding covers.

      // ⌘Enter — §5's other way into a rename, beside the double-click. Also before the typing
      // guard: the only typing target that can hold focus here is the filter field, and a chord
      // aimed at the cursor row is still aimed at the cursor row.
      if (mod && e.key === "Enter") {
        const row = cursor ? rows.find((r) => r.id === cursor) : undefined;
        if (!row) return;
        e.preventDefault();
        startRename(row.id);
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
          // THE NOTICE FOLLOWS THE SEND, and the fragment is read before it. Both halves matter: the
          // text has to be captured while the row still describes what was outstanding (afterwards
          // it is gone from the list and its fragment has been recomputed for an archived thread),
          // and it must only be shown if the mutation actually left the tab. Written first, it
          // claimed "Archived · discarded a pending diff (+42−11)" over a socket that had silently
          // dropped the command. A thread with nothing outstanding produces no notice at all (§3.4).
          const outstanding = row;
          if (!sendArchiveThread(row.id)) return;
          useThreadStore.getState().noteArchived(outstanding);
          // The cursor moves to the neighbour BEFORE the row leaves, so the next J/K continues from
          // where the eye is rather than from a row that is no longer in the list.
          setCursor(rows[at + 1]?.id ?? rows[at - 1]?.id ?? null);
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
  }, [rows, cursor, setCursor, setFilter, focusFilter, startRename]);
}
