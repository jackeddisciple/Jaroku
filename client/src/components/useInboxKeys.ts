// §5.5's keyboard: a full Inbox must be clearable without touching the mouse.
//
// EXTENDING THE BINDING LAYER THAT ALREADY EXISTS rather than adding a second one, which §5.5 asks
// for by name. `CommandPalette` owns the global handler and stands down for non-modified keys while
// a full-screen view is up, so the view that owns the screen owns the keyboard; modified chords —
// ⌘K, ⌘P, ⌘Z — keep working throughout, because those are the app's rather than a surface's. This
// hook is mounted with the view, so there is nothing to unregister and no "am I visible" flag to
// keep in step with the thing that is actually visible.
//
// THE BINDINGS ARE THE ONES THE REST OF THE APP ALREADY USES. J/K moves a card here exactly as it
// moves a thread there and a trace step in the panel — a person learns one pair of movement keys and
// the surface decides what moves. `E` archives a thread and resolves an item, which are the same
// verb on two surfaces: this is dealt with.
//
// TWO THINGS §5.5 SINGLES OUT, AND BOTH ARE ABOUT THE CURSOR RATHER THAN THE KEYS:
//
//   "Focus must survive a filter change." Changing the chip re-orders and re-filters the board under
//   the cursor, and a cursor left on a card that is no longer rendered is a cursor nobody can see
//   moving. It falls back to the first row rather than to nothing, so the next keystroke does
//   something.
//
//   "...and a card resolving out from under it." §5.6 means cards leave while somebody is working,
//   from anywhere including another person's action. The cursor moves to the NEIGHBOUR before the
//   row goes, so the next J continues from where the eye is.
//
// `S` IS A TWO-KEY CHORD, which is the one binding here that is not a single press. §3's three
// durations are a choice and a snooze with no duration would have to invent one — so `S` arms, and
// 1/2/3 completes. Anything else cancels, because a chord that swallowed the next keystroke would
// eat a `J` somebody meant as movement.

import { useEffect, useRef } from "react";
import {
  INBOX_FILTERS,
  rangeBetween,
  type InboxFilter,
} from "../lib/inboxBoard.ts";
import {
  sendBulkInboxAction,
  sendDismissInboxItem,
  sendResolveInboxItem,
  sendSnoozeInboxItem,
  sendUndoInboxAction,
} from "../lib/socket.ts";
import { useInboxStore } from "../store/inboxStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import type { InboxItemView, SnoozeDuration } from "../types.ts";

/** Anything that swallows a bare letter: the filter field, an inline credential form, the composer. */
function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/** `S` then 1 / 2 / 3, in the order §3 lists the durations. */
const BY_DIGIT: Record<string, SnoozeDuration> = { "1": "hour", "2": "tomorrow", "3": "week" };

export interface InboxKeyHandlers {
  /** The cards in the order they RENDER, across column boundaries — which is what J/K walks. */
  rows: InboxItemView[];
  cursor: string | null;
  setCursor: (id: string | null) => void;
  setFilter: (f: InboxFilter) => void;
  /** `Enter` — expand the card under the cursor in place. */
  toggleExpand: (id: string) => void;
  /** A range selection, for shift-clicked bulk. Cleared by anything that acts. */
  selection: string[];
  setSelection: (ids: string[]) => void;
}

