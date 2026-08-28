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

import { useEffect, useMemo, useRef, useState } from "react";

import { DESTRUCTIVE, FAILURE_SENTENCE } from "../lib/cockpitCopy.ts";
import { cockpitCost, cockpitTime } from "../lib/cockpitFormat.ts";
import { groupByDay, rowColumns, type RowColumns } from "../lib/workRow.ts";
import { sendCancelWork, sendListWork, sendLoadWorkItem, sendRetryWork } from "../lib/socket.ts";
import { ROW_HEIGHT, SPINE_X } from "../lib/cockpitLayout.ts";
import { TYPE } from "../lib/tokens.ts";
import { useMcpStore } from "../store/mcpStore.ts";
import { useWorkStore } from "../store/workStore.ts";
import { WORK_STATUS_ORDER } from "../store/workStore.ts";
import type { WorkItemView } from "../types.ts";
import { Capable } from "./Capable.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Truncate } from "./Truncate.tsx";
import { WorkGlyph } from "./WorkGlyph.tsx";

/**
 * §6's row: one line, six slots, vertically centred.
 *
 * ONE LINE AND NOT TWO. It was two — the input above a metadata line carrying the agent, the actor
 * and the failure — and §6 replaces that with a single row whose columns shed under pressure. The
 * difference is what the list is FOR: a two-line row is a compact card, forty of them is the wall
 * §6 opens by ruling out, and a reader scanning for one job among forty is scanning down ONE line
 * of input text rather than down an alternating pattern.
 *
 * THE INPUT TAKES THE REMAINING SPACE, which §6 states and which is the reason the columns beside
 * it are `shrink-0`: "This is the widest element and it takes the remaining space — the user
 * recognises their own job by what they asked for, not by an id."
 *
 * ROW HEIGHT SITS ON THE LADDER — §6: `SPACE.tight` above and below `body`'s line height, which is
 * `py-2` over `text-body`. It is also `ROW_HEIGHT` in `cockpitLayout.ts`, because §18 windows this
 * list and a virtualiser over variable heights needs a measurement cache. So the height is a
 * CONSTRAINT the row is built to rather than a number measured off it — one line, no wrapping,
 * `Truncate` on the only element that can overflow.
 *
 * §Craft 4: THE SECONDARY CONTROLS' WIDTH IS RESERVED AT ALL TIMES. "A row's secondary controls
 * appear on hover or focus, but their width is reserved in the row's layout at all times —
 * appearing is an opacity change, never a reflow. A hover that nudges neighbouring content is the
 * most common way a list stops feeling solid under the cursor." So the slot is a fixed width and
 * only its opacity moves, and it holds that width for a role that cannot use the verb at all.
 */
