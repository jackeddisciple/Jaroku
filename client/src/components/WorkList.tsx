// §9's work list: one list across every agent, because the operator asks "what is happening".
//
// SIX STATUSES, SIX DISTINCT MARKS — §10, and the file it points at records why: `StatusGlyph` in
// the sidebar exists because `paused` once fell through to the completed tick, so a run halted
// mid-graph wore the same green as one that finished. The same mistake is available here twice
// over: `cancelled` reading as `failed`, and `waiting` reading as `running`. Both are amber-shaped
// in a reader's head and neither is amber.
//
// AMBER MEANS RUNNING. ONLY RUNNING. Not `queued`, not `waiting`, not a warning — §10 states it and
// v0.2.2's wordmark pass established it. A queued job is not yet doing anything and a waiting one
// has STOPPED, so painting either of them the in-flight colour would make the one colour in this
// palette that carries motion mean three things.
//
// ROSE IS SCARCE. In the Inbox it appears exactly once, on the left edge of a blocking card, and
// §10 asks that failed rows not be painted red. A failure here is a glyph and a sentence; the row
// stays on the ink ladder like every other row, because a list where a fifth of the rows are red is
// a list nobody can scan.
//
// TEXT FADES VIA `Truncate`, NEVER A HARD CUT — §10 again. An input is a real customer email and an
// output is what the agent did about it; both are longer than a row, and the ellipsis is what says
// so rather than a string that simply stops.

import { useEffect, useRef } from "react";

import { fmtCost, fmtDuration } from "../lib/format.ts";
import { sendCancelWork, sendListWork, sendLoadWorkItem, sendRetryWork } from "../lib/socket.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { useWorkStore } from "../store/workStore.ts";
import { WORK_STATUS_ORDER } from "../store/workStore.ts";
import type { WorkItemView, WorkStatus } from "../types.ts";
import { Capable } from "./Capable.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { StatusDot } from "./StatusBadge.tsx";
import { Truncate } from "./Truncate.tsx";
import {
  CheckIcon, ClockIcon, LoaderIcon, MinusIcon, PauseIcon, XIcon,
} from "./panelIcons.tsx";

/**
 * §10's six marks, exhaustive by type so a seventh status is a compile error rather than a blank.
 *
 * THE TWO THAT ARE EASY TO GET WRONG, and each is a decision:
 *
 *   `waiting` IS A PAUSE, NOT A SPINNER. The graph has STOPPED — a person has to answer something —
 *   and a turning arc would say the opposite of what is true. It is the only mark here that is ink
 *   rather than a status colour, because it is the only state where the reader is the blocker.
 *
 *   `cancelled` IS A DASH, NOT A CROSS. Nothing failed; somebody pressed stop. A cross would file
 *   an ordinary operational decision under "something went wrong", which is the same conflation
 *   `stopped_reporting` exists to avoid one field over.
 */
function WorkGlyph({ status }: { status: WorkStatus }) {
  switch (status) {
    case "queued":
      // NOT AMBER. It is not doing anything yet, and amber means running.
      return <StatusDot state="neutral" icon={ClockIcon} size={ICON.xs} title="queued" />;
    case "running":
      return <StatusDot state="pending" icon={LoaderIcon} spin size={ICON.xs} title="running" />;
    case "waiting":
      return <StatusDot state="warn" icon={PauseIcon} size={ICON.xs} title="waiting for you to answer something" />;
    case "succeeded":
      return <StatusDot state="ok" icon={CheckIcon} size={ICON.xs} title="succeeded" />;
    case "failed":
      return <StatusDot state="error" icon={XIcon} size={ICON.xs} title="failed" />;
    case "cancelled":
      return <StatusDot state="neutral" icon={MinusIcon} size={ICON.xs} title="cancelled" />;
  }
}

/**
 * What a failure kind means, in the operator's words rather than in the column's.
 *
 * `stopped_reporting` IS THE ONE THAT MATTERS MOST — §11.3 in as many words: the container went
 * quiet, it MAY have completed, and it MAY have spent money. Every other kind is a fact somebody
 * observed; this is the absence of one, and rendering it as "failed" would be a confident claim
 * about somebody's bill.
 *
 * `rejected` IS WORDED AS JAROKU'S BUG because it is one. Telling somebody their agent refused
 * something when Jaroku sent it something malformed points them at the wrong product.
 */
const FAILURE_SENTENCE: Record<string, string> = {
  unauthorised: "the agent refused Jaroku's credential — reconnect it",
  agent_error: "the agent raised — the trace has the failing step",
  rejected: "Jaroku sent this agent something it refused. That is a bug in Jaroku",
  unreachable: "the agent could not be reached",
  stopped_reporting:
    "the container stopped reporting. It may have completed, and it may have spent money — " +
    "whatever steps are on the trace really happened",
  busy: "the agent was already running as many jobs as it allows",
};

