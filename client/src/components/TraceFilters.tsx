// The timeline's filter and search: which kind of step to show, and words to find one by.
//
// THE KINDS ARE THE SCHEMA'S FOUR AND NOTHING INVENTED — model calls, tool calls, state updates,
// routing — plus Errors, which is not a kind but the question people open a trace with. Each says
// how many steps it would show — always, as the tab's own number beside its word (the product owner's
// call, 2026-10-14: numbers, not coloured dots) — and a kind this run has none of stays in place,
// greyed, so the row never reflows while a live run streams in.
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

import { useEffect, useMemo, useRef, useState } from "react";

import { filterCounts, type StepFilter } from "../lib/traceView.ts";
import { Icon } from "../lib/icons/registry.ts";
import { ICON } from "../lib/tokens.ts";
import { useTraceStore, visibleTraceRows, type StepView } from "../store/traceStore.ts";
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


/**
 * LIST OR GRAPH (2026-10-14), beside the search: the steps as a list, or the agent's graph with this
 * run on it. A third view, Waterfall — each step's time drawn behind its row — came out the same day:
 * the product owner had no use for it, and the timeline column already draws the same thing.
 */
export function ViewSwitcher() {
  const view = useTraceStore((s) => s.stepView);
  const setView = useTraceStore((s) => s.setStepView);
  const options: SegmentOption<StepView>[] = [
    { value: "list", label: "List", icon: Icon.trace.viewList },
    { value: "graph", label: "Graph — the agent's nodes with this run on them", icon: Icon.trace.viewGraph },
  ];
  return <Segmented options={options} value={view} onChange={setView} ariaLabel="Show the steps as" />;
}

export function TraceFilters({ steps }: { steps: readonly Step[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const filter = useTraceStore((s) => s.stepFilter);
  const query = useTraceStore((s) => s.stepQuery);
  const setFilter = useTraceStore((s) => s.setStepFilter);
  const setQuery = useTraceStore((s) => s.setStepQuery);
  const counts = useMemo(() => filterCounts(steps), [steps]);
  // The nodes that fold — steps something ran inside — and whether any of them is open now.
  const folds = useMemo(() => {
    const ids = new Set(steps.map((st) => st.id));
    return [...new Set(steps.map((st) => st.parent_step_id).filter((p): p is string => p != null && ids.has(p)))];
  }, [steps]);
  const foldable = folds.length > 0;
  const collapsedIds = useTraceStore((s) => s.collapsedStepIds);
  const anyOpen = folds.some((id) => !collapsedIds[id]);
  const narrowed = filter !== "all" || query.trim() !== "";

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
      // NOT UNDER SOMETHING ON TOP: the code overlay or a modal covers the trace, and focus sent to a
      // field behind it is focus somebody cannot see.
      if (ui.codeOverlayOpen || document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) return;
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
    // HOW MANY, ALWAYS — the count is how a tab says what it holds. Errors' turns red, word and number,
    // the moment there is one (2026-10-14).
    count: counts[k.value],
    countTone: k.value === "errors" ? "danger" : undefined,
    alert: k.value === "errors" && counts.errors > 0,
    // Never disable the one that is chosen: it must stay pressable to read as chosen.
    disabled: counts[k.value] === 0 && k.value !== filter,
    // E jumps between failures from anywhere; the Errors tab is where the key is learnt, failures or not.
    label: (counts[k.value] === 0 ? `Show ${k.noun} — this run has none` : `Show ${k.noun}`)
      + (k.value === "errors" ? " · E jumps to the next failed step" : ""),
  }));

  return (
    // Sticky with the column names under it — StepList holds the two in one box.
    <div ref={ref} className="relative flex flex-wrap items-center gap-2 py-2">
      {/* At the pane's very narrowest the words alone do not fit; the strip scrolls in its own box
          rather than pushing the panel wide. */}
      <div className="max-w-full overflow-x-auto">
        <Segmented options={options} value={filter} onChange={setFilter} ariaLabel="Show steps of kind" round />
      </div>
      {/* THE TOOLS, AS ONE GROUP AT THE ROW'S END — fold, view, search — so on a narrow panel they move to
          the next line together rather than one at a time. */}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {/* FOLD OR UNFOLD EVERY NODE AT ONCE (2026-10-14), one mark that says which it will do: Collapse
            all while any node is open, Expand all once none is. Off while a filter or a search is on:
            those set folding aside. */}
        <IconButton
          icon={anyOpen ? Icon.trace.collapseAll : Icon.trace.expandAll}
          label={anyOpen ? "Collapse all" : "Expand all"}
          disabledReason={!foldable ? "Nothing here folds" : narrowed ? "Folding is set aside while a filter or search is on" : null}
          onClick={() => useTraceStore.getState().setAllCollapsed(anyOpen)}
        />
        <ViewSwitcher />
        {!showField && (
          <span ref={mark} className="shrink-0">
            <IconButton icon={Icon.trace.search} label={`Search steps (${keyHint("⌘F")} or /)`} onClick={() => setOpen(true)} />
          </span>
        )}
      </span>
      {showField && (
        // Open, the search takes a line of its own under the filters and the tools.
        <div className="flex h-8 min-w-[9rem] basis-full items-center gap-2 rounded-control border border-hair bg-panel px-2 focus-within:border-edge">
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
              // A 24px target around the 12px mark — it was the mark alone, twelve pixels to hit.
              className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-faint transition-colors hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
            >
              <Icon.global.clearSearch size={ICON.xs} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
