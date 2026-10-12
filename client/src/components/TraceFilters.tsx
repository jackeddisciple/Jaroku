// The timeline's filter and search: which kind of step to show, and words to find one by.
//
// THE KINDS ARE THE SCHEMA'S FOUR AND NOTHING INVENTED — model calls, tool calls, state updates,
// routing — plus Errors, which is not a kind but the question people open a trace with. Each says
// how many steps it would show, and a kind this run has none of stays in place, greyed, so the row
// never reflows while a live run streams in.
//
// A FAILURE IS NEVER FILTERED INTO SILENCE. The Errors count is red whenever there is one, whatever is
// selected, so a trace narrowed to model calls still says that something else went wrong.
//
// SEARCH READS THE REAL STEPS — name, id, #seq, kind, error and the first few thousand characters of
// input and output (`searchText`) — and a match keeps the node it ran inside on screen as context.

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { filterCounts, type StepFilter } from "../lib/traceView.ts";
import { Icon } from "../lib/icons/registry.ts";
import { ICON } from "../lib/tokens.ts";
import { useTraceStore } from "../store/traceStore.ts";
import type { Step } from "../types.ts";
import { SearchIcon } from "./panelIcons.tsx";
import { Segmented, type SegmentOption } from "./Segmented.tsx";

const KINDS: { value: StepFilter; text: string; noun: string }[] = [
  { value: "all", text: "All", noun: "every step" },
  { value: "llm", text: "LLM", noun: "model calls" },
  { value: "tool", text: "Tools", noun: "tool calls" },
  { value: "state", text: "State", noun: "state updates" },
  { value: "route", text: "Routing", noun: "routing decisions" },
  { value: "errors", text: "Errors", noun: "failed steps" },
];

/** Below this width the counts give way, all but the red one — the words are what fit first. */
const COUNTS_FROM = 460;

export function TraceFilters({ steps }: { steps: readonly Step[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [roomy, setRoomy] = useState(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setRoomy(el.clientWidth >= COUNTS_FROM);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const filter = useTraceStore((s) => s.stepFilter);
  const query = useTraceStore((s) => s.stepQuery);
  const setFilter = useTraceStore((s) => s.setStepFilter);
  const setQuery = useTraceStore((s) => s.setStepQuery);
  const counts = useMemo(() => filterCounts(steps), [steps]);

  const options: SegmentOption<StepFilter>[] = KINDS.map((k) => ({
    value: k.value,
    text: k.text,
    count: roomy || (k.value === "errors" && counts.errors > 0) ? counts[k.value] : undefined,
    countTone: k.value === "errors" ? "danger" : undefined,
    // Never disable the one that is chosen: it must stay pressable to read as chosen.
    disabled: counts[k.value] === 0 && k.value !== filter,
    label: counts[k.value] === 0 ? `Show ${k.noun} — this run has none` : `Show ${k.noun}`,
  }));

  return (
    // STICKY, so the controls stay in reach however far down the timeline somebody has scrolled.
    <div ref={ref} className="sticky top-0 z-10 -mx-1 mb-1 flex flex-wrap items-center gap-2 bg-bg px-1 py-2">
      {/* At the pane's very narrowest the words alone do not fit; the strip scrolls in its own box
          rather than pushing the panel wide. */}
      <div className="max-w-full overflow-x-auto">
        <Segmented options={options} value={filter} onChange={setFilter} ariaLabel="Show steps of kind" />
      </div>
      <div className="flex h-8 min-w-[9rem] flex-1 items-center gap-2 rounded-control border border-hair bg-panel px-2 focus-within:border-edge">
        <span className="shrink-0 text-faint" aria-hidden><SearchIcon size={ICON.xs} /></span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // The input's keys are its own: Escape clears the search rather than closing the drawer.
            e.stopPropagation();
            if (e.key === "Escape") setQuery("");
          }}
          placeholder="Search steps…"
          aria-label="Search steps by name, id, error or payload"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          className="min-w-0 flex-1 bg-transparent text-caption text-ink outline-none placeholder:text-faint"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            title="Clear the search"
            aria-label="Clear the search"
            className="shrink-0 rounded-xs text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
          >
            <Icon.global.clearSearch size={ICON.xs} />
          </button>
        )}
      </div>
    </div>
  );
}
