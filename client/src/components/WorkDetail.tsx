// §9's work detail: what was asked, what came back, how long, what it cost, and a link to the trace.
//
// A SLIDE-OVER FROM THE RIGHT, WHICH IS THE ONE THE TRACE STEP DETAIL ALREADY USES — §9 asks for
// that specifically, and it is the same mechanism rather than a similar one: mounted always,
// translated off-screen when closed, so the transition plays in both directions. A panel that
// unmounted would appear instantly and leave slowly, which reads as two different controls.
//
// AND IT DOES NOT BUILD A SECOND TRACE VIEWER — §9 in as many words. The link goes down the
// ORDINARY `loadRun` path, which is the one route into a trace from any surface in this product and
// is also what stamps a failure as reviewed for the Inbox. A panel that rendered steps here would
// be a second timeline, a second step-detail, and a second thing to keep in step with the frozen
// schema — and the Inbox card the failure raised would never resolve, because nothing would have
// been opened.
//
// REACHABLE BY ID ALONE, which is §12's constraint on Part 3 honoured now rather than later: "the
// work detail must be reachable by id alone, because a citation chip opens it without a list in
// between". `sendLoadWorkItem` takes an id and needs no page, so a chip in a future thread can open
// this without the Cockpit ever having been rendered.

import { useEffect } from "react";

import { fmtCost, fmtDuration, fmtTokens } from "../lib/format.ts";
import { selectRun } from "../lib/selection.ts";
import { sendCancelWork, sendLoadRun, sendRetryWork } from "../lib/socket.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useWorkStore } from "../store/workStore.ts";
import { Capable } from "./Capable.tsx";
import { Chip } from "./Chip.tsx";
import { XIcon } from "./panelIcons.tsx";

function Kv({ label, value, tag }: { label: string; value: React.ReactNode; tag?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-caption">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 text-right text-ink tabular-nums">{value}</span>
        {tag}
      </span>
    </div>
  );
}

/**
 * A block of somebody's own text — the input, or what the agent said back.
 *
 * PRE-WRAPPED AND SCROLLED WITHIN ITSELF, because both are arbitrary length and neither is markup:
 * an input is a real customer email and an output is what the agent did about it. Rendering either
 * as flowing prose would collapse the line breaks that make a pasted email readable, and letting it
 * grow would push the figures above it out of a panel somebody is reading them from.
 */
function TextBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex min-h-0 flex-col gap-1">
      <span className={TYPE.sectionLabel}>{label}</span>
      <div className="max-h-[40vh] overflow-auto rounded-control border border-hair bg-canvas px-2.5 py-2">
        {/* `pre` FOR THE LINE BREAKS AND NOT FOR THE FACE. An input is a real customer email and
            an output is what the agent said back — both are prose, and §04's rule is that the
            mono face means "this is literally code". What preserves a pasted email's shape is
            `whitespace-pre-wrap`; setting it in mono as well would make somebody's own words read
            as a log line. `McpConfirmModal` earns mono because what it renders is JSON. */}
        <pre className="whitespace-pre-wrap break-words font-sans text-caption leading-[1.55] text-ink">{text}</pre>
      </div>
    </div>
  );
}