function Row({ item }: { item: WorkItemView }) {
  const openId = useWorkStore((s) => s.open?.id ?? s.openingId);
  const active = openId === item.id;
  const live = item.status === "queued" || item.status === "running" || item.status === "waiting";

  return (
    <li>
      <div
        className={`group flex items-center gap-3 border-b border-hair px-2 py-2 transition-colors duration-fast ${
          active ? "bg-active/50" : "hover:bg-active/30"
        }`}
      >
        {/* THE ROW IS THE TARGET, and the controls sit outside it rather than inside — a button
            nested in a button is a hit area that swallows the row's own click, which is the bug
            the Inbox's `view_evidence` control had. */}
        <button
          type="button"
          onClick={() => sendLoadWorkItem(item.id)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <WorkGlyph status={item.status} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Truncate className={`min-w-0 ${TYPE.body}`} title={item.input_preview}>
              {item.input_preview}
            </Truncate>
            <div className="flex min-w-0 items-baseline gap-1.5 text-tiny text-muted">
              <span className="shrink-0">{item.agent_name ?? "an agent that has been deleted"}</span>
              {/* WHO ASKED. §4's whole reason for a NOT NULL actor — the question the tab exists to
                  answer — and it is rendered on every row rather than on hover, because a list
                  where attribution is a hover state is a list nobody scans for attribution. */}
              <span className="text-faint">·</span>
              <span className="shrink-0">{item.created_by_name ?? "somebody who has left"}</span>
              {item.failure_kind && (
                <>
                  <span className="text-faint">·</span>
                  <Truncate className="min-w-0" title={FAILURE_SENTENCE[item.failure_kind] ?? item.failure_kind}>
                    {FAILURE_SENTENCE[item.failure_kind] ?? item.failure_kind}
                  </Truncate>
                </>
              )}
            </div>
          </div>

          {/* THE FIGURES, RIGHT-ALIGNED AND TABULAR, so a column of them reads as a column.
              `fmtCost` is the one place the null-versus-zero rule is spelled: `—` is unknown and
              `$0.00` is free, and they are different claims. */}
          <div className="hidden shrink-0 items-baseline gap-3 text-tiny tabular-nums text-muted sm:flex">
            {item.duration_ms !== null && <span>{fmtDuration(item.duration_ms)}</span>}
            <span className="w-[7ch] text-right">
              {fmtCost(item.cost_usd)}
              {/* A FLOOR SAYS SO — §11.1. Some call could not be priced, so the total is an
                  undercount, and a confidently wrong number is what the rule exists to prevent. */}
              {!item.cost_complete && <span className="text-faint">+</span>}
            </span>
          </div>
        </button>

        {/* THE TWO VERBS, GATED BY WHAT THEY ARE RATHER THAN BY WHAT THEY LOOK LIKE. `Capable`
            renders nothing at all for a role that cannot use them — §8's rule is ABSENT rather than
            disabled or hidden, because a disabled control invites somebody to work out what would
            enable it and a hidden one is a devtools panel away from being clicked. */}
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-fast focus-within:opacity-100 group-hover:opacity-100">
          {live ? (
            <Capable cmd="cancelWork">
              <button
                type="button"
                onClick={() => sendCancelWork(item.id)}
                className="rounded-control px-2 py-0.5 text-tiny text-muted transition-colors duration-fast hover:bg-active hover:text-ink"
                // A CANCEL IS A REQUEST READ AT A NODE BOUNDARY, and the title says so rather than
                // promising a stop the graph has not made yet.
                title="Ask the agent to stop at its next node boundary"
              >
                Cancel
              </button>
            </Capable>
          ) : (
            <Capable cmd="retryWork">
              <button
                type="button"
                onClick={() => sendRetryWork(item.id)}
                className="rounded-control px-2 py-0.5 text-tiny text-muted transition-colors duration-fast hover:bg-active hover:text-ink"
                title="Ask the same thing again, as a new job, on whatever is live now"
              >
                Retry
              </button>
            </Capable>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * §8's filters: a scope toggle and a status rail.
 *
 * "MINE" VS "ALL" IS A FILTER, NOT A PERMISSION — §8 says so and the consequence is that the toggle
 * is ALWAYS PRESENT AND NEVER GATED. Anyone who can see the Cockpit sees the whole workspace's work
 * when they switch, for the reason `billing:read` is a member capability: a member whose job was
 * refused has to see what it was refused behind, and work in a shared workspace is not a secret
 * from the people sharing it.
 *
 * IT DEFAULTS TO "MINE", because the operator's first question is about their own jobs.
 */
function Filters() {
  const filters = useWorkStore((s) => s.filters);
  const counts = useWorkStore((s) => s.counts);
  const setFilters = useWorkStore((s) => s.setFilters);

  const choose = (patch: Parameters<typeof setFilters>[0]): void => {
    setFilters(patch);
    sendListWork();
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-hair px-6 py-2">
      <div className="flex items-center gap-1">
        {(["mine", "all"] as const).map((scope) => (
          <button
            key={scope}
            type="button"
            onClick={() => choose({ scope })}
            className={`rounded-control px-2 py-0.5 text-tiny transition-colors duration-fast ${
              filters.scope === scope ? "bg-active text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {scope === "mine" ? "Mine" : "Everyone's"}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => choose({ status: null })}
          className={`rounded-control px-2 py-0.5 text-tiny transition-colors duration-fast ${
            filters.status === null ? "bg-active text-ink" : "text-muted hover:text-ink"
          }`}
        >
          All
        </button>
        {WORK_STATUS_ORDER.map((status) => (
          // A STATUS WITH NOTHING IN IT IS NOT OFFERED. A rail of six chips reading zero is six
          // controls that lead to an empty list, and the counts are the workspace's — so a chip
          // that is present is a chip with something behind it.
          counts[status] > 0 ? (
            <button
              key={status}
              type="button"
              onClick={() => choose({ status: filters.status === status ? null : status })}
              className={`flex items-center gap-1.5 rounded-control px-2 py-0.5 text-tiny transition-colors duration-fast ${
                filters.status === status ? "bg-active text-ink" : "text-muted hover:text-ink"
              }`}
            >
              <WorkGlyph status={status} />
              <span className="tabular-nums">{counts[status]}</span>
            </button>
          ) : null
        ))}
      </div>

      {/* THE AGENT FILTER IS SET BY THE FLEET CARD AND CLEARED HERE, so somebody who arrived from a
          card — or from an Agent detail's pointer strip — has a way back that does not require
          finding the card again. */}
      {filters.agentId && (
        <button
          type="button"
          onClick={() => choose({ agentId: null })}
          className="ml-auto rounded-control px-2 py-0.5 text-tiny text-muted transition-colors duration-fast hover:text-ink"
        >
          Showing one agent — clear
        </button>
      )}
    </div>
  );
}

export function WorkList() {
  const items = useWorkStore((s) => s.items);
  const nextCursor = useWorkStore((s) => s.nextCursor);
  const filters = useWorkStore((s) => s.filters);
  const scrollRef = useRef<HTMLDivElement>(null);

  // THE LIST SCROLLS BACK TO THE TOP WHEN THE FILTER CHANGES, because a scroll position is a
  // position in a list and the list has been replaced. Left alone, somebody switching from a long
  // "Everyone's" to a short "Mine" lands below the end of the new one and reads it as empty.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [filters.scope, filters.status, filters.agentId]);

  return (
    <>
      <Filters />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-1">
        {items.length === 0 ? (
          <ZeroState />
        ) : (
          <>
            <ul className="flex flex-col">
              {items.map((item) => (
                <Row key={item.id} item={item} />
              ))}
            </ul>
            {/* KEYSET, NOT INFINITE SCROLL. A list whose head moves every few seconds and that also
                loads on scroll is a list that jumps under the reader; an explicit control is the
                one that keeps the position somebody chose. */}
            {nextCursor && (
              <button
                type="button"
                onClick={() => sendListWork({ more: true })}
                className="w-full py-3 text-tiny text-muted transition-colors duration-fast hover:text-ink"
              >
                Show older jobs
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

/**
 * §11.4's second and third zero states. The first — no live agents — is the shell's.
 *
 * "THREE ZERO STATES, THREE SENTENCES", and the distinction the spec draws is between a workspace
 * that has not started and a list that has been narrowed: one is a next step and the other is a
 * filter somebody can undo. Collapsing them would tell an operator with forty jobs that nothing has
 * been asked of their agents, because they had clicked "failed".
 */
function ZeroState() {
  const filters = useWorkStore((s) => s.filters);
  const setFilters = useWorkStore((s) => s.setFilters);
  const filtered = filters.scope === "mine" || filters.status !== null || filters.agentId !== null;

  if (!filtered) {
    return <EmptyState size="line" title="Nothing has been asked of them yet" />;
  }
  return (
    <EmptyState
      size="line"
      title="Nothing here matches the filter"
      hint={
        <button
          type="button"
          onClick={() => {
            setFilters({ scope: "all", status: null, agentId: null });
            sendListWork();
          }}
          className="underline-offset-2 hover:text-ink hover:underline"
        >
          show everything
        </button>
      }
    />
  );
}
