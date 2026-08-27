// §4.4's filter bar: a text field and five chips carrying live counts.
//
// A ZERO-COUNT CHIP IS DIMMED, NEVER REMOVED, and this is the rule that decides the layout. Counts
// move on their own — a run finishes, a diff is applied, somebody else in the workspace archives
// something — and a chip that disappeared at zero would take the four beside it with it, so the chip
// you were about to click would be somewhere else by the time you got there. Fixed positions also make
// the 1–5 shortcuts (§4.7) mean something stable.
//
// THE COUNTS ARE THE SERVER'S, not this component's. §2.1 requires the nav badge and the Needs you
// chip to be the same number, computed once and rendered twice — so both read the snapshot's `counts`,
// and neither counts rows for itself. A chip that filtered a list and then counted what it found would
// be a second answer, and the two would differ for exactly as long as a snapshot was in flight.
//
// AND THEY ARE THE UNFILTERED COUNTS. Typing `webhook` narrows the list; it does not rewrite what "2
// threads need you" means. A chip whose count fell as you typed would make the filter look like it was
// resolving your work.

import { FILTER_LABEL, THREAD_FILTERS, type ThreadFilter } from "../lib/threadFilter.ts";
import { ICON } from "../lib/tokens.ts";
import type { ThreadCounts } from "../types.ts";
import { SearchIcon, XIcon } from "./panelIcons.tsx";

export function ThreadFilterBar({
  filter,
  onFilter,
  query,
  onQuery,
  counts,
  inputRef,
}: {
  filter: ThreadFilter;
  onFilter: (f: ThreadFilter) => void;
  query: string;
  onQuery: (q: string) => void;
  counts: ThreadCounts;
  /** So `/` can focus the field from anywhere in the view (§4.7). */
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="shrink-0 border-b border-hair px-5 py-2">
      <div className="flex items-center gap-2 rounded-control bg-active px-2.5 py-1.5">
        <span className="shrink-0 text-faint"><SearchIcon size={ICON.xs} /></span>
        {/* A PLACEHOLDER IS NOT AN ACCESSIBLE NAME, and it is the one thing that disappears the
            moment somebody starts typing — so a screen-reader user arrived at an unnamed text
            field, and arrived at it again with a value in it and still nothing saying what the
            value was for. The label says what it filters rather than repeating the word: "filter"
            is what the control does, "threads" is what it does it to. */}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="filter…"
          aria-label="Filter threads"
          className="min-w-0 flex-1 bg-transparent text-caption text-ink placeholder:text-faint outline-none focus-visible:shadow-focusring"
        />
        {query && (
          <button
            onClick={() => onQuery("")}
            title="Clear the filter"
            className="shrink-0 text-faint transition-colors hover:text-ink"
          >
            <XIcon size={ICON.xs} />
          </button>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {THREAD_FILTERS.map((id) => {
          const count = counts[id];
          const active = filter === id;
          return (
            <button
              key={id}
              onClick={() => onFilter(id)}
              // COLOUR IS NEVER THE ONLY SIGNAL (§10) — `ShieldControl` states the rule and
              // `ActivityView`'s 24h/7d/30d chips already apply it two surfaces away. Between the
              // active chip and the other four there was exactly one difference, `bg-active
              // text-ink`, so which of five filters was applied was a fact only a sighted user
              // had. These are a pressed group rather than tabs: the panel below is one list being
              // narrowed, not five panels.
              aria-pressed={active}
              // Dimmed at zero rather than disabled: clicking "Archived 0" is a legitimate thing to do
              // — it answers "have I archived anything" — and the empty state that follows says so.
              // A disabled chip would refuse a question it could perfectly well answer.
              className={`rounded-control px-2 py-1 text-tiny transition-colors ${
                active ? "bg-active text-ink" : count === 0 ? "text-faint hover:text-muted" : "text-muted hover:text-ink"
              }`}
            >
              {FILTER_LABEL[id]}
              {/* The count is always in the DOM, even at zero, so a chip never changes width when its
                  number arrives — which is what stops the row reflowing under the cursor. */}
              <span className={`ml-1 tabular-nums ${count === 0 ? "opacity-40" : "text-faint"}`}>{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