export function WorkDetail() {
  const item = useWorkStore((s) => s.open);
  const openingId = useWorkStore((s) => s.openingId);
  const close = useWorkStore((s) => s.closeItem);
  const needsLoad = useTraceStore((s) => s.needsLoad);
  const setRightTab = useUiStore((s) => s.setRightTab);
  const open = Boolean(item ?? openingId);

  // Escape closes it, like every other overlay in this client.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const live = item && (item.status === "queued" || item.status === "running" || item.status === "waiting");

  /**
   * The trace, down the ordinary path.
   *
   * IT LEAVES THE COCKPIT, and that is deliberate rather than a shortcut: a trace is the three-pane
   * application's own surface, with the timeline, the step detail, the graph and the state diff
   * around it. Opening it inside a slide-over would be the second trace viewer §9 rules out — and
   * `closeNav` is what §2's layout law asks for, "clicking a card restores the 3-pane layout with
   * that entity selected".
   */
  const openTrace = (): void => {
    if (!item?.run_id) return;
    if (needsLoad(item.run_id)) sendLoadRun(item.run_id);
    // `selectRun` RATHER THAN THREE STORE WRITES. It closes the full-screen view, clears the nav
    // section, selects the run AND follows it to the agent that made it — which is the four-step
    // dance every other surface that opens a trace already does, in one place. Writing them out
    // here would be a fifth copy of it, and the one that forgets the agent is the one that leaves
    // the header naming somebody else's work.
    selectRun(item.run_id);
    setRightTab("trace");
  };

  return (
    <div
      className={`absolute top-0 right-0 bottom-0 z-20 flex w-[420px] max-w-[92%] flex-col border-l border-edge bg-elevated shadow-floating transition-transform duration-base ease-state ${
        open ? "translate-x-0" : "pointer-events-none translate-x-full"
      }`}
      aria-hidden={!open}
      role="complementary"
    >
      <div className="flex shrink-0 items-center gap-2 px-4 py-3">
        <span className={TYPE.panelLabel}>Job</span>
        <button
          type="button"
          onClick={close}
          className="ml-auto text-muted transition-colors duration-fast hover:text-ink"
          title="Close (Esc)"
        >
          <XIcon size={ICON.sm} />
        </button>
      </div>

      {!item ? (
        // NOT A SPINNER. The panel opens on the id first, so it is never a blank slide-over, and the
        // line says what is happening rather than turning while nothing does.
        <div className="px-4 py-2 text-caption text-muted">Reading the job…</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-5">
          <div className="flex flex-col">
            <Kv label="Agent" value={item.agent_name ?? "an agent that has been deleted"} />
            <Kv label="Asked by" value={item.created_by_name ?? "somebody who has left"} />
            <Kv label="Status" value={item.status} />
            <Kv label="Started" value={item.started_at ? new Date(item.started_at).toLocaleString() : "—"} />
            {/* UNKNOWN IS NOT ZERO — §11.1. `fmtCost` and `fmtDuration` are where that rule lives, and
                a job still running genuinely has no duration yet rather than a duration of zero. */}
            {/* NULL IS NOT ZERO AND NOT "0ms". A job still running genuinely has no duration yet,
                and a growing number would be reporting one for something that has not got one. */}
            <Kv label="Took" value={item.duration_ms === null ? "—" : fmtDuration(item.duration_ms)} />
            <Kv label="Tokens" value={fmtTokens(item.tokens)} />
            <Kv
              label="Cost"
              value={fmtCost(item.cost_usd)}
              // A FLOOR SAYS SO, IN WORDS RATHER THAN IN A SYMBOL. The row has room for a `+` and
              // this panel has room for the sentence, and this is where somebody comes to find out
              // what the number on the row meant.
              tag={
                !item.cost_complete && (
                  <span className="shrink-0 text-tiny text-muted">at least — part of this run could not be priced</span>
                )
              }
            />
          </div>

          <TextBlock label="What was asked" text={item.input} />

          {/* WHAT CAME BACK, ON A JOB THAT PRODUCED SOMETHING. An empty answer is a real outcome and
              renders as one; a job that has not finished has nothing to show and says nothing. */}
          {item.output !== null && <TextBlock label="What came back" text={item.output || "(the agent produced nothing)"} />}

          {item.error && (
            <div className="flex flex-col gap-1">
              <span className={TYPE.sectionLabel}>What went wrong</span>
              {/* ROSE IS SCARCE — §10. The sentence is ink on the ordinary ladder and the failure is
                  carried by the glyph on the row; a red block here would be the second place in the
                  product that paints a whole region for a failure. */}
              <p className="text-caption leading-[1.55] text-ink">{item.error}</p>
            </div>
          )}

          <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
            {/* THE TRACE, THROUGH `loadRun` AND NOWHERE ELSE. Absent rather than disabled for a job
                that never reached a container: there is no trace, and a control that explained
                itself would be an offer being refused. */}
            {item.run_id && (
              <button
                type="button"
                onClick={openTrace}
                className="rounded-control border border-hair px-2.5 py-1 text-tiny text-ink transition-colors duration-fast hover:bg-active"
              >
                Open the trace
              </button>
            )}
            {live ? (
              <Capable cmd="cancelWork">
                <button
                  type="button"
                  onClick={() => sendCancelWork(item.id)}
                  className="rounded-control border border-hair px-2.5 py-1 text-tiny text-muted transition-colors duration-fast hover:bg-active hover:text-ink"
                  title="Ask the agent to stop at its next node boundary"
                >
                  Cancel
                </button>
              </Capable>
            ) : (
              <Capable cmd="retryWork">
                <button
                  type="button"
                  onClick={() => {
                    sendRetryWork(item.id);
                    // THE PANEL FOLLOWS THE RETRY, because a retry is a NEW job and the person who
                    // pressed it is looking at the old one. `dispatched` opens the new one; asking
                    // for this one again would fight it.
                  }}
                  className="rounded-control border border-hair px-2.5 py-1 text-tiny text-muted transition-colors duration-fast hover:bg-active hover:text-ink"
                  title="Ask the same thing again, as a new job, on whatever is live now"
                >
                  Retry
                </button>
              </Capable>
            )}
            {/* THE ID, COPYABLE AND CITABLE — §12: "work_items.id must be stable and citable, because
                Part 3's answers cite it and the citation is clickable". Rendering it now is what
                makes that a property somebody can rely on rather than a promise. */}
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(item.id)}
              className="ml-auto transition-opacity duration-fast hover:opacity-80"
              title="Copy this job's id"
            >
              {/* THROUGH `Chip`'s `mono` PROP RATHER THAN A LOCAL CLASS, which is where the one decision
                  about that face lives. An id IS an identifier — §12 needs it citable — so mono is
                  right here and wrong four lines up, and routing it through the component that
                  owns the face is what keeps the two apart. */}
              <Chip mono size="sm" tone="faint">{item.id.slice(0, 8)}</Chip>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

