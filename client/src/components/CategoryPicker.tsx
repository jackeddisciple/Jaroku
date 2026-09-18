// One compact control for a taxonomy of forty, and the field that finds one is the field that
// invents one.
//
// WHY THIS IS NOT `Select`, WHICH IS A FAIR QUESTION. That file's header ends "this is that, once,
// so a seventh dropdown cannot invent an eighth spelling of it", and the rule is right. What this
// is, though, is a COMBOBOX rather than a select: it searches, it groups, and its text field can
// produce a value that is not in the list at all. Bending `Select`'s flat `options: SelectOption[]`
// to carry group headings, a filter and free text would widen the one control six other call sites
// depend on, to serve the one call site that needs all three.
//
// SO IT BORROWS THE CONTRACT INSTEAD OF THE CODE. Everything `Select` promises, this promises, in
// the same spelling: a real `<button>` trigger with `aria-haspopup` and `aria-expanded`, a
// click-outside listener, Escape to cancel, arrow keys through the options, Enter to choose. A
// custom control that is only clickable is a worse control than the native one it replaced.
//
// ── WHY THE TAXONOMY IS BEHIND A POPOVER AT ALL ────────────────────────────────────────────────
//
// It used to be forty chips in six labelled groups, in the dialog, above the one question the
// dialog exists to ask. That is a vocabulary presented as the main event: the screen was six
// hundred pixels of taxonomy and one textarea, and the textarea is the thing that says what the
// agent is FOR. Behind a trigger it is one line until somebody wants it.
//
// ── THE SEARCH FIELD DOES TWO JOBS ─────────────────────────────────────────────────────────────
//
// It filters, and when nothing matches it OFFERS WHAT WAS TYPED — the product owner's call, and it
// is what replaces the old "Name your own" button and its revealed input. Two controls for "pick a
// word" and "supply a word" was always one more than the question needs, and it read as two
// different kinds of answer when the column stores both identically: the category is TEXT and the
// presets are a vocabulary, not a constraint (I6).
//
// THE OFFER IS ONLY MADE WHEN NOTHING MATCHES, which is what keeps it from being noise. Typing
// `bill` finds Billing; typing `queue watching` finds nothing, so the last row becomes the way to
// use it. Nothing is invented on the user's behalf: the row has to be chosen.
//
//   npm run test:agent-category

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { CATEGORY_GROUPS, UNCATEGORIZED, normalizeCategory } from "../lib/agentCategories.ts";
import { ICON, LAYER, TYPE } from "../lib/tokens.ts";
import { CheckIcon, ChevronDownIcon } from "./panelIcons.tsx";

/**
 * Distance from the trigger and the closest the popover may come to the window's edge — the same
 * two numbers, for the same reasons, as `lib/anchoredMenu.ts`.
 */
const GAP = 4;
const EDGE = 8;

/**
 * The tallest the popover may get on a screen with room to spare, and the shortest it is willing to
 * be before it would rather open the other way.
 *
 * A MAXIMUM, BECAUSE FORTY ROWS FIT NOWHERE. Six headings and forty options is around a thousand
 * pixels; a popover allowed to be that tall is one that swallows the dialog it belongs to.
 *
 * AND A MINIMUM, WHICH IS THE PART THAT DECIDES THE DIRECTION — see `fit`. "Flip up unless the
 * maximum fits below" sounds right and is not: in this dialog there are 228px under the trigger
 * and 471px over it, so that rule flips up every time and the popover covers the header and the
 * textarea, which is the field the dialog is FOR. The question is not whether there is room for
 * the tallest popover, it is whether there is room for a usable one — the search field, a heading
 * and four or five options.
 */
const POPOVER_MAX = 320;
const POPOVER_MIN = 200;

/** One row of the popover: a preset, or the offer to use what was typed. */
export type CategoryRow =
  | { kind: "preset"; value: string; group: string }
  | { kind: "custom"; value: string };

/**
 * What the popover offers for a query — the whole of this control's logic, as a function.
 *
 * EXPORTED BECAUSE THIS IS THE PART WORTH ASSERTING. The old dialog's forty chips were checked by
 * scraping the rendered markup for each preset, which only worked because everything was on screen
 * at once; behind a popover there is nothing to scrape until somebody clicks. This is the same
 * question asked of the source of truth instead of the paint: are all forty reachable, does the
 * filter narrow, and does the offer appear exactly when the list is empty.
 */
