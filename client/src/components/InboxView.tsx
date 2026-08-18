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
import { ICON, TYPE } from "../lib/tokens.ts";
import { useInboxStore } from "../store/inboxStore.ts";
import { useSessionStore } from "../store/sessionStore.ts";
import { useTraceStore } from "../store/traceStore.ts";
import { InboxCard } from "./InboxCard.tsx";
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
  expandedId,
  onExpand,
}: {
  severity: InboxSeverity;
  items: InboxItemView[];
  now: number;
  expandedId: string | null;
  onExpand: (id: string | null) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
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
            <InboxCard
              key={item.id}
              item={item}
              now={now}
              expanded={expandedId === item.id}
              // §4.5: clicking a card expands it IN PLACE, and clicking it again closes it. It does
              // not navigate — navigation is what the actions are for, and it is the fallback.
              onClick={() => onExpand(expandedId === item.id ? null : item.id)}
            />
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

        <div className="min-w-0 flex-1 overflow-hidden px-4 py-3">
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
                    onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                  />
                ))
              )}
            </div>
          ) : (
            <div className="flex h-full gap-4">
              {INBOX_COLUMNS.map((severity) => (
                <Column
                  key={severity}
                  severity={severity}
                  items={columnItems(visible, severity)}
                  now={now}
                  expandedId={expandedId}
                  onExpand={setExpandedId}
                />
              ))}
            </div>
          )}
        </div>
      </div>

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
