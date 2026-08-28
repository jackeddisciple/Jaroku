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

import { DESTRUCTIVE, EMPTY, FAILURE_SENTENCE, FILTERS, HEADER, LIVE, STATUS_WORD } from "../lib/cockpitCopy.ts";
import { cockpitCost, cockpitTime } from "../lib/cockpitFormat.ts";
import { rowColumns, type RowColumns } from "../lib/workRow.ts";
import { dayAt, flattenWork, workWindow } from "../lib/workWindow.ts";
import { sendCancelWork, sendListWork, sendLoadWorkItem, sendRetryWork } from "../lib/socket.ts";
import { ROW_HEIGHT, SPINE_X } from "../lib/cockpitLayout.ts";
import { ICON, TYPE } from "../lib/tokens.ts";
import { useMcpStore } from "../store/mcpStore.ts";
import { useWorkStore } from "../store/workStore.ts";
import { WORK_STATUS_ORDER } from "../store/workStore.ts";
import type { WorkItemView } from "../types.ts";
import { Capable } from "./Capable.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Truncate } from "./Truncate.tsx";
import { WorkGlyph } from "./WorkGlyph.tsx";
import { XIcon } from "./panelIcons.tsx";

/**
 * How many rows to assume before the container has been measured.
 *
 * TWENTY, which is a tall screenful at `ROW_HEIGHT` and a bounded one at any screen. The number
 * matters only for the single frame between mount and the first `ResizeObserver` callback: too few
 * and a tall window paints a short list and then grows, too many and the frame the virtualiser
 * exists to protect renders rows nobody will see. Twenty is more than a laptop shows and far less
 * than a page.
 */
const FIRST_PAINT_ROWS = 20;

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
        className={`group relative flex items-center gap-3 border-b border-hair transition-colors duration-fast ${
          active ? "bg-active/50" : "hover:bg-active/30"
        }`}
      >
        {/* §6's ONE LOUDER ROW. "A `waiting` row is the only row that is visually louder. A left
            edge marker, exactly one, in the manner of the Inbox's single rose edge on a blocking
            card. NOT A FILLED ROW, NOT A COLOURED BACKGROUND."

            THE FORM IS THE INBOX'S AND THE COLOUR IS NOT. The Inbox's edge is rose because rose
            appears exactly once in this product and that scarcity is what makes it work — so
            borrowing the colour would spend it a second time and make it mean two things. What is
            borrowed is the DEVICE: two pixels on the left edge, nothing else changed. The colour
            is amber, because that is what `waiting` already is (§9) and a marker in a different
            colour from the glyph two pixels away would be two signals for one state.

            AND EXACTLY ONE ROW WEARS IT. `failed` does not — §9 asks that failed rows not be
            painted, because a list where a fifth of the rows are marked is a list nobody scans.
            `waiting` earns it by being the only status where a PERSON is the blocker. */}
        {item.status === "waiting" && (
          <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-run" />
        )}
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
 * §6's day heading, in flow — the one the pinned bar above the list is a copy of.
 *
 * IT IS NOT `position: sticky`, AND THAT IS §18's DOING RATHER THAN §6's. §6 asks for a sticky day
 * heading and CSS stickiness is the obvious way to get one; §18 then asks for the list to be
 * virtualised, and the two cannot both be had the CSS way. A sticky element sticks within its
 * nearest scrolling ancestor for as long as its own containing box is on screen — and under
 * virtualisation the group's box is only as tall as the slice of it that is in the DOM, so a
 * heading unsticks a few rows into a long day and then reappears. It looks like a rendering fault
 * because it is one.
 *
 * SO THE STICKINESS MOVED UP A LEVEL. `WorkList` pins one heading itself, computed by `dayAt` from
 * the flat array rather than from a box, and this heading stays in the flow where it belongs — it
 * is what a reader scrolling past a day boundary actually sees move. Between them the reader always
 * has the day in view, which is what §6 asked for, and neither depends on a box that is a lie.
 *
 * `TYPE.panelLabel`'s RECIPE AND NOT ITS OWN. §16: sentence case everywhere "except
 * `TYPE.panelLabel`, which is the caps recipe and the only caps in the app" — so a day heading is
 * one of the few places caps are correct, and it gets them by using the token rather than by
 * writing `uppercase` beside a size.
 *
 * ONE ROW TALL, LIKE EVERY OTHER ENTRY, which is what lets `feedWindow` apply to the flat list
 * unchanged. `workWindow.ts` argues that at length; the short version is that the alternative was a
 * measurement cache, and that is the complexity `feedWindow.ts` exists to avoid.
 */
