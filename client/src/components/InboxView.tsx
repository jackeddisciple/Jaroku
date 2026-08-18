// The full-screen Inbox (§4): a severity board, and deliberately not a list or a grid.
//
// THIS TAB MUST NOT LOOK LIKE THREADS OR AGENTS. Threads is rows, Agents is a card grid, and this is
// three columns of cards whose SIZE carries their severity. That is the core design decision of the
// surface and the reason it is worth being a fourth destination rather than a filter on one of the
// other two.
//
// IT LOOKS LIKE KANBAN AND DOES NOT BEHAVE LIKE IT, which is worth stating where somebody might
// reach for a library:
//
//   Columns are BUCKETS, not lanes. Severity is assigned by the system and a card never moves from
//   Blocking to Attention — there is no cross-column drag, and no drop target for one.
//   Cards do not progress left to right. They sit in place and then resolve and vanish.
//   No WIP limits, no manual reordering, no swimlanes. Order is severity then age, and the user does
//   not choose it.
//
// So there is no drag-and-drop dependency here. The one drag this surface has — to the snooze tray —
// is a pointer-event handler, because one drag target does not justify a library.
//
// THE ARRANGEMENT RULES ARE A PURE MODULE, not expressions in this file. `lib/inboxBoard.ts` owns
// the filter, the ordering, the age bar's curve and the tray's line, for the reason `threadGroups`
// and `agentTags` are their own modules: each of them looks obviously right in a screenshot and is
// wrong in the case nobody had that day.
//
// FILTER STATE IS LOCAL, which is the requirement rather than a shortcut — §5.1's rail is per
// session, and local state does that by construction because the view unmounts when you leave it.

import { useEffect, useMemo, useState } from "react";

/**
 * The width below which three columns stop being three columns.
 *
 * 720px, which is roughly three cards at the width a blocking card needs to hold an inline form
 * plus the rail beside them. Below it the columns are narrower than their own contents, and a card
 * whose subject line wraps to three lines has stopped carrying its severity in its size.
 */
const STACK_BELOW_PX = 720;
import {
  COLUMN_EMPTY,
  COLUMN_LABEL,
  INBOX_COLUMNS,
  INBOX_FILTERS,
  INBOX_FILTER_LABEL,
  columnItems,
  filterInbox,
  type InboxFilter,
} from "../lib/inboxBoard.ts";
import { sendListInbox } from "../lib/socket.ts";
import { ICON, MOTION, TYPE } from "../lib/tokens.ts";
import { useInboxStore } from "../store/inboxStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useUiStore } from "../store/uiStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { InboxCard } from "./InboxCard.tsx";
import { InboxTray } from "./InboxTray.tsx";
import { useInboxDrag } from "./useInboxDrag.ts";
import { selectOnClick, useInboxKeys } from "./useInboxKeys.ts";
import { InboxUndoToast } from "./InboxUndoToast.tsx";
import { sendSnoozeInboxItem } from "../lib/socket.ts";
import { RefreshIcon } from "./panelIcons.tsx";
import type { InboxItemView, InboxSeverity } from "../types.ts";

/**
 * §5.3's zero state. "Celebrate it. Do not apologise for it, do not offer suggestions, do not fill
 * the space. An empty Inbox is the product working."
 *
 * SO THERE IS NO CALL TO ACTION HERE, and that is the hardest part of the instruction to follow: the
 * reflex is to offer something to do next. What is beneath the line is one REAL statistic, counted
 * from resolutions, because a number somebody earned is the only congratulation that means anything.
 */
function NothingNeedsYou({ cleared }: { cleared: number }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="text-[18px] font-medium text-ink">Nothing needs you</div>
      {cleared > 0 && (
        <div className="mt-2 text-[12px] text-muted">
          Cleared {cleared} item{cleared === 1 ? "" : "s"} this week.
        </div>
      )}
    </div>
  );
}

/**
 * §5.1's left rail: the six filter counts, then the top five agents.
 *
 * COUNTS COME OFF THE SNAPSHOT rather than being derived from the rows in hand, which matters
 * because the rows in hand are already filtered — a chip whose number came from what is on screen
 * would report the filter back to itself and every chip but the active one would read zero.
 */
