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
//
// SEARCH IS A MARK UNTIL IT IS WANTED — the product owner's call on 2026-10-12: no box sitting empty
// under the filters. The mark opens into the field in the same row; Escape, or leaving it empty,
// folds it back. A search that is on stays open, so the words narrowing the list are always in view.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { filterCounts, type StepFilter } from "../lib/traceView.ts";
import { Icon } from "../lib/icons/registry.ts";
import { ICON } from "../lib/tokens.ts";
import { useTraceStore, visibleTraceRows } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { insideKeyOwner, paneOwnsBareKey } from "../lib/bareKeys.ts";
import { keyHint } from "../lib/modKey.ts";
import type { Step } from "../types.ts";
import { IconButton } from "./IconButton.tsx";
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

  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const showField = open || query !== "";
  // Emptied from outside — "Clear filters", another run — while nobody is typing in it: fold it.
  useEffect(() => {
    if (query === "" && document.activeElement !== input.current) setOpen(false);
  }, [query]);
  const fold = (refocus: boolean): void => {
    setQuery("");
    setOpen(false);
    // Back to the mark, so the keyboard is where it was before the field opened.
    if (refocus) requestAnimationFrame(() => mark.current?.querySelector("button")?.focus());
  };

  // ⌘F AND `/` OPEN IT, FROM ANYWHERE ON THE THREE-PANE VIEW while the steps are on screen — the two
  // keys a list's search answers to elsewhere. `/` only when it is not being typed (the composer, a
  // field), and neither while a full-screen view or the palette owns the keys, or inside a region that
  // owns its own (the graph canvas has its own ⌘F, and is not on screen with this).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const ui = useUiStore.getState();
      if (ui.navView !== null || ui.paletteOpen || insideKeyOwner(e.target)) return;
      const find = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f";
      const slash = e.key === "/" && paneOwnsBareKey(e, { navView: ui.navView, paletteOpen: ui.paletteOpen });
      if (!find && !slash) return;
      e.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Enter or ↓ in the field goes to the first step that matched — not a row kept only as context —
   * selected and focused, so the arrows carry on through the results from there.
   */
  const toFirstMatch = (): void => {
    const first = visibleTraceRows(useTraceStore.getState()).find((r) => !r.context);
    if (!first) return;
    useTraceStore.getState().selectStep(first.step.id);
    useUiStore.getState().setSelectedNodeId(null);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[role="treeitem"][data-step-id="${first.step.id}"]`)?.focus());
  };

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
    // Sticky with the column names under it — StepList holds the two in one box.
    <div ref={ref} className="flex flex-wrap items-center gap-2 py-2">
      {/* At the pane's very narrowest the words alone do not fit; the strip scrolls in its own box
          rather than pushing the panel wide. */}
      <div className="max-w-full overflow-x-auto">
        <Segmented options={options} value={filter} onChange={setFilter} ariaLabel="Show steps of kind" />
      </div>
      {showField ? (
        <div className="flex h-8 min-w-[9rem] flex-1 items-center gap-2 rounded-control border border-hair bg-panel px-2 focus-within:border-edge">
          <span className="shrink-0 text-faint" aria-hidden><Icon.trace.search size={ICON.xs} /></span>
          <input
            ref={input}
            // Opened by a press on the mark, so the words go straight in.
            autoFocus={open}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // Leaving it empty folds it. With words in it, it stays: the search is still on.
            onBlur={() => {
              if (query === "") setOpen(false);
            }}
            onKeyDown={(e) => {
              // The input's keys are its own: Escape clears the search rather than closing the drawer.
              e.stopPropagation();
              if (e.key === "Escape") fold(true);
              else if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                toFirstMatch();
              }
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
              onClick={() => {
                setQuery("");
                input.current?.focus();
              }}
              title="Clear the search"
              aria-label="Clear the search"
              className="shrink-0 rounded-xs text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
            >
              <Icon.global.clearSearch size={ICON.xs} />
            </button>
          )}
        </div>
      ) : (
        <span ref={mark} className="ml-auto shrink-0">
          <IconButton icon={Icon.trace.search} label={`Search steps (${keyHint("⌘F")} or /)`} onClick={() => setOpen(true)} />
        </span>
      )}
    </div>
  );
}