function DayHeading({ label }: { label: string }) {
  return (
    <li style={{ height: ROW_HEIGHT }} className={`flex items-center bg-canvas ${TYPE.panelLabel}`}>{label}</li>
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
  // THE NAME COMES FROM THE FLEET, which is the one place it exists. A chip that carried the name
  // the fleet card had when it was pressed would be a copy of a fact that moves — an agent renamed
  // while the filter was applied would leave the chip naming somebody who no longer exists.
  const agentName = useWorkStore(
    (s) => s.fleet.find((c) => c.agent_id === s.filters.agentId)?.agent_name ?? "this agent",
  );

  const choose = (patch: Parameters<typeof setFilters>[0]): void => {
    setFilters(patch);
    sendListWork();
  };

  return (
    <div className={`flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-hair py-2 ${SPINE_X}`}>
      {/* §6: "Toggles are the app's existing SEGMENTED CONTROL, not `<select>` — the codebase
          records that its six native selects were a violation, and you are not adding a seventh."
          The app's segmented control is a pressed group of chips: `ThreadFilterBar` establishes it
          and `ActivityView`'s range chips repeat it, both with `aria-pressed`, both because §9's
          rule is that colour is never the only signal — between an active chip and an inactive one
          there was exactly one difference, `bg-active text-ink`, so which filter was applied was a
          fact only a sighted user had.

          §14: THE MINE/ALL TOGGLE IS NEVER GATED. "Part 2 is explicit: it is a filter, not a
          permission." Anyone who can see the Cockpit sees the whole workspace's work when they
          switch, for the reason `billing:read` is a member capability — a member whose job was
          refused has to see what it was refused behind, and work in a shared workspace is not a
          secret from the people sharing it. There is deliberately no `Capable` around this. */}
      <div className="flex items-center gap-1" role="group" aria-label="Whose work to show">
        {(["mine", "all"] as const).map((scope) => (
          <button
            key={scope}
            type="button"
            onClick={() => choose({ scope })}
            aria-pressed={filters.scope === scope}
            className={`rounded-control px-2 py-0.5 text-tiny transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
              filters.scope === scope ? "bg-active text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {FILTERS.scope[scope]}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by status">
        <button
          type="button"
          onClick={() => choose({ status: null })}
          aria-pressed={filters.status === null}
          className={`rounded-control px-2 py-0.5 text-tiny transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
            filters.status === null ? "bg-active text-ink" : "text-muted hover:text-ink"
          }`}
        >
          {FILTERS.allStatuses}
        </button>
        {WORK_STATUS_ORDER.map((status) => (
          // A STATUS WITH NOTHING IN IT IS NOT OFFERED. A rail of six chips reading zero is six
          // controls that lead to an empty list, and the counts are the page's own scope — so a
          // chip that is present is a chip with something behind it.
          counts[status] > 0 ? (
            <button
              key={status}
              type="button"
              onClick={() => choose({ status: filters.status === status ? null : status })}
              aria-pressed={filters.status === status}
              // §12: EVERY ICON-ONLY CONTROL HAS AN ACCESSIBLE NAME. A chip carrying a glyph and a
              // figure reads as a bare number without one — "3", six times, in a row.
              aria-label={`${STATUS_WORD[status]}: ${counts[status]}`}
              className={`flex items-center gap-1.5 rounded-control px-2 py-0.5 text-tiny transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focusring ${
                filters.status === status ? "bg-active text-ink" : "text-muted hover:text-ink"
              }`}
            >
              <WorkGlyph status={status} />
              <span className="tabular-nums">{counts[status]}</span>
            </button>
          ) : null
        ))}
      </div>

      {/* §4's REMOVABLE CHIP, set by a fleet card and cleared here.
          "The filter appears as a removable chip above the list, so the user can see WHY the list
          shrank and can undo it in one press. A list that silently filtered is a list the user
          thinks is broken."

          IT NAMES THE AGENT, which is the difference from what this said before. "Showing one
          agent — clear" tells the reader that a filter exists and not which one, so somebody who
          arrived from an Agent detail's pointer strip — with no fleet card on screen to compare
          against — could see that the list was narrowed and not to what. The name is the whole
          value of the chip.

          THE `×` IS PART OF THE CHIP RATHER THAN BESIDE IT, because the chip IS the undo. A label
          with a separate dismiss control is two targets for one decision, and the smaller of them
          is the one that does the thing. */}
      {filters.agentId && (
        <button
          type="button"
          onClick={() => choose({ agentId: null })}
          className="ml-auto flex items-center gap-1 rounded-chip border border-hair bg-panel px-2 py-0.5 text-tiny text-ink transition-colors duration-fast hover:bg-active focus-visible:outline-none focus-visible:shadow-focusring"
          title={FILTERS.clearAgent}
        >
          <span className="max-w-[22ch] truncate">{FILTERS.agentChip(agentName)}</span>
          <span className="shrink-0 text-faint" aria-hidden>
            <XIcon size={ICON.badge} />
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * §12's polite live region: `waiting`, and only `waiting`.
 *
 * "Live status changes announce through a polite live region. ONLY `waiting` ANNOUNCES, because it
 * is the only change that needs a person — a region that announces every transition on a busy
 * workspace is a screen reader nobody can use."
 *
 * THAT SCARCITY IS THE SAME RULE THE BADGE FOLLOWS, and it is worth stating together: the sidebar
 * badge counts `waiting` and nothing else, the window title carries `waiting` and nothing else, and
 * this announces `waiting` and nothing else. Three surfaces, one question — is a person the blocker
 * — and a fourth thing reaching for any of them is what makes all three ignorable.
 *
 * IT ANNOUNCES A TRANSITION AND NOT A STATE. The region holds a sentence only for jobs that have
 * JUST become `waiting`, which is what a live region is for; re-announcing every waiting job on
 * every render would make a screen reader read the same three sentences on every delta in the
 * workspace, most of which have nothing to do with them.
 *
 * `aria-live="polite"` AND NOT `assertive`. A job waiting on an answer is important and is not an
 * interruption: assertive cuts off whatever the reader is in the middle of, which for a person
 * reading a job's detail would mean losing their place to be told about a different job.
 */
function WaitingAnnouncer() {
  const items = useWorkStore((s) => s.items);
  const [announced, setAnnounced] = useState<Set<string>>(new Set());
  const [sentence, setSentence] = useState("");

  useEffect(() => {
    const nowWaiting = items.filter((i) => i.status === "waiting");
    const fresh = nowWaiting.filter((i) => !announced.has(i.id));
    if (fresh.length === 0) {
      // A JOB THAT STOPS WAITING IS FORGOTTEN, so that the same job blocking twice announces twice.
      // Without this the set grows for the life of the session and the second confirmation on a
      // long-running agent is silent.
      const stillWaiting = new Set(nowWaiting.map((i) => i.id));
      if ([...announced].some((id) => !stillWaiting.has(id))) setAnnounced(stillWaiting);
      return;
    }
    setSentence(HEADER.announce(fresh[0]!.agent_name ?? "An agent"));
    setAnnounced(new Set(nowWaiting.map((i) => i.id)));
  }, [items, announced]);

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {sentence}
    </div>
  );
}

export function WorkList() {
  const items = useWorkStore((s) => s.items);
  const nextCursor = useWorkStore((s) => s.nextCursor);
  const filters = useWorkStore((s) => s.filters);
  const pending = useWorkStore((s) => s.pending);
  const admit = useWorkStore((s) => s.admitPending);
  const setAtTop = useWorkStore((s) => s.setAtTop);
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
  // §18's flat list: headings and rows, every entry one row tall, so `feedWindow` applies to it
  // unchanged. See `workWindow.ts` for why a heading is a row and why that is not a compromise.
  const entries = useMemo(() => flattenWork(items), [items]);

  /**
   * §18's window, and the scroll offset it is computed from.
   *
   * THE OFFSET IS STATE RATHER THAN A REF, because the window has to be recomputed on every scroll
   * frame and a ref does not re-render. It is the one piece of high-frequency state on this tab,
   * and it is cheap: the handler does one assignment and the arithmetic below is four lines.
   */
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  useEffect(() => {
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewport(entry.contentRect.height);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [host]);

  /**
   * A VIEWPORT NOBODY HAS MEASURED RENDERS A SCREENFUL, NOT NOTHING — and this is §Craft 1 rather
   * than a workaround.
   *
   * `feedWindow` answers an EMPTY window for a viewport of zero, deliberately and correctly: its
   * own note says a container that has not been measured reports zero, and treating that as "render
   * everything" would render ten thousand rows on the one frame the virtualiser exists to protect.
   * What it cannot know is what a caller should do INSTEAD of everything.
   *
   * Rendering nothing is the wrong answer. A `ResizeObserver` fires after the first paint, so the
   * list committed one frame with no rows and then filled — a flash of an empty list on every
   * mount, every filter change and every workspace switch. That is the layout shift §Craft 1 opens
   * with, at its most visible: not one pixel of jump but a whole region appearing.
   *
   * SO AN UNMEASURED CONTAINER IS ASSUMED TO BE ONE SCREENFUL. Bounded, so the frame the
   * virtualiser protects is still protected; enough that the first paint is the list rather than a
   * gap. If the real height turns out larger the observer corrects it on the next frame, which is
   * the ordinary case for a window that was always going to be re-measured.
   */
  const height = viewport > 0 ? viewport : FIRST_PAINT_ROWS * ROW_HEIGHT;
  const view = workWindow(entries.length, scrollTop, height);
  const slice = entries.slice(view.start, view.end);
  // §18's pinned heading — CSS `sticky` cannot survive virtualisation, because a group's box is
  // only as tall as the slice of it that is in the DOM. `dayAt` answers from the data instead.
  const pinnedDay = dayAt(entries, view.start);

  // THE LIST SCROLLS BACK TO THE TOP WHEN THE FILTER CHANGES, because a scroll position is a
  // position in a list and the list has been replaced. Left alone, somebody switching from a long
  // "Everyone's" to a short "Mine" lands below the end of the new one and reads it as empty.
  //
  // AND THE WINDOW'S OWN OFFSET GOES WITH IT. `scrollTo` fires a scroll event, but not before the
  // next render — so a window computed from a stale offset would slice row four hundred of a list
  // that now has six rows, and the first paint after a filter change would be blank.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [filters.scope, filters.status, filters.agentId]);

  return (
    <>
      <Filters />
      {/* §12s live region. Outside the scroller, because a region inside a virtualised list would
          be unmounted the moment the reader scrolled past it. */}
      <WaitingAnnouncer />
      {/* §3C: THE ONLY REGION ON THIS TAB THAT SCROLLS VERTICALLY, and it says so at both edges.
          `.scroll-fade` is `index.css`'s own 16px mask, opted into by class exactly as that file
          intends — a hard cut at the top of a list whose head moves every few seconds reads as the
          list having ended rather than as it continuing above.

          `px-5` IS THE SPINE. It was `px-4`, which put every row's status glyph four pixels left of
          the word "Cockpit" and of the first fleet card — the two-pixel disagreement §Craft 3 is
          about, at twice the size. */}
      <div
        ref={(el) => { scrollRef.current = el; setHost(el); }}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          // §18: "AN ITEM ARRIVING WHILE THE READER IS ALREADY AT THE TOP INSERTS DIRECTLY." A
          // small tolerance rather than `=== 0`, because a scroller can sit at a fractional offset
          // after a wheel event and a reader two pixels down is, by any reading a person would
          // give it, at the top. `ROW_HEIGHT / 2` is the tolerance: less than half a row means no
          // row is meaningfully hidden above the fold.
          setAtTop(e.currentTarget.scrollTop < ROW_HEIGHT / 2);
        }}
        className={`relative scroll-fade min-h-0 flex-1 overflow-y-auto py-1 ${SPINE_X}`}
      >
        {items.length === 0 ? (
          <ZeroState />
        ) : (
          <>
            {/* §18's PILL. "A new item arriving above the scroll position does not insert. It
                increments a count, and a small pill — '3 new' — appears pinned at the top of the
                list. Pressing it scrolls to the top and inserts them."

                PINNED TO THE LIST AND NOT INSIDE A GROUP — §18 says so in as many words, and it is
                why the pill is not one of the flattened entries: an entry could be scrolled past,
                and a control announcing rows the reader has not seen must not itself be one of the
                things they have to scroll to find.

                ABOVE THE DAY HEADING IN THE STACKING ORDER, because for the frame after a press the
                two occupy the same strip and the pill is the one being pressed.

                NO ENTRANCE ANIMATION. §11: "Rows entering the list do not animate", and §Craft's
                closing list rules out an entrance on every row. The pill appearing is a state
                change the reader should notice, not a performance. */}
            {pending.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  // ORDER MATTERS: admit first, then scroll. Admitting inserts the rows at the head
                  // and pushes the reader's position down by exactly their height; scrolling first
                  // would land at the top of the OLD list and then be shoved down again.
                  admit();
                  scrollRef.current?.scrollTo({ top: 0 });
                  setScrollTop(0);
                  setAtTop(true);
                }}
                title={LIVE.pillTitle}
                className="absolute inset-x-0 top-0 z-20 mx-auto w-fit rounded-full border border-edge bg-elevated px-2.5 py-0.5 text-tiny tabular-nums text-ink shadow-floating transition-colors duration-fast hover:bg-active"
              >
                {LIVE.pill(pending.length)}
              </button>
            )}

            {/* §18's PINNED HEADING, which is what replaces CSS `sticky`. It is `aria-hidden`
                because the real heading is in the list below it and a screen reader reading both
                would announce every day twice; this one is for the eye, which is the only sense
                stickiness was ever for. */}
            {pinnedDay && (
              <div
                aria-hidden
                className={`pointer-events-none absolute inset-x-0 top-0 z-10 bg-canvas py-1.5 ${SPINE_X} ${TYPE.panelLabel}`}
              >
                {pinnedDay}
              </div>
            )}

            {/* THE SPACER PAIR, WHICH IS WHY THIS IS NOT A `transform`. A translated slice takes
                its rows out of the scroller's own flow, so the scrollbar reports the height of six
                rows over a list of ten thousand. Two spacers keep the scroller's own geometry
                honest, which is what makes the thumb the right size and a page-down the right
                distance — and `feedWindow` already returns both numbers for exactly this. */}
            <div style={{ height: view.offsetTop }} aria-hidden />
            <ul className="flex flex-col">
              {slice.map((entry) => (
                entry.kind === "day"
                  // §22: A SINGLE ROW STILL GETS ITS HEADING. "A single row with no heading looks
                  // like a fragment." And a day with no items renders nothing at all, which falls
                  // out of deriving the groups from the items — see `groupByDay`.
                  ? <DayHeading key={entry.key} label={entry.label} />
                  : <Row key={entry.key} item={entry.item} columns={columns} />
              ))}
            </ul>
            <div style={{ height: Math.max(0, view.totalHeight - view.end * ROW_HEIGHT) }} aria-hidden />
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
  // WHAT COUNTS AS FILTERED INCLUDES THE DEFAULT SCOPE, which is the subtle half. §8 defaults to
  // `mine`, so a member of a busy workspace who has never touched a control is looking at a
  // FILTERED list — and telling them "nothing has been asked of them yet" over forty of a
  // colleague's jobs is the exact confusion §10 asks the three states to prevent.
  const filtered = filters.scope === "mine" || filters.status !== null || filters.agentId !== null;

  // §10's SECOND STATE: live agents, nothing asked of them. A `line`, because the composer directly
  // below it is the answer and a full-height illustration over a control that fixes it is theatre.
  if (!filtered) {
    return <EmptyState size="line" title={EMPTY.noWork.title} />;
  }

  // §10's THIRD: narrowed to nothing. It "names the filter and offers to clear it", which is what
  // makes it distinguishable at a glance from the second — the two call for different actions, and
  // a reader who cannot tell which one they are looking at will go and deploy a second agent.
  return (
    <EmptyState
      size="line"
      title={EMPTY.filtered.title}
      hint={
        <button
          type="button"
          onClick={() => {
            setFilters({ scope: "all", status: null, agentId: null });
            sendListWork();
          }}
          className="underline-offset-2 hover:text-ink hover:underline focus-visible:outline-none focus-visible:shadow-focusring"
        >
          {EMPTY.filtered.action}
        </button>
      }
    />
  );
}