function Row({ item, columns }: { item: WorkItemView; columns: RowColumns }) {
  const openId = useWorkStore((s) => s.open?.id ?? s.openingId);
  const active = openId === item.id;
  const live = item.status === "queued" || item.status === "running" || item.status === "waiting";
  const cost = cockpitCost(item.cost_usd, item.cost_complete);
  const when = cockpitTime(item.created_at);

  return (
    <li>
      <div
        style={{ height: ROW_HEIGHT }}
        // §6: "Selection is a hairline-strength background at INTERACTION's active rung, and it
        // persists while the detail panel is open so the reader can see where they are in the list."
        className={`group flex items-center gap-3 border-b border-hair transition-colors duration-fast ${
          active ? "bg-active/50" : "hover:bg-active/30"
        }`}
      >
        {/* THE ROW IS THE TARGET, and the controls sit outside it rather than inside — a button
            nested in a button is a hit area that swallows the row's own click, which is the bug
            the Inbox's `view_evidence` control had. */}
        <button
          type="button"
          onClick={() => sendLoadWorkItem(item.id)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:shadow-focusring"
        >
          {/* 1. STATUS GLYPH, fixed width at `ICON.xs`, and on the spine. §13: it never leaves. */}
          <WorkGlyph status={item.status} />

          {/* 2. THE INPUT, one line, `variant="prose"`, at `body`. The widest element. */}
          <Truncate variant="prose" className="min-w-0 flex-1 text-body text-ink" title={item.input_preview}>
            {item.input_preview}
          </Truncate>

          {/* THE FAILURE'S SENTENCE, when there is one, between the input and the columns. It is
              not one of §6's six and it is not a column: it appears on a minority of rows, it is
              prose rather than a figure, and giving it a fixed slot would reserve width on every
              successful row for something almost none of them has. §16: never "failed" alone —
              six kinds exist so six things can be said. */}
          {item.failure_kind && (
            <Truncate className="hidden min-w-0 max-w-[28ch] shrink text-caption text-muted md:block"
              title={FAILURE_SENTENCE[item.failure_kind]}>
              {FAILURE_SENTENCE[item.failure_kind]}
            </Truncate>
          )}

          {/* 3. AGENT NAME. Absent when the list is filtered to one agent, and the second thing to
                 go under width pressure — both decided in `workRow.ts`, not here. */}
          {columns.agent && (
            <span className="shrink-0 text-caption text-muted">
              {item.agent_name ?? "an agent that has been deleted"}
            </span>
          )}

          {/* 4. ACTOR, in the `all` view only, and the first thing to go. §6 puts it at `text-faint`
                 because it is the least of the six: in `mine` it is always the reader. */}
          {columns.actor && (
            <span className="shrink-0 text-caption text-faint">
              {item.created_by_name ?? "somebody who has left"}
            </span>
          )}

          {/* 5. COST, tabular, or an em dash carrying the reason it is one. A FIXED WIDTH, so a
                 column of them is a column: §17's "`tabular-nums` on every figure that can change
                 in place" only aligns if the box does not resize around the digits. */}
          {columns.cost && (
            <span
              className="w-[8ch] shrink-0 text-right text-caption tabular-nums text-muted"
              title={cost.title ?? undefined}
            >
              {cost.text}
              {/* A FLOOR SAYS SO. Some call could not be priced, so the total is an undercount, and
                  a confidently wrong number is what the rule exists to prevent. */}
              {cost.floor && <span className="text-faint">+</span>}
            </span>
          )}

          {/* 6. TIME, relative, right-aligned, and it never leaves. The exact instant is the hover
                 — §17 allows an absolute timestamp only where the reader arrived on purpose. */}
          <span
            className="w-[7ch] shrink-0 text-right text-caption tabular-nums text-muted"
            title={when.title ?? undefined}
          >
            {when.text}
          </span>
        </button>

        {/* §14: A WAITING JOB IS ANSWERED IN THE EXISTING MODAL, UNCHANGED, and the row's job is
            to say WHICH question rather than to ask it again. The modal is mounted at the
            application root and is already on screen for anyone in this workspace.

            THERE IS DELIBERATELY NO "ANSWER" BUTTON HERE. A second control that opened a second
            copy of the dialog would be two places one question can be answered — §15's "no second
            confirmation dialog beside the existing MCP modal" — and it is worse than a duplicated
            surface, because the two would race for one nonce and the loser would report a failure
            for a question that had been answered correctly. */}
        {item.status === "waiting" && <WaitingFor item={item} />}

        {/* THE VERB SLOT, whose WIDTH IS ALWAYS THERE — §Craft 4. See this component's header. */}
        <div className="flex w-[68px] shrink-0 items-center justify-end pr-1 opacity-0 transition-opacity duration-fast focus-within:opacity-100 group-hover:opacity-100">
          {live ? (
            <Capable cmd="cancelWork">
              <button
                type="button"
                onClick={() => sendCancelWork(item.id)}
                className="rounded-control px-2 py-0.5 text-tiny text-muted transition-colors duration-fast hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
                // §21: STOP IS INLINE, A SINGLE PRESS, NO DIALOG — "it is scoped to one item and
                // the item is on screen". The title says what it actually does rather than
                // promising a stop the graph has not made yet.
                title={DESTRUCTIVE.stop.title}
              >
                {DESTRUCTIVE.stop.label}
              </button>
            </Capable>
          ) : (
            <Capable cmd="retryWork">
              <button
                type="button"
                onClick={() => sendRetryWork(item.id)}
                className="rounded-control px-2 py-0.5 text-tiny text-muted transition-colors duration-fast hover:bg-active hover:text-ink focus-visible:outline-none focus-visible:shadow-focusring"
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
 * §6's sticky day heading, in `TYPE.panelLabel`'s recipe.
 *
 * STICKY, WHICH IS THE WHOLE REASON IT IS A HEADING RATHER THAN A SEPARATOR. A reader forty rows
 * into a long day needs to know which day they are in without scrolling back, and `LAYER.sticky` is
 * the rung `tokens.ts` names for exactly this: "a sticky section header, pinned to an edge of its
 * own scroller".
 *
 * `TYPE.panelLabel`'s RECIPE AND NOT ITS OWN. §16: sentence case everywhere "except
 * `TYPE.panelLabel`, which is the caps recipe and the only caps in the app" — so a day heading is
 * one of the few places caps are correct, and it gets them by using the token rather than by
 * writing `uppercase` beside a size.
 *
 * ON THE CANVAS, NOT TRANSPARENT. A sticky element with no background lets the rows scroll THROUGH
 * it, which is the classic version of this bug and reads as text overlapping text.
 */
function DayHeading({ label }: { label: string }) {
  return (
    <li className={`sticky top-0 z-10 bg-canvas py-1.5 ${TYPE.panelLabel}`}>{label}</li>
  );
}

/**
 * What a waiting job is waiting for, named on the row.
 *
 * IT READS `mcpStore.confirms`, WHICH IS THE MODAL'S OWN QUEUE, so the row and the dialog cannot
 * disagree about what is being asked — one source, rendered twice. A row that carried the tool
 * name from its own payload would be a second copy of a fact that moves, and the moment it moved
 * the list would be naming a call nobody was being asked about any more.
 *
 * AND IT SAYS SOMETHING EVEN WHEN THE ASK IS NOT IN HAND. A job can read `waiting` in a client
 * that has not received the request — a race on connect, or a workspace switch mid-question — and
 * "waiting on somebody" is true and useful where a blank row is neither.
 */
function WaitingFor({ item }: { item: WorkItemView }) {
  const ask = useMcpStore((s) => s.confirms.find((c) => c.runId === item.run_id));
  return (
    <span className="hidden shrink-0 text-tiny text-muted sm:inline">
      {ask ? (
        <>
          waiting on <span className="text-ink">{ask.server}/{ask.tool}</span>
        </>
      ) : (
        "waiting on somebody"
      )}
    </span>
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
    <div className={`flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-hair py-2 ${SPINE_X}`}>
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

  /**
   * §13's width, measured on the CONTAINER rather than queried on the viewport.
   *
   * WHICH IT HAS TO BE HERE. The Cockpit sits beside a sidebar the user can drag, so a `md:` query
   * would keep every column on a 1400px window while the pane holding them shrank to 400. That is
   * the same reason `InboxView` and `AgentDetail` both measure their own content box rather than
   * using a breakpoint prefix; the THRESHOLDS are still Tailwind's own, in `workRow.ts`, so §13's
   * "do not add a breakpoint that is not already in the app's set" holds.
   */
  const [width, setWidth] = useState(0);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [host]);
  const columns = rowColumns(width, filters);

  // §6's day grouping, computed once per render of the list rather than per row. `useMemo` because
  // the list can be ten thousand rows (§18) and the grouping walks all of them.
  const days = useMemo(() => groupByDay(items), [items]);

  // THE LIST SCROLLS BACK TO THE TOP WHEN THE FILTER CHANGES, because a scroll position is a
  // position in a list and the list has been replaced. Left alone, somebody switching from a long
  // "Everyone's" to a short "Mine" lands below the end of the new one and reads it as empty.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [filters.scope, filters.status, filters.agentId]);

  return (
    <>
      <Filters />
      {/* §3C: THE ONLY REGION ON THIS TAB THAT SCROLLS VERTICALLY, and it says so at both edges.
          `.scroll-fade` is `index.css`'s own 16px mask, opted into by class exactly as that file
          intends — a hard cut at the top of a list whose head moves every few seconds reads as the
          list having ended rather than as it continuing above.

          `px-5` IS THE SPINE. It was `px-4`, which put every row's status glyph four pixels left of
          the word "Cockpit" and of the first fleet card — the two-pixel disagreement §Craft 3 is
          about, at twice the size. */}
      <div
        ref={(el) => { scrollRef.current = el; setHost(el); }}
        className={`scroll-fade min-h-0 flex-1 overflow-y-auto py-1 ${SPINE_X}`}
      >
        {items.length === 0 ? (
          <ZeroState />
        ) : (
          <>
            {/* ONE `<ul>` PER DAY, and the heading inside it rather than between two lists. §12
                calls the work list "a list" and its rows buttons; a heading floating between two
                `<ul>`s is a label a screen reader reads outside the list it labels. */}
            {days.map((day) => (
              <ul key={day.key} className="flex flex-col">
                {/* §22: A SINGLE ROW STILL GETS ITS HEADING. "A single row with no heading looks
                    like a fragment." And a day with no items renders nothing at all, which falls
                    out of deriving the groups from the items — see `groupByDay`. */}
                <DayHeading label={day.label} />
                {day.items.map((item) => (
                  <Row key={item.id} item={item} columns={columns} />
                ))}
              </ul>
            ))}
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