function LeftRail({
  filter,
  onFilter,
  agentId,
  onAgent,
}: {
  filter: InboxFilter;
  onFilter: (f: InboxFilter) => void;
  agentId: string | null;
  onAgent: (id: string | null) => void;
}) {
  const counts = useInboxStore((s) => s.counts);
  const agents = useInboxStore((s) => s.agents);
  const team = counts.team > 0;

  const value: Record<InboxFilter, number> = {
    all: counts.all,
    blocking: counts.blocking,
    attention: counts.attention,
    proposals: counts.proposals,
    team: counts.team,
    snoozed: counts.snoozed,
  };

  return (
    <div className="w-[168px] shrink-0 border-r border-hair px-3 py-3">
      {INBOX_FILTERS.map((f) => {
        // §2.4: the Team chip does not exist in a Personal workspace. Absent rather than greyed,
        // because a disabled control invites somebody to work out how to enable it.
        if (f === "team" && !team) return null;
        const active = filter === f;
        return (
          <button
            key={f}
            onClick={() => onFilter(f)}
            className={`relative flex w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-[12px] transition-colors ${
              active ? "bg-active text-ink" : "text-muted hover:bg-active/50 hover:text-ink"
            }`}
          >
            {active && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-ink" />}
            {INBOX_FILTER_LABEL[f]}
            {/* A ZERO RENDERS NOTHING, matching the empty-sections discipline the whole app follows:
                a count of 0 beside a chip is noise, and the chip staying in place is what keeps the
                keyboard's 1–6 a stable address. */}
            {value[f] > 0 && (
              <span className="ml-auto text-[11px] tabular-nums text-faint">{value[f]}</span>
            )}
          </button>
        );
      })}

      {agents.length > 0 && (
        <>
          <div className="mt-4 mb-1 px-2.5">
            <span className={TYPE.panelLabel}>By agent</span>
          </div>
          {agents.map((a) => {
            const active = agentId === a.agent_id;
            return (
              <button
                key={a.agent_id}
                // CLICKING THE ACTIVE ONE CLEARS IT, because the rail has no "all agents" row and a
                // filter somebody cannot turn off is a filter they have to reload the tab to escape.
                onClick={() => onAgent(active ? null : a.agent_id)}
                className={`relative flex w-full items-center gap-2 rounded-control px-2.5 py-1 text-left text-[11px] transition-colors ${
                  active ? "bg-active text-ink" : "text-muted hover:bg-active/50 hover:text-ink"
                }`}
                title={a.name}
              >
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="shrink-0 tabular-nums text-faint">{a.count}</span>
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}

/** One column: a header that carries its own count, and its cards. */
function Column({
  severity,
  items,
  now,
  leaving,
  expandedId,
  onExpand,
  cursor,
  selection,
  onSelect,
  dragProps,
  dimmed,
  draggingId,
}: {
  severity: InboxSeverity;
  items: InboxItemView[];
  now: number;
  /** Cards on their way out (§5.6). Keyed by id, so a column re-renders one card rather than itself. */
  leaving: Record<string, true>;
  expandedId: string | null;
  onExpand: (id: string | null) => void;
  /** Where the keyboard is. Not the same as what is expanded — see `InboxCard`. */
  cursor: string | null;
  /** A shift-clicked range, which the keyboard's E / X / S then act on together. */
  selection: string[];
  onSelect: (itemId: string, shiftKey: boolean) => void;
  /** The pointer handlers for one card. See `useInboxDrag` for why this is not a library. */
  dragProps: (itemId: string) => Record<string, unknown>;
  /** A card is being dragged: §4.1 asks the columns to dim so it reads instantly as not-a-lane. */
  dimmed: boolean;
  draggingId: string | null;
}) {
  return (
    <div
      // §4.1: "If a user starts dragging toward another column, DIM THE COLUMNS so it reads instantly
      // as not-a-lane." The dimming is the explanation — there is no drop target to refuse, because
      // a column is a bucket and severity is assigned by the system.
      className={`flex min-w-0 flex-1 flex-col transition-opacity motion-reduce:transition-none ${
        dimmed ? "opacity-40" : "opacity-100"
      }`}
    >
      <div className="flex shrink-0 items-center gap-2 px-1 pb-2">
        <span className="text-[10px] font-medium tracking-wider text-faint">{COLUMN_LABEL[severity]}</span>
        <span className="text-[10px] tabular-nums text-faint">{items.length}</span>
        <span className="h-px flex-1 bg-hair" />
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {items.length === 0 ? (
          // §5.3: per-column empties get a quiet line of their own, and each says its own thing.
          <div className="px-1 py-3 text-[11px] text-faint">{COLUMN_EMPTY[severity]}</div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              {...dragProps(item.id)}
              className={draggingId === item.id ? "opacity-50" : ""}
              onClickCapture={(e) => onSelect(item.id, e.shiftKey)}
            >
              <InboxCard
                item={item}
                now={now}
                expanded={expandedId === item.id}
                selected={cursor === item.id || selection.includes(item.id)}
                leaving={Boolean(leaving[item.id])}
                // §4.5: clicking a card expands it IN PLACE, and clicking it again closes it. It does
                // not navigate — navigation is what the actions are for, and it is the fallback.
                // A shift-click builds a range instead, which `onClickCapture` above has already
                // recorded — so expanding is skipped for it rather than happening as well.
                onClick={(e) => {
                  if (e.shiftKey) return;
                  onExpand(expandedId === item.id ? null : item.id);
                }}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function InboxView() {
  const items = useInboxStore((s) => s.items);
  const snoozed = useInboxStore((s) => s.snoozed);
  const counts = useInboxStore((s) => s.counts);
  const cleared = useInboxStore((s) => s.clearedThisWeek);
  const loaded = useInboxStore((s) => s.loaded);
  const error = useInboxStore((s) => s.error);
  const workspaceName = useSessionStore((s) => s.workspaces.find((w) => w.id === s.workspaceId)?.name ?? null);
  // Whether this view's mutations can actually leave the tab. The composer has read the same thing
  // since it was written, and a dropped write is invisible.
  const connected = useTraceStore((s) => s.connection === "open");

  const [filter, setFilter] = useState<InboxFilter>("all");
  const [agentId, setAgentId] = useState<string | null>(null);
  /**
   * Which card is open (§4.5). ONE AT A TIME, deliberately.
   *
   * Two expanded cards is a board that has stopped being scannable, which is the one thing this
   * surface cannot afford to lose — and a card whose evidence is worth reading is a card somebody is
   * dealing with now rather than one of three they are comparing.
   */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  /**
   * §4.1's one drag, to §5.4's one destination.
   *
   * DROPPING SNOOZES UNTIL TOMORROW, which is a default rather than a choice — a drag has no way to
   * express which of the three durations somebody meant, and asking mid-drop would be a menu opening
   * under a pointer that is already moving away. The overflow and the keyboard are where the other
   * two live, and the tray itself offers "1h" per row for the case where tomorrow was too far.
   */
  const drag = useInboxDrag((itemId) => sendSnoozeInboxItem(itemId, "tomorrow"));

  /**
   * §5.5's cursor: where the keyboard is, which is NOT the same as which card is expanded.
   *
   * It starts unplaced, because the first `J` is the most common keystroke this view will ever see
   * and landing it on the first card is a better first move than restoring somewhere.
   */
  const [cursor, setCursor] = useState<string | null>(null);

  /**
   * §8: "Narrow widths: three columns do not survive. Fall back to a SINGLE COLUMN with cards keeping
   * their variable heights, ordered by severity then age. The board's whole benefit survives the
   * columns disappearing."
   *
   * WHICH IS WHY THE FALLBACK IS ONE COLUMN AND NOT TWO, and why the cards do not shrink. What the
   * board communicates is priority-by-size; three columns are how that is arranged when there is room
   * and are not themselves the thing. Two narrow columns would keep the arrangement and lose the
   * sizes, which is the half worth keeping.
   *
   * MEASURED WITH A ResizeObserver ON THE BOARD RATHER THAN A MEDIA QUERY, because this app's panes
   * are draggable: the viewport can be wide while this surface is not, and a media query would keep
   * three columns inside a pane somebody has dragged to a third of the screen. The same reason
   * `AgentDetail` measures itself.
   */
  const [narrow, setNarrow] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < STACK_BELOW_PX);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [host]);

  /**
   * §5.7's pointer, arriving. Consumed once on mount and cleared, so it is an intent rather than a
   * filter that sticks — coming back to the board later starts at All, which is what §5.1's
   * per-session rule asks for.
   */
  useEffect(() => {
    const intent = useUiStore.getState().takeInboxAgentIntent();
    if (intent) setAgentId(intent);
  }, []);
  /** §3's bulk selection, built by shift-click and acted on by the keyboard. */
  const [selection, setSelection] = useState<string[]>([]);

  /**
   * The clock the age bars are drawn against.
   *
   * ONE VALUE FOR THE WHOLE BOARD, ticked on a timer rather than read per card. Forty cards each
   * calling `Date.now()` in a render is forty slightly different clocks, and a board that only
   * re-rendered when something else changed would have bars frozen at whatever time the last
   * snapshot happened to arrive.
   *
   * A MINUTE, because the bar is logarithmic over a week: a second is never a visible change, and a
   * timer that fires more often than the thing it draws can move is a render for nothing.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const visible = useMemo(
    () => filterInbox(items, snoozed, filter, agentId),
    [items, snoozed, filter, agentId],
  );

  /**
   * The cards in the order they RENDER, which is what J/K walks.
   *
   * ACROSS COLUMN BOUNDARIES IN VISUAL ORDER (§5.5), which means column by column — blocking, then
   * attention, then proposals — because that is how the three columns read. Walking the store's
   * array instead would move the cursor around the screen at random.
   */
  const ordered = useMemo(
    () =>
      filter === "snoozed" || filter === "team"
        ? visible
        : INBOX_COLUMNS.flatMap((severity) => columnItems(visible, severity)),
    [visible, filter],
  );

  useInboxKeys({
    rows: ordered,
    cursor,
    setCursor,
    setFilter,
    toggleExpand: (id) => setExpandedId((open) => (open === id ? null : id)),
    selection,
    setSelection,
  });

  /**
   * §5.5: "focus must survive a filter change and a card resolving out from under it."
   *
   * The keyboard moves the cursor off a card before it acts on it, which covers the second half from
   * this tab's own actions. This covers everything else: a filter change, a teammate's resolution
   * arriving on the socket, a snooze returning. A cursor on a card nobody can see is a cursor nobody
   * can see MOVING, so it falls back to the first card rather than to nothing.
   */
  useEffect(() => {
    if (cursor && !ordered.some((i) => i.id === cursor)) setCursor(ordered[0]?.id ?? null);
  }, [cursor, ordered]);

  /**
   * §5.6: a card that has resolved plays its collapse and then goes.
   *
   * THE TIMER IS HERE RATHER THAN IN THE STORE, because how long the animation takes is a rendering
   * decision and the store holds facts. `MOTION.base` is the app's one duration for a state change
   * with something to show, so a card leaving takes exactly as long as everything else that leaves.
   */
  const leaving = useInboxStore((s) => s.leaving);
  const dropLeaving = useInboxStore((s) => s.dropLeaving);
  useEffect(() => {
    const ids = Object.keys(leaving);
    if (ids.length === 0) return;
    const timer = setTimeout(() => ids.forEach(dropLeaving), MOTION.base + 40);
    return () => clearTimeout(timer);
  }, [leaving, dropLeaving]);

  // A cursor on an agent that no longer has anything open is a filter showing an empty board with
  // no way to tell why. It falls back to everything, which is what the rail would show anyway.
  useEffect(() => {
    if (agentId && !useInboxStore.getState().agents.some((a) => a.agent_id === agentId)) setAgentId(null);
  }, [agentId, items]);

  const empty = counts.all === 0 && counts.snoozed === 0;

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* §4.1: the title, the count, and the one thing this surface can ask for. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-hair px-5 py-3">
        <span className={TYPE.panelLabel}>Inbox</span>
        <span className="text-[11px] tabular-nums text-faint">{counts.all}</span>
        {!connected && (
          <span className="text-[11px] text-muted" title="Changes here need a connection">
            reconnecting…
          </span>
        )}
        {/* ASK AGAIN. A full-snapshot channel that goes stale — a transition nothing broadcast, a
            frame dropped during a reconnect — otherwise has no remedy but reloading the page. Quiet
            and to the left, because it is a way to check rather than a thing to do. */}
        <button
          onClick={() => sendListInbox()}
          disabled={!connected}
          className="ml-auto rounded-control p-1.5 text-faint transition-colors hover:bg-active hover:text-ink disabled:pointer-events-none disabled:opacity-40"
          title="Ask for the board again"
        >
          <RefreshIcon size={ICON.xs} />
        </button>
      </div>

      {error && (
        <div className="shrink-0 border-b border-hair px-5 py-2 text-[11px] text-err">{error}</div>
      )}

      <div className="flex min-h-0 flex-1">
        <LeftRail filter={filter} onFilter={setFilter} agentId={agentId} onAgent={setAgentId} />

        <div ref={setHost} className="min-w-0 flex-1 overflow-hidden px-4 py-3">
          {!loaded ? (
            // NOT A SPINNER (§9). Three skeleton cards at the three sizes, so the board does not jump
            // when the real ones land — and so the wait says what is coming rather than only that
            // something is.
            <div className="flex gap-4">
              {[64, 44, 32].map((h, i) => (
                <div key={i} className="flex-1 space-y-2">
                  <div className="h-2.5 w-24 rounded bg-active" />
                  <div className="rounded-card bg-active/60" style={{ height: h }} />
                  <div className="rounded-card bg-active/40" style={{ height: h }} />
                </div>
              ))}
            </div>
          ) : empty ? (
            <NothingNeedsYou cleared={cleared} />
          ) : filter === "snoozed" || filter === "team" ? (
            // TWO FILTERS RENDER A FLAT LIST RATHER THAN THREE COLUMNS, and for the same reason the
            // Archived thread filter does: the columns are about severity, and neither of these is a
            // question about severity. Snoozed is one tray's contents and Team is one category, and
            // splitting either across three columns would put two cards under two headings to say
            // one thing.
            <div className="h-full space-y-2 overflow-y-auto pr-1">
              {visible.length === 0 ? (
                <div className="px-1 py-3 text-[11px] text-faint">
                  Nothing under {INBOX_FILTER_LABEL[filter]}
                </div>
              ) : (
                visible.map((item) => (
                  <InboxCard
                    key={item.id}
                    item={item}
                    now={now}
                    expanded={expandedId === item.id}
                    selected={cursor === item.id}
                    leaving={Boolean(leaving[item.id])}
                    onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                  />
                ))
              )}
            </div>
          ) : narrow ? (
            // ONE COLUMN, CARDS UNCHANGED. `ordered` is already severity then age — the same order
            // the three columns read in — so the fallback is the columns' own sequence poured into
            // one lane rather than a second arrangement to keep in step.
            <div className="h-full space-y-2 overflow-y-auto pr-1">
              {ordered.map((item) => (
                <div
                  key={item.id}
                  {...drag.cardProps(item.id)}
                  className={drag.state.itemId === item.id ? "opacity-50" : ""}
                  onClickCapture={(e) => selectOnClick(ordered, item.id, e.shiftKey, cursor, setSelection)}
                >
                  <InboxCard
                    item={item}
                    now={now}
                    expanded={expandedId === item.id}
                    selected={cursor === item.id || selection.includes(item.id)}
                    leaving={Boolean(leaving[item.id])}
                    onClick={(e) => {
                      if (e.shiftKey) return;
                      setExpandedId(expandedId === item.id ? null : item.id);
                    }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-full gap-4">
              {INBOX_COLUMNS.map((severity) => (
                <Column
                  key={severity}
                  severity={severity}
                  items={columnItems(visible, severity)}
                  now={now}
                  leaving={leaving}
                  expandedId={expandedId}
                  onExpand={setExpandedId}
                  cursor={cursor}
                  selection={selection}
                  onSelect={(id, shift) => selectOnClick(ordered, id, shift, cursor, setSelection)}
                  dragProps={drag.cardProps}
                  dimmed={drag.state.itemId !== null}
                  draggingId={drag.state.itemId}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* §3's toast, above the tray and in the flow rather than floating: a floating card covers the
          bottom of the board, which is where somebody who has just dismissed something is looking. */}
      <InboxUndoToast />

      {/* §5.4's strip, which is what keeps snooze from being a slower dismissal. It is also the one
          drop target on the board — see `useInboxDrag` for why that is a pointer handler rather than
          a dependency. */}
      <InboxTray snoozed={snoozed} now={now} trayRef={drag.trayRef} armed={drag.state.itemId !== null} />

      {/* The workspace is named when the board is empty and this is the first thing somebody sees —
          after a switch, "Nothing needs you in Acme Corp" reads as an empty scope where a bare
          sentence reads as data that has gone missing. Rendered here rather than inside the zero
          state so the celebration stays the largest thing on the screen. */}
      {empty && workspaceName && (
        <div className="shrink-0 pb-6 text-center text-[11px] text-faint">in {workspaceName}</div>
      )}
    </div>
  );
}