export function useInboxKeys({
  rows, cursor, setCursor, setFilter, toggleExpand, selection, setSelection,
}: InboxKeyHandlers): void {
  /**
   * True between `S` and the digit that completes it.
   *
   * A REF RATHER THAN STATE, because arming a chord is not something to re-render for — and because
   * a state update between the two keystrokes would race a fast typist against React's batching.
   */
  const arming = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;

      // ⌘Z / Ctrl+Z — §3's undo. BEFORE THE TYPING GUARD, because a chord is an application action
      // and somebody who has just dismissed forty things and started typing in the filter still
      // means undo. It is also the one binding here that is not about the cursor at all.
      if (mod && e.key.toLowerCase() === "z") {
        const undo = useInboxStore.getState().undo;
        if (!undo) return;
        e.preventDefault();
        sendUndoInboxAction(undo.token);
        return;
      }

      // The palette owns every other chord. Bare keys are this view's, and never while typing —
      // a credential being typed into an inline form must not archive four cards on its way past.
      if (mod || useUiStore.getState().paletteOpen || isTypingTarget(e.target)) return;

      // The armed half of `S`. Checked before everything else, because while a chord is open the
      // next keystroke belongs to it.
      if (arming.current) {
        arming.current = false;
        const duration = BY_DIGIT[e.key];
        const row = cursor ? rows.find((r) => r.id === cursor) : undefined;
        // ANYTHING THAT IS NOT A DURATION CANCELS rather than being swallowed, so a `J` somebody
        // meant as movement is a cancelled chord and not a lost keystroke. It is deliberately not
        // re-dispatched: a key that did two things because a chord was open would be worse.
        if (!duration || !row) return;
        e.preventDefault();
        if (selection.length > 1) sendBulkInboxAction("snooze", selection, duration);
        else sendSnoozeInboxItem(row.id, duration);
        setSelection([]);
        return;
      }

      const at = cursor ? rows.findIndex((r) => r.id === cursor) : -1;
      const move = (delta: 1 | -1): void => {
        if (rows.length === 0) return;
        // An unplaced cursor lands on the first card going down and the last going up rather than
        // refusing to move: the first J is the most common keystroke this view will ever see.
        const next = at === -1
          ? (delta === 1 ? 0 : rows.length - 1)
          : Math.min(rows.length - 1, Math.max(0, at + delta));
        setCursor(rows[next]?.id ?? null);
        // MOVING THE CURSOR CLEARS A RANGE. A selection somebody built with shift-click and then
        // walked away from is a selection they have forgotten about, and the next `X` would dismiss
        // all of it.
        if (selection.length > 0) setSelection([]);
      };

      /** What an action applies to: the range if there is one, else the card under the cursor. */
      const targets = (): string[] => {
        if (selection.length > 1) return selection;
        const row = rows[at];
        return row ? [row.id] : [];
      };

      /**
       * Where the cursor goes when what it is on is about to leave.
       *
       * §5.5's "focus must survive a card resolving out from under it", applied BEFORE the mutation
       * rather than after: afterwards the row is gone from the list and there is no neighbour to
       * find. The next one down, else the one above, else nothing.
       */
      const stepOff = (): void => setCursor(rows[at + 1]?.id ?? rows[at - 1]?.id ?? null);

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
          toggleExpand(row.id);
          return;
        }
        case "e":
        case "E": {
          const ids = targets();
          if (ids.length === 0) return;
          e.preventDefault();
          // §3: RESOLVE IS SHARED. Somebody saying "this is dealt with" settles it for the workspace,
          // and if they were wrong the next sweep does nothing — the row is already resolved — while
          // undo puts it back for the predicate to judge afresh.
          stepOff();
          if (ids.length > 1) sendBulkInboxAction("resolve", ids);
          else sendResolveInboxItem(ids[0]!);
          setSelection([]);
          return;
        }
        case "x":
        case "X": {
          const ids = targets();
          if (ids.length === 0) return;
          e.preventDefault();
          stepOff();
          if (ids.length > 1) sendBulkInboxAction("dismiss", ids);
          else sendDismissInboxItem(ids[0]!);
          setSelection([]);
          return;
        }
        case "s":
        case "S": {
          if (!rows[at]) return;
          e.preventDefault();
          // ARMED, not applied. The duration is the next keystroke — see the header.
          arming.current = true;
          return;
        }
        case "Escape":
          // A range built and then thought better of. Nothing else on this surface uses Escape,
          // because there are no dialogs to close: §3 replaced them with undo.
          if (selection.length > 0) {
            e.preventDefault();
            setSelection([]);
          }
          return;
        case "/":
          e.preventDefault();
          // `/` FOCUSES THE FILTER, which on this board is the rail rather than a text field — so it
          // moves the cursor to the first card of the ALL filter, which is what "filter" means here.
          setFilter("all");
          setCursor(rows[0]?.id ?? null);
          return;
      }

      // 1–6 — the rail's chips, by position. Positional rather than by name because the chips never
      // move (a zero-count chip keeps its place), so the number is a stable address.
      const digit = Number(e.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= INBOX_FILTERS.length) {
        e.preventDefault();
        setFilter(INBOX_FILTERS[digit - 1]!);
        setSelection([]);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, cursor, setCursor, setFilter, toggleExpand, selection, setSelection]);
}

/**
 * §4.5's shift-click, as the handler a card's click goes through.
 *
 * HERE RATHER THAN IN THE VIEW because it is the other half of the same selection the keyboard
 * reads: a range built with the mouse and then acted on with `E` has to be the same list, and two
 * places building it is how the two end up disagreeing about what is selected.
 */
export function selectOnClick(
  ordered: readonly InboxItemView[],
  itemId: string,
  shiftKey: boolean,
  cursor: string | null,
  setSelection: (ids: string[]) => void,
): void {
  if (!shiftKey || !cursor) {
    setSelection([]);
    return;
  }
  setSelection(rangeBetween(ordered, cursor, itemId));
}
