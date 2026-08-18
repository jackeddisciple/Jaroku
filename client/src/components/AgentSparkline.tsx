// §5.5's clickable health sparkline: the last ~20 run outcomes, each one a door into its trace.
//
// EVERY BAR IS A BUTTON, which is the whole feature and the reason this is not a `<canvas>` or a
// path. "The last ~20 run outcomes on the card are individually clickable: a click opens that run's
// trace directly. A failed bar opens on the failing step." A drawn line cannot be tabbed to, cannot
// carry a tooltip per segment, and cannot be reached by a screen reader — and this is a control, not
// a decoration.
//
// THE MAPPING FROM A STEP TO ITS TRACE IS REUSED, NOT REWRITTEN. §5.5 is explicit: "The mapping from
// step to trace already exists and was built deliberately rather than by name matching — reuse it, do
// not write a second one." So a failed bar carries the step id the SERVER resolved (the first failing
// step of that run, from `steps.error`), and opening it is `selectRun` followed by `selectStep` —
// the two calls the trace panel already answers to. Nothing here matches a name against anything.
//
// ELEVEN PIXELS OF BAR AND TWO OF GAP. The row has to read as one shape at a glance and still give
// each bar a target somebody can hit; below about three pixels of width a bar stops being clickable
// in any honest sense, so the strip shrinks by dropping OLD bars rather than by making all of them
// thinner — which is also the right thing to drop, because the newest outcomes are the ones being
// asked about.

import { STATUS, TEXT } from "../lib/tokens.ts";
import { selectRun } from "../lib/selection.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { relTime } from "../lib/format.ts";
import type { AgentRunBar } from "../types.ts";

/** What each outcome looks like. Borrowed from STATUS, so nothing here invents a meaning. */
const BAR_COLOR: Record<AgentRunBar["outcome"], string> = {
  ok: STATUS.ok,
  error: STATUS.error,
  // AMBER, AND THIS IS THE ONE PLACE IT IS CORRECT ON THIS CARD: a run in flight is runtime activity,
  // which is precisely what amber means. Nothing else in the sparkline may use it.
  running: STATUS.pending,
  // Halted and waiting on a person. Not amber — nothing is happening — and not the error red, because
  // nothing has gone wrong.
  paused: TEXT.muted,
};

const LABEL: Record<AgentRunBar["outcome"], string> = {
  ok: "finished",
  error: "failed",
  running: "running",
  paused: "paused, waiting on you",
};

/**
 * Open a run's trace, on its failing step when it has one.
 *
 * `selectRun` IS WHAT KEEPS THE HEADER HONEST — it follows the run to the agent that made it and
 * closes the full-screen view, which is `lib/selection.ts`'s one invariant and the reason that module
 * exists. Reaching into `traceStore` directly here would produce the chimera it was written to
 * prevent: this agent's name above another agent's trace.
 */
function openRun(bar: AgentRunBar): void {
  selectRun(bar.run_id, { fromNav: true });
  useUiStore.getState().setRightTab("trace");
  if (bar.failed_step_id) {
    const trace = useTraceStore.getState();
    trace.selectStep(bar.failed_step_id);
    // Expanded as well as selected: somebody clicking a red bar is asking what went wrong, and the
    // payload is where the answer is. A selected-but-collapsed step would be one more click for the
    // thing they came for.
    trace.setExpandedStep(bar.failed_step_id);
  }
}

export function AgentSparkline({
  outcomes,
  /** How many bars fit. The strip drops the OLDEST when there is not room for all of them. */
  max = 20,
  height = 14,
  className = "",
}: {
  outcomes: readonly AgentRunBar[];
  max?: number;
  height?: number;
  className?: string;
}) {
  // Oldest first is how the server sends it and how a sparkline is read, so the slice comes off the
  // FRONT — dropping history rather than the runs somebody is asking about.
  const bars = outcomes.slice(Math.max(0, outcomes.length - max));

  // NOTHING TO SHOW IS NOT AN EMPTY BOX. A row of grey placeholder bars would claim twenty runs that
  // never happened; the line simply is not there, and the card's "Not started yet" says the rest.
  if (bars.length === 0) return null;

  return (
    <div
      className={`flex items-end gap-[2px] ${className}`}
      style={{ height }}
      role="group"
      aria-label={`The last ${bars.length} runs`}
    >
      {bars.map((bar) => (
        <button
          key={bar.run_id}
          type="button"
          onClick={(e) => {
            // The card behind this opens the AGENT; a bar opens a RUN. Two destinations one pixel
            // apart, which is exactly why the bar has to stop the click rather than let it through.
            e.stopPropagation();
            openRun(bar);
          }}
          title={`${LABEL[bar.outcome]} · ${relTime(bar.started_at)}${bar.failed_step_id ? " — opens on the failing step" : ""}`}
          aria-label={`Run ${LABEL[bar.outcome]} ${relTime(bar.started_at)}`}
          className="group/bar h-full w-[3px] shrink-0 rounded-[1px] transition-[opacity,transform] duration-fast hover:scale-y-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#3a3a44] motion-reduce:hover:scale-y-100"
          style={{
            background: BAR_COLOR[bar.outcome],
            // A settled bar sits back; the pointer brings it forward. Opacity rather than a second
            // colour, because the colours already mean four different things and a fifth shade of
            // green would be a fifth meaning.
            opacity: bar.outcome === "running" ? 1 : 0.72,
          }}
        />
      ))}
    </div>
  );
}