export function categoryRows(query: string): CategoryRow[] {
  const q = query.trim().toLowerCase();
  const rows: CategoryRow[] = [];
  // GROUPED IN THE OUTPUT RATHER THAN THE INPUT — see `heading` below. Flattened here so the
  // keyboard has one list to walk and the filter cannot strand a heading over nothing.
  for (const group of CATEGORY_GROUPS) {
    for (const c of group.categories) {
      if (!q || c.toLowerCase().includes(q)) rows.push({ kind: "preset", value: c, group: group.label });
    }
  }
  // THE OFFER, AND ONLY WHEN THE LIST HAS NOTHING. See the header: `bill` should find Billing
  // rather than propose itself.
  const typed = normalizeCategory(query);
  if (rows.length === 0 && typed !== UNCATEGORIZED) rows.push({ kind: "custom", value: typed });
  return rows;
}

export function CategoryPicker({
  value,
  onChange,
}: {
  /** The chosen category, or `UNCATEGORIZED` for "nothing chosen yet". */
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** Which row the keyboard is on, as an index into `rows`. */
  const [cursor, setCursor] = useState(0);
  /** Which way it opens, and how tall it may be — measured, never assumed. See `fit` below. */
  const [box, setBox] = useState<{ above: boolean; max: number }>({ above: false, max: POPOVER_MAX });
  /**
   * A NAMESPACE FOR THE ROW IDS, because `aria-activedescendant` points at one by id and two pickers
   * on one screen would otherwise both claim `row-0`.
   */
  const rowId = useId();
  const host = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const chosen = value !== UNCATEGORIZED ? value : null;
  const rows = useMemo(() => categoryRows(query), [query]);

  /**
   * WHICH WAY IT OPENS, AND HOW TALL — and this is a bug that was found by looking rather than by
   * reasoning. The trigger is the LAST field in the dialog, so on a 742px window its popover opened
   * downward straight through the footer and off the bottom of the screen: Cancel and Create were
   * covered, and everything below Business was unreachable. `overflow` had nothing to do with it —
   * the window is the clip — which is why `useAnchoredMenu` (a portal, for a panel inside a
   * scroller) is not the fix here. This is.
   *
   * IT IS NOT "ALWAYS UP" EITHER, which is the shortcut this field's position makes tempting. The
   * dialog is centred, so a taller viewport puts the trigger above the middle and downward is right
   * again; a rule about where this one field happens to sit is a rule that stops being true.
   *
   * A LAYOUT EFFECT, for `useAnchoredMenu`'s reason: it runs before paint, so the popover is never
   * seen at the wrong size or on the wrong side of the field for a frame.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const fit = (): void => {
      const t = host.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      // Downward unless downward is genuinely cramped. `POPOVER_MIN` is what "cramped" means; a
      // popover taller than the window fits nowhere anyway, and flipping one up for the sake of a
      // few more rows moves the clipped edge from the bottom — where the scrollbar is — to the top,
      // where the search field is.
      const up = below < POPOVER_MIN && above > below;
      setBox({ above: up, max: Math.max(Math.min(POPOVER_MAX, up ? above : below), 0) });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);

  // THE CURSOR FOLLOWS THE LIST. Filtering to three rows with the cursor on the tenth would leave
  // Enter choosing nothing, which is the one way a keyboard-driven list goes quietly wrong.
  useEffect(() => { setCursor(0); }, [query]);

  /**
   * AND THE LIST FOLLOWS THE CURSOR — found by holding Down, which is the only way to find it.
   * Forty rows in a 190px window means thirty-four of them are out of sight, and arrowing past the
   * fifth left the highlight somewhere below the fold: the popover looked as though the keys had
   * stopped working, and Enter then chose a row nobody had seen. Arrow keys are the half of this
   * control that is not optional (`Select`'s own argument), and a cursor you cannot see is not a
   * cursor.
   *
   * `block: "nearest"` AND `behavior: "auto"`, the idiom `BuildPane`'s step keyboard already uses:
   * nearest moves the list by the least it can rather than recentring on every keypress, and a
   * smooth scroll cannot keep up with a held key — it animates towards a row the cursor has
   * already left.
   */
  useEffect(() => {
    if (!open) return;
    list.current?.querySelectorAll<HTMLElement>('[role="option"]')[cursor]
      ?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [open, cursor, rows]);

  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    const away = (e: MouseEvent): void => {
      if (!host.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const choose = (row: CategoryRow): void => {
    onChange(row.value);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={host} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        // THE TRIGGER READS AS A FIELD, not as a button, because it is one of two answers on a form
        // and the other is a textarea. Same rung, same border, same ground as that one.
        className="flex w-full items-center gap-2 rounded-input border border-edge bg-elevated px-3 py-2 text-left text-caption transition-colors duration-fast hover:border-chrome focus-visible:outline-none focus-visible:shadow-focusring"
      >
        <span className={`min-w-0 flex-1 truncate ${chosen ? "text-ink" : "text-faint"}`}>
          {chosen ?? "Choose a category…"}
        </span>
        {/* THE ONE MARK ON THIS CONTROL. A chevron is what says "this opens"; anything else here
            would be decoration on a form that is deliberately two questions long. */}
        <span className="shrink-0 text-faint" aria-hidden>
          <ChevronDownIcon size={ICON.xs} />
        </span>
      </button>

      {open && (
        <div
          // AT THE MENU LAYER, capped to the room measured above, and a column so the list is the
          // part that gives: the search field and Clear stay whole at any height, which is the
          // whole argument for capping the popover rather than the list inside it.
          //
          // INSIDE THE DIALOG RATHER THAN PORTALLED. `useDialog` pulls focus back whenever it lands
          // outside the panel, and it exempts only another `[role="dialog"]` — so a popover
          // portalled into the body would have its search field emptied of focus the instant it
          // got it. Nothing clips this one but the window, and `max` is the answer to that.
          style={{ zIndex: LAYER.menu, maxHeight: box.max }}
          className={`absolute left-0 right-0 flex flex-col overflow-hidden rounded-card border border-edge bg-elevated shadow-floating ${
            box.above ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          <div className="shrink-0 border-b border-hair p-1.5">
            <input
              ref={field}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
                if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, rows.length - 1)); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); return; }
                if (e.key === "Enter") {
                  e.preventDefault();
                  const row = rows[cursor];
                  if (row) choose(row);
                }
              }}
              placeholder="Search, or type your own…"
              aria-label="Search categories, or type your own"
              // A COMBOBOX, WHICH IS WHAT IT HAS BEEN BEHAVING AS. Focus stays in this field while
              // the arrow keys move a highlight down the list, so without `aria-activedescendant`
              // there is nothing for a screen reader to announce: the cursor was visible and
              // silent, which is the same defect as the one that made it invisible (see the scroll
              // effect above) arriving through the other sense.
              role="combobox"
              aria-expanded
              aria-controls={`${rowId}-list`}
              aria-autocomplete="list"
              aria-activedescendant={rows[cursor] ? `${rowId}-${cursor}` : undefined}
              className="w-full rounded-input bg-transparent px-2 py-1 text-caption text-ink outline-none placeholder:text-faint"
            />
          </div>

          {/* THE PART THAT SCROLLS. `min-h-0` because a flex child will not shrink below its
              content otherwise, and a list that refuses to shrink is how the cap gets ignored. */}
          <div ref={list} id={`${rowId}-list`} role="listbox" aria-label="Category" className="min-h-0 flex-1 overflow-y-auto p-1">
            {rows.length === 0 && (
              // ONLY REACHABLE ON WHITESPACE. A query with characters in it always produces either
              // a match or the offer, so this is the empty field's own state, not a dead end.
              <div className="px-2 py-3 text-center text-caption text-faint">Type to search</div>
            )}
            {rows.map((row, i) => {
              const prev = rows[i - 1];
              // A HEADING WHENEVER THE GROUP CHANGES, derived as the rows are drawn. Filtering
              // therefore cannot leave a heading with nothing under it — the one failure the old
              // chip layout could not have, because it never filtered.
              const heading = row.kind === "preset"
                && (i === 0 || (prev?.kind === "preset" && prev.group !== row.group))
                ? row.group
                : null;
              return (
                <div key={`${row.kind}:${row.value}`}>
                  {heading && <div className={`${TYPE.panelLabel} px-2 pb-0.5 pt-2`}>{heading}</div>}
                  <button
                    type="button"
                    role="option"
                    id={`${rowId}-${i}`}
                    aria-selected={row.value === chosen}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => choose(row)}
                    className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-caption transition-colors duration-fast ${
                      i === cursor ? "bg-active text-ink" : "text-muted hover:text-ink"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {row.kind === "custom" ? <>Use “{row.value}”</> : row.value}
                    </span>
                    {/* THE TICK IS THE CURRENT ANSWER, and the slot is held whether or not it is in
                        it — a row that changed width on selection would shift the list under the
                        pointer. */}
                    <span className="inline-flex w-3 shrink-0 justify-center text-faint" aria-hidden>
                      {row.value === chosen && <CheckIcon size={ICON.badge} />}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>

          {chosen && (
            // THE WAY BACK TO NOTHING. "No category" is a real answer, and the footer says so;
            // without this the only way to un-choose one was to cancel the whole dialog.
            <button
              type="button"
              onClick={() => { onChange(UNCATEGORIZED); setOpen(false); setQuery(""); }}
              className="w-full shrink-0 border-t border-hair px-3 py-2 text-left text-caption text-faint transition-colors duration-fast hover:text-ink"
            >
              Clear category
            </button>
          )}
        </div>
      )}
    </div>
  );
}
